/**
 * tui-v2 WP-06b fullscreen backend tests (plan §6.4 + §5.5 patch contract).
 *
 * Covered:
 *   - capability declaration (§6.4 boundary; main-screen never fakes them);
 *   - plan() recipe: resources op first, full redraw = atomic erase + full
 *     row rewrite, incremental = per-row changed spans;
 *   - continuation safety: no run starts with a width-0 cell, no wide head
 *     is left unpaired, replay never violates the physical-line invariant;
 *   - cross-frame styleId/hyperlinkId comparison by RESOLVED content (ids
 *     alias across frames — raw-id comparison is a regression test here);
 *   - cursor re-assertion on any cell-writing patch; mode ops on change;
 *   - generation gate + patchSeq lineage;
 *   - THE DIFFERENTIAL PROOF (WP-06): one frame sequence is rendered full
 *     (canonicalizeFrame per frame) while the other replays
 *     first-frame-full + incremental patches through
 *     applyPatchToCanonicalGrid — grids/cursors/modes must be equal after
 *     every frame, including resize transactions and random fuzz rounds;
 *   - writer bytes reproduce the frame in the VirtualTerminal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { OverlayState } from '../../src/tui-v2/model/schema.js'
import { compositeFrame } from '../../src/tui-v2/renderer/compositor.js'
import { buildFrame } from '../../src/tui-v2/renderer/frame-builder.js'
import type {
  Frame,
  PatchOperation,
  TerminalModeSnapshot,
} from '../../src/tui-v2/renderer/frame.js'
import { FULLSCREEN_CAPABILITIES, FullscreenBackend } from '../../src/tui-v2/terminal/fullscreen-backend.js'
import { PiTuiMainScreenBackend } from '../../src/tui-v2/terminal/main-screen.js'
import type { PiTerminalStack } from '../../src/tui-v2/terminal/pi-adapter.js'
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import { encodePatchOperationsSync } from '../../src/tui-v2/terminal/writer.js'
import {
  canonicalizeFrame,
  compareGrid,
  type CanonicalCell,
  type CanonicalGridV1,
  type CanonicalStyle,
} from '../../src/tui-v2/testkit/canonical.js'
import {
  applyPatchToCanonicalGrid,
  findLineWidthViolations,
} from '../../src/tui-v2/testkit/frame-assert.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js'

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

const WIDTH = 24
const HEIGHT = 6

function testProfile(id: string, width = WIDTH, height = HEIGHT): TerminalProfile {
  return { ...getProfile('unicode-ambiguous-narrow'), id, columns: width, rows: height }
}

const PROFILE = testProfile('fullscreen-backend-test')

function defaultModes(height: number): TerminalModeSnapshot {
  // What a fresh VirtualTerminal reports: the first patch carries no mode
  // ops (the lifecycle owns session modes), so synthetic frames must match
  // the terminal's initial state byte-for-byte.
  return {
    alternateScreen: false,
    rawInput: false,
    mouse: 'off',
    bracketedPaste: false,
    syncOutput: false,
    autowrap: true,
    wrapPending: false,
    scrollRegion: { top: 0, bottom: height - 1 },
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

let frameSeq = 0
interface FrameSpec {
  readonly lines: readonly string[]
  readonly width?: number
  readonly height?: number
  readonly fullRedraw?: boolean
  readonly fullRedrawReason?: 'initial' | 'resize' | 'resume' | 'damage' | 'unknown-mode' | 'cleanup'
  readonly cursor?: { x: number; y: number; visible: boolean }
  readonly modes?: TerminalModeSnapshot
  readonly overlays?: readonly OverlayState[]
  readonly generation?: number
}

function makeOverlay(partial: Partial<OverlayState> & { overlayId: string }): OverlayState {
  return {
    revision: 1,
    anchor: 'center',
    visible: true,
    captureInput: true,
    nonCapturing: false,
    payload: {},
    ...partial,
  }
}

/** Overlay content lines travel inside the (serializable) payload. */
function overlayRenderer(overlay: OverlayState, _width: number): readonly string[] {
  const payload = overlay.payload as { lines?: readonly string[] }
  return Array.isArray(payload.lines) ? payload.lines : []
}

