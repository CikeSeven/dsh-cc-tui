/**
 * tui-v2 WP-03c PiTerminalAdapter tests (plan §5.6): the strict write(string)
 * parser boundary (round-trip / rejection / partial reassembly / payload cap),
 * the per-method lifecycle mapping of the pinned pi Terminal surface, input
 * event dispatch and the backpressure/error fixtures.
 *
 * Top-level test names contain "terminal" so
 * `--test-name-pattern 'pi fork|terminal|overlay'` selects this file.
 *
 * Everything runs on fake streams + a ManualClock; no real TTY is opened.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

import type { Clock } from '../../src/tui-v2/model/schema.js'
import {
  createPiTerminalStack,
  type PiAdapterError,
  type PiTerminalStack,
} from '../../src/tui-v2/terminal/pi-adapter.js'
import { parsePiTerminalString, piOutput } from '../../src/tui-v2/terminal/pi.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'

// ---------------------------------------------------------------------------
// test doubles (same shape as terminal-lifecycle.test.ts)
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

  _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk))
    if (this.failNextError !== null) {
      const error = this.failNextError
      this.failNextError = null
      callback(error)
      return
    }
    if (!this.holdCallbacks) callback()
    // held callbacks never fire: the writer op deadline must expire
  }

  get text(): string {
    return this.chunks.join('')
  }
}

async function tick(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}

interface Rig {
  stack: PiTerminalStack
  stdin: FakeStdin
  stream: FakeStream
  clock: ManualClock
  host: EventEmitter
  errors: PiAdapterError[]
  stopReasons: string[]
}

function buildRig(startOptions?: { alternateScreen?: boolean }): Rig {
  const profile = getProfile('kitty-sync')
  const stdin = new FakeStdin()
  const stream = new FakeStream()
  const clock = new ManualClock()
  const host = new EventEmitter()
  const errors: PiAdapterError[] = []
  const stopReasons: string[] = []
  const stdout = { columns: 80, rows: 24 }
  const stack = createPiTerminalStack({
    stdin,
    stdout,
    stream,
    clock,
    profile,
    startOptions: startOptions ?? { alternateScreen: false },
    processHost: host,
    onError: (error) => errors.push(error),
    onRequestStop: (reason) => stopReasons.push(reason),
  })
  return { stack, stdin, stream, clock, host, errors, stopReasons }
}

/** Drive a stop barrier to completion (drain timers live on the ManualClock). */
async function settleStop(clock: ManualClock, promise: Promise<void>): Promise<void> {
  await tick(6)
  clock.advance(200)
  await tick(6)
  await promise
}

// ---------------------------------------------------------------------------
// write(string): parser round-trip
// ---------------------------------------------------------------------------

test('terminal pi adapter: every piOutput control builder round-trips byte-for-byte', async () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter
  const cases: Array<[string, string]> = [
    ['syncOutputBegin', piOutput.syncOutputBegin()],
    ['syncOutputEnd', piOutput.syncOutputEnd()],
    ['enterAltScreen', piOutput.enterAltScreen()],
    ['exitAltScreen', piOutput.exitAltScreen()],
    ['setAutowrap(true)', piOutput.setAutowrap(true)],
    ['setAutowrap(false)', piOutput.setAutowrap(false)],
    ['enableButtonMotionMouse', piOutput.enableButtonMotionMouse()],
    ['enableAllMotionMouse', piOutput.enableAllMotionMouse()],
    ['disableMouse', piOutput.disableMouse()],
    ['setCursorVisible(true)', piOutput.setCursorVisible(true)],
    ['setCursorVisible(false)', piOutput.setCursorVisible(false)],
    ['setColorSchemeNotifications(true)', piOutput.setColorSchemeNotifications(true)],
    ['setColorSchemeNotifications(false)', piOutput.setColorSchemeNotifications(false)],
    ['eraseDisplay', piOutput.eraseDisplay()],
    ['eraseScrollback', piOutput.eraseScrollback()],
    ['eraseLine', piOutput.eraseLine()],
    ['cursorUp(3)', piOutput.cursorUp(3)],
    ['cursorDown(2)', piOutput.cursorDown(2)],
    ['cursorColumn(9)', piOutput.cursorColumn(9)],
    ['cursorTo(4, 7)', piOutput.cursorTo(4, 7)],
    ['carriageReturn', piOutput.carriageReturn()],
    ['newline', piOutput.newline()],
    ['sgrReset', piOutput.sgrReset()],
    ['segmentReset', piOutput.segmentReset()],
    ['queryCellSize', piOutput.queryCellSize()],
    ['queryBackgroundColor', piOutput.queryBackgroundColor()],
    ['queryColorScheme', piOutput.queryColorScheme()],
    ['osc52Clipboard', piOutput.osc52Clipboard(Buffer.from('clip text').toString('base64'))],
  ]
  for (const [name, bytes] of cases) {
    // Each builder output must be accepted by the strict parser on its own.
    const parsed = parsePiTerminalString(bytes)
    assert.ok(parsed.ok, `${name} must parse: ${JSON.stringify(parsed)}`)
    assert.equal(parsed.remainder, '', `${name} must not leave a remainder`)
    adapter.write(bytes)
  }
  await tick()
  const expected = cases.map(([, bytes]) => bytes).join('')
  assert.equal(rig.stream.text, expected)
  assert.equal(rig.errors.length, 0)
  assert.equal(rig.stack.adapter.diagnostics().rejectedWrites, 0)
})

