/**
 * tui-v2 WP-06b compositor tests (plan §6.3).
 *
 * Covered contract points:
 *   - fixed composition order: baseFrame + overlay stack (back -> front) +
 *     highlight skeleton + cursor pass-through;
 *   - overlay layout: center/edge anchors, absolute/percent sizes, margin,
 *     offsetX/offsetY, maxHeight clipping, row/col overrides, clamping;
 *   - nesting = model stack order; nonCapturing overlays paint without focus
 *     semantics; invisible overlays paint nothing;
 *   - the cells under an overlay always come from THIS frame's baseFrame —
 *     closing an overlay leaves no residue (asserted over two consecutive
 *     frames through the real patch planner + canonical replay);
 *   - wide-grapheme pairs are healed at overlay rect edges (no dangling head
 *     / orphan continuation);
 *   - affectedRegions enumerate open/move/change/close; unchanged overlays
 *     produce no regions;
 *   - base-only input is returned unchanged (identity == WP-06a bytes);
 *   - dialog payloads render through the components/overlays bridge.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { ApprovalDialogPayload } from '../../src/tui-v2/model/overlay-payloads.js'
import type { OverlayState } from '../../src/tui-v2/model/schema.js'
import { compositeFrame, resolveOverlayRect, type OverlayRect } from '../../src/tui-v2/renderer/compositor.js'
import { buildFrame } from '../../src/tui-v2/renderer/frame-builder.js'
import type { Frame, TerminalModeSnapshot } from '../../src/tui-v2/renderer/frame.js'
import { lineStyle, type LineStyle } from '../../src/tui-v2/renderer/lines.js'
import { renderDialogOverlayLines } from '../../src/tui-v2/components/overlays/render-dialog.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import { FullscreenBackend } from '../../src/tui-v2/terminal/fullscreen-backend.js'
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import {
  canonicalizeFrame,
  compareGrid,
} from '../../src/tui-v2/testkit/canonical.js'
import {
  applyPatchToCanonicalGrid,
  findLineWidthViolations,
} from '../../src/tui-v2/testkit/frame-assert.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'

const WIDTH = 20
const HEIGHT = 10

const PROFILE: TerminalProfile = {
  ...getProfile('unicode-ambiguous-narrow'),
  id: 'compositor-test',
  columns: WIDTH,
  rows: HEIGHT,
}

function defaultModes(height: number): TerminalModeSnapshot {
  return {
    alternateScreen: true,
    rawInput: true,
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
function baseFrame(lines: readonly string[], width = WIDTH, height = HEIGHT): Frame {
  return buildFrame({
    frameId: `base-${++frameSeq}`,
    stateRevision: frameSeq,
    width,
    height,
    lines,
    profile: { ...PROFILE, columns: width, rows: height },
    modes: defaultModes(height),
    generation: 0,
  })
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

/** Deterministic overlay content: one line per entry, letter per overlay. */
function letterRenderer(letterById: Readonly<Record<string, string[]>>) {
  return (overlay: OverlayState, _width: number): readonly string[] => letterById[overlay.overlayId] ?? []
}

/** Row text of a frame (graphemes joined per row). */
function rowText(frame: Frame, y: number): string {
  return frame.cells
    .slice(y * frame.stride, (y + 1) * frame.stride)
    .map((cell) => cell.grapheme)
    .join('')
}

function cellAt(frame: Frame, x: number, y: number) {
  return frame.cells[y * frame.stride + x]!
}

// ---------------------------------------------------------------------------
// layout resolution
// ---------------------------------------------------------------------------