function composeFrame(spec: FrameSpec, previous: Frame | null = null): Frame {
  const width = spec.width ?? WIDTH
  const height = spec.height ?? HEIGHT
  const profile = testProfile(PROFILE.id, width, height)
  const base = buildFrame({
    frameId: `f-${++frameSeq}`,
    stateRevision: frameSeq,
    width,
    height,
    lines: spec.lines,
    profile,
    modes: spec.modes ?? defaultModes(height),
    generation: spec.generation ?? 0,
    ...(spec.fullRedraw !== undefined ? { fullRedraw: spec.fullRedraw } : {}),
    ...(spec.fullRedrawReason !== undefined ? { fullRedrawReason: spec.fullRedrawReason } : {}),
    ...(spec.cursor !== undefined ? { cursor: spec.cursor } : {}),
  })
  return compositeFrame({
    base,
    profile,
    overlays: spec.overlays ?? [],
    renderOverlay: overlayRenderer,
    previous,
  }).frame
}

const DEFAULT_STYLE: CanonicalStyle = {
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
}

const BLANK: CanonicalCell = {
  grapheme: '',
  width: 1,
  continuation: false,
  resolvedStyle: DEFAULT_STYLE,
  hyperlink: null,
}

function emptyGrid(width: number, height: number, modes: TerminalModeSnapshot): CanonicalGridV1 {
  return {
    width,
    height,
    cells: Array.from({ length: width * height }, () => BLANK),
    cursor: { x: 0, y: 0, visible: false },
    modes,
    scrollback: [],
    images: [],
  }
}

/** VT-conformant resize (no reflow): crop/pad with default-style blanks. */
function resizeGrid(grid: CanonicalGridV1, width: number, height: number): CanonicalGridV1 {
  const cells: CanonicalCell[] = Array.from({ length: width * height }, () => BLANK)
  for (let y = 0; y < Math.min(height, grid.height); y++) {
    for (let x = 0; x < Math.min(width, grid.width); x++) {
      cells[y * width + x] = grid.cells[y * grid.width + x] as CanonicalCell
    }
  }
  return { ...grid, width, height, cells }
}

function assertReplayEqualsFrame(replayed: CanonicalGridV1, frame: Frame, label: string): void {
  const comparison = compareGrid(replayed, { gridEncoding: 'readable', value: canonicalizeFrame(frame) })
  assert.ok(comparison.ok, `${label}: grid mismatch: ${JSON.stringify(comparison.diffs)}`)
  assert.deepEqual(findLineWidthViolations(replayed), [], `${label}: line-width violations`)
}

/**
 * Replay a frame sequence through the backend's patches and compare against
 * a fresh full render after EVERY frame (the WP-06 differential proof).
 */
function assertSequenceEquivalence(frames: readonly Frame[], label: string): void {
  const backend = new FullscreenBackend()
  let previous: Frame | null = null
  let grid: CanonicalGridV1 | null = null
  frames.forEach((frame, index) => {
    const patch = backend.plan(previous, frame)
    // patch.bytes is computed with the writer's fixed encoder (§5.5).
    assert.equal(patch.bytes, encodePatchOperationsSync(patch.operations).bytes, `${label}[${index}] bytes`)
    assert.equal(patch.operations[0]?.kind, 'resources', `${label}[${index}] resources op first`)
    if (previous !== null && (previous.width !== frame.width || previous.height !== frame.height)) {
      assert.equal(patch.fullRedraw, true, `${label}[${index}] resize forces fullRedraw`)
      assert.equal(patch.operations[1]?.kind, 'erase', `${label}[${index}] resize erases atomically first`)
    }
    // Continuation safety: no write-cells run starts with a continuation.
    for (const op of patch.operations) {
      if (op.kind === 'write-cells' && op.cells.length > 0) {
        assert.notEqual(op.cells[0]?.width, 0, `${label}[${index}] run must not start with a continuation`)
      }
    }
    if (grid === null || previous === null) {
      grid = emptyGrid(frame.width, frame.height, frame.modes)
    } else if (previous.width !== frame.width || previous.height !== frame.height) {
      grid = resizeGrid(grid, frame.width, frame.height)
    }
    grid = applyPatchToCanonicalGrid(grid, patch)
    assertReplayEqualsFrame(grid, frame, `${label}[${index}]`)
    previous = frame
  })
}