test('terminal pi adapter: CUP default params normalize to explicit 1;1', async () => {
  const rig = buildRig()
  rig.stack.adapter.write(piOutput.cursorHome())
  rig.stack.adapter.write(piOutput.clearScreenHomeScrollback())
  await tick()
  assert.equal(rig.stream.text, '\x1b[1;1H' + '\x1b[2J\x1b[1;1H\x1b[3J')
  assert.equal(rig.errors.length, 0)
})

test('terminal pi adapter: data-plane text/SGR/OSC 8 round-trip through write()', async () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter
  adapter.write('plain')
  adapter.write('\x1b[1;31mred\x1b[0m')
  adapter.write('\x1b]8;;https://example.com\x07link\x1b]8;;\x07')
  adapter.write('a\r\nb\rc\n')
  await tick()
  assert.equal(
    rig.stream.text,
    'plain' + '\x1b[1;31mred\x1b[0m' + '\x1b]8;;https://example.com\x07link\x1b]8;;\x07' + 'a\r\nb\rc\n',
  )
  assert.equal(rig.errors.length, 0)
})

test('terminal pi adapter: kitty and iTerm2 image markers pass the compat boundary', async () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter
  const payload = Buffer.from('fake-png-bytes').toString('base64')
  const kitty = `\x1b_Ga=T,f=100,s=1,v=1;${payload}\x1b\\`
  adapter.write(kitty)
  // Payload-free delete (a=d) keeps the separator-less pi marker form.
  adapter.write('\x1b_Ga=d,d=i,i=7\x1b\\')
  // iTerm2: size is recomputed as the decoded byte count; parameter order
  // normalizes to the pinned encodeITerm2 form (inline,size,width).
  adapter.write(`\x1b]1337;File=inline=1;width=3:${payload}\x07`)
  await tick()
  assert.equal(
    rig.stream.text,
    kitty +
      '\x1b_Ga=d,d=i,i=7\x1b\\' +
      `\x1b]1337;File=inline=1;size=${Buffer.byteLength(payload, 'base64')};width=3:${payload}\x07`,
  )
  assert.equal(rig.errors.length, 0)
})

// ---------------------------------------------------------------------------
// write(string): rejection + partial reassembly + payload cap
// ---------------------------------------------------------------------------

test('terminal pi adapter: unknown sequences are rejected atomically with zero bytes out', async () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter

  const rejections: string[] = [
    '\x1b]999;nope\x07', // unregistered OSC
    '\x1b[?9999h', // DEC mode outside the allowlist
    '\x1b_pi:c\x1b\\', // unregistered APC (the pi cursor marker)
    '\x1b[Z', // unknown CSI final
    '\x07', // stray BEL outside OSC
  ]
  for (const bad of rejections) {
    const before = rig.stream.text.length
    adapter.write(bad)
    await tick()
    assert.equal(rig.stream.text.length, before, `no bytes may leave for ${JSON.stringify(bad)}`)
  }
  assert.equal(rig.errors.length, rejections.length)
  for (const error of rig.errors) assert.equal(error.code, 'unsupported-pi-sequence')

  // Atomicity: a valid prefix in the SAME write must not leak either.
  const before = rig.stream.text.length
  adapter.write('valid-prefix\x1b[?9999h')
  await tick()
  assert.equal(rig.stream.text.length, before)

  // The adapter recovers: later valid writes flow normally.
  adapter.write('after')
  await tick()
  assert.ok(rig.stream.text.endsWith('after'))
  assert.equal(adapter.diagnostics().rejectedWrites, rejections.length + 1)
})

