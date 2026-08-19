/**
 * tui-v2 WP-03c pi fork end-to-end integration tests (plan §5.6/WP-03):
 * fake stdin/stdout + VirtualTerminal + ManualClock driving the real vendored
 * Tui/TuiMainScreen/TuiAltScreen through the PiTerminalAdapter stack.
 *
 * Covered: Text rendering, Editor input echo, SIGWINCH resize redraw, alt
 * screen (overlay) open/close with main-screen restore, the stop+awaitStop
 * §5.7 barrier (VT modes back to defaults, stdin/signal listeners removed)
 * and a write-failure error fixture.
 *
 * Top-level test names carry "pi fork" so
 * `--test-name-pattern 'pi fork|terminal|overlay'` selects this file.
 *
 * Two time domains are in play: TuiBase rendering uses REAL timers
 * (process.nextTick + setTimeout(16ms)) while writer/lifecycle/input
 * timeouts run on the injected ManualClock. Real waits poll with a deadline.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

import type { Clock } from '../../src/tui-v2/model/schema.js'
import type { Frame, TerminalCell, TerminalModeSnapshot } from '../../src/tui-v2/renderer/frame.js'
import {
  createPiTerminalStack,
  type PiAdapterError,
  type PiTerminalStack,
} from '../../src/tui-v2/terminal/pi-adapter.js'
import { PiTuiAltScreenBackend } from '../../src/tui-v2/terminal/alt-screen.js'
import { PiTuiMainScreenBackend } from '../../src/tui-v2/terminal/main-screen.js'
import { Editor, Text } from '../../src/tui-v2/terminal/pi.js'
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import { encodePatchOperationsSync as writerModuleEncode } from '../../src/tui-v2/terminal/writer.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js'
import { defaultEditorTheme } from './pi-fork/test-themes.js'

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

/** Output stream that feeds a VirtualTerminal and keeps the raw bytes. */
class VtStream extends Writable {
  readonly chunks: string[] = []
  failNextError: Error | null = null

  constructor(private readonly vt: VirtualTerminal) {
    super()
  }

  _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    const text = String(chunk)
    this.chunks.push(text)
    if (this.failNextError !== null) {
      const error = this.failNextError
      this.failNextError = null
      callback(error)
      return
    }
    this.vt.write(text)
    callback()
  }

  get text(): string {
    return this.chunks.join('')
  }
}