// ---------------------------------------------------------------------------
// capabilities (§6.4)
// ---------------------------------------------------------------------------

test('fullscreen backend declares the §6.4 capability boundary; main-screen never fakes it', () => {
  const backend = new FullscreenBackend()
  assert.equal(backend.mode, 'fullscreen')
  assert.deepEqual(backend.capabilities, {
    supportsViewportLayout: true,
    supportsNestedOverlay: true,
    supportsScrollRegion: true,
    supportsInlineLiveRegion: false,
  })
  assert.equal(FULLSCREEN_CAPABILITIES.supportsScrollRegion, true)
  // The main-screen backend explicitly declares the opposite corner (inline
  // semantics are WP-07; faking viewport/overlay/scroll-region is forbidden).
  const stubStack = { adapter: undefined } as unknown as PiTerminalStack
  const main = new PiTuiMainScreenBackend(stubStack)
  assert.deepEqual(main.capabilities, {
    supportsViewportLayout: false,
    supportsNestedOverlay: false,
    supportsScrollRegion: false,
    supportsInlineLiveRegion: true,
  })
  assert.equal(main.mode, 'inline')
})

// ---------------------------------------------------------------------------
// recipe shape
// ---------------------------------------------------------------------------

test('fullscreen backend: first frame is a full redraw (resources first, no erase, no mode ops)', () => {
  const backend = new FullscreenBackend()
  const frame = composeFrame({ lines: ['hello', '\x1b[1;31mred\x1b[0m'] })
  const patch = backend.plan(null, frame)
  assert.equal(patch.fullRedraw, true)
  assert.equal(patch.operations[0]?.kind, 'resources')
  // No erase against a fresh alt screen (DEC 1049 enters cleared).
  assert.ok(!patch.operations.some((op) => op.kind === 'erase'))
  const writes = patch.operations.filter((op) => op.kind === 'write-cells')
  assert.equal(writes.length, HEIGHT)
  // Cursor re-asserted; modes left to the lifecycle on the first frame.
  assert.ok(patch.operations.some((op) => op.kind === 'cursor'))
  assert.ok(!patch.operations.some((op) => op.kind === 'mode'))
  assert.equal(patch.bytes, encodePatchOperationsSync(patch.operations).bytes)
})

test('fullscreen backend: incremental patch rewrites only changed spans', () => {
  const backend = new FullscreenBackend()
  const frame1 = composeFrame({ lines: ['aaaa', 'bbbb', 'cccc'] })
  const frame2 = composeFrame({ lines: ['aaaa', 'bXbb', 'cccc'] })
  const patch = backend.plan(frame1, frame2)
  assert.equal(patch.fullRedraw, false)
  const writes = patch.operations.filter((op) => op.kind === 'write-cells')
  assert.equal(writes.length, 1)
  const write = writes[0] as Extract<PatchOperation, { kind: 'write-cells' }>
  assert.equal(write.y, 1)
  assert.equal(write.x, 1)
  assert.equal(write.cells.map((cell) => cell.grapheme).join(''), 'X')
  // Cursor unchanged and no cell-adjacent drift... cells were written, so the
  // cursor is re-asserted (resting position = frame cursor).
  assert.ok(patch.operations.some((op) => op.kind === 'cursor'))
  assertSequenceEquivalence([frame1, frame2], 'span')
})

