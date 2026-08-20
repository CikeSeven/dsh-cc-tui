/** WP-08e1 internal trajectory SceneV2 registration/takeover contract. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTrajectoryController } from '../../src/tui-v2/controllers/trajectory.js'
import { createTrajectorySceneDescriptor } from '../../src/tui-v2/scenes/trajectory.js'
import { createPluginUIRuntime } from '../../src/tui-v2/scenes/runtime.js'
import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js'
import { emptySurfaceView } from '../../src/tui-v2/model/surfaces.js'
import type { ChannelSurfaceAdapter } from '../../src/dsh-adapter/ui-surfaces.js'
import type { Clock, EventMeta } from '../../src/tui-v2/model/schema.js'
import type { SceneHostHooks } from '../../src/tui-v2/scenes/runtime.js'

const clock: Clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }
const emptySnapshot = {
  identity: 'session-1:0', generation: 1, revision: 1, status: 'empty' as const,
  totalRows: 0, windowStart: 0, windowEnd: 0, rows: [], wave: [], matchedWaveColumns: [],
  hotspots: [], hotspotTotal: 0, totals: {
    turns: 0, steps: 0, rows: 0, calls: 0, errors: 0, retries: 0, spanMs: 0, toolMs: 0,
    decodeMs: 0, ttftMs: 0, ttftSamples: 0, retryMs: 0, tokens: { input: 0, output: 0, think: 0, cacheRead: 0, cacheWrite: 0 },
  },
}

function adapter(): ChannelSurfaceAdapter {
  return {
    snapshot: () => emptySurfaceView('session-1:0'),
    trajectorySnapshot: async () => emptySnapshot,
    inspectTrajectory: async () => null,
    setActivityFrames: () => true,
    subscribe: () => () => {},
    dispose: () => {},
  }
}

test('trajectory SceneV2: registered scene renders bounded empty/degraded view and restores close', async () => {
  const events: unknown[] = []
  let seq = 0
  const runtime = createPluginUIRuntime()
  const hooks: SceneHostHooks = {
    dispatch: (event) => events.push(event),
    nextMeta: (sourceSeq): EventMeta => ({
      schemaVersion: 1, adapterInstanceId: 'a', durableSessionId: 's', uiSessionGeneration: 'g', resetEpoch: 0,
      sessionEpoch: 'g:0', source: 'plugin', sourceSeq, seq: ++seq, at: 0,
    }),
    takeover: {
      request: async () => ({ token: {} as never, generation: 0, modeBeforeTakeover: {} as never, barrier: {} as never }),
      restore: async () => {},
      current: () => null,
    },
    requestRender: () => {},
  }
  runtime.attach(hooks)
  const controller = createTrajectoryController({
    adapter: adapter(), clock, degradedNotice: 'inline degraded notice',
  })
  await controller.open()
  const handle = runtime.register(createTrajectorySceneDescriptor(controller, {
    ...unknownConservativeDefaults(), columns: 40, rows: 12,
  }), { pluginId: 'dsh-tui' })
  assert.equal(handle.result.status, 'accepted')
  assert.equal(runtime.open('trajectory'), true)
  await runtime.whenIdle()
  const scene = runtime.activeAdapter()
  assert.ok(scene)
  const lines = scene!.render(40)
  assert.ok(lines.some((line) => line.includes('No trajectory events')))
  assert.ok(lines.some((line) => line.includes('inline degraded notice')))
  await runtime.close()
  await runtime.whenIdle()
  assert.equal(runtime.activeView(), null)
  await runtime.detach()
  controller.dispose()
})