test('compositor layout: anchors place the rect inside the frame', () => {
  const o = (anchor: OverlayState['anchor']) => makeOverlay({ overlayId: 'o', anchor, width: 8 })
  // contentHeight 2 for every anchor
  assert.deepEqual(resolveOverlayRect(o('center'), WIDTH, HEIGHT, 2), { x: 6, y: 4, width: 8, height: 2 })
  assert.deepEqual(resolveOverlayRect(o('top-left'), WIDTH, HEIGHT, 2), { x: 0, y: 0, width: 8, height: 2 })
  assert.deepEqual(resolveOverlayRect(o('bottom-right'), WIDTH, HEIGHT, 2), { x: 12, y: 8, width: 8, height: 2 })
  assert.deepEqual(resolveOverlayRect(o('top-center'), WIDTH, HEIGHT, 2), { x: 6, y: 0, width: 8, height: 2 })
  assert.deepEqual(resolveOverlayRect(o('bottom-center'), WIDTH, HEIGHT, 2), { x: 6, y: 8, width: 8, height: 2 })
  assert.deepEqual(resolveOverlayRect(o('left-center'), WIDTH, HEIGHT, 2), { x: 0, y: 4, width: 8, height: 2 })
  assert.deepEqual(resolveOverlayRect(o('right-center'), WIDTH, HEIGHT, 2), { x: 12, y: 4, width: 8, height: 2 })
})

test('compositor layout: percent/absolute sizes, minWidth, maxHeight clip', () => {
  // width percentage is relative to the FRAME width (pi semantics).
  assert.equal(resolveOverlayRect(makeOverlay({ overlayId: 'o', width: '50%' }), WIDTH, HEIGHT, 1).width, 10)
  assert.equal(resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 7 }), WIDTH, HEIGHT, 1).width, 7)
  // minWidth wins over a smaller width; both clamp to the available width.
  assert.equal(
    resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 4, minWidth: 12 }), WIDTH, HEIGHT, 1).width,
    12,
  )
  assert.equal(resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 500 }), WIDTH, HEIGHT, 1).width, 20)
  // maxHeight clips the content; a percentage maxHeight resolves on the frame height.
  assert.equal(
    resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 8, maxHeight: 3 }), WIDTH, HEIGHT, 9).height,
    3,
  )
  assert.equal(
    resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 8, maxHeight: '50%' }), WIDTH, HEIGHT, 9).height,
    5,
  )
  // content shorter than maxHeight keeps its own height
  assert.equal(
    resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 8, maxHeight: 6 }), WIDTH, HEIGHT, 2).height,
    2,
  )
  // oversized content clamps to the available height, never overflows the frame
  const tall = resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 8 }), WIDTH, HEIGHT, 99)
  assert.ok(tall.y + tall.height <= HEIGHT, `rect ${JSON.stringify(tall)} stays inside`)
})

test('compositor layout: margins inset the available region', () => {
  const rect = resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 8, margin: 2 }), WIDTH, HEIGHT, 2)
  // avail 16x6; center: row = 2 + floor((6-2)/2) = 4, col = 2 + floor((16-8)/2) = 6
  assert.deepEqual(rect, { x: 6, y: 4, width: 8, height: 2 })
  const partial = resolveOverlayRect(
    makeOverlay({ overlayId: 'o', width: 8, margin: { top: 2, left: 4 } }),
    WIDTH,
    HEIGHT,
    2,
  )
  assert.deepEqual(partial, { x: 8, y: 5, width: 8, height: 2 })
  // margins shrink the width clamp
  assert.equal(
    resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 100, margin: { left: 4, right: 4 } }), WIDTH, HEIGHT, 1).width,
    12,
  )
})

test('compositor layout: explicit row/col (absolute and percent) beat the anchor; offsets shift', () => {
  assert.deepEqual(
    resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 8, row: 0, col: 0 }), WIDTH, HEIGHT, 2),
    { x: 0, y: 0, width: 8, height: 2 },
  )
  // 100% = bottom/right edge of the available slack (overlay stays in bounds)
  assert.deepEqual(
    resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 8, row: '100%', col: '100%' }), WIDTH, HEIGHT, 2),
    { x: 12, y: 8, width: 8, height: 2 },
  )
  // offsets apply to the anchor position and the result is clamped
  assert.deepEqual(
    resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 8, offsetX: 2, offsetY: 1 }), WIDTH, HEIGHT, 2),
    { x: 8, y: 5, width: 8, height: 2 },
  )
  assert.deepEqual(
    resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 8, row: 50, col: 50 }), WIDTH, HEIGHT, 2),
    { x: 12, y: 8, width: 8, height: 2 },
  )
  // negative offsets clamp at the margin box
  assert.deepEqual(
    resolveOverlayRect(makeOverlay({ overlayId: 'o', width: 8, offsetX: -99, offsetY: -99 }), WIDTH, HEIGHT, 2),
    { x: 0, y: 0, width: 8, height: 2 },
  )
})