test('fullscreen backend: styleId aliasing across frames is diffed by resolved content', () => {
  const backend = new FullscreenBackend()
  // Both frames assign styleId 1 first-come-first-served: red in frame1,
  // blue in frame2. Raw-id comparison would call the cell unchanged.
  const frame1 = composeFrame({ lines: ['\x1b[31mA\x1b[0m'] })
  const frame2 = composeFrame({ lines: ['\x1b[34mA\x1b[0m'] })
  const patch = backend.plan(frame1, frame2)
  const writes = patch.operations.filter((op) => op.kind === 'write-cells')
  assert.equal(writes.length, 1, 'recolored cell must be rewritten')
  assertSequenceEquivalence([frame1, frame2], 'alias')
})

test('fullscreen backend: wide-grapheme edits stay continuation-safe', () => {
  const sequences: readonly (readonly string[])[] = [
    ['x你y', 'xay'], // pair breaks: head + continuation both rewritten
    ['abc', 'a你c'], // pair forms: head + continuation inside the span
    ['a你c', 'abc'],
    ['你好世界', '你a世界'],
  ]
  sequences.forEach(([before, after], index) => {
    const frame1 = composeFrame({ lines: [before as string] })
    const frame2 = composeFrame({ lines: [after as string] })
    assertSequenceEquivalence([frame1, frame2], `wide-${index}`)
  })
})

test('fullscreen backend: cursor is re-asserted whenever cells are written', () => {
  const backend = new FullscreenBackend()
  const cursor = { x: 3, y: 1, visible: true }
  const frame1 = composeFrame({ lines: ['aaaa', 'bbbb'], cursor })
  const frame2 = composeFrame({ lines: ['aaaa', 'bbXb'], cursor })
  const patch = backend.plan(frame1, frame2)
  const cursorOps = patch.operations.filter((op) => op.kind === 'cursor')
  assert.equal(cursorOps.length, 1)
  assert.deepEqual(cursorOps[0], { kind: 'cursor', x: 3, y: 1, visible: true })
})

test('fullscreen backend: mode ops only on change (incl. scrollRegion deep compare)', () => {
  const backend = new FullscreenBackend()
  const modes1 = defaultModes(HEIGHT)
  const frame1 = composeFrame({ lines: ['a'], modes: modes1 })
  const same = backend.plan(frame1, composeFrame({ lines: ['b'], modes: modes1 }))
  assert.ok(!same.operations.some((op) => op.kind === 'mode'))
  const modes2: TerminalModeSnapshot = {
    ...modes1,
    bracketedPaste: true,
    scrollRegion: { top: 1, bottom: HEIGHT - 2 },
  }
  const changed = backend.plan(frame1, composeFrame({ lines: ['b'], modes: modes2 }))
  const modeOps = changed.operations.filter((op) => op.kind === 'mode')
  assert.deepEqual(
    modeOps.map((op) => (op as Extract<PatchOperation, { kind: 'mode' }>).name).sort(),
    ['bracketedPaste', 'scrollRegion'],
  )
})

// ---------------------------------------------------------------------------
// generation gate / patchSeq lineage
// ---------------------------------------------------------------------------

test('fullscreen backend: generation gate and patchSeq lineage', async () => {
  const backend = new FullscreenBackend()
  await backend.start(2)
  assert.throws(() => backend.start(1), RangeError)
  const frame = composeFrame({ lines: ['g'], generation: 2 })
  const first = backend.plan(null, frame)
  assert.equal(first.patchSeq, 0)
  const second = backend.plan(frame, composeFrame({ lines: ['h'], generation: 2 }))
  assert.equal(second.patchSeq, 1)
  // A frame older than the active generation is rejected.
  assert.throws(() => backend.plan(null, composeFrame({ lines: ['x'], generation: 1 })), RangeError)
  // A newer generation restarts the patchSeq lineage and forces a full redraw.
  const nextGen = backend.plan(frame, composeFrame({ lines: ['h'], generation: 3 }))
  assert.equal(nextGen.patchSeq, 0)
  assert.equal(nextGen.fullRedraw, true)
  // stop is generation-gated: a stale stop is ignored silently.
  await backend.stop(1)
  await backend.stop(2)
})

// ---------------------------------------------------------------------------
// resize transaction recipe
// ---------------------------------------------------------------------------