test('terminal pi adapter: chunk-split sequences reassemble via the buffered remainder', async () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter

  // Split inside a CSI: nothing is emitted until the final byte arrives.
  adapter.write('\x1b[3')
  await tick()
  assert.equal(rig.stream.text, '')
  adapter.write('1mred\x1b[0m')
  await tick()
  assert.equal(rig.stream.text, '\x1b[31mred\x1b[0m')

  // Plain text is never buffered — it flushes immediately.
  adapter.write('hel')
  adapter.write('lo')
  await tick()
  assert.ok(rig.stream.text.endsWith('\x1b[31mred\x1b[0mhello'))

  // Split inside an OSC 52: the partial sequence is held in the remainder
  // (no bytes) until the terminator arrives.
  const payload = Buffer.from('clip').toString('base64')
  adapter.write(`\x1b]52;c;${payload.slice(0, 2)}`)
  await tick()
  assert.ok(rig.stream.text.endsWith('\x1b[31mred\x1b[0mhello'), 'partial OSC must not emit bytes')
  adapter.write(`${payload.slice(2)}\x07`)
  await tick()
  assert.ok(rig.stream.text.endsWith(`\x1b[31mred\x1b[0mhello\x1b]52;c;${payload}\x07`))
  assert.equal(rig.errors.length, 0)
  assert.equal(adapter.diagnostics().remainderLength, 0)
})

test('terminal pi adapter: payload over 8 MiB is rejected and the buffered tail is cleared', async () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter
  adapter.write('a'.repeat(8 * 1024 * 1024 + 1))
  await tick()
  assert.equal(rig.stream.text, '')
  assert.equal(rig.errors.length, 1)
  assert.equal(rig.errors[0]?.code, 'unsupported-pi-sequence')
  assert.equal(adapter.diagnostics().remainderLength, 0)
  adapter.write('b')
  await tick()
  assert.equal(rig.stream.text, 'b')
})

// ---------------------------------------------------------------------------
// method matrix: sync methods enqueue the pinned typed operations
// ---------------------------------------------------------------------------

test('terminal pi adapter: method matrix maps to the pinned byte forms', async () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter

  adapter.hideCursor()
  adapter.showCursor()
  adapter.moveBy(-2)
  adapter.moveBy(3)
  adapter.moveBy(0) // no-op: nothing enqueued
  adapter.clearLine()
  adapter.clearFromCursor()
  adapter.clearScreen()
  adapter.setTitle('hello title')
  adapter.setProgress(true)
  adapter.setProgress(false)
  await tick()

  assert.equal(
    rig.stream.text,
    '\x1b[?25l' + // hideCursor
      '\x1b[?25h' + // showCursor
      '\x1b[2A' + // moveBy(-2)
      '\x1b[3B' + // moveBy(3)
      '\x1b[2K' + // clearLine (lifecycle clear line = EL 2)
      '\x1b[0J' + // clearFromCursor (ED 0)
      '\x1b[2J\x1b[1;1H' + // clearScreen (ED 2 + CUP home, normalized)
      '\x1b]2;hello title\x07' + // setTitle (OSC 2 — deviation from pi's OSC 0)
      '\x1b]9;4;1\x07' + // setProgress(true) → normal (deviation from pi's 9;4;3)
      '\x1b]9;4;0\x07', // setProgress(false) → none
  )
  assert.equal(rig.errors.length, 0)

  assert.equal(adapter.columns, 80)
  assert.equal(adapter.rows, 24)
  assert.equal(adapter.kittyProtocolActive, false) // no takeover yet
})

test('terminal pi adapter: invalid sync-method arguments throw before enqueueing', () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter
  assert.throws(() => adapter.moveBy(1.5), RangeError)
  assert.throws(() => adapter.setTitle(42 as unknown as string), TypeError)
  assert.throws(() => adapter.write(null as unknown as string), TypeError)
})

// ---------------------------------------------------------------------------
// start/stop lifecycle wiring
// ---------------------------------------------------------------------------

test('terminal pi adapter: start runs the takeover; stop+awaitStop run the §5.7 barrier', async () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter

  const inputs: string[] = []
  adapter.start((data) => inputs.push(data), () => undefined)
  const started = await adapter.whenStarted()
  assert.deepEqual(started, { status: 'active' })
  // Takeover bytes landed (no alt screen with startOptions, kitty push yes).
  assert.equal(rig.stream.text, '\x1b[?2004h' + '\x1b[?1002h\x1b[?1006h' + '\x1b[?1004h' + '\x1b[>1u' + '\x1b[?2026h' + '\x1b[?25l')
  assert.equal(adapter.kittyProtocolActive, true)
  assert.deepEqual(rig.stdin.rawModes, [true])

  // Input events dispatch as pi wire strings.
  rig.stdin.write('x')
  await tick()
  assert.deepEqual(inputs, ['x'])

  // drainInput resolves on the injected clock.
  const drain = adapter.drainInput(1000, 50)
  await tick(2)
  rig.clock.advance(100)
  await tick(2)
  await drain

  adapter.stop()
  await settleStop(rig.clock, adapter.awaitStop())
  // awaitStop is the same settled barrier on repeat calls.
  await adapter.awaitStop()
  assert.equal(rig.stdin.listenerCount('data'), 0)
  assert.equal(rig.stack.lifecycle.lifecycleState(), 'stopped')

  // Post-stop writes are dropped by the writer and counted, never written.
  const before = rig.stream.text.length
  adapter.write('late')
  adapter.hideCursor()
  await tick()
  assert.equal(rig.stream.text.length, before)
  assert.ok(adapter.diagnostics().stoppedResults >= 2)
})

