/**
 * tui-v2 WP-04b renderer-scheduler tests (plan §5.7): priority order,
 * 16-33 ms stream coalescing, preemption of pending (never in-flight)
 * renders, the resize transaction, stale-revision drops and stop rejection.
 * All timing runs on an injected fake clock.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Clock } from '../../src/tui-v2/model/schema.js'
import {
  STREAM_WINDOW_MIN_MS,
  createRenderScheduler,
  type RenderPriority,
  type ScheduledFrame,
  type SchedulerDiagnostic,
} from '../../src/tui-v2/renderer/scheduler.js'

class FakeClock implements Clock {
  time = 0
  private nextId = 1
  private timers = new Map<number, { at: number; cb: () => void }>()

  now(): number {
    return this.time
  }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + delayMs, cb: callback })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }
  get pendingCount(): number {
    return this.timers.size
  }
  /** Advance time, running due timers in fire order. */
  advance(ms: number): void {
    this.time += ms
    for (;;) {
      let due: { id: number; at: number; cb: () => void } | null = null
      for (const [id, timer] of this.timers) {
        if (timer.at <= this.time && (due === null || timer.at < due.at)) due = { id, ...timer }
      }
      if (due === null) break
      this.timers.delete(due.id)
      due.cb()
    }
  }
}

interface Frame extends ScheduledFrame {
  readonly label: string
}

const frame = (label: string, stateRevision: number): Frame => ({ label, stateRevision })

/** Flush microtasks (execute()/pump() chains are promise-based). */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function setup() {
  const clock = new FakeClock()
  const rendered: { label: string; priority: RenderPriority }[] = []
  const diagnostics: SchedulerDiagnostic[] = []
  const scheduler = createRenderScheduler<Frame>({
    clock,
    render: (state, priority) => {
      rendered.push({ label: state.label, priority })
    },
    onDiagnostic: (event) => diagnostics.push(event),
  })
  scheduler.start()
  return { clock, scheduler, rendered, diagnostics }
}

test('scheduler: stream chunks coalesce inside the 16 ms window, latest wins', async () => {
  const { clock, scheduler, rendered, diagnostics } = setup()
  scheduler.requestRender('stream', () => frame('s1', 1))
  scheduler.requestRender('stream', () => frame('s2', 2))
  scheduler.requestRender('stream', () => frame('s3', 3))
  clock.advance(STREAM_WINDOW_MIN_MS - 1)
  assert.equal(rendered.length, 0, 'nothing renders before the window closes')
  clock.advance(1)
  await flush()
  assert.deepEqual(rendered, [{ label: 's3', priority: 'stream' }])
  assert.equal(diagnostics.filter((d) => d.kind === 'coalesced').length, 2)
  assert.equal(scheduler.committedRevision, 3)
})

test('scheduler: input preempts a pending stream render', async () => {
  const { clock, scheduler, rendered, diagnostics } = setup()
  scheduler.requestRender('stream', () => frame('s1', 1))
  scheduler.requestRender('input', () => frame('i1', 2))
  clock.advance(0) // input due immediately
  await flush()
  assert.deepEqual(rendered, [{ label: 'i1', priority: 'input' }])
  clock.advance(100)
  await flush()
  assert.equal(rendered.length, 1, 'preempted stream render never runs')
  assert.ok(diagnostics.some((d) => d.kind === 'preempted' && d.priority === 'stream'))
})

test('scheduler: priority order exit > input > resize > sync > stream > notify', async () => {
  const { clock, scheduler, rendered } = setup()
  // Schedule low-to-high; each higher priority preempts the pending one.
  scheduler.requestRender('notify', () => frame('n', 1))
  scheduler.requestRender('stream', () => frame('s', 2))
  scheduler.requestRender('sync', () => frame('y', 3))
  scheduler.requestRender('resize', () => frame('r', 4))
  scheduler.requestRender('input', () => frame('i', 5))
  scheduler.requestRender('exit', () => frame('e', 6))
  clock.advance(0)
  await flush()
  assert.deepEqual(rendered, [{ label: 'e', priority: 'exit' }])
  clock.advance(1000)
  await flush()
  assert.equal(rendered.length, 1)
})