test('fullscreen backend: resize transaction is an atomic erase + full rewrite', () => {
  const frames = [
    composeFrame({ lines: ['wide frame row', '第二行'] }),
    composeFrame({ lines: ['narrow now'], width: 12, height: 4 }),
    composeFrame({ lines: ['wide again', '你好的世界'], width: 30, height: 8 }),
    composeFrame({ lines: ['short'], width: 30, height: 3 }),
  ]
  assertSequenceEquivalence(frames, 'resize')
})

// ---------------------------------------------------------------------------
// full redraw reasons pass through the DiffPlanner shape
// ---------------------------------------------------------------------------

test('fullscreen backend: fullRedraw triggers map to the full recipe (resume/damage/cleanup/unknown-mode)', () => {
  for (const reason of ['resume', 'damage', 'cleanup', 'unknown-mode'] as const) {
    const backend = new FullscreenBackend()
    const frame1 = composeFrame({ lines: ['before'] })
    const frame2 = composeFrame({ lines: ['after'], fullRedraw: true, fullRedrawReason: reason })
    const patch = backend.plan(frame1, frame2)
    assert.equal(patch.fullRedraw, true, `${reason} forces full redraw`)
    assert.equal(patch.operations[1]?.kind, 'erase', `${reason}: erase precedes the rewrite`)
    const replayed = applyPatchToCanonicalGrid(canonicalizeFrame(frame1), patch)
    assertReplayEqualsFrame(replayed, frame2, reason)
  }
})

// ---------------------------------------------------------------------------
// VirtualTerminal byte-level check (fixed encoder → independent parser)
// ---------------------------------------------------------------------------

test('fullscreen backend: writer bytes reproduce every frame in the virtual terminal', () => {
  const backend = new FullscreenBackend()
  const vt = new VirtualTerminal(PROFILE)
  const overlay = makeOverlay({
    overlayId: 'dlg',
    width: 10,
    row: 1,
    col: 2,
    payload: { lines: ['\x1b[1mDLG TITLE\x1b[0m', '你-content'] },
  })
  const frames = [
    composeFrame({ lines: ['\x1b[1;31mbold-red\x1b[0m 你', 'plain', '\x1b[38;5;209m256\x1b[0m'] }),
    composeFrame({ lines: ['\x1b[1;31mbold-red\x1b[0m 你', 'changed', '\x1b[38;5;209m256\x1b[0m'], overlays: [overlay] }),
    composeFrame({ lines: ['\x1b[32mgreen\x1b[0m', 'changed', 'third'], overlays: [overlay] }),
    composeFrame({ lines: ['\x1b[32mgreen\x1b[0m', 'changed', 'third'] }), // overlay closed
  ]
  let prev: Frame | null = null
  for (const frame of frames) {
    const patch = backend.plan(prev, frame)
    const { encoded, bytes } = encodePatchOperationsSync(patch.operations)
    assert.equal(bytes, patch.bytes)
    vt.write(encoded)
    const comparison = compareGrid(vt.snapshot(), { gridEncoding: 'readable', value: canonicalizeFrame(frame) })
    assert.ok(comparison.ok, `vt mismatch at frame ${frame.frameId}: ${JSON.stringify(comparison.diffs)}`)
    prev = frame
  }
  assertSequenceEquivalence(frames, 'vt-sequence')
})

// ---------------------------------------------------------------------------
// differential fuzz (seeded, deterministic)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FUZZ_TOKENS = [
  'a',
  'Z',
  '0',
  ' ',
  '你',
  '好',
  '·',
  '—',
  '🙂',
  'é',
  '\t',
]
const FUZZ_STYLES = ['', '\x1b[31m', '\x1b[1;34m', '\x1b[4m', '\x1b[48;5;17m', '\x1b[38;2;10;20;30m']
const FUZZ_ANCHORS: readonly OverlayState['anchor'][] = [
  'center',
  'top-left',
  'bottom-right',
  'top-center',
  'left-center',
]