// ---------------------------------------------------------------------------
// composition order / stack / capture flags
// ---------------------------------------------------------------------------

test('compositor: overlay paints over the base; stack order resolves overlaps (nesting)', () => {
  const back = makeOverlay({ overlayId: 'back', width: 10, row: 2, col: 2 })
  const front = makeOverlay({ overlayId: 'front', width: 10, row: 3, col: 4 })
  const { frame } = compositeFrame({
    base: baseFrame(['base row 0', 'base row 1', 'base row 2', 'base row 3']),
    profile: PROFILE,
    overlays: [back, front],
    renderOverlay: letterRenderer({ back: ['bbbbbbbbbb'], front: ['ffffffffff'] }),
  })
  // back overlay at rows 2..2, front at row 3; overlap columns 4..11 on... they
  // share no row here, so place them on the same row to prove order:
  assert.equal(rowText(frame, 2).slice(2, 12), 'bbbbbbbbbb')
  assert.equal(rowText(frame, 3).slice(4, 14), 'ffffffffff')

  const overlap = compositeFrame({
    base: baseFrame(['', '', 'xxxxxxxxxxxxxxxxxxxx']),
    profile: PROFILE,
    overlays: [back, makeOverlay({ overlayId: 'front', width: 10, row: 2, col: 4 })],
    renderOverlay: letterRenderer({ back: ['bbbbbbbbbb'], front: ['ffffffffff'] }),
  }).frame
  // Same row: front (top of stack) wins the overlap columns 4..13.
  assert.equal(rowText(overlap, 2), 'xxbbffffffffffxxxxxx')
  // Layer metadata: base z 0, then stack order.
  assert.deepEqual(
    overlap.layers.map((layer) => [layer.id, layer.z]),
    [
      ['base', 0],
      ['back', 1],
      ['front', 2],
    ],
  )
  assert.deepEqual(overlap.layers[1]?.clip, { x: 2, y: 2, width: 10, height: 1 })
})

test('compositor: nonCapturing and invisible overlays', () => {
  const passive = makeOverlay({ overlayId: 'passive', width: 6, row: 1, col: 1, captureInput: false, nonCapturing: true })
  const hidden = makeOverlay({ overlayId: 'hidden', width: 6, row: 3, col: 1, visible: false })
  const { frame } = compositeFrame({
    base: baseFrame(['abcdefghij']),
    profile: PROFILE,
    overlays: [passive, hidden],
    renderOverlay: letterRenderer({ passive: ['pppppp'], hidden: ['hhhhhh'] }),
  })
  // nonCapturing paints (capture semantics stay in the reducer, not here)…
  assert.equal(rowText(frame, 1).slice(1, 7), 'pppppp')
  // …while an invisible overlay paints nothing and records no layer.
  assert.ok(!rowText(frame, 3).includes('hhhhhh'))
  assert.deepEqual(
    frame.layers.map((layer) => layer.id),
    ['base', 'passive'],
  )
})

// ---------------------------------------------------------------------------
// no-residue close / "下方永远来自本次 baseFrame"
// ---------------------------------------------------------------------------