test('scheduler: an in-flight render is never interrupted; queued work runs after', async () => {
  const clock = new FakeClock()
  const order: string[] = []
  let release: (() => void) | null = null
  const scheduler = createRenderScheduler<Frame>({
    clock,
    render: async (state) => {
      order.push(`begin:${state.label}`)
      if (state.label === 'slow') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      order.push(`end:${state.label}`)
    },
  })
  scheduler.start()
  scheduler.requestRender('sync', () => frame('slow', 1))
  clock.advance(0)
  await flush(1)
  assert.deepEqual(order, ['begin:slow'])
  // Ctrl+C class input arrives mid-render: must wait, not interrupt.
  scheduler.requestRender('input', () => frame('int', 2))
  clock.advance(0)
  await flush(1)
  assert.deepEqual(order, ['begin:slow'], 'in-flight render not interrupted')
  release?.()
  await flush()
  assert.deepEqual(order, ['begin:slow', 'end:slow', 'begin:int', 'end:int'])
  scheduler.stop()
})

test('scheduler: stale revisions below the committed watermark are dropped', async () => {
  const { clock, scheduler, rendered, diagnostics } = setup()
  scheduler.requestRender('sync', () => frame('new', 10))
  clock.advance(0)
  await flush()
  assert.equal(scheduler.committedRevision, 10)
  scheduler.requestRender('sync', () => frame('old', 5))
  clock.advance(0)
  await flush()
  assert.equal(rendered.length, 1, 'stale frame never reaches render')
  assert.ok(diagnostics.some((d) => d.kind === 'dropped-stale' && d.stateRevision === 5))
})

test('scheduler: resize transaction cancels pending, runs listeners, forces one render', async () => {
  const { clock, scheduler, rendered, diagnostics } = setup()
  const cleaned: string[] = []
  scheduler.onResize(() => cleaned.push('caches-cleared'))
  scheduler.requestRender('stream', () => frame('s1', 1))
  const accepted = scheduler.beginResizeTransaction(() => frame('resized', 2))
  assert.equal(accepted, true)
  assert.deepEqual(cleaned, ['caches-cleared'])
  clock.advance(0)
  await flush()
  assert.deepEqual(rendered, [{ label: 'resized', priority: 'resize' }])
  clock.advance(100)
  await flush()
  assert.equal(rendered.length, 1, 'the pre-resize stream render was cancelled')
  assert.ok(diagnostics.some((d) => d.kind === 'resize-transaction'))
})

test('scheduler: stop rejects all further requests and releases timers', async () => {
  const { clock, scheduler, rendered, diagnostics } = setup()
  scheduler.requestRender('stream', () => frame('s1', 1))
  scheduler.stop()
  assert.equal(scheduler.phase, 'stopped')
  assert.equal(clock.pendingCount, 0, 'pending timer released')
  assert.equal(scheduler.requestRender('exit', () => frame('e', 2)), false)
  assert.equal(scheduler.requestRender('sync', () => frame('y', 3)), false)
  clock.advance(1000)
  await flush()
  assert.equal(rendered.length, 0)
  assert.equal(diagnostics.filter((d) => d.kind === 'rejected-stopped').length, 2)
})

test('scheduler: lower-priority request merges into a pending higher one', async () => {
  const { clock, scheduler, rendered } = setup()
  scheduler.requestRender('input', () => frame('i1', 1))
  scheduler.requestRender('notify', () => frame('n1', 1)) // merged away
  clock.advance(1)
  await flush()
  assert.deepEqual(rendered, [{ label: 'i1', priority: 'input' }])
})

test('scheduler: stream window is clamped to [16, 33] ms', async () => {
  const clock = new FakeClock()
  const rendered: string[] = []
  const scheduler = createRenderScheduler<Frame>({
    clock,
    streamWindowMs: 500, // clamped to 33
    render: (state) => {
      rendered.push(state.label)
    },
  })
  scheduler.start()
  scheduler.requestRender('stream', () => frame('s', 1))
  clock.advance(33)
  await flush()
  assert.deepEqual(rendered, ['s'])
  scheduler.stop()
})