test('terminal pi adapter: dispatchInputEvent translates key/paste/mouse/focus/resize', async () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter
  const inputs: string[] = []
  let resizes = 0

  // Before start() there is no consumer: events drop + count.
  adapter.dispatchInputEvent({ kind: 'key', sequence: 0, generation: 0, payload: { key: 'a', raw: 'a', text: 'a', eventType: 'press' } })
  assert.equal(adapter.diagnostics().undeliveredInputEvents, 1)

  adapter.start((data) => inputs.push(data), () => (resizes += 1))
  adapter.dispatchInputEvent({ kind: 'key', sequence: 1, generation: 0, payload: { key: 'a', raw: 'a', text: 'a', eventType: 'press' } })
  adapter.dispatchInputEvent({ kind: 'paste', sequence: 2, generation: 0, payload: { text: 'pasted' } })
  adapter.dispatchInputEvent({
    kind: 'mouse',
    sequence: 3,
    generation: 0,
    payload: {
      protocol: 'sgr-1006',
      action: 'press',
      button: 'left',
      x: 2,
      y: 3,
      modifiers: { shift: false, alt: false, ctrl: false },
      wheel: null,
    },
  })
  adapter.dispatchInputEvent({
    kind: 'mouse',
    sequence: 4,
    generation: 0,
    payload: {
      protocol: 'sgr-1006',
      action: 'release',
      button: 'left',
      x: 2,
      y: 3,
      modifiers: { shift: false, alt: false, ctrl: false },
      wheel: null,
    },
  })
  adapter.dispatchInputEvent({ kind: 'focus', sequence: 5, generation: 0, payload: { focused: true } })
  adapter.dispatchInputEvent({ kind: 'focus', sequence: 6, generation: 0, payload: { focused: false } })
  adapter.dispatchInputEvent({ kind: 'resize', sequence: 7, generation: 0, payload: { columns: 100, rows: 30 } })
  // signal/query-response events are consumed by the dsh layer, never by pi.
  adapter.dispatchInputEvent({ kind: 'signal', sequence: 8, generation: 0, payload: { signal: 'SIGINT' } })

  assert.deepEqual(inputs, [
    'a',
    '\x1b[200~pasted\x1b[201~',
    '\x1b[<0;3;4M',
    '\x1b[<0;3;4m',
    '\x1b[I',
    '\x1b[O',
  ])
  assert.equal(resizes, 1)

  await settleStop(rig.clock, adapter.awaitStop())
})

// ---------------------------------------------------------------------------
// backpressure / error fixtures
// ---------------------------------------------------------------------------

test('terminal pi adapter: stream write failure surfaces through onError and fails the writer', async () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter
  adapter.start(() => undefined, () => undefined)
  await adapter.whenStarted()

  rig.stream.failNextError = new Error('boom')
  adapter.hideCursor()
  await tick(6)
  assert.ok(rig.errors.some((error) => error.code === 'write-failed'), JSON.stringify(rig.errors))
  assert.ok(adapter.diagnostics().errorResults >= 1)
  assert.equal(rig.stack.writer.lifecycleState(), 'failed-after-takeover')

  // The stop barrier still settles against a failed writer.
  await settleStop(rig.clock, adapter.awaitStop())
})

test('terminal pi adapter: held-back write callback trips the writer op deadline (backpressure)', async () => {
  const rig = buildRig()
  const adapter = rig.stack.adapter
  adapter.start(() => undefined, () => undefined)
  await adapter.whenStarted()

  rig.stream.holdCallbacks = true
  adapter.showCursor()
  await tick(6)
  assert.equal(rig.errors.length, 0) // still waiting on the callback
  rig.clock.advance(600) // exceed the 500 ms writer op budget
  await tick(6)
  assert.ok(rig.errors.some((error) => error.code === 'write-timeout'), JSON.stringify(rig.errors))
  assert.ok(adapter.diagnostics().errorResults >= 1)

  rig.stream.holdCallbacks = false
  await settleStop(rig.clock, adapter.awaitStop())
})