test('compositor: closing an overlay repaints from THIS frame’s base (no previous-frame blit)', () => {
  const backend = new FullscreenBackend()
  const overlay = makeOverlay({ overlayId: 'dlg', width: 8, row: 2, col: 2 })
  const renderer = letterRenderer({ dlg: ['DDDDDDDD', 'DDDDDDDD'] })

  const base1 = baseFrame(['one', 'two', 'three', 'four'])
  const frame1 = compositeFrame({
    base: base1,
    profile: PROFILE,
    overlays: [overlay],
    renderOverlay: renderer,
  }).frame

  // Frame 2: the base content CHANGED under the overlay and the overlay is gone.
  const base2 = baseFrame(['ONE', 'TWO', 'THREE', 'FOUR'])
  const out2 = compositeFrame({ base: base2, profile: PROFILE, overlays: [], renderOverlay: renderer, previous: frame1 })
  // Base-only degradation: the frame IS base2 (identity, byte-equivalent).
  assert.equal(out2.frame, base2)
  // The closed overlay's rect is reported as affected.
  assert.deepEqual(out2.affectedRegions, [{ x: 2, y: 2, width: 8, height: 2 }])

  // Differential proof: planning frame1 -> frame2 and replaying the patch on
  // frame1's canonical grid yields exactly frame2's grid — zero residue.
  const patch = backend.plan(frame1, out2.frame)
  const replayed = applyPatchToCanonicalGrid(canonicalizeFrame(frame1), patch)
  const comparison = compareGrid(replayed, { gridEncoding: 'readable', value: canonicalizeFrame(out2.frame) })
  assert.ok(comparison.ok, `grid mismatch after close: ${JSON.stringify(comparison.diffs)}`)
  assert.deepEqual(findLineWidthViolations(replayed), [])
})

test('compositor: base changed UNDER a visible overlay; cells outside the rect come from the new base', () => {
  const overlay = makeOverlay({ overlayId: 'dlg', width: 6, row: 0, col: 0 })
  const renderer = letterRenderer({ dlg: ['DDDDDD'] })
  const frame1 = compositeFrame({
    base: baseFrame(['alpha-ONE']),
    profile: PROFILE,
    overlays: [overlay],
    renderOverlay: renderer,
  }).frame
  const frame2 = compositeFrame({
    base: baseFrame(['omega-TWO']),
    profile: PROFILE,
    overlays: [overlay],
    renderOverlay: renderer,
    previous: frame1,
  }).frame
  // The overlay covers cols 0..5; cols 6+ show THIS frame's base ('TWO'),
  // never the previous frame's content.
  assert.equal(rowText(frame2, 0), 'DDDDDDTWO' + ' '.repeat(11))
  // Same rect, same revision: the overlay region itself is not "affected"…
  // (base damage under it is the diff planner's exact job).
  assert.deepEqual(
    compositeFrame({
      base: baseFrame(['omega']),
      profile: PROFILE,
      overlays: [overlay],
      renderOverlay: renderer,
      previous: frame1,
    }).affectedRegions,
    [],
  )
})

// ---------------------------------------------------------------------------
// wide-grapheme healing at rect edges
// ---------------------------------------------------------------------------

test('compositor: wide grapheme pairs are healed at the overlay rect edges', () => {
  // base row: a(0) b(1) 你(2-3) c(4) d(5)
  const base = baseFrame(['ab你cd'])
  // Left edge inside the pair: overlay covers cols 3..6.
  const left = compositeFrame({
    base,
    profile: PROFILE,
    overlays: [makeOverlay({ overlayId: 'o', width: 4, row: 0, col: 3 })],
    renderOverlay: letterRenderer({ o: ['XXXX'] }),
  }).frame
  assert.deepEqual(
    { g: cellAt(left, 2, 0).grapheme, w: cellAt(left, 2, 0).width },
    { g: ' ', w: 1 },
    'surviving head blanked',
  )
  assert.equal(rowText(left, 0).slice(3, 7), 'XXXX')
  assert.deepEqual(findLineWidthViolations(canonicalizeFrame(left)), [])

  // Right edge inside the pair: overlay covers cols 1..2 (the head).
  const right = compositeFrame({
    base,
    profile: PROFILE,
    overlays: [makeOverlay({ overlayId: 'o', width: 2, row: 0, col: 1 })],
    renderOverlay: letterRenderer({ o: ['YY'] }),
  }).frame
  assert.deepEqual(
    { g: cellAt(right, 3, 0).grapheme, w: cellAt(right, 3, 0).width },
    { g: ' ', w: 1 },
    'surviving continuation blanked',
  )
  assert.deepEqual(findLineWidthViolations(canonicalizeFrame(right)), [])
})