async function tick(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Poll a real-time condition (TuiBase renders on real timers). */
async function waitForReal(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (condition()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitForReal deadline exceeded')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Drive a stop barrier to completion (drain timers live on the ManualClock). */
async function settleStop(clock: ManualClock, promise: Promise<void>): Promise<void> {
  await tick(6)
  clock.advance(200)
  await tick(6)
  await promise
}

// ---------------------------------------------------------------------------
// rig
// ---------------------------------------------------------------------------

interface Rig {
  profile: TerminalProfile
  stack: PiTerminalStack
  stdin: FakeStdin
  stdout: { columns: number; rows: number }
  stream: VtStream
  clock: ManualClock
  host: EventEmitter
  vt: VirtualTerminal
  errors: PiAdapterError[]
}

function buildRig(): Rig {
  // Pin the geometry so the VT grid and the fake stdout agree.
  const profile: TerminalProfile = { ...getProfile('kitty-sync'), columns: 80, rows: 24 }
  const stdin = new FakeStdin()
  const stdout = { columns: 80, rows: 24 }
  const clock = new ManualClock()
  const host = new EventEmitter()
  const errors: PiAdapterError[] = []
  const vt = new VirtualTerminal(profile)
  const stream = new VtStream(vt)
  const stack = createPiTerminalStack({
    stdin,
    stdout,
    stream,
    clock,
    profile,
    // The main screen never takes the alternate screen; the alt backend
    // enters it explicitly through the vendored TuiAltScreen.
    startOptions: { alternateScreen: false },
    processHost: host,
    onError: (error) => errors.push(error),
  })
  stack.lifecycle.attachProcessHandlers()
  return { profile, stack, stdin, stdout, stream, clock, host, vt, errors }
}

/** Row text from the VT's ACTIVE grid (main or alt), trailing blanks trimmed. */
function lineText(vt: VirtualTerminal, y: number): string {
  const snapshot = vt.snapshot()
  const cells = snapshot.cells.slice(y * snapshot.width, (y + 1) * snapshot.width)
  return cells.map((cell) => cell.grapheme).join('').trimEnd()
}

function screenText(vt: VirtualTerminal): string {
  const snapshot = vt.snapshot()
  const lines: string[] = []
  for (let y = 0; y < snapshot.height; y++) {
    const cells = snapshot.cells.slice(y * snapshot.width, (y + 1) * snapshot.width)
    lines.push(cells.map((cell) => cell.grapheme).join(''))
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// end-to-end: render, echo, resize, overlay, teardown
// ---------------------------------------------------------------------------

test('pi fork integration: Text render, Editor echo, resize redraw, alt overlay restore, clean teardown', async () => {
  const rig = buildRig()
  const main = new PiTuiMainScreenBackend(rig.stack)
  await main.start(1)
  assert.equal(rig.stack.lifecycle.lifecycleState(), 'active')
  assert.deepEqual(rig.stdin.rawModes, [true])

  // --- Text rendering through the vendored main-screen TUI ----------------
  main.tui.addChild(new Text('hello world', 0, 0))
  await waitForReal(() => lineText(rig.vt, 0) === 'hello world')

  // --- Editor input echo: stdin bytes → input source → adapter → pi wire --
  // (the editor draws as a regular child; setFocus routes input to it)
  const editor = new Editor(main.tui, defaultEditorTheme)
  main.tui.addChild(editor)
  main.tui.setFocus(editor)
  rig.stdin.write('x')
  await waitForReal(() => editor.getText() === 'x')
  await waitForReal(() => screenText(rig.vt).includes('x'))

  // --- SIGWINCH resize → adapter.onResize → TUI re-render at the new width -
  const bytesBeforeResize = rig.stream.text.length
  rig.stdout.columns = 40
  rig.stdout.rows = 24
  rig.vt.resize(40, 24)
  rig.host.emit('SIGWINCH')
  await waitForReal(() => rig.stream.text.length > bytesBeforeResize)
  assert.equal(rig.stack.adapter.columns, 40)
  // The vendored TUI renders through the same adapter dimensions source.
  assert.equal(lineText(rig.vt, 0).includes('hello world') || screenText(rig.vt).includes('x'), true)

  // --- alt screen (overlay) open ------------------------------------------
  rig.stdout.columns = 80 // back to the original geometry before the overlay
  rig.vt.resize(80, 24)
  const bytesBeforeResizeBack = rig.stream.text.length
  rig.host.emit('SIGWINCH')
  // Let the main TUI's resize re-render settle BEFORE the overlay takes the
  // screen — the two vendored TUIs share one terminal, so the session owner
  // must serialize their frames (WP-04 will own this ordering).
  await waitForReal(() => rig.stream.text.length > bytesBeforeResizeBack)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const alt = new PiTuiAltScreenBackend(rig.stack)
  await alt.start(2)
  assert.ok(rig.stream.text.includes('\x1b[?1049h'), 'alt screen enter bytes must be written')
  alt.tui.addChild(new Text('overlay body', 0, 0))
  await waitForReal(() => lineText(rig.vt, 0) === 'overlay body')

  // --- alt screen close: primary screen restore, session stays taken over -
  await alt.stop(2)
  // The restore bytes are enqueued synchronously but flush on microtasks.
  await tick(6)
  assert.ok(rig.stream.text.includes('\x1b[?1049l'), 'alt screen exit bytes must be written')
  await tick()
  assert.equal(rig.vt.snapshot().modes.alternateScreen, false)
  // The scoped stop left the session alive: the lifecycle is still active.
  assert.equal(rig.stack.lifecycle.lifecycleState(), 'active')
  // The restore path reprinted the main-screen document on the primary grid.
  await waitForReal(() => screenText(rig.vt).includes('hello world'))

  // --- session teardown: stop + awaitStop barrier --------------------------
  const stopPromise = main.stop(1)
  await settleStop(rig.clock, stopPromise)

  const modes = rig.vt.snapshot().modes
  assert.equal(modes.alternateScreen, false)
  assert.equal(modes.mouse, 'off')
  assert.equal(modes.bracketedPaste, false)
  assert.equal(modes.syncOutput, false)
  assert.equal(modes.kittyKeyboard, false)
  assert.equal(modes.focusReporting, false)
  assert.equal(modes.cursorVisible, true)
  assert.equal(modes.autowrap, true)

  // stdin + signal listeners are gone (§5.7 barrier tail).
  assert.equal(rig.stdin.listenerCount('data'), 0)
  assert.equal(rig.host.listenerCount('SIGINT'), 0)
  assert.equal(rig.host.listenerCount('SIGWINCH'), 0)
  assert.equal(rig.stack.lifecycle.lifecycleState(), 'stopped')
  assert.equal(rig.errors.length, 0, JSON.stringify(rig.errors))
})

test('pi fork integration: stale generations are rejected/ignored by both backends', async () => {
  const rig = buildRig()
  const main = new PiTuiMainScreenBackend(rig.stack)
  await main.start(3)
  await assert.rejects(() => main.start(2), RangeError)
  await assert.rejects(() => main.start(-1), TypeError)
  const alt = new PiTuiAltScreenBackend(rig.stack)
  await assert.rejects(() => alt.start(2), RangeError) // never started: still validates ordering
  await main.stop(0) // stale stop: ignored, session still active
  assert.equal(rig.stack.lifecycle.lifecycleState(), 'active')
  await settleStop(rig.clock, main.stop(3))
  assert.equal(rig.stack.lifecycle.lifecycleState(), 'stopped')
})

test('pi fork integration: write failure surfaces via onError and the stop barrier still settles', async () => {
  const rig = buildRig()
  const main = new PiTuiMainScreenBackend(rig.stack)
  await main.start(1)

  rig.stream.failNextError = new Error('boom')
  rig.stack.adapter.hideCursor()
  await tick(6)
  assert.ok(rig.errors.some((error) => error.code === 'write-failed'), JSON.stringify(rig.errors))
  assert.ok(rig.stack.adapter.diagnostics().errorResults >= 1)

  // The failed writer leaves the barrier in failed-after-takeover, but
  // awaitStop() settles and stdin is detached.
  await settleStop(rig.clock, main.stop(1))
  assert.equal(rig.stdin.listenerCount('data'), 0)
  assert.equal(rig.stack.writer.lifecycleState(), 'failed-after-takeover')
})

// ---------------------------------------------------------------------------
// backend plan(): Frame → TerminalPatch
// ---------------------------------------------------------------------------

function defaultModes(): TerminalModeSnapshot {
  return {
    alternateScreen: false,
    rawInput: true,
    mouse: 'off',
    bracketedPaste: true,
    syncOutput: false,
    autowrap: true,
    wrapPending: false,
    scrollRegion: { top: 0, bottom: 23 },
    cursorStyle: 'block',
    cursorVisible: false,
    kittyKeyboard: false,
    modifyOtherKeys: false,
    focusReporting: false,
    windowsDec9001: false,
    osc133: false,
    title: null,
    progress: { state: 'none' },
  }
}

function makeFrame(row0: string, generation: number, fullRedraw = false): Frame {
  const width = 4
  const height = 2
  const stride = 4
  const cells: TerminalCell[] = []
  for (const row of [row0.padEnd(width, ' ').slice(0, width), ' '.repeat(width)]) {
    for (const grapheme of row) cells.push({ grapheme, width: 1, styleId: 0 })
  }
  return {
    frameId: `frame-${generation}-${row0}`,
    stateRevision: 1,
    width,
    height,
    stride,
    cells,
    cursor: { x: 0, y: 0, visible: false },
    modes: defaultModes(),
    resources: {
      styles: [
        { id: 0, foreground: null, background: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false },
      ],
      hyperlinks: [],
    },
    images: [],
    layers: [],
    generation,
    fullRedraw,
    metadata: { changedRows: 0, renderMs: 0, diffMs: 0, terminalProfileId: 'test' },
  }
}

test('pi fork integration: backend plan() builds conservative patches with generation checks', async () => {
  const rig = buildRig()
  const main = new PiTuiMainScreenBackend(rig.stack)
  await main.start(5)

  // First frame: full rewrite — resources + one write-cells per row + cursor.
  const first = main.plan(null, makeFrame('abcd', 5))
  assert.equal(first.fullRedraw, true)
  assert.equal(first.patchSeq, 0)
  assert.equal(first.generation, 5)
  assert.equal(first.operations[0]?.kind, 'resources')
  const firstWrites = first.operations.filter((op) => op.kind === 'write-cells')
  assert.equal(firstWrites.length, 2)
  assert.ok(first.operations.some((op) => op.kind === 'cursor'))
  assert.ok(first.bytes > 0)
  // The bytes field is exactly what the writer's own encoder produces.
  assert.equal(writerModuleEncode(first.operations).bytes, first.bytes)

  // Same-geometry frame with one changed row: only that row is rewritten.
  const second = main.plan(makeFrame('abcd', 5), makeFrame('abXd', 5))
  assert.equal(second.fullRedraw, false)
  assert.equal(second.patchSeq, 1)
  const secondWrites = second.operations.filter((op) => op.kind === 'write-cells')
  assert.equal(secondWrites.length, 1)
  assert.equal(secondWrites[0]?.kind === 'write-cells' ? secondWrites[0].y : -1, 0)

  // fullRedraw flag on the next frame forces the full path again.
  const third = main.plan(makeFrame('abcd', 5), makeFrame('abcd', 5, true))
  assert.equal(third.fullRedraw, true)

  // Stale frame generation is rejected; images are out of the backend scope.
  assert.throws(() => main.plan(null, makeFrame('abcd', 4)), RangeError)
  const withImage = { ...makeFrame('abcd', 5), images: [{ imageId: 'i', protocol: 'kitty' as const, x: 0, y: 0, width: 1, height: 1, payloadHash: 'h', storeKey: 'k' }] }
  assert.throws(() => main.plan(null, withImage), RangeError)

  await settleStop(rig.clock, main.stop(5))
})
