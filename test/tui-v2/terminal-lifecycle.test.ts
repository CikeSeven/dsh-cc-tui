/**
 * tui-v2 WP-03b2 terminal lifecycle tests (plan §5.7/§6.6): takeover/cleanup
 * orchestration, process signal handlers, deadlines and the mode snapshot.
 *
 * Top-level test names contain "terminal" so
 * `--test-name-pattern 'terminal'` selects this file.
 *
 * Everything runs on fake streams + a ManualClock; no real TTY is opened.
 * Signal tests emit synthetic events on an injected EventEmitter processHost
 * so the test runner's own process handlers are never triggered; one test
 * asserts real-process attach/detach purely via listener counts (no emits).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

import type { Clock } from '../../src/tui-v2/model/schema.js'
import {
  createInputSource,
  type ResizePayload,
  type SignalPayload,
  type TerminalInputEvent,
} from '../../src/tui-v2/terminal/input.js'
import {
  createTerminalLifecycle,
  LIFECYCLE_CLEANUP_DEADLINE_MS,
  type LifecycleDiagnostic,
  type LifecycleStopReason,
  type TerminalLifecycle,
} from '../../src/tui-v2/terminal/lifecycle.js'
import { unknownConservativeDefaults, type TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import { createTerminalWriter } from '../../src/tui-v2/terminal/writer.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js'

// ---------------------------------------------------------------------------
// test doubles
// ---------------------------------------------------------------------------

class ManualClock implements Clock {
  private t = 0
  private seq = 0
  private timers: Array<{ id: number; at: number; cb: () => void }> = []

  now(): number {
    return this.t
  }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.seq
    this.timers.push({ id, at: this.t + Math.max(0, delayMs), cb: callback })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle)
  }
  advance(ms: number): void {
    const target = this.t + ms
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (due === undefined) break
      this.timers = this.timers.filter((timer) => timer.id !== due.id)
      this.t = due.at
      due.cb()
    }
    this.t = target
  }
}

class FakeStdin extends PassThrough {
  readonly isTTY = true
  readonly rawModes: boolean[] = []
  setRawMode(raw: boolean): void {
    this.rawModes.push(raw)
  }
}

class FakeStream extends Writable {
  readonly chunks: string[] = []
  holdCallbacks = false
  failNextError: Error | null = null

  constructor() {
    super({ highWaterMark: 16 })
  }

  _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk))
    if (this.failNextError !== null) {
      const error = this.failNextError
      this.failNextError = null
      callback(error)
      return
    }
    if (!this.holdCallbacks) callback()
    // held callbacks are never released: the writer op deadline must fire
  }

  get text(): string {
    return this.chunks.join('')
  }
}

async function tick(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// stack builder
// ---------------------------------------------------------------------------

interface LifecycleStack {
  profile: TerminalProfile
  stdin: FakeStdin
  host: EventEmitter
  stream: FakeStream
  clock: ManualClock
  events: TerminalInputEvent[]
  diagnostics: LifecycleDiagnostic[]
  reasons: LifecycleStopReason[]
  resumes: string[]
  processErrors: Array<{ error: unknown; origin: string }>
  writer: ReturnType<typeof createTerminalWriter>
  input: ReturnType<typeof createInputSource>
  lifecycle: TerminalLifecycle
  vt: VirtualTerminal
}

function buildStack(
  profileId: string,
  options: { stdout?: { columns?: number; rows?: number }; realProcess?: boolean } = {},
): LifecycleStack {
  const profile = profileId === 'unknown-conservative' ? unknownConservativeDefaults() : getProfile(profileId)
  const stdin = new FakeStdin()
  const stdout = options.stdout ?? { columns: 131, rows: 43 }
  const host = new EventEmitter()
  const stream = new FakeStream()
  const clock = new ManualClock()
  const events: TerminalInputEvent[] = []
  const diagnostics: LifecycleDiagnostic[] = []
  const reasons: LifecycleStopReason[] = []
  const resumes: string[] = []
  const processErrors: Array<{ error: unknown; origin: string }> = []
  const input = createInputSource({ stdin, generation: 0, clock, profile, onEvent: (event) => events.push(event) })
  const writer = createTerminalWriter({ stream, clock, profile })
  const lifecycle = createTerminalLifecycle({
    writer,
    input,
    profile,
    clock,
    stdin,
    stdout,
    processHost: options.realProcess === true ? undefined : host,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onRequestStop: (reason) => reasons.push(reason),
    onResume: () => resumes.push('SIGCONT'),
    onProcessError: (error, origin) => processErrors.push({ error, origin }),
  })
  return { profile, stdin, host, stream, clock, events, diagnostics, reasons, resumes, processErrors, writer, input, lifecycle, vt: new VirtualTerminal(profile) }
}

/** Drive stop() to completion: ops settle on microtasks, drainInput on the clock. */
async function settleStop(clock: ManualClock, promise: Promise<void>): Promise<void> {
  await tick(6)
  clock.advance(200)
  await tick(6)
  await promise
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

test('terminal lifecycle: start emits the fixed sequence in order and VT modes land (full-capability profile)', async () => {
  const stack = buildStack('kitty-sync')
  const first = stack.lifecycle.start()
  assert.equal(stack.lifecycle.start(), first) // idempotent: same promise
  const result = await first
  assert.deepEqual(result, { status: 'active' })
  assert.equal(stack.lifecycle.lifecycleState(), 'active')

  // Fixed order: alt, paste, mouse(1002+1006), focus, kitty push, sync, hide cursor.
  assert.equal(
    stack.stream.text,
    '\x1b[?1049h' + '\x1b[?2004h' + '\x1b[?1002h\x1b[?1006h' + '\x1b[?1004h' + '\x1b[>1u' + '\x1b[?2026h' + '\x1b[?25l',
  )
  assert.deepEqual(stack.stdin.rawModes, [true]) // raw via termios, not ANSI

  stack.vt.write(stack.stream.text)
  const modes = stack.vt.snapshot().modes
  assert.equal(modes.alternateScreen, true)
  assert.equal(modes.bracketedPaste, true)
  assert.equal(modes.mouse, 'sgr-1006')
  assert.equal(modes.focusReporting, true)
  assert.equal(modes.kittyKeyboard, true)
  assert.equal(modes.syncOutput, true)
  assert.equal(modes.cursorVisible, false)

  // The mode snapshot tracks what was issued (takeover restore baseline).
  const snapshot = stack.lifecycle.currentModeSnapshot()
  assert.equal(snapshot.alternateScreen, true)
  assert.equal(snapshot.rawInput, true)
  assert.equal(snapshot.mouse, 'sgr-1006')
  assert.equal(snapshot.kittyKeyboard, true)
  assert.equal(snapshot.cursorVisible, false)
  assert.equal(snapshot.windowsDec9001, false) // declined by contract
  assert.equal(stack.lifecycle.generation(), 0)

  await settleStop(stack.clock, stack.lifecycle.stop('user-exit'))
})

test('terminal lifecycle: unknown-conservative refuses alternate screen before any takeover byte', async () => {
  const stack = buildStack('unknown-conservative')
  const result = await stack.lifecycle.start()
  assert.equal(result.status, 'error')
  if (result.status === 'error') assert.equal(result.error.code, 'unsupported-alternate-screen')
  assert.equal(stack.stream.text, '') // not a single byte was written
  assert.deepEqual(stack.stdin.rawModes, []) // raw mode never touched
  assert.equal(stack.stdin.listenerCount('data'), 0) // input never started
  assert.equal(stack.lifecycle.lifecycleState(), 'failed-before-takeover')
  assert.ok(stack.diagnostics.some((d) => d.code === 'unsupported-alternate-screen'))
})

test('terminal lifecycle: unknown-conservative inline start skips every advanced sequence', async () => {
  const stack = buildStack('unknown-conservative')
  const result = await stack.lifecycle.start({ alternateScreen: false })
  assert.deepEqual(result, { status: 'active' })
  assert.equal(stack.lifecycle.lifecycleState(), 'active')
  // Only hide-cursor (basic CSI) went out; every advanced capability 'unknown'
  // was skipped, never guessed (§5.4).
  assert.equal(stack.stream.text, '\x1b[?25l')
  const skipped = stack.diagnostics
    .filter((d) => d.code === 'capability-skipped')
    .map((d) => (d.details as { capability: string }).capability)
    .sort()
  assert.deepEqual(skipped, [
    'supportsBracketedPaste',
    'supportsFocusReporting',
    'supportsKittyKeyboard',
    'supportsMouse',
    'supportsSyncOutput',
  ])
  // Mouse enable is refused on this profile (capability not confirmed).
  const mouse = await stack.lifecycle.setMouseEnabled(true)
  assert.equal(mouse.status, 'error')
  if (mouse.status === 'error') assert.equal(mouse.error.code, 'capability-refused')

  await settleStop(stack.clock, stack.lifecycle.stop('user-exit'))
  stack.vt.write(stack.stream.text)
  const modes = stack.vt.snapshot().modes
  assert.equal(modes.cursorVisible, true)
  assert.equal(modes.alternateScreen, false)
  assert.equal(modes.bracketedPaste, false)
  assert.equal(modes.mouse, 'off')
  assert.equal(stack.lifecycle.lifecycleState(), 'stopped')
})

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

test('terminal lifecycle: stop writes reverse-order cleanup, VT modes restored, idempotent promise', async () => {
  const stack = buildStack('kitty-sync')
  await stack.lifecycle.start()
  const startText = stack.stream.text

  const p1 = stack.lifecycle.stop('user-exit')
  const p2 = stack.lifecycle.stop('user-exit')
  assert.equal(p1, p2) // repeated stop converges on the same promise
  await settleStop(stack.clock, p1)
  // Still idempotent after completion.
  assert.equal(stack.lifecycle.stop('user-exit'), p1)

  const segment = stack.stream.text.slice(startText.length)
  const order = [
    '\x1b[?2026l', // sync end
    '\x1b[<99u', // kitty pop
    '\x1b[?1000l', // mouse off (first of the mouse reset bundle)
    '\x1b[?2004l', // paste off
    '\x1b[?1004l', // focus off
    '\x1b[?25h', // show cursor
    '\x1b[?1049l', // exit alt
  ]
  const indices = order.map((needle) => segment.indexOf(needle))
  for (let i = 0; i < indices.length; i++) {
    assert.ok((indices[i] as number) >= 0, `missing exit sequence ${JSON.stringify(order[i])} in ${JSON.stringify(segment)}`)
    if (i > 0) assert.ok((indices[i] as number) > (indices[i - 1] as number), `exit order violated at ${JSON.stringify(order[i])}`)
  }

  stack.vt.write(stack.stream.text)
  const modes = stack.vt.snapshot().modes
  assert.equal(modes.alternateScreen, false)
  assert.equal(modes.bracketedPaste, false)
  assert.equal(modes.mouse, 'off')
  assert.equal(modes.focusReporting, false)
  assert.equal(modes.kittyKeyboard, false)
  assert.equal(modes.syncOutput, false)
  assert.equal(modes.cursorVisible, true)

  assert.equal(stack.lifecycle.lifecycleState(), 'stopped')
  assert.equal(stack.writer.lifecycleState(), 'stopped')
  assert.deepEqual(stack.stdin.rawModes, [true, false])
  assert.equal(stack.stdin.listenerCount('data'), 0)
  const snapshot = stack.lifecycle.currentModeSnapshot()
  assert.equal(snapshot.alternateScreen, false)
  assert.equal(snapshot.mouse, 'off')
  assert.equal(snapshot.cursorVisible, true)
  const stopped = stack.diagnostics.find((d) => d.code === 'stopped')
  assert.ok(stopped !== undefined)
  assert.equal((stopped.details as { reason: string }).reason, 'user-exit')
})

// ---------------------------------------------------------------------------
// process signal handlers
// ---------------------------------------------------------------------------

const HOST_EVENTS = ['SIGWINCH', 'SIGCONT', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection'] as const

test('terminal lifecycle: SIGWINCH/SIGCONT/SIGINT/SIGTERM fire their callbacks; detach removes everything', async () => {
  const stack = buildStack('unicode-ambiguous-narrow')
  await stack.lifecycle.start()
  stack.lifecycle.attachProcessHandlers()
  stack.lifecycle.attachProcessHandlers() // idempotent
  for (const event of HOST_EVENTS) assert.equal(stack.host.listenerCount(event), 1, `one listener for ${event}`)

  stack.host.emit('SIGWINCH')
  stack.host.emit('SIGWINCH')
  const resizes = stack.events.filter((event) => event.kind === 'resize')
  assert.equal(resizes.length, 2)
  assert.deepEqual(resizes[0]?.payload as ResizePayload, { columns: 131, rows: 43 })

  stack.host.emit('SIGCONT')
  assert.deepEqual(stack.resumes, ['SIGCONT'])

  stack.host.emit('SIGINT')
  stack.host.emit('SIGTERM')
  assert.deepEqual(stack.reasons, ['sigint', 'sigterm'])
  const signals = stack.events.filter((event) => event.kind === 'signal')
  assert.deepEqual(signals.map((event) => (event.payload as SignalPayload).signal), ['SIGINT', 'SIGTERM'])

  stack.lifecycle.detachProcessHandlers()
  stack.lifecycle.detachProcessHandlers() // idempotent
  for (const event of HOST_EVENTS) assert.equal(stack.host.listenerCount(event), 0, `no listener left for ${event}`)
  stack.host.emit('SIGWINCH')
  stack.host.emit('SIGCONT')
  assert.equal(stack.events.filter((event) => event.kind === 'resize').length, 2)
  assert.equal(stack.resumes.length, 1)

  await settleStop(stack.clock, stack.lifecycle.stop('user-exit'))
})

test('terminal lifecycle: real-process attach/detach is exact and idempotent (listener counts only)', async () => {
  const stack = buildStack('unicode-ambiguous-narrow', { realProcess: true })
  const baseline = new Map<string, number>()
  for (const event of HOST_EVENTS) baseline.set(event, process.listenerCount(event))

  stack.lifecycle.attachProcessHandlers()
  stack.lifecycle.attachProcessHandlers()
  for (const event of HOST_EVENTS) {
    assert.equal(process.listenerCount(event), (baseline.get(event) as number) + 1, `+1 listener for ${event}`)
  }
  stack.lifecycle.detachProcessHandlers()
  stack.lifecycle.detachProcessHandlers()
  for (const event of HOST_EVENTS) {
    assert.equal(process.listenerCount(event), baseline.get(event), `listener restored for ${event}`)
  }
})

test('terminal lifecycle: repeated SIGINT during cleanup sets the force flag and writes no extra sequences', async () => {
  const stack = buildStack('kitty-sync')
  await stack.lifecycle.start()
  stack.lifecycle.attachProcessHandlers()

  stack.host.emit('SIGINT')
  assert.deepEqual(stack.reasons, ['sigint'])
  // Coordinator behavior: stop on the first stop request.
  const stopping = stack.lifecycle.stop('sigint')
  await tick(3) // cleanup ops settle; drainInput timer still pending on the clock
  const textBefore = stack.stream.text

  stack.host.emit('SIGINT') // repeat DURING cleanup: force flag only
  assert.equal(stack.lifecycle.forceStopRequested(), true)
  assert.equal(stack.reasons.length, 1)
  assert.equal(stack.stream.text, textBefore) // not one extra byte

  stack.clock.advance(200)
  await tick(6)
  await stopping
  assert.equal(stack.lifecycle.lifecycleState(), 'stopped')
  assert.equal(stack.host.listenerCount('SIGINT'), 0) // detached at barrier end
})

test('terminal lifecycle: stdin close requests stop; uncaughtException reports and starts cleanup without exiting', async () => {
  const stack = buildStack('unicode-ambiguous-narrow')
  await stack.lifecycle.start()
  stack.lifecycle.attachProcessHandlers()

  stack.stdin.destroy()
  await tick()
  assert.deepEqual(stack.reasons, ['stdin-close'])

  const boom = new Error('boom')
  stack.host.emit('uncaughtException', boom)
  assert.equal(stack.processErrors.length, 1)
  assert.equal(stack.processErrors[0]?.error, boom)
  assert.equal(stack.processErrors[0]?.origin, 'uncaughtException')
  // Cleanup kicked off by the handler itself (stop('error')), never exit.
  assert.equal(stack.lifecycle.lifecycleState(), 'stopping')

  stack.host.emit('unhandledRejection', new Error('later'))
  assert.equal(stack.processErrors.length, 2)
  assert.equal(stack.processErrors[1]?.origin, 'unhandledRejection')

  await tick(6)
  stack.clock.advance(200)
  await tick(6)
  assert.equal(stack.lifecycle.lifecycleState(), 'stopped')
  for (const event of HOST_EVENTS) assert.equal(stack.host.listenerCount(event), 0) // stop detached all
})

// ---------------------------------------------------------------------------
// deadlines
// ---------------------------------------------------------------------------

test('terminal lifecycle: stalled writer hits the per-op cleanup deadline, stop still completes (best-effort)', async () => {
  const stack = buildStack('kitty-sync')
  await stack.lifecycle.start()
  stack.stream.holdCallbacks = true // every later write never settles

  const startNow = stack.clock.now()
  const stop = stack.lifecycle.stop('user-exit')
  await tick(6)
  stack.clock.advance(500) // first exit sequence (sync-output-end) times out
  await tick(6)
  stack.clock.advance(500)
  await tick(6)
  stack.clock.advance(200) // drainInput idle window
  await tick(6)
  await stop

  const timeoutDiag = stack.diagnostics.find((d) => d.code === 'cleanup-op-timeout')
  assert.ok(timeoutDiag !== undefined, 'op deadline diagnostic recorded')
  assert.equal((timeoutDiag.details as { operation: string }).operation, 'sync-output-end')
  // Bounded by the §5.7 deadlines, within the 2 s total budget (the writer
  // failure fast-errors the remaining ops after the first timeout).
  assert.ok(stack.clock.now() - startNow <= LIFECYCLE_CLEANUP_DEADLINE_MS)
  assert.equal(stack.writer.lifecycleState(), 'failed-after-takeover')
  assert.equal(stack.lifecycle.lifecycleState(), 'failed-after-takeover')
  assert.deepEqual(stack.stdin.rawModes, [true, false]) // raw still restored
})

test('terminal lifecycle: startup op failure cleans up and lands in failed-after-takeover', async () => {
  const stack = buildStack('kitty-sync')
  stack.stream.failNextError = new Error('write blew up')
  const result = await stack.lifecycle.start()
  assert.equal(result.status, 'error')
  if (result.status === 'error') assert.equal(result.error.code, 'failed-after-takeover')
  assert.equal(stack.lifecycle.lifecycleState(), 'failed-after-takeover')
  assert.deepEqual(stack.stdin.rawModes, [true, false]) // raw restored by cleanup
  assert.equal(stack.stdin.listenerCount('data'), 0) // input never started
  assert.ok(/^failed/.test(stack.writer.lifecycleState()))
  assert.ok(stack.diagnostics.some((d) => d.code === 'start-failed'))
  // A later stop() still converges (idempotent cleanup, best-effort).
  await settleStop(stack.clock, stack.lifecycle.stop('error'))
  assert.equal(stack.lifecycle.lifecycleState(), 'failed-after-takeover')
})

// ---------------------------------------------------------------------------
// runtime mode control
// ---------------------------------------------------------------------------

test('terminal lifecycle: mouse toggle goes through the writer queue and updates the snapshot', async () => {
  const stack = buildStack('kitty-sync')
  await stack.lifecycle.start()
  let fed = 0
  const feed = (): void => {
    stack.vt.write(stack.stream.text.slice(fed))
    fed = stack.stream.text.length
  }

  const off = await stack.lifecycle.setMouseEnabled(false)
  assert.equal(off.status, 'written')
  feed()
  assert.equal(stack.vt.snapshot().modes.mouse, 'off')
  assert.equal(stack.lifecycle.currentModeSnapshot().mouse, 'off')

  const on = await stack.lifecycle.setMouseEnabled(true)
  assert.equal(on.status, 'written')
  feed()
  assert.equal(stack.vt.snapshot().modes.mouse, 'sgr-1006')
  assert.equal(stack.lifecycle.currentModeSnapshot().mouse, 'sgr-1006')

  await settleStop(stack.clock, stack.lifecycle.stop('user-exit'))
})

test('terminal lifecycle: SIGWINCH falls back to profile geometry when stdout reports no dimensions', async () => {
  const stack = buildStack('unicode-ambiguous-narrow', { stdout: {} })
  await stack.lifecycle.start()
  stack.lifecycle.attachProcessHandlers()
  stack.host.emit('SIGWINCH')
  const resize = stack.events.find((event) => event.kind === 'resize')
  assert.deepEqual(resize?.payload as ResizePayload, { columns: stack.profile.columns, rows: stack.profile.rows })
  stack.lifecycle.detachProcessHandlers()
  await settleStop(stack.clock, stack.lifecycle.stop('user-exit'))
})