// ---------------------------------------------------------------------------
// affectedRegions
// ---------------------------------------------------------------------------

test('compositor: affectedRegions track open/change/move/close', () => {
  const renderer = letterRenderer({ o: ['ZZ'] })
  const baseA = baseFrame(['row'])
  const v1 = makeOverlay({ overlayId: 'o', width: 2, row: 1, col: 1 })
  const first = compositeFrame({ base: baseA, profile: PROFILE, overlays: [v1], renderOverlay: renderer })
  // Opening vs a bare previous frame: the new rect is affected.
  const bare = compositeFrame({ base: baseFrame(['row']), profile: PROFILE })
  const opened = compositeFrame({
    base: baseFrame(['row']),
    profile: PROFILE,
    overlays: [v1],
    renderOverlay: renderer,
    previous: bare.frame,
  })
  assert.deepEqual(opened.affectedRegions, [{ x: 1, y: 1, width: 2, height: 1 }])

  // Unchanged (same revision + rect): no regions.
  const same = compositeFrame({
    base: baseFrame(['row']),
    profile: PROFILE,
    overlays: [v1],
    renderOverlay: renderer,
    previous: first.frame,
  })
  assert.deepEqual(same.affectedRegions, [])
  assert.equal(same.frame.metadata.changedRows, 0)

  // Revision bump, same rect: the rect is affected.
  const bumped = compositeFrame({
    base: baseFrame(['row']),
    profile: PROFILE,
    overlays: [makeOverlay({ overlayId: 'o', revision: 2, width: 2, row: 1, col: 1 })],
    renderOverlay: renderer,
    previous: first.frame,
  })
  assert.deepEqual(bumped.affectedRegions, [{ x: 1, y: 1, width: 2, height: 1 }])

  // Move: new rect AND old rect are affected.
  const moved = compositeFrame({
    base: baseFrame(['row']),
    profile: PROFILE,
    overlays: [makeOverlay({ overlayId: 'o', width: 2, row: 4, col: 5 })],
    renderOverlay: renderer,
    previous: first.frame,
  })
  assert.deepEqual(moved.affectedRegions, [
    { x: 5, y: 4, width: 2, height: 1 },
    { x: 1, y: 1, width: 2, height: 1 },
  ])
})

// ---------------------------------------------------------------------------
// highlight skeleton + identity + freeze
// ---------------------------------------------------------------------------

test('compositor: highlight skeleton paints above overlays; empty input is a no-op', () => {
  const inverse: LineStyle = lineStyle({ inverse: true })
  const overlay = makeOverlay({ overlayId: 'o', width: 4, row: 0, col: 0 })
  const { frame } = compositeFrame({
    base: baseFrame(['hello world']),
    profile: PROFILE,
    overlays: [overlay],
    renderOverlay: letterRenderer({ o: ['OOOO'] }),
    highlights: [{ kind: 'selection', x: 2, y: 0, width: 4, height: 1, style: inverse }],
  })
  const styles = new Map(frame.resources.styles.map((style) => [style.id, style]))
  // The region covers overlay cells (0..3) and base cells (4..5): all inverse.
  for (const x of [2, 3, 4, 5]) {
    assert.equal(styles.get(cellAt(frame, x, 0).styleId)?.inverse, true, `cell ${x} highlighted`)
  }
  assert.equal(styles.get(cellAt(frame, 1, 0).styleId)?.inverse, false)
  const layer = frame.layers.find((l) => l.id === 'highlight:selection:0')
  assert.equal(layer?.z, 1000)
  assert.deepEqual(layer?.clip, { x: 2, y: 0, width: 4, height: 1 })
  assert.deepEqual(findLineWidthViolations(canonicalizeFrame(frame)), [])

  // Empty highlights + no overlays = identity (byte-equivalent to WP-06a).
  const bare = baseFrame(['plain'])
  const out = compositeFrame({ base: bare, profile: PROFILE, highlights: [] })
  assert.equal(out.frame, bare)
  assert.deepEqual(out.affectedRegions, [])
})

