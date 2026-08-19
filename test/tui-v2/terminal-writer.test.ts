/**
 * tui-v2 WP-03b terminal kernel tests: ansi builders, TerminalWriter and
 * QueryBroker (plan §5.5/§5.6/§5.7).
 *
 * Top-level test names contain "terminal" so
 * `--test-name-pattern 'pi fork|terminal|overlay'` selects this file.
 *
 * All timing is driven by a manual Clock; no module under test touches a real
 * timer. The fake Writable controls callback timing, error injection and the
 * high-water mark, and its full output is fed to the VirtualTerminal oracle
 * for the end-to-end case.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'

import type { Clock } from '../../src/tui-v2/model/schema.js'
import type { FrameResources, PatchOperation, StyleDescriptor, TerminalCell, TerminalPatch } from '../../src/tui-v2/renderer/frame.js'
import * as ansi from '../../src/tui-v2/terminal/ansi.js'
import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js'
import {
  createQueryBroker,
  parseQueryResponse,
  QueryError,
  type QueryRequest,
  type QueryToken,
  type TerminalInputEvent,
  type TerminalQueryBroker,
} from '../../src/tui-v2/terminal/query.js'
import {
  createTerminalWriter,
  encodePatchOperations,
  WRITER_MAX_BATCH_BYTES,
  type TerminalControlOperation,
  type WriteResult,
} from '../../src/tui-v2/terminal/writer.js'
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
  pendingTimers(): number {
    return this.timers.length
  }
}

class FakeStream extends Writable {
  readonly chunks: string[] = []
  holdCallbacks = false
  failNextError: Error | null = null
  private held: Array<() => void> = []

  constructor() {
    // Tiny high-water mark: buffered writes report backpressure.
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
    if (this.holdCallbacks) this.held.push(() => callback())
    else callback()
  }

  releaseHeld(count = Number.POSITIVE_INFINITY): void {
    const releasing = this.held.splice(0, count)
    for (const cb of releasing) cb()
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
// shared builders
// ---------------------------------------------------------------------------

const DEFAULT_STYLE: StyleDescriptor = {
  id: 0,
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
}

function style(partial: Partial<StyleDescriptor> & { id: number }): StyleDescriptor {
  return { ...DEFAULT_STYLE, ...partial }
}

function cell(grapheme: string, styleId: number, width: 0 | 1 | 2 = 1, hyperlinkId?: number): TerminalCell {
  return hyperlinkId === undefined ? { grapheme, width, styleId } : { grapheme, width, styleId, hyperlinkId }
}

function resourcesOp(styles: readonly StyleDescriptor[], hyperlinks: FrameResources['hyperlinks'] = []): PatchOperation {
  return { kind: 'resources', resources: { styles, hyperlinks } }
}

interface PatchSpec {
  readonly frameId?: string
  readonly stateRevision?: number
  readonly patchSeq?: number
  readonly generation?: number
  readonly fullRedraw?: boolean
}

async function makePatch(operations: readonly PatchOperation[], spec: PatchSpec = {}): Promise<TerminalPatch> {
  const { bytes } = await encodePatchOperations(operations)
  return {
    frameId: spec.frameId ?? 'frame',
    stateRevision: spec.stateRevision ?? 1,
    patchSeq: spec.patchSeq ?? 1,
    generation: spec.generation ?? 0,
    operations,
    bytes,
    fullRedraw: spec.fullRedraw ?? false,
  }
}

function makeWriter(stream: FakeStream, clock: ManualClock, extra: { broker?: TerminalQueryBroker; tokens?: QueryToken[] } = {}) {
  return createTerminalWriter({
    stream,
    clock,
    profile: unknownConservativeDefaults(),
    queryBroker: extra.broker,
    queryTokenSink:
      extra.tokens === undefined
        ? undefined
        : (token) => {
            extra.tokens?.push(token)
          },
  })
}

function queryResponseEvent(token: QueryToken, raw: string, generation = 0): TerminalInputEvent {
  return {
    kind: 'query-response',
    sequence: 1,
    generation,
    payload: null,
    query: { tokenId: token.id, kind: token.kind, value: raw },
  }
}

const CURSOR_REQUEST: QueryRequest = { kind: 'cursor', generation: 0, timeoutMs: 150, retry: 0, expected: 'cursor-report' }

// ---------------------------------------------------------------------------
// ansi builders
// ---------------------------------------------------------------------------

test('terminal ansi: SGR styles from StyleDescriptor (named/256/truecolor/attrs/reset)', () => {
  assert.equal(ansi.sgrStyle(style({ id: 1, bold: true, foreground: 'red' })), '\x1b[0;1;31m')
  assert.equal(ansi.sgrStyle(style({ id: 1, foreground: 'bright-blue' })), '\x1b[0;94m')
  assert.equal(ansi.sgrStyle(style({ id: 1, foreground: 'ansi16:9' })), '\x1b[0;91m')
  assert.equal(ansi.sgrStyle(style({ id: 1, foreground: 'ansi256:200' })), '\x1b[0;38;5;200m')
  assert.equal(ansi.sgrStyle(style({ id: 1, background: '#010203' })), '\x1b[0;48;2;1;2;3m')
  assert.equal(ansi.sgrStyle(style({ id: 1, background: 'rgb:0a0b0c' })), '\x1b[0;48;2;10;11;12m')
  assert.equal(
    ansi.sgrStyle(style({ id: 1, dim: true, italic: true, underline: true, inverse: true, strike: true })),
    '\x1b[0;2;3;4;7;9m',
  )
  assert.equal(ansi.sgrStyle(style({ id: 1, foreground: 'default' })), '\x1b[0;39m')
  assert.equal(ansi.sgrStyle(DEFAULT_STYLE), '\x1b[0m')
  assert.equal(ansi.sgrReset(), '\x1b[0m')
  assert.throws(() => ansi.sgrStyle(style({ id: 1, foreground: 'chartreuse' })), TypeError)
  assert.throws(() => ansi.sgrStyle(style({ id: 1, foreground: 'ansi256:300' })), RangeError)
})

test('terminal ansi: cursor movement/position/style with bounds', () => {
  assert.equal(ansi.cursorUp(3), '\x1b[3A')
  assert.equal(ansi.cursorDown(2), '\x1b[2B')
  assert.equal(ansi.cursorForward(10), '\x1b[10C')
  assert.equal(ansi.cursorBack(1), '\x1b[1D')
  // n=0 is a defined no-op (CSI 0 A would move by one in real terminals).
  assert.equal(ansi.cursorUp(0), '')
  assert.equal(ansi.cursorTo(2, 5), '\x1b[2;5H')
  assert.equal(ansi.cursorShow(), '\x1b[?25h')
  assert.equal(ansi.cursorHide(), '\x1b[?25l')
  assert.equal(ansi.cursorStyleShape('block'), '\x1b[2 q')
  assert.equal(ansi.cursorStyleShape('underline'), '\x1b[4 q')
  assert.equal(ansi.cursorStyleShape('bar'), '\x1b[6 q')
  assert.throws(() => ansi.cursorUp(-1), RangeError)
  assert.throws(() => ansi.cursorForward(10000), RangeError)
  assert.throws(() => ansi.cursorTo(0, 1), RangeError)
  assert.throws(() => ansi.cursorUp(1.5), RangeError)
})

test('terminal ansi: erase, scroll region and SU/SD', () => {
  assert.equal(ansi.eraseInDisplay(0), '\x1b[0J')
  assert.equal(ansi.eraseInDisplay(1), '\x1b[1J')
  assert.equal(ansi.eraseInDisplay(2), '\x1b[2J')
  // ED 3 (erase scrollback) joined the allowlist in WP-03c: the pi fork's
  // clearScreenHomeScrollback/eraseScrollback forms emit `\x1b[3J`.
  assert.equal(ansi.eraseInDisplay(3), '\x1b[3J')
  assert.equal(ansi.eraseInLine(0), '\x1b[0K')
  assert.equal(ansi.eraseInLine(1), '\x1b[1K')
  assert.equal(ansi.eraseInLine(2), '\x1b[2K')
  assert.equal(ansi.eraseCharacters(4), '\x1b[4X')
  assert.throws(() => ansi.eraseInDisplay(4 as 0), RangeError)
  assert.throws(() => ansi.eraseInLine(9 as 0), RangeError)
  assert.equal(ansi.setScrollRegion(2, 9), '\x1b[2;9r')
  assert.equal(ansi.resetScrollRegion(), '\x1b[r')
  assert.equal(ansi.scrollUp(2), '\x1b[2S')
  assert.equal(ansi.scrollDown(3), '\x1b[3T')
  assert.throws(() => ansi.setScrollRegion(5, 5), RangeError)
  assert.throws(() => ansi.scrollUp(10000), RangeError)
})

test('terminal ansi: DECSET/DECRST allowlist and fixed sync-output forms', () => {
  assert.equal(ansi.decset(1049), '\x1b[?1049h')
  assert.equal(ansi.decrst(2004), '\x1b[?2004l')
  assert.equal(ansi.decset(7), '\x1b[?7h')
  assert.throws(() => ansi.decset(1337), RangeError)
  assert.throws(() => ansi.decrst(9001), RangeError)
  assert.throws(() => ansi.decset(5), RangeError)
  assert.equal(ansi.syncOutputBegin(), '\x1b[?2026h')
  assert.equal(ansi.syncOutputEnd(), '\x1b[?2026l')
})

test('terminal ansi: OSC 8 hyperlink validation (length/control chars/params)', () => {
  assert.equal(ansi.hyperlink('https://example.com'), '\x1b]8;;https://example.com\x07')
  assert.equal(ansi.hyperlink('https://example.com', 'id=x'), '\x1b]8;id=x;https://example.com\x07')
  assert.equal(ansi.hyperlinkClose(), '\x1b]8;;\x07')
  assert.throws(() => ansi.hyperlink(`https://example.com/${'a'.repeat(2083)}`), RangeError)
  assert.throws(() => ansi.hyperlink('https://example.com/\x1b]8;;evil'), /control/)
  assert.throws(() => ansi.hyperlink('https://example.com/\x07'), /control/)
  assert.throws(() => ansi.hyperlink('https://example.com', 'a;b'), /params/)
  assert.throws(() => ansi.hyperlink(''), TypeError)
})

test('terminal ansi: OSC 0/2 title sanitization and progress enum', () => {
  assert.equal(ansi.setTitle('demo'), '\x1b]2;demo\x07')
  assert.equal(ansi.setTitle('demo', 0), '\x1b]0;demo\x07')
  // C0/ESC/BEL are stripped, printable payload kept.
  assert.equal(ansi.setTitle('a\x1b]8;;x\x07b'), '\x1b]2;a]8;;xb\x07')
  assert.throws(() => ansi.setTitle('x'.repeat(257)), RangeError)
  assert.throws(() => ansi.setTitle('x', 1 as 0), RangeError)
  assert.equal(ansi.progress('none'), '\x1b]9;4;0\x07')
  assert.equal(ansi.progress('normal', 42), '\x1b]9;4;1;42\x07')
  assert.equal(ansi.progress('error', 100), '\x1b]9;4;2;100\x07')
  assert.equal(ansi.progress('paused'), '\x1b]9;4;4\x07')
  assert.throws(() => ansi.progress('normal', 101), RangeError)
  assert.throws(() => ansi.progress('normal', -1), RangeError)
})

test('terminal ansi: kitty keyboard push/set/pop bounds', () => {
  assert.equal(ansi.kittyKeyboardPush(1), '\x1b[>1u')
  assert.equal(ansi.kittyKeyboardPush(15), '\x1b[>15u')
  assert.equal(ansi.kittyKeyboardSet(3, 2), '\x1b[=3;2u')
  assert.equal(ansi.kittyKeyboardPop(2), '\x1b[<2u')
  assert.throws(() => ansi.kittyKeyboardPush(16), RangeError)
  assert.throws(() => ansi.kittyKeyboardPush(-1), RangeError)
  assert.throws(() => ansi.kittyKeyboardSet(1, 4 as 1), RangeError)
  assert.throws(() => ansi.kittyKeyboardPop(0), RangeError)
})

test('terminal ansi: kitty APC and iTerm2 image payload validation', () => {
  assert.equal(ansi.kittyImage({ a: 't', f: 100 }, 'aGk='), '\x1b_Ga=t,f=100;aGk=\x1b\\')
  assert.equal(ansi.iterm2Image({ width: 3, height: 2 }, 'aGk='), '\x1b]1337;File=inline=1;width=3;height=2:aGk=\x07')
  assert.throws(() => ansi.kittyImage({ a: 't' }, 'not base64!!'), /base64/)
  assert.throws(() => ansi.iterm2Image({}, 'bad\npayload'), /base64/)
  assert.throws(() => ansi.kittyImage({ 'bad key': 'x' }, 'aGk='), /key/)
  assert.throws(() => ansi.kittyImage({ a: 'x,y' }, 'aGk='), /value/)
  const oversized = `${'A'.repeat(8 * 1024 * 1024 + 4)}`
  assert.throws(() => ansi.kittyImage({ a: 't' }, oversized), RangeError)
  assert.throws(() => ansi.iterm2Image({}, oversized), RangeError)
})

test('terminal ansi: fixed query sequence forms', () => {
  assert.equal(ansi.queryCursorReport(), '\x1b[6n')
  assert.equal(ansi.queryXtVersion(), '\x1b[>0q')
  assert.equal(ansi.queryDeviceAttributes(), '\x1b[c')
  assert.equal(ansi.queryKittyKeyboard(), '\x1b[?u')
  assert.equal(ansi.queryCellSize(), '\x1b[16t')
  assert.equal(ansi.queryWindowSizePixels(), '\x1b[14t')
  assert.equal(ansi.queryTextAreaSize(), '\x1b[18t')
  assert.equal(ansi.queryBackgroundColor(), '\x1b]11;?\x07')
  assert.equal(ansi.queryFocusReportingMode(), '\x1b[?1004$p')
})

test('terminal ansi: encodeCells emits SGR/OSC8, skips continuations, validates ids', () => {
  const resources: FrameResources = {
    styles: [DEFAULT_STYLE, style({ id: 1, bold: true, foreground: 'red' })],
    hyperlinks: [{ id: 7, uri: 'https://example.com' }],
  }
  const encoded = ansi.encodeCells([cell('A', 1), cell('B', 1, 1, 7), cell('', 1, 0), cell('C', 0)], resources)
  assert.equal(encoded.sequence, '\x1b[0;1;31mA\x1b]8;;https://example.com\x07B\x1b]8;;\x07\x1b[0mC\x1b[0m')
  assert.equal(encoded.bytes, Buffer.byteLength(encoded.sequence, 'utf8'))
  assert.equal(encoded.skippedContinuations, 1)

  assert.throws(() => ansi.encodeCells([cell('X', 99)], resources), /styleId 99/)
  assert.throws(() => ansi.encodeCells([cell('X', 0, 1, 5)], resources), /hyperlinkId 5/)
  const dupes: FrameResources = { styles: [DEFAULT_STYLE, DEFAULT_STYLE], hyperlinks: [] }
  assert.throws(() => ansi.encodeCells([], dupes), /duplicate style id/)
})

// ---------------------------------------------------------------------------
// writer basics
// ---------------------------------------------------------------------------

test('terminal writer: ordered patch writes land in order', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops = (text: string): PatchOperation[] => [
    resourcesOp([DEFAULT_STYLE]),
    { kind: 'write-cells', x: 0, y: 0, cells: [...text].map((g) => cell(g, 0)) },
  ]
  const a = await writer.write(await makePatch(ops('AB'), { stateRevision: 1, patchSeq: 1 }))
  const b = await writer.write(await makePatch(ops('CD'), { stateRevision: 1, patchSeq: 2 }))
  assert.equal(a.status, 'written')
  assert.equal(b.status, 'written')
  if (a.status === 'written') assert.deepEqual([a.frameId, a.stateRevision, a.patchSeq], ['frame', 1, 1])
  assert.ok(stream.text.indexOf('AB') < stream.text.indexOf('CD'), stream.text)
})

test('terminal writer: stale patches (older generation / revision rollback / non-increasing seq) never touch the stream', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops: PatchOperation[] = [resourcesOp([DEFAULT_STYLE]), { kind: 'write-cells', x: 0, y: 0, cells: [cell('A', 0)] }]

  assert.equal((await writer.write(await makePatch(ops, { stateRevision: 2, patchSeq: 1 }))).status, 'written')
  // Same revision, equal patchSeq → non-increasing.
  assert.equal((await writer.write(await makePatch(ops, { stateRevision: 2, patchSeq: 1 }))).status, 'stale')
  // stateRevision rollback.
  assert.equal((await writer.write(await makePatch(ops, { stateRevision: 1, patchSeq: 99 }))).status, 'stale')
  // Newer generation is adopted; afterwards the older generation is stale.
  await writer.write(await makePatch(ops, { generation: 1, stateRevision: 1, patchSeq: 1 }))
  assert.equal((await writer.write(await makePatch(ops, { generation: 0, stateRevision: 9, patchSeq: 9 }))).status, 'stale')

  const occurrences = stream.text.split('A').length - 1
  assert.equal(occurrences, 2, `stream must only contain the two committed patches: ${JSON.stringify(stream.text)}`)
  assert.equal(writer.stats().stalePatches, 3)
})

test('terminal writer: bytes mismatch and invalid operations are WriterErrors, not writes', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops: PatchOperation[] = [resourcesOp([DEFAULT_STYLE]), { kind: 'write-cells', x: 0, y: 0, cells: [cell('A', 0)] }]
  const good = await makePatch(ops)
  const badBytes: TerminalPatch = { ...good, bytes: good.bytes + 1 }
  const r1 = await writer.write(badBytes)
  assert.equal(r1.status, 'error')
  if (r1.status === 'error') assert.equal(r1.error.code, 'patch-bytes-mismatch')

  const badOps: PatchOperation[] = [{ kind: 'write-cells', x: 0, y: 0, cells: [cell('A', 0)] }] // no resources first
  const badOpsPatch: TerminalPatch = { ...good, operations: badOps, patchSeq: 2, bytes: 0 }
  const r2 = await writer.write(badOpsPatch)
  assert.equal(r2.status, 'error')
  if (r2.status === 'error') assert.equal(r2.error.code, 'invalid-patch')
  assert.equal(stream.text, '')
})

test('terminal writer: watermark advances only after the whole batch settles', async () => {
  const stream = new FakeStream()
  stream.holdCallbacks = true
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops = (text: string, x: number): PatchOperation[] => [
    resourcesOp([DEFAULT_STYLE]),
    { kind: 'write-cells', x, y: 0, cells: [...text].map((g) => cell(g, 0)) },
  ]

  const pA = writer.write(await makePatch(ops('A', 0), { patchSeq: 1 }))
  await tick() // encode chain + first write started
  const pB = writer.write(await makePatch(ops('B', 1), { patchSeq: 2 }))
  const pC = writer.write(await makePatch(ops('C', 2), { patchSeq: 3 }))
  await tick()
  assert.equal(stream.chunks.length, 1, 'one write in flight, B and C queued')
  assert.equal(writer.stats().framesWritten, 0, 'nothing committed while the callback is held')

  stream.releaseHeld() // A settles
  assert.equal((await pA).status, 'written')
  await tick()
  assert.equal(stream.chunks.length, 2, 'B and C merged into one bounded buffer')
  assert.equal(writer.stats().framesWritten, 1, 'B/C still uncommitted while their batch is held')
  assert.ok(stream.chunks[1]?.includes('B') && stream.chunks[1]?.includes('C'))

  stream.releaseHeld() // the merged batch settles
  assert.equal((await pB).status, 'written')
  assert.equal((await pC).status, 'written')
  assert.equal(writer.stats().framesWritten, 3)
  // Watermark now at patchSeq 3: a replayed seq is stale.
  assert.equal((await writer.write(await makePatch(ops('D', 3), { patchSeq: 3 }))).status, 'stale')
})

test('terminal writer: stream callback error fails the batch and the writer', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops: PatchOperation[] = [resourcesOp([DEFAULT_STYLE]), { kind: 'write-cells', x: 0, y: 0, cells: [cell('A', 0)] }]

  assert.equal((await writer.write(await makePatch(ops, { patchSeq: 1 }))).status, 'written')
  assert.equal(writer.lifecycleState(), 'active')
  stream.failNextError = new Error('boom')
  const failed = await writer.write(await makePatch(ops, { patchSeq: 2 }))
  assert.equal(failed.status, 'error')
  if (failed.status === 'error') {
    assert.equal(failed.error.code, 'write-failed')
    assert.equal(failed.error.recoverable, false)
  }
  assert.equal(writer.lifecycleState(), 'failed-after-takeover')
  const after = await writer.write(await makePatch(ops, { patchSeq: 3 }))
  assert.equal(after.status, 'error')
  if (after.status === 'error') assert.equal(after.error.code, 'writer-failed')
  assert.equal(writer.stats().writesFailed, 1)
})

test('terminal writer: 500 ms op timeout (fake clock) fails and destroys the stream', async () => {
  const stream = new FakeStream()
  stream.holdCallbacks = true
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops: PatchOperation[] = [resourcesOp([DEFAULT_STYLE]), { kind: 'write-cells', x: 0, y: 0, cells: [cell('A', 0)] }]

  const pending = writer.write(await makePatch(ops))
  await tick()
  assert.equal(stream.chunks.length, 1)
  clock.advance(499)
  await tick()
  assert.equal(writer.lifecycleState(), 'starting', 'no timeout before 500 ms')
  clock.advance(1)
  const result = await pending
  assert.equal(result.status, 'error')
  if (result.status === 'error') assert.equal(result.error.code, 'write-timeout')
  assert.equal(writer.lifecycleState(), 'failed-before-takeover')
  assert.equal(stream.destroyed, true)
  const after = await writer.write(await makePatch(ops, { patchSeq: 2 }))
  assert.equal(after.status, 'error')
})

test('terminal writer: backpressure — no next write until callback + drain', async () => {
  const stream = new FakeStream()
  stream.holdCallbacks = true
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops = (text: string, x: number): PatchOperation[] => [
    resourcesOp([DEFAULT_STYLE]),
    { kind: 'write-cells', x, y: 0, cells: [...text].map((g) => cell(g, 0)) },
  ]

  const pA = writer.write(await makePatch(ops('AAAA', 0), { patchSeq: 1 }))
  await tick()
  const pB = writer.write(await makePatch(ops('BBBB', 4), { patchSeq: 2 }))
  await tick()
  assert.equal(stream.chunks.length, 1, 'second write must wait for the in-flight one')
  stream.holdCallbacks = false // B flushes automatically once it starts
  stream.releaseHeld()
  assert.equal((await pA).status, 'written')
  assert.equal((await pB).status, 'written')
  assert.equal(stream.chunks.length, 2)
  assert.ok(stream.chunks[0]?.includes('AAAA') && stream.chunks[1]?.includes('BBBB'))
})

test('terminal writer: pending-bytes cap rejects an oversize patch as stale', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const big = 'A'.repeat(8 * 1024 * 1024 + 1)
  const ops: PatchOperation[] = [
    resourcesOp([DEFAULT_STYLE]),
    { kind: 'write-cells', x: 0, y: 0, cells: [cell(big, 0)] },
  ]
  const result = await writer.write(await makePatch(ops))
  assert.equal(result.status, 'stale')
  assert.equal(writer.stats().droppedPatches, 1)
  assert.equal(stream.text, '')
})

test('terminal writer: writeControl lifecycle/sequence branches and untrusted rejection', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)

  const lifecycle = await writer.writeControl(
    { kind: 'lifecycle', operation: { kind: 'lifecycle', action: 'enter-alt', enabled: true } },
    0,
  )
  assert.equal(lifecycle.status, 'written')
  const title = await writer.writeControl({ kind: 'lifecycle', operation: { kind: 'title', value: 'demo' } }, 0)
  assert.equal(title.status, 'written')
  const clear = await writer.writeControl({ kind: 'lifecycle', operation: { kind: 'clear', scope: 'screen' } }, 0)
  assert.equal(clear.status, 'written')
  const move = await writer.writeControl({ kind: 'lifecycle', operation: { kind: 'cursor-move', delta: -3 } }, 0)
  assert.equal(move.status, 'written')
  assert.ok(stream.text.includes('\x1b[?1049h'))
  assert.ok(stream.text.includes('\x1b]2;demo\x07'))
  assert.ok(stream.text.includes('\x1b[2J'))
  assert.ok(stream.text.includes('\x1b[3A'))

  // A sequence built by ansi.ts passes the trust gate.
  const trusted = await writer.writeControl({ kind: 'sequence', sequence: ansi.sgrReset(), purpose: 'pi-compatible' }, 0)
  assert.equal(trusted.status, 'written')

  // A forged/raw string never passes, even with a cast (plan §5.6 gate).
  const forged = await writer.writeControl(
    { kind: 'sequence', sequence: '\x1b[31m' as ansi.ControlSequence, purpose: 'pi-compatible' },
    0,
  )
  assert.equal(forged.status, 'error')
  if (forged.status === 'error') assert.equal(forged.error.code, 'untrusted-sequence')
  // Concatenating two trusted sequences produces an unregistered string.
  const concat = await writer.writeControl(
    { kind: 'sequence', sequence: `${ansi.sgrReset()}${ansi.cursorUp(1)}` as ansi.ControlSequence, purpose: 'cleanup' },
    0,
  )
  assert.equal(concat.status, 'error')
  assert.equal(writer.stats().untrustedSequences, 2)
})

test('terminal writer: quiesce/resume barrier semantics', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops = (text: string): PatchOperation[] => [
    resourcesOp([DEFAULT_STYLE]),
    { kind: 'write-cells', x: 0, y: 0, cells: [...text].map((g) => cell(g, 0)) },
  ]
  await writer.write(await makePatch(ops('A'), { stateRevision: 1, patchSeq: 7 }))

  const barrier = await writer.quiesce()
  assert.deepEqual(barrier, { generation: 0, committedPatchSeq: 7 })
  // Quiesced: new patches and controls are stale.
  assert.equal((await writer.write(await makePatch(ops('B'), { stateRevision: 1, patchSeq: 8 }))).status, 'stale')
  assert.equal(
    (await writer.writeControl({ kind: 'lifecycle', operation: { kind: 'clear', scope: 'line' } }, 0)).status,
    'stale',
  )
  // Forged barrier (same fields, different object) and generation regression.
  assert.throws(() => writer.resume({ generation: 0, committedPatchSeq: 7 }, 0), TypeError)
  assert.throws(() => writer.resume(barrier, -1), RangeError)

  writer.resume(barrier, 0)
  assert.equal((await writer.write(await makePatch(ops('C'), { stateRevision: 1, patchSeq: 8 }))).status, 'written')

  // New generation via resume: watermark baselines reset.
  const barrier2 = await writer.quiesce()
  assert.deepEqual(barrier2, { generation: 0, committedPatchSeq: 8 })
  writer.resume(barrier2, 1)
  assert.equal((await writer.write(await makePatch(ops('D'), { generation: 1, stateRevision: 0, patchSeq: 0 }))).status, 'written')
})

test('terminal writer: invalidate resets the watermark baseline', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops: PatchOperation[] = [resourcesOp([DEFAULT_STYLE]), { kind: 'write-cells', x: 0, y: 0, cells: [cell('A', 0)] }]
  await writer.write(await makePatch(ops, { stateRevision: 5, patchSeq: 5 }))
  // Without invalidate this would be stale; after invalidate it commits.
  writer.invalidate()
  const result = await writer.write(await makePatch(ops, { stateRevision: 0, patchSeq: 0 }))
  assert.equal(result.status, 'written')
})

test('terminal writer: stop blocks new work, flushes cleanup, stays idempotent', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops: PatchOperation[] = [resourcesOp([DEFAULT_STYLE]), { kind: 'write-cells', x: 0, y: 0, cells: [cell('A', 0)] }]
  await writer.write(await makePatch(ops))

  const stopA = writer.stop()
  const stopB = writer.stop()
  assert.equal(stopA, stopB, 'stop is idempotent (same promise)')
  await stopA
  assert.equal(writer.lifecycleState(), 'stopped')
  assert.ok(stream.text.includes('\x1b[?25h'), 'cleanup shows the cursor')
  assert.ok(stream.text.includes('\x1b[?1049l'), 'cleanup exits the alt screen')
  assert.equal((await writer.write(await makePatch(ops, { patchSeq: 2 }))).status, 'stopped')
  assert.equal(
    (await writer.writeControl({ kind: 'lifecycle', operation: { kind: 'clear', scope: 'line' } }, 0)).status,
    'stopped',
  )
})

test('terminal writer: stop with preserveScreen keeps the alt screen', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  await writer.stop({ preserveScreen: true })
  assert.equal(stream.text.includes('\x1b[?1049l'), false)
  assert.ok(stream.text.includes('\x1b[?25h'))
  assert.equal(writer.lifecycleState(), 'stopped')
})

test('terminal writer: stop waits for the in-flight write, destroys on deadline', async () => {
  const stream = new FakeStream()
  stream.holdCallbacks = true
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops: PatchOperation[] = [resourcesOp([DEFAULT_STYLE]), { kind: 'write-cells', x: 0, y: 0, cells: [cell('A', 0)] }]
  const pending = writer.write(await makePatch(ops))
  await tick()
  const stopping = writer.stop()
  await tick()
  // The in-flight write's own 500 ms deadline settles it before stop proceeds.
  clock.advance(500)
  await pending
  await stopping
  assert.equal(stream.destroyed, true)
  assert.equal(writer.lifecycleState(), 'failed-before-takeover')
})

test('terminal writer: stats are a bounded counter set', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  const ops: PatchOperation[] = [resourcesOp([DEFAULT_STYLE]), { kind: 'write-cells', x: 0, y: 0, cells: [cell('A', 0)] }]
  await writer.write(await makePatch(ops))
  const stats = writer.stats()
  for (const [key, value] of Object.entries(stats)) {
    assert.equal(typeof value, 'number', `${key} must be a bounded number`)
    assert.ok(Number.isFinite(value), key)
  }
  assert.equal(stats.framesWritten, 1)
  assert.equal(stats.writesCompleted, 1)
  assert.ok(stats.bytesWritten > 0)
  assert.ok(stats.maxBatchBytes <= WRITER_MAX_BATCH_BYTES)
})

// ---------------------------------------------------------------------------
// query broker
// ---------------------------------------------------------------------------

test('terminal query: response grammars parse per kind and reject garbage', () => {
  assert.deepEqual(parseQueryResponse('cursor-report', '\x1b[12;5R'), { row: 12, column: 5 })
  assert.equal(parseQueryResponse('cursor-report', '\x1b[12R'), null)
  assert.deepEqual(parseQueryResponse('size-report', '\x1b[8;24;80t'), { rows: 24, columns: 80 })
  assert.deepEqual(parseQueryResponse('cell-size-report', '\x1b[6;18;9t'), { heightPixels: 18, widthPixels: 9 })
  assert.deepEqual(parseQueryResponse('version-report', '\x1bP>|kitty(0.36.0)\x1b\\'), { version: 'kitty(0.36.0)' })
  assert.equal(parseQueryResponse('version-report', '\x1b[12;5R'), null)
  assert.deepEqual(parseQueryResponse('capability-report', '\x1b[?1;2c'), { params: [1, 2] })
  assert.deepEqual(parseQueryResponse('color-report', '\x1b]11;rgb:0000/0000/ffff\x07'), { color: 'rgb:0000/0000/ffff' })
  assert.equal(parseQueryResponse('color-report', '\x1b]11;not-a-color\x07'), null)
  assert.deepEqual(parseQueryResponse('kitty-keyboard-report', '\x1b[?15u'), { flags: 15 })
  assert.deepEqual(parseQueryResponse('focus-report', '\x1b[?1004;1$y'), { mode: 1, enabled: true, recognized: true })
  assert.deepEqual(parseQueryResponse('focus-report', '\x1b[?1004;2$y'), { mode: 2, enabled: false, recognized: true })
  assert.equal(parseQueryResponse('focus-report', '\x1b[?1004;9$y'), null)
})

test('terminal query: request/response round trip through writer + broker', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const broker = createQueryBroker({ clock })
  const tokens: QueryToken[] = []
  const writer = makeWriter(stream, clock, { broker, tokens })

  const responsePromise = writer.query({ ...CURSOR_REQUEST, generation: 1 })
  await tick()
  assert.equal(tokens.length, 1, 'the token sink receives the registered token')
  assert.ok(stream.text.includes('\x1b[6n'), 'query bytes went through the writer queue')
  assert.equal(broker.isRegistered(tokens[0] as QueryToken), true)

  const accepted = broker.accept(tokens[0] as QueryToken, queryResponseEvent(tokens[0] as QueryToken, '\x1b[12;5R', 1))
  assert.equal(accepted, true)
  const response = await responsePromise
  assert.deepEqual(response.value, { row: 12, column: 5 })
  assert.equal(response.kind, 'cursor')
  assert.equal(response.generation, 1)
  assert.equal(broker.isRegistered(tokens[0] as QueryToken), false, 'settled tokens unregister')
  assert.equal(broker.diagnostics().responses, 1)
})

test('terminal query: forged token (copied fields) never registers', async () => {
  const clock = new ManualClock()
  const broker = createQueryBroker({ clock })
  const { token, response } = broker.begin(CURSOR_REQUEST)
  const cancelled = assert.rejects(response, (error: QueryError) => error.code === 'query-cancelled')
  assert.equal(broker.isRegistered(token), true)

  const forged = { id: token.id, generation: token.generation, kind: token.kind } as QueryToken
  assert.equal(broker.isRegistered(forged), false, 'field-copy objects fail the identity registry')
  assert.equal(broker.accept(forged, queryResponseEvent(forged, '\x1b[1;1R')), false)
  assert.equal(broker.diagnostics().lateOrUnknown, 1)
  broker.cancel(token)
  await cancelled
})

test('terminal query: late and duplicate responses are dropped and counted', async () => {
  const clock = new ManualClock()
  const broker = createQueryBroker({ clock })
  const { token, response } = broker.begin(CURSOR_REQUEST)

  clock.advance(150) // single attempt deadline (retry: 0)
  await assert.rejects(response, (error: QueryError) => error.code === 'query-timeout')
  assert.equal(broker.accept(token, queryResponseEvent(token, '\x1b[1;1R')), false, 'late response dropped')
  assert.equal(broker.diagnostics().lateOrUnknown, 1)
  assert.equal(broker.diagnostics().timeouts, 1)

  const second = broker.begin(CURSOR_REQUEST)
  assert.equal(broker.accept(second.token, queryResponseEvent(second.token, '\x1b[2;2R')), true)
  await second.response
  assert.equal(broker.accept(second.token, queryResponseEvent(second.token, '\x1b[2;2R')), false, 'duplicate dropped')
  assert.equal(broker.diagnostics().lateOrUnknown, 2)
})

test('terminal query: grammar/kind/generation mismatches drop but keep waiting', async () => {
  const clock = new ManualClock()
  const broker = createQueryBroker({ clock })
  const { token, response } = broker.begin(CURSOR_REQUEST)

  // Grammar mismatch (a size report for a cursor query).
  assert.equal(broker.accept(token, queryResponseEvent(token, '\x1b[8;24;80t')), false)
  // Generation mismatch.
  assert.equal(broker.accept(token, queryResponseEvent(token, '\x1b[1;1R', 9)), false)
  // Wrong kind in the query field.
  const wrongKind = queryResponseEvent(token, '\x1b[1;1R')
  assert.equal(broker.accept(token, { ...wrongKind, query: { tokenId: token.id, kind: 'size', value: '\x1b[1;1R' } }), false)
  assert.equal(broker.diagnostics().mismatches, 3)
  assert.equal(broker.isRegistered(token), true, 'mismatches never settle the waiter')

  assert.equal(broker.accept(token, queryResponseEvent(token, '\x1b[3;4R')), true)
  assert.deepEqual((await response).value, { row: 3, column: 4 })
})

test('terminal query: concurrent same-kind queries correlate by token identity', async () => {
  const clock = new ManualClock()
  const broker = createQueryBroker({ clock })
  const first = broker.begin(CURSOR_REQUEST)
  const second = broker.begin(CURSOR_REQUEST)
  assert.notEqual(first.token.id, second.token.id)

  // Resolve out of order: token identity, not QueryKind, routes responses.
  assert.equal(broker.accept(second.token, queryResponseEvent(second.token, '\x1b[2;2R')), true)
  assert.deepEqual((await second.response).value, { row: 2, column: 2 })
  assert.equal(broker.isRegistered(first.token), true)
  assert.equal(broker.accept(first.token, queryResponseEvent(first.token, '\x1b[1;1R')), true)
  assert.deepEqual((await first.response).value, { row: 1, column: 1 })
})

test('terminal query: 150 ms deadline, 1 retry with retransmit, 300 ms total budget', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const broker = createQueryBroker({ clock })
  const tokens: QueryToken[] = []
  const writer = makeWriter(stream, clock, { broker, tokens })

  const response = writer.query({ ...CURSOR_REQUEST, retry: 1 })
  await tick()
  const occurrences = () => stream.text.split('\x1b[6n').length - 1
  assert.equal(occurrences(), 1, 'initial attempt written')

  clock.advance(150) // first attempt deadline → broker retransmits
  await tick()
  assert.equal(occurrences(), 2, 'retry re-sends the query bytes through the writer')
  clock.advance(149)
  await tick()
  clock.advance(1) // t=300: total budget hit
  await assert.rejects(response, (error: QueryError) => error.code === 'query-timeout')
  assert.equal(broker.diagnostics().timeouts, 1)

  // retry: 0 → a single attempt, rejected at 150 ms.
  const single = writer.query({ ...CURSOR_REQUEST })
  await tick()
  clock.advance(150)
  await assert.rejects(single, (error: QueryError) => error.code === 'query-timeout')
})

test('terminal query: writeControl query branch enforces registration/generation/duplicate rules', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const broker = createQueryBroker({ clock })
  const writer = makeWriter(stream, clock, { broker })

  // Valid query branch.
  const ok = broker.begin({ ...CURSOR_REQUEST, generation: 1 })
  ok.response.catch(() => undefined)
  const sent = await writer.writeControl({ kind: 'query', request: ok.token.generation === 1 ? { ...CURSOR_REQUEST, generation: 1 } : CURSOR_REQUEST, token: ok.token }, 1)
  assert.equal(sent.status, 'written')
  assert.ok(stream.text.includes('\x1b[6n'))

  // Duplicate: same token again → stale.
  const dupe = await writer.writeControl({ kind: 'query', request: { ...CURSOR_REQUEST, generation: 1 }, token: ok.token }, 1)
  assert.equal(dupe.status, 'stale')
  broker.cancel(ok.token)

  // Unregistered (cancelled) token → WriterError.
  const cancelled = broker.begin({ ...CURSOR_REQUEST, generation: 1 })
  cancelled.response.catch(() => undefined)
  broker.cancel(cancelled.token)
  const rejected = await writer.writeControl({ kind: 'query', request: { ...CURSOR_REQUEST, generation: 1 }, token: cancelled.token }, 1)
  assert.equal(rejected.status, 'error')
  if (rejected.status === 'error') assert.equal(rejected.error.code, 'unregistered-query-token')

  // Kind/expected mismatch → WriterError (before the generation-bump case
  // below, because a higher operation generation would be adopted).
  const badShape = broker.begin({ ...CURSOR_REQUEST, generation: 1 })
  badShape.response.catch(() => undefined)
  const badRequest = { ...CURSOR_REQUEST, generation: 1, expected: 'size-report' as const }
  const bad = await writer.writeControl({ kind: 'query', request: badRequest, token: badShape.token }, 1)
  assert.equal(bad.status, 'error')
  broker.cancel(badShape.token)

  // Triple-generation mismatch (token gen 1, request gen 1, operation gen 2).
  const mismatch = broker.begin({ ...CURSOR_REQUEST, generation: 1 })
  mismatch.response.catch(() => undefined)
  const stale = await writer.writeControl({ kind: 'query', request: { ...CURSOR_REQUEST, generation: 1 }, token: mismatch.token }, 2)
  assert.equal(stale.status, 'stale')
  broker.cancel(mismatch.token)
})

test('terminal query: query-under-stream — a held frame write never blocks the frame and the query waits for its slot', async () => {
  const stream = new FakeStream()
  stream.holdCallbacks = true
  const clock = new ManualClock()
  const broker = createQueryBroker({ clock })
  const tokens: QueryToken[] = []
  const writer = makeWriter(stream, clock, { broker, tokens })

  const ops: PatchOperation[] = [resourcesOp([DEFAULT_STYLE]), { kind: 'write-cells', x: 0, y: 0, cells: [cell('F', 0)] }]
  const frameResult = writer.write(await makePatch(ops))
  await tick()
  assert.equal(stream.chunks.length, 1, 'frame write in flight')

  const responsePromise = writer.query(CURSOR_REQUEST)
  await tick()
  assert.equal(stream.chunks.length, 1, 'query waits behind the in-flight frame write')

  stream.holdCallbacks = false // the query write flushes automatically
  stream.releaseHeld() // frame settles → the query takes the next slot
  assert.equal((await frameResult).status, 'written')
  await tick()
  assert.equal(stream.chunks.length, 2)
  assert.ok(stream.chunks[0]?.includes('F'))
  assert.equal(stream.chunks[1], '\x1b[6n')

  broker.accept(tokens[0] as QueryToken, queryResponseEvent(tokens[0] as QueryToken, '\x1b[7;7R'))
  assert.deepEqual((await responsePromise).value, { row: 7, column: 7 })
  assert.equal(clock.pendingTimers(), 0, 'no dangling timers after the round trip')
})

test('terminal query: query() without a broker rejects', async () => {
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = makeWriter(stream, clock)
  await assert.rejects(writer.query(CURSOR_REQUEST), /no QueryBroker/)
})

// ---------------------------------------------------------------------------
// VirtualTerminal end-to-end
// ---------------------------------------------------------------------------

test('terminal end-to-end: ansi builders → writer → VirtualTerminal snapshot (SGR/DECSET/title/cursor)', async () => {
  const profile = { ...getProfile('kitty-sync'), columns: 20, rows: 3 }
  const stream = new FakeStream()
  const clock = new ManualClock()
  const writer = createTerminalWriter({ stream, clock, profile })

  const red = style({ id: 1, bold: true, foreground: 'ansi16:1' })
  const ops: PatchOperation[] = [
    resourcesOp([DEFAULT_STYLE, red]),
    { kind: 'mode', name: 'alternateScreen', value: true },
    { kind: 'write-cells', x: 0, y: 0, cells: [cell('A', 1), cell('B', 1)] },
    { kind: 'mode', name: 'syncOutput', value: true },
    { kind: 'mode', name: 'title', value: 'demo' },
    { kind: 'cursor', x: 3, y: 1, visible: true },
  ]
  const result = await writer.write(await makePatch(ops))
  assert.equal(result.status, 'written')

  const vt = new VirtualTerminal(profile)
  vt.write(stream.text)
  const grid = vt.snapshot()
  assert.equal(grid.modes.alternateScreen, true)
  assert.equal(grid.modes.syncOutput, true)
  assert.equal(grid.modes.title, 'demo')
  assert.equal(grid.cells[0]?.grapheme, 'A')
  assert.equal(grid.cells[1]?.grapheme, 'B')
  assert.deepEqual(
    [grid.cells[0]?.resolvedStyle.bold, grid.cells[0]?.resolvedStyle.foreground],
    [true, 'ansi16:1'],
  )
  assert.deepEqual(grid.cursor, { x: 3, y: 1, visible: true })
  assert.equal(grid.modes.mouse, 'off')

  // DECSET via writeControl also lands in the mode snapshot.
  const viaControl: WriteResult = await writer.writeControl(
    { kind: 'lifecycle', operation: { kind: 'lifecycle', action: 'paste', enabled: true } },
    0,
  )
  assert.equal(viaControl.status, 'written')
  vt.reset()
  // Re-feed everything after reset: the alternate screen persists per bytes.
  const vt2 = new VirtualTerminal(profile)
  vt2.write(stream.text)
  assert.equal(vt2.snapshot().modes.bracketedPaste, true)

  await writer.stop()
  const vt3 = new VirtualTerminal(profile)
  vt3.write(stream.text)
  const stoppedGrid = vt3.snapshot()
  assert.equal(stoppedGrid.modes.alternateScreen, false, 'stop cleanup exits the alt screen')
  assert.equal(stoppedGrid.modes.cursorVisible, true)
  assert.equal(stoppedGrid.modes.mouse, 'off', 'cleanup restores mouse tracking to off')
})
