/**
 * tui-v2 WP-03b2 terminal input tests (plan §6.6): stdin owner + tokenizer.
 *
 * Top-level test names contain "terminal" so
 * `--test-name-pattern 'terminal'` selects this file.
 *
 * stdin is a PassThrough masquerading as a TTY (isTTY/setRawMode); all module
 * timers (drainInput) run on a ManualClock. The vendored StdinBuffer keeps its
 * own real-timer partial flushing — tests stay deterministic by completing
 * sequences or calling `input.flushPending()` instead of waiting for those.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'

import type { Clock } from '../../src/tui-v2/model/schema.js'
import {
  createInputSource,
  parseMouseSequence,
  type KeyPayload,
  type MousePayload,
  type PastePayload,
  type ResizePayload,
  type SignalPayload,
  type TerminalInputEvent,
} from '../../src/tui-v2/terminal/input.js'
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import {
  createQueryBroker,
  QueryError,
  type QueryRequest,
  type TerminalQueryBroker,
} from '../../src/tui-v2/terminal/query.js'
import { createTerminalWriter } from '../../src/tui-v2/terminal/writer.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'

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

/** PassThrough posing as a tty stdin: isTTY + setRawMode recorded. */
class FakeStdin extends PassThrough {
  readonly isTTY = true
  readonly rawModes: boolean[] = []
  setRawMode(raw: boolean): void {
    this.rawModes.push(raw)
  }
}

class FakeStream extends Writable {
  readonly chunks: string[] = []
  constructor() {
    super({ highWaterMark: 16 })
  }
  _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk))
    callback()
  }
  get text(): string {
    return this.chunks.join('')
  }
}