test('compositor: composed frames are deep-frozen and carry layer revision/clip metadata', () => {
  const overlay = makeOverlay({ overlayId: 'o', revision: 7, width: 4, row: 1, col: 1 })
  const { frame } = compositeFrame({
    base: baseFrame(['abc']),
    profile: PROFILE,
    overlays: [overlay],
    renderOverlay: letterRenderer({ o: ['QQQQ'] }),
  })
  assert.ok(Object.isFrozen(frame))
  assert.ok(Object.isFrozen(frame.cells))
  assert.ok(Object.isFrozen(frame.layers))
  assert.deepEqual(frame.layers[1], { id: 'o', z: 1, revision: 7, clip: { x: 1, y: 1, width: 4, height: 1 } })
  assert.throws(() => {
    ;(frame.layers[1] as { revision: number }).revision = 99
  }, TypeError)
})

test('compositor: geometry mismatch with a live previous frame forces fullRedraw (resize)', () => {
  const wide = baseFrame(['x'], 40, 10)
  const composed = compositeFrame({
    base: baseFrame(['x'], 40, 10),
    profile: PROFILE,
    overlays: [makeOverlay({ overlayId: 'o', width: 4 })],
    renderOverlay: letterRenderer({ o: ['QQQQ'] }),
    previous: wide, // same width here; now build a narrower next frame:
  })
  void composed
  const next = compositeFrame({
    base: baseFrame(['x'], 20, 10),
    profile: PROFILE,
    overlays: [makeOverlay({ overlayId: 'o', width: 4 })],
    renderOverlay: letterRenderer({ o: ['QQQQ'] }),
    previous: composed.frame,
  })
  assert.equal(next.frame.fullRedraw, true)
  assert.equal(next.frame.metadata.fullRedrawReason, 'resize')
})

// ---------------------------------------------------------------------------
// dialog payload bridge
// ---------------------------------------------------------------------------

test('compositor: dialog overlay payloads render through the components bridge', () => {
  const payload: ApprovalDialogPayload = {
    kind: 'approval',
    key: 'k1',
    toolName: 'Bash',
    command: 'ls -la',
    selection: { focusIndex: 0, checked: [], text: '' },
  }
  const overlay = makeOverlay({ overlayId: 'approval:k1', width: 40, payload: payload as OverlayState['payload'] })
  const { frame } = compositeFrame({
    base: baseFrame(['transcript']),
    profile: PROFILE,
    overlays: [overlay],
    renderOverlay: (o, width) =>
      renderDialogOverlayLines(o.payload, width, { profile: PROFILE, theme: DEFAULT_COMPONENT_THEME }),
  })
  assert.ok(frame.layers.some((layer) => layer.id === 'approval:k1'))
  const clip = frame.layers.find((layer) => layer.id === 'approval:k1')?.clip
  assert.ok(clip !== undefined)
  const text = rowText(frame, clip.y)
  // The rect clamps to the 20-column frame, so the title is clipped — assert
  // on the part that survives.
  assert.ok(text.includes('Approval required'), `first overlay row carries the title: ${text}`)
  assert.deepEqual(findLineWidthViolations(canonicalizeFrame(frame)), [])

  // Unknown payloads render nothing and record no layer.
  const foreign = compositeFrame({
    base: baseFrame(['transcript']),
    profile: PROFILE,
    overlays: [makeOverlay({ overlayId: 'foreign', width: 10, payload: { kind: 'unknown-future' } })],
    renderOverlay: (o, width) =>
      renderDialogOverlayLines(o.payload, width, { profile: PROFILE, theme: DEFAULT_COMPONENT_THEME }),
  })
  assert.deepEqual(
    foreign.frame.layers.map((layer) => layer.id),
    ['base'],
  )
})