function fuzzLine(rand: () => number, maxColumns: number): string {
  let out = ''
  let columns = 0
  const budget = Math.floor(rand() * (maxColumns + 6))
  while (columns < budget) {
    const token = FUZZ_TOKENS[Math.floor(rand() * FUZZ_TOKENS.length)] as string
    const style = FUZZ_STYLES[Math.floor(rand() * FUZZ_STYLES.length)] as string
    out += style === '' ? token : `${style}${token}\x1b[0m`
    columns += 1
    if (rand() < 0.08) {
      out += `\x1b]8;;https://fuzz.example/${columns}\x07L${columns}\x1b]8;;\x07`
    }
  }
  return out
}

function fuzzOverlay(rand: () => number, round: number, index: number): OverlayState {
  const lineCount = Math.floor(rand() * 5)
  const lines = Array.from({ length: lineCount }, () => fuzzLine(rand, 12))
  const widthRoll = rand()
  const dimension =
    widthRoll < 0.4 ? Math.floor(rand() * 14) + 2 : (`${Math.floor(rand() * 80) + 10}%` as `${number}%`)
  return makeOverlay({
    overlayId: `fuzz-${round}-${index}`,
    revision: 1 + Math.floor(rand() * 3),
    anchor: FUZZ_ANCHORS[Math.floor(rand() * FUZZ_ANCHORS.length)] as OverlayState['anchor'],
    width: dimension,
    ...(rand() < 0.4 ? { maxHeight: Math.floor(rand() * 4) + 1 } : {}),
    ...(rand() < 0.3 ? { margin: Math.floor(rand() * 3) } : {}),
    ...(rand() < 0.3 ? { offsetX: Math.floor(rand() * 5) - 2, offsetY: Math.floor(rand() * 5) - 2 } : {}),
    ...(rand() < 0.2 ? { nonCapturing: true, captureInput: false } : {}),
    ...(rand() < 0.15 ? { visible: false } : {}),
    payload: { lines },
  })
}

test('fullscreen backend: differential fuzz — full render vs incremental patch replay', () => {
  const profiles = ['ascii-narrow', 'unicode-ambiguous-narrow', 'unicode-ambiguous-wide']
  for (let round = 0; round < 18; round++) {
    const rand = mulberry32(0xced0 + round)
    const profileId = profiles[round % profiles.length] as string
    const width = 8 + Math.floor(rand() * 24)
    const height = 4 + Math.floor(rand() * 8)
    const profile = { ...getProfile(profileId), id: `fuzz-${round}`, columns: width, rows: height }
    const frameCount = 5 + Math.floor(rand() * 12)

    const frames: Frame[] = []
    let overlayStack: OverlayState[] = []
    let previous: Frame | null = null
    for (let i = 0; i < frameCount; i++) {
      // Mutate the overlay stack: open / revise / close.
      const roll = rand()
      if (roll < 0.35 && overlayStack.length < 3) {
        overlayStack = [...overlayStack, fuzzOverlay(rand, round, i)]
      } else if (roll < 0.6 && overlayStack.length > 0) {
        const index = Math.floor(rand() * overlayStack.length)
        overlayStack = overlayStack.map((o, j) =>
          j === index ? fuzzOverlay(rand, round, i) : o,
        )
      } else if (roll < 0.75 && overlayStack.length > 0) {
        overlayStack = overlayStack.slice(1)
      }
      const lineCount = Math.max(1, Math.floor(rand() * (height + 2)))
      const lines = Array.from({ length: lineCount }, () => fuzzLine(rand, width))
      const fullRedraw = rand() < 0.1
      const base = buildFrame({
        frameId: `fuzz-${round}-${i}`,
        stateRevision: i,
        width,
        height,
        lines,
        profile,
        modes: defaultModes(height),
        generation: 0,
        ...(fullRedraw ? { fullRedraw: true, fullRedrawReason: 'damage' as const } : {}),
      })
      const frame = compositeFrame({
        base,
        profile,
        overlays: overlayStack,
        renderOverlay: overlayRenderer,
        previous,
      }).frame
      frames.push(frame)
      previous = frame
    }
    assertSequenceEquivalence(frames, `fuzz-round-${round}(${profileId})`)
  }
})