/** Flush nextTick + microtask queues without relying on real timers. */
async function tick(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

interface InputStack {
  stdin: FakeStdin
  clock: ManualClock
  events: TerminalInputEvent[]
  input: ReturnType<typeof createInputSource>
  broker: TerminalQueryBroker | undefined
}

function makeInput(overrides: { generation?: number; broker?: TerminalQueryBroker; profile?: TerminalProfile } = {}): InputStack {
  const stdin = new FakeStdin()
  const clock = new ManualClock()
  const events: TerminalInputEvent[] = []
  const broker = overrides.broker
  const input = createInputSource({
    stdin,
    generation: overrides.generation ?? 0,
    clock,
    profile: overrides.profile ?? getProfile('unicode-ambiguous-narrow'),
    queryBroker: broker,
    onEvent: (event) => events.push(event),
  })
  return { stdin, clock, events, input, broker }
}

function keysOf(events: readonly TerminalInputEvent[]): Array<string | null> {
  return events.filter((event) => event.kind === 'key').map((event) => (event.payload as KeyPayload).key)
}

const CURSOR_REQUEST: QueryRequest = { kind: 'cursor', generation: 0, timeoutMs: 150, retry: 0, expected: 'cursor-report' }

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

test('terminal input: plain characters, Enter, arrows and Ctrl+C become key events with monotonic sequence', async () => {
  const { stdin, events, input } = makeInput()
  input.start()
  stdin.write('a')
  stdin.write('\r')
  stdin.write('\x1b[A\x1b[B\x1b[C\x1b[D')
  stdin.write('\x03')
  await tick()

  assert.deepEqual(keysOf(events), ['a', 'enter', 'up', 'down', 'right', 'left', 'ctrl+c'])
  const sequences = events.map((event) => event.sequence)
  assert.deepEqual(sequences, [0, 1, 2, 3, 4, 5, 6])
  assert.ok(events.every((event) => event.generation === 0))
  const first = events[0] as TerminalInputEvent
  assert.equal((first.payload as KeyPayload).text, 'a')
  assert.equal((first.payload as KeyPayload).eventType, 'press')
  assert.equal(input.diagnostics().keyEvents, 7)
})

test('terminal input: CSI-u (kitty) and modifyOtherKeys forms parse through vendored keys', async () => {
  const { stdin, events, input } = makeInput()
  input.start()
  stdin.write('\x1b[97;5u') // CSI-u ctrl+a
  stdin.write('\x1b[27;5;99~') // modifyOtherKeys ctrl+c
  stdin.write('\x1b[97u') // kitty printable 'a'
  stdin.write('\x1b[1;5A') // CSI-u style ctrl+up
  await tick()

  assert.deepEqual(keysOf(events), ['ctrl+a', 'ctrl+c', 'a', 'ctrl+up'])
  const printable = events[2] as TerminalInputEvent
  assert.equal((printable.payload as KeyPayload).text, 'a')
})

test('terminal input: unrecognized sequence still surfaces as a key event with raw payload', async () => {
  const { stdin, events, input } = makeInput()
  input.start()
  stdin.write('\x1b[999~') // not a known key
  await tick()
  assert.equal(events.length, 1)
  const payload = events[0]?.payload as KeyPayload
  assert.equal(payload.key, null)
  assert.equal(payload.raw, '\x1b[999~')
  assert.equal(payload.text, null)
})

// ---------------------------------------------------------------------------
// bracketed paste
// ---------------------------------------------------------------------------

test('terminal input: bracketed paste reassembled across 3 chunks; ESC inside content does not truncate', async () => {
  const { stdin, events, input } = makeInput()
  input.start()
  stdin.write('\x1b[200~hello \x1b[31m fake')
  stdin.write(' middle \x1b[200~ nested-start')
  await tick()
  assert.equal(events.length, 0) // no end marker yet: nothing emitted
  stdin.write(' end!\x1b[201~Z')
  await tick()

  assert.equal(events.length, 2)
  const paste = events[0] as TerminalInputEvent
  assert.equal(paste.kind, 'paste')
  assert.equal((paste.payload as PastePayload).text, 'hello \x1b[31m fake middle \x1b[200~ nested-start end!')
  const tail = events[1] as TerminalInputEvent
  assert.equal(tail.kind, 'key')
  assert.equal((tail.payload as KeyPayload).key, 'Z')
  assert.equal(input.diagnostics().pasteEvents, 1)
})

// ---------------------------------------------------------------------------
// mouse
// ---------------------------------------------------------------------------

test('terminal input: SGR 1006 mouse press/move/release/wheel with modifiers', async () => {
  const { stdin, events, input } = makeInput()
  input.start()
  stdin.write('\x1b[<0;10;5M') // left press at col 10 row 5
  stdin.write('\x1b[<32;11;5M') // drag with left held
  stdin.write('\x1b[<0;11;5m') // release
  stdin.write('\x1b[<64;3;2M') // wheel up
  stdin.write('\x1b[<4;1;1M') // shift+left press
  await tick()

  assert.equal(events.length, 5)
  const [press, move, release, wheel, shifted] = events.map((event) => event.payload as MousePayload)
  assert.deepEqual(press, {
    protocol: 'sgr-1006',
    action: 'press',
    button: 'left',
    x: 9,
    y: 4,
    modifiers: { shift: false, alt: false, ctrl: false },
    wheel: null,
  })
  assert.deepEqual(move, { ...press, action: 'move', x: 10 })
  assert.deepEqual(release, { ...press, action: 'release', x: 10 })
  assert.deepEqual(wheel, {
    protocol: 'sgr-1006',
    action: 'wheel',
    button: 'none',
    x: 2,
    y: 1,
    modifiers: { shift: false, alt: false, ctrl: false },
    wheel: 'up',
  })
  assert.equal(shifted.modifiers.shift, true)
  assert.equal(input.diagnostics().mouseEvents, 5)
})

test('terminal input: urxvt 1015 and X10 mouse decoding', async () => {
  const { stdin, events, input } = makeInput()
  input.start()
  stdin.write('\x1b[32;10;5M') // urxvt left press (32 = code 0)
  stdin.write('\x1b[35;10;5M') // urxvt release (35 = code 3)
  stdin.write(`\x1b[M${String.fromCharCode(32 + 0, 33 + 9, 33 + 4)}`) // X10 left press (9,4)
  await tick()

  assert.equal(events.length, 3)
  const [press, release, x10] = events.map((event) => event.payload as MousePayload)
  assert.deepEqual(press, {
    protocol: 'urxvt-1015',
    action: 'press',
    button: 'left',
    x: 9,
    y: 4,
    modifiers: { shift: false, alt: false, ctrl: false },
    wheel: null,
  })
  assert.equal(release.action, 'release')
  assert.equal(release.protocol, 'urxvt-1015')
  assert.deepEqual(x10, { ...press, protocol: 'x10' })
})

// ---------------------------------------------------------------------------
// focus
// ---------------------------------------------------------------------------

test('terminal input: focus in/out (CSI I / CSI O)', async () => {
  const { stdin, events, input } = makeInput()
  input.start()
  stdin.write('\x1b[I\x1b[O')
  await tick()
  assert.equal(events.length, 2)
  assert.deepEqual(events.map((event) => event.kind), ['focus', 'focus'])
  assert.deepEqual(events.map((event) => (event.payload as { focused: boolean }).focused), [true, false])
})

// ---------------------------------------------------------------------------
// generation / sequence / ring
// ---------------------------------------------------------------------------

test('terminal input: generation bump drops buffered partial bytes and restamps events', async () => {
  const { stdin, events, input } = makeInput()
  input.start()
  stdin.write('\x1b[') // partial CSI, buffered
  await tick()
  assert.equal(events.length, 0)

  input.setGeneration(1)
  assert.equal(input.diagnostics().droppedGenerationMismatch, 1)

  stdin.write('A') // must NOT combine with the dropped partial into 'up'
  await tick()
  assert.equal(events.length, 1)
  const payload = events[0]?.payload as KeyPayload
  assert.notEqual(payload.key, 'up')
  assert.equal(events[0]?.generation, 1)
  assert.throws(() => input.setGeneration(1), RangeError) // must increase
})

test('terminal input: diagnostic ring is a bounded tail of raw bytes', async () => {
  const { stdin, input } = makeInput()
  input.start()
  stdin.write('x'.repeat(5000))
  await tick()
  const ring = input.diagnosticRing()
  assert.equal(ring.length, 4096)
  assert.equal(ring, 'x'.repeat(4096))
  assert.equal(input.diagnostics().bytesReceived, 5000)
  assert.equal(input.diagnostics().ringCapacity, 4096)
})

// ---------------------------------------------------------------------------
// query-response routing
// ---------------------------------------------------------------------------

test('terminal input: query response routed to broker through writer queryTokenSink wiring', async () => {
  const clock = new ManualClock()
  const broker = createQueryBroker({ clock })
  const stdin = new FakeStdin()
  const events: TerminalInputEvent[] = []
  const input = createInputSource({
    stdin,
    generation: 0,
    clock,
    profile: getProfile('unicode-ambiguous-narrow'),
    queryBroker: broker,
    onEvent: (event) => events.push(event),
  })
  const stream = new FakeStream()
  // The designated wiring (§5.6): writer's queryTokenSink feeds the stdin owner.
  const writer = createTerminalWriter({
    stream,
    clock,
    profile: getProfile('unicode-ambiguous-narrow'),
    queryBroker: broker,
    queryTokenSink: (token) => input.registerQueryToken(token),
  })
  input.start()

  const responsePromise = writer.query(CURSOR_REQUEST)
  await tick() // query bytes flushed
  assert.equal(stream.text, '\x1b[6n')

  stdin.write('\x1b[12;40R')
  await tick()
  const response = await responsePromise
  assert.deepEqual(response.value, { row: 12, column: 40 })
  assert.equal(response.kind, 'cursor')
  assert.equal(broker.diagnostics().responses, 1)
  assert.equal(input.diagnostics().routedQueryResponses, 1)
  // Routed responses never reach the app event stream.
  assert.equal(events.length, 0)
})

test('terminal input: forged/stale query responses are dropped and counted', async () => {
  const clock = new ManualClock()
  const broker = createQueryBroker({ clock })
  const { stdin, events, input } = makeInput({ broker })
  input.start()

  // No active token at all (forged responses of three grammar shapes).
  stdin.write('\x1b[8;24;80t')
  stdin.write('\x1bP>|fake(1.0)\x1b\\')
  stdin.write('\x1b]11;rgb:0000/0000/0000\x07')
  await tick()
  assert.equal(input.diagnostics().unclaimedQueryResponses, 3)
  assert.equal(events.length, 0)

  // Stale generation: the token belongs to generation 0, input moved to 1.
  const { token, response } = broker.begin(CURSOR_REQUEST)
  input.registerQueryToken(token)
  const outcome = response.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  input.setGeneration(1)
  stdin.write('\x1b[12;40R')
  await tick()
  assert.equal(input.diagnostics().unclaimedQueryResponses, 4)
  assert.equal(broker.diagnostics().responses, 0)
  assert.equal(events.length, 0)

  // The waiter still settles via its own deadline (150 ms attempt, retry 0).
  clock.advance(150)
  const settled = await outcome
  assert.equal(settled.ok, false)
  assert.ok(!settled.ok && settled.error instanceof QueryError)
  assert.ok(!settled.ok && settled.error.code === 'query-timeout')
})

// ---------------------------------------------------------------------------
// partial sequences / StdinBuffer boundaries
// ---------------------------------------------------------------------------

test('terminal input: partial CSI split across chunks completes without timeout', async () => {
  const { stdin, events, input } = makeInput()
  input.start()
  stdin.write('\x1b[1;')
  await tick()
  assert.equal(events.length, 0)
  stdin.write('5A')
  await tick()
  assert.equal(events.length, 1)
  assert.equal((events[0]?.payload as KeyPayload).key, 'ctrl+up')
})

test('terminal input: flushPending emits lone ESC as escape and partial CSI as raw key', async () => {
  const { stdin, events, input } = makeInput()
  input.start()
  stdin.write('\x1b')
  await tick()
  assert.equal(events.length, 0)
  input.flushPending()
  assert.equal(keysOf(events)[0], 'escape')

  stdin.write('\x1b[1;')
  await tick()
  input.flushPending()
  const payload = events[1]?.payload as KeyPayload
  assert.equal(payload.key, null)
  assert.equal(payload.raw, '\x1b[1;')
})

// ---------------------------------------------------------------------------
// stop / drain
// ---------------------------------------------------------------------------

test('terminal input: stop() detaches and drops; drainInput waits for silence on the clock', async () => {
  const { stdin, clock, events, input } = makeInput()
  input.start()

  // drainInput during activity: bytes are consumed and discarded, not events.
  let drained = false
  const drain = input.drainInput(1000, 50).then(() => {
    drained = true
  })
  clock.advance(20)
  stdin.write('q')
  await tick()
  assert.equal(events.length, 0) // discarded by the drain, not tokenized
  clock.advance(40)
  await tick()
  assert.equal(drained, false) // idle window restarted by the 'q' byte
  clock.advance(20) // t=80, last byte at t=20 + idle 50 -> resolved
  await drain
  assert.equal(drained, true)
  assert.ok(input.diagnosticRing().endsWith('q'))

  // maxMs cap path on a fresh drain.
  let capped = false
  const cap = input.drainInput(30, 10000).then(() => {
    capped = true
  })
  clock.advance(30)
  await cap
  assert.equal(capped, true)

  input.stop()
  assert.equal(stdin.listenerCount('data'), 0)
  stdin.write('x')
  await tick()
  assert.equal(events.length, 0) // nothing emitted after stop
  assert.equal(input.diagnostics().keyEvents, 0)
})

// ---------------------------------------------------------------------------
// injected signal/resize events
// ---------------------------------------------------------------------------

test('terminal input: emitSignal/emitResize share the owner sequence space and respect stop', async () => {
  const { stdin, events, input } = makeInput()
  input.start()
  stdin.write('a')
  input.emitResize(131, 43)
  input.emitSignal('SIGINT')
  await tick()

  assert.equal(events.length, 3)
  assert.deepEqual(events.map((event) => event.kind), ['key', 'resize', 'signal'])
  assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2])
  assert.deepEqual(events[1]?.payload as ResizePayload, { columns: 131, rows: 43 })
  assert.deepEqual(events[2]?.payload as SignalPayload, { signal: 'SIGINT' })
  assert.throws(() => input.emitResize(0, 24), RangeError)

  input.stop()
  input.emitSignal('SIGTERM')
  assert.equal(events.length, 3)
  assert.ok(input.diagnostics().droppedAfterStop >= 1)
})
