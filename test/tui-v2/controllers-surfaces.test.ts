/** WP-08e1 surface/trajectory controller contracts. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createActivityController, createSurfaceController } from '../../src/tui-v2/controllers/surfaces.js'
import { createTrajectoryController } from '../../src/tui-v2/controllers/trajectory.js'
import { emptySurfaceView, type UiSurfaceView } from '../../src/tui-v2/model/surfaces.js'
import type { Clock } from '../../src/tui-v2/model/schema.js'
import { createChannelSurfaceAdapter, type ChannelSurfaceAdapter, type SurfaceChannel, type TrajectoryAdapterSnapshot } from '../../src/dsh-adapter/ui-surfaces.js'
import type { TrajNode } from '../../src/dsh-adapter/trajectory/types.js'
import type { InspectDetail } from '../../src/dsh-adapter/trajectory/inspect.js'

class ManualClock implements Clock {
  nowValue = 0
  private next = 1
  private timers = new Map<number, { at: number; cb: () => void }>()
  now(): number { return this.nowValue }
  setTimeout(cb: () => void, delay: number): unknown {
    const id = this.next++
    this.timers.set(id, { at: this.nowValue + delay, cb })
    return id
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number) }
  advance(ms: number): void {
    this.nowValue += ms
    for (;;) {
      const due = [...this.timers.entries()].find(([, timer]) => timer.at <= this.nowValue)
      if (due === undefined) break
      this.timers.delete(due[0])
      due[1].cb()
    }
  }
  get pending(): number { return this.timers.size }
}

function surface(): UiSurfaceView {
  return { ...emptySurfaceView('session-1'), revision: 1, sessionEpoch: 'session-1', activityEnabled: true, activity: {
    phase: 'thinking', line: 'working', preset: 'claude', frame: '·', frameIndex: 0, intervalMs: 100, updatedAt: 0,
  } }
}

test('activity controller: clock-owned frames, deterministic preset and stall', () => {
  const clock = new ManualClock()
  let renders = 0
  const controller = createActivityController({ clock, stallMs: 500, onFrame: () => { renders += 1 } })
  controller.update(surface())
  assert.equal(clock.pending, 1)
  clock.advance(150)
  assert.equal(renders, 1)
  assert.notEqual(controller.view(surface().activity)?.frame, '·')
  clock.advance(500)
  assert.equal(controller.view(surface().activity)?.phase, 'stalled')
  assert.ok(controller.diagnostics().stalls > 0)
  assert.equal(controller.setPreset('not-a-preset'), false)
  controller.dispose()
  assert.equal(clock.pending, 0)
})

function node(seq: number, label: string, status: TrajNode['status'] = 'ok'): TrajNode {
  return { seq, time: seq * 100, kind: seq === 1 ? 'turn' : 'tool', turn: seq, label, detail: `detail ${label}`, durationMs: seq * 10, status }
}

function snapshot(nodes: readonly TrajNode[]): TrajectoryAdapterSnapshot {
  const rows = nodes.map((item) => ({
    seq: item.seq, time: item.time, kind: item.kind, turn: item.turn, label: item.label,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
    ...(item.status === undefined ? {} : { status: item.status }),
  }))
  return {
    identity: 'session-1:1', generation: 1, revision: nodes.length, status: rows.length === 0 ? 'empty' : 'ready',
    totalRows: rows.length, windowStart: 0, windowEnd: Math.min(2, rows.length), rows: rows.slice(0, 2),
    wave: rows.map((_, index) => ({ weight: 10, count: 1, input: 0, model: 0, tool: 10, error: false, retry: false, running: false, firstIndex: index })),
    matchedWaveColumns: [],
    hotspots: [{ label: 'bash', totalMs: 20, count: 2, tokens: 3, firstIndex: 1 }], hotspotTotal: 1,
    totals: { turns: 1, steps: 1, rows: nodes.length, calls: 2, errors: 0, retries: 0, spanMs: 100, toolMs: 20, decodeMs: 0, ttftMs: 0, ttftSamples: 0, retryMs: 0, tokens: { input: 1, output: 2, think: 0, cacheRead: 0, cacheWrite: 0 } },
  }
}

const detail: InspectDetail = { title: 'bash', facts: ['turn 1'], sections: [{ title: 'output', body: 'safe output' }] }

function trajectoryAdapter(next: TrajectoryAdapterSnapshot): ChannelSurfaceAdapter {
  return {
    snapshot: () => emptySurfaceView('session-1'),
    trajectorySnapshot: async () => next,
    inspectTrajectory: async (seq, identity, generation) => ({ identity, generation, seq, detail }),
    setActivityFrames: () => true,
    subscribe: () => () => {},
    dispose: () => {},
  }
}

test('surface controller: activity preset and toggle stay outside the component', () => {
  const clock = new ManualClock()
  let storedPreset = ''
  const adapter: ChannelSurfaceAdapter = {
    snapshot: () => surface(),
    trajectorySnapshot: async () => snapshot([]),
    inspectTrajectory: async () => null,
    setActivityFrames: (name) => { storedPreset = name; return true },
    subscribe: () => () => {},
    dispose: () => {},
  }
  const controller = createSurfaceController({ adapter, clock })
  controller.refresh(surface())
  assert.equal(controller.setActivityPreset('moon'), true)
  assert.equal(storedPreset, 'moon')
  assert.equal(controller.toggleActivity(), false)
  assert.equal(controller.activityEnabled(), false)
  assert.equal(controller.activity.view(surface().activity), null)
  controller.dispose()
})

test('surface adapter trajectory boundary publishes no raw nodes or session events', async () => {
  const listeners = new Set<() => void>()
  const channel: SurfaceChannel = {
    agentId: 'session-1', activityEnabled: true, activityFrames: 'claude', working: false,
    contextBarEnabled: true, contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    contextWindow: undefined, lastUsage: undefined, workingActivity: undefined, goal: undefined, todos: [], loadedContext: undefined,
    setActivityFrames: () => true, traceEvents: () => [],
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const adapter = createChannelSurfaceAdapter(channel, new ManualClock())
  const projected = await adapter.trajectorySnapshot({ windowRows: 2, waveWidth: 3 })
  assert.equal('nodes' in projected, false)
  assert.equal('events' in projected, false)
  assert.doesNotThrow(() => JSON.stringify(projected))
  adapter.dispose()
  assert.equal(listeners.size, 0)
})

test('trajectory controller: bounded window, query/navigation, inspector and dispose', async () => {
  const clock = new ManualClock()
  const controller = createTrajectoryController({ adapter: trajectoryAdapter(snapshot([node(1, 'turn 1'), node(2, 'bash'), node(3, 'grep', 'error')])), clock, windowRows: 2 })
  await controller.open()
  assert.equal(controller.view().status, 'ready')
  assert.equal(controller.view().rows.length, 2)
  controller.handleInput('down')
  assert.equal(controller.view().cursor, 1)
  controller.handleInput('/')
  controller.handleInput('g')
  assert.equal(controller.view().query, 'g')
  controller.handleInput('enter')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.view().inspector.status, 'ready')
  controller.handleInput('q')
  assert.equal(controller.diagnostics().closes, 1)
  controller.dispose()
  controller.handleInput('down')
  assert.ok(controller.diagnostics().closes >= 1)
})
