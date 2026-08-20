/**
 * tui-v2 WP-06a frame-builder tests: the §5.5 Frame/Cell contract on the
 * single-base-layer path (compositor lands in WP-06b+; `layers` is the
 * reserved seam).
 *
 * Covered contract points (plan §5.5 line ~692):
 *   - stride === width, row-major dense width*height grid;
 *   - wide head width:2 + continuation width:0/grapheme:'' invariants;
 *   - blank cells explicitly styled (padding resolves to default style id 0);
 *   - styleId/hyperlinkId frame-local, content-keyed, complete resources
 *     resolvable by id (never by array position);
 *   - hidden cursor normalized to (0,0); visible out-of-frame cursor throws;
 *   - metadata assembly (changedRows/renderMs/diffMs/terminalProfileId/
 *     fullRedrawReason) + generation/fullRedraw;
 *   - published frames are deep-frozen (§5.1): mutation attempts throw and
 *     cannot change the canonical grid;
 *   - differential proof: the full-render patch replays to the identical
 *     canonical grid (applyPatchToCanonicalGrid) AND the writer's fixed
 *     SGR/OSC 8 encoder bytes reproduce the frame in the VirtualTerminal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildFrame } from '../../src/tui-v2/renderer/frame-builder.js'
import { createCellPipelineDiagnostics } from '../../src/tui-v2/renderer/cells.js'
import type {
  Frame,
  TerminalCell,
  TerminalModeSnapshot,
} from '../../src/tui-v2/renderer/frame.js'
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import { planScreenPatch } from '../../src/tui-v2/terminal/screen-plan.js'
import { encodePatchOperationsSync } from '../../src/tui-v2/terminal/writer.js'
import {
  canonicalizeFrame,
  compareGrid,
  gridSha256,
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

const WIDTH = 12
const HEIGHT = 4

const PROFILE: TerminalProfile = {
  ...getProfile('unicode-ambiguous-narrow'),
  id: 'frame-builder-test',
  columns: WIDTH,
  rows: HEIGHT,
}

/** VT-default mode snapshot (what a fresh VirtualTerminal reports). */
function defaultModes(height: number): TerminalModeSnapshot {
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

function baseInput(lines: readonly string[]): Parameters<typeof buildFrame>[0] {
  return {
    frameId: 'frame-1',
    stateRevision: 7,
    width: WIDTH,
    height: HEIGHT,
    lines,
    profile: PROFILE,
    modes: defaultModes(HEIGHT),
    generation: 3,
  }
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

function blankCanonicalCell(): CanonicalCell {
  return { grapheme: '', width: 1, continuation: false, resolvedStyle: DEFAULT_STYLE, hyperlink: null }
}

function emptyGrid(frame: Frame): CanonicalGridV1 {
  return {
    width: frame.width,
    height: frame.height,
    cells: Array.from({ length: frame.width * frame.height }, blankCanonicalCell),
    cursor: { x: 0, y: 0, visible: false },
    modes: frame.modes,
    scrollback: [],
    images: [],
  }
}

// ---------------------------------------------------------------------------
// grid shape + width hard guard
// ---------------------------------------------------------------------------

test('fullscreen frame: stride === width, dense row-major grid, styled blanks', () => {
  const frame = buildFrame(baseInput(['hello', '你好']))
  assert.equal(frame.stride, frame.width)
  assert.equal(frame.cells.length, WIDTH * HEIGHT)
  // Row-major: 'h' at (0,0), wide head '你' at (0,1) with continuation (1,1).
  assert.equal((frame.cells[0] as TerminalCell).grapheme, 'h')
  assert.deepEqual(
    { grapheme: (frame.cells[WIDTH] as TerminalCell).grapheme, width: (frame.cells[WIDTH] as TerminalCell).width },
    { grapheme: '你', width: 2 },
  )
  assert.deepEqual(
    { grapheme: (frame.cells[WIDTH + 1] as TerminalCell).grapheme, width: (frame.cells[WIDTH + 1] as TerminalCell).width },
    { grapheme: '', width: 0 },
  )
  // Blank padding carries an explicit style that resolves to the default.
  const styles = new Map(frame.resources.styles.map((style) => [style.id, style]))
  const padding = frame.cells[5] as TerminalCell
  assert.equal(padding.grapheme, ' ')
  assert.deepEqual(styles.get(padding.styleId), { id: 0, ...DEFAULT_STYLE })
  // Missing rows are blank-filled.
  const lastRow = frame.cells.slice(3 * WIDTH, 4 * WIDTH)
  assert.ok(lastRow.every((cell) => cell.grapheme === ' ' && cell.styleId === 0))
})

test('fullscreen frame: every physical row satisfies assertLineWidth <= viewport.width', () => {
  const diagnostics = createCellPipelineDiagnostics()
  const frame = buildFrame({
    ...baseInput([
      'short',
      'this logical line is definitely longer than twelve columns',
      '0123456789a你cd', // wide grapheme straddles the right edge -> clipped whole
      '', // '' row is blank-filled
    ]),
    diagnostics,
  })
  const grid = canonicalizeFrame(frame)
  assert.deepEqual(findLineWidthViolations(grid), [])
  for (let y = 0; y < frame.height; y++) {
    const row = frame.cells.slice(y * frame.stride, (y + 1) * frame.stride)
    const columns = row.reduce((sum, cell) => sum + cell.width, 0)
    assert.ok(columns <= frame.width, `row ${y} physical width ${columns} <= ${frame.width}`)
  }
  // Clipping happened (long line + straddling wide grapheme) and is diagnosed.
  assert.equal(diagnostics.clippedLines, 2)
  assert.equal(diagnostics.overwideGraphemes, 1)
})

test('fullscreen frame: extra lines beyond height are dropped, never leak', () => {
  const frame = buildFrame(baseInput(['one', 'two', 'three', 'four', 'FIVE-DROPPED']))
  const text = frame.cells.map((cell) => cell.grapheme).join('')
  assert.ok(!text.includes('FIVE'), 'rows beyond height never enter the frame')
})

// ---------------------------------------------------------------------------
// resources: identity, completeness, frame-locality
// ---------------------------------------------------------------------------

test('fullscreen frame: resources are complete, unique and resolvable by id', () => {
  const frame = buildFrame(
    baseInput([
      '\x1b[1;31mAB\x1b[0m \x1b[38;5;209mC\x1b[0m',
      '\x1b[31;1mDE\x1b[0m \x1b]8;;https://x.example\x07L1\x1b]8;;\x07\x1b]8;;https://x.example\x07L2\x1b]8;;\x07',
    ]),
  )
  // Ids are unique within each pool.
  const styleIds = frame.resources.styles.map((style) => style.id)
  assert.equal(new Set(styleIds).size, styleIds.length)
  const linkIds = frame.resources.hyperlinks.map((link) => link.id)
  assert.equal(new Set(linkIds).size, linkIds.length)
  // Content-keyed dedupe: '1;31' and '31;1' share one style; same uri shares one link id.
  assert.equal(frame.resources.styles.length, 3) // default + bold-red + ansi256:209
  assert.equal(frame.resources.hyperlinks.length, 1)
  // Every cell resolves through an id-keyed map (never array position).
  const styles = new Map(frame.resources.styles.map((style) => [style.id, style]))
  const links = new Map(frame.resources.hyperlinks.map((link) => [link.id, link]))
  for (const cell of frame.cells) {
    assert.ok(styles.has(cell.styleId), `styleId ${cell.styleId} resolvable`)
    if (cell.hyperlinkId !== undefined) {
      assert.ok(links.has(cell.hyperlinkId), `hyperlinkId ${cell.hyperlinkId} resolvable`)
    }
  }
  const link = frame.resources.hyperlinks[0]
  assert.equal(link?.uri, 'https://x.example')
  assert.equal(links.get(link?.id as number)?.uri, 'https://x.example')
})

test('fullscreen frame: style ids are frame-local (never borrowed across frames)', () => {
  const first = buildFrame(baseInput(['\x1b[31mred\x1b[0m']))
  const second = buildFrame(baseInput(['plain']))
  // Both frames are self-contained: id 0 is the default style in each, and the
  // second frame knows nothing about the first frame's red run.
  assert.equal(first.resources.styles.length, 2)
  assert.equal(second.resources.styles.length, 1)
  assert.equal(second.resources.styles[0]?.id, 0)
})

// ---------------------------------------------------------------------------
// cursor + metadata
// ---------------------------------------------------------------------------

test('fullscreen frame: hidden cursor normalizes to (0,0); visible cursor is bounds-checked', () => {
  assert.deepEqual(buildFrame(baseInput([])).cursor, { x: 0, y: 0, visible: false })
  // A hidden cursor with stale coordinates is still normalized to (0,0).
  assert.deepEqual(
    buildFrame({ ...baseInput([]), cursor: { x: 5, y: 2, visible: false } }).cursor,
    { x: 0, y: 0, visible: false },
  )
  const visible = buildFrame({ ...baseInput([]), cursor: { x: 3, y: 1, visible: true } })
  assert.deepEqual(visible.cursor, { x: 3, y: 1, visible: true })
  assert.throws(
    () => buildFrame({ ...baseInput([]), cursor: { x: WIDTH, y: 0, visible: true } }),
    /outside 12x4 frame/,
  )
  assert.throws(
    () => buildFrame({ ...baseInput([]), cursor: { x: 0.5, y: 0, visible: true } }),
    /outside 12x4 frame/,
  )
})

test('fullscreen frame: metadata and generation assembly', () => {
  const frame = buildFrame({
    ...baseInput(['x']),
    fullRedraw: true,
    fullRedrawReason: 'resize',
    renderMs: 4,
    diffMs: 1,
  })
  assert.equal(frame.generation, 3)
  assert.equal(frame.fullRedraw, true)
  assert.equal(frame.stateRevision, 7)
  assert.deepEqual(frame.metadata, {
    changedRows: HEIGHT, // whole-frame publish: the honest default
    renderMs: 4,
    diffMs: 1,
    terminalProfileId: 'frame-builder-test',
    fullRedrawReason: 'resize',
  })
  // layers/images are the compositor seam: present and empty on base frames.
  assert.deepEqual(frame.layers, [])
  assert.deepEqual(frame.images, [])
  const custom = buildFrame({ ...baseInput(['x']), changedRows: 2 })
  assert.equal(custom.metadata.changedRows, 2)
})

// ---------------------------------------------------------------------------
// immutability (§5.1)
// ---------------------------------------------------------------------------

test('fullscreen frame: published frames are frozen; mutation cannot affect canonical output', () => {
  const frame = buildFrame(
    baseInput(['\x1b[31mred\x1b[0m \x1b]8;;https://x.example\x07L\x1b]8;;\x07']),
  )
  const before = gridSha256(canonicalizeFrame(frame))
  assert.ok(Object.isFrozen(frame))
  assert.ok(Object.isFrozen(frame.cells))
  assert.ok(Object.isFrozen(frame.cells[0]))
  assert.ok(Object.isFrozen(frame.resources.styles[0]))
  assert.ok(Object.isFrozen(frame.modes.scrollRegion))
  // ESM is strict mode: every mutation attempt throws TypeError.
  assert.throws(() => {
    ;(frame.cells[0] as { grapheme: string }).grapheme = 'X'
  }, TypeError)
  assert.throws(() => {
    ;(frame as { width: number }).width = 1
  }, TypeError)
  assert.throws(() => {
    ;(frame.resources.styles[1] as { foreground: string }).foreground = 'blue'
  }, TypeError)
  assert.throws(() => {
    ;(frame.modes.scrollRegion as { top: number }).top = 2
  }, TypeError)
  assert.equal(gridSha256(canonicalizeFrame(frame)), before)
})

// ---------------------------------------------------------------------------
// differential proof: patch replay and writer bytes reproduce the frame
// ---------------------------------------------------------------------------

const STYLED_LINES = [
  '\x1b[1;31mbold-red\x1b[0m 你', // named color (canonicalized) + wide grapheme
  // xterm (and the VT oracle) represents an OSC 8 hyperlink with the
  // underline attribute in the buffer, so linked cells carry SGR 4.
  '\x1b]8;;https://x.example\x07\x1b[4mlink\x1b[0m\x1b]8;;\x07\tend', // hyperlink + tab
  '\x1b[38;5;209m256\x1b[0m \x1b[38;2;171;205;239mtrue\x1b[0m',
  'plain',
]

test('fullscreen frame: full-render patch replays to the identical canonical grid', () => {
  const frame = buildFrame(baseInput(STYLED_LINES))
  const patch = planScreenPatch(null, frame, 1)
  // §5.5: the resources operation is committed before any cell write.
  assert.equal(patch.operations[0]?.kind, 'resources')
  const replayed = applyPatchToCanonicalGrid(emptyGrid(frame), patch)
  const expected = canonicalizeFrame(frame)
  const comparison = compareGrid(replayed, { gridEncoding: 'readable', value: expected })
  assert.ok(comparison.ok, `grid mismatch: ${JSON.stringify(comparison.diffs)}`)
  assert.deepEqual(findLineWidthViolations(replayed), [])
})

test('fullscreen frame: writer SGR/OSC8 bytes reproduce the frame in the virtual terminal', () => {
  const frame = buildFrame(baseInput(STYLED_LINES))
  const patch = planScreenPatch(null, frame, 1)
  const { encoded, bytes } = encodePatchOperationsSync(patch.operations)
  // patch.bytes is computed by the same fixed encoder (§5.5 byte accounting).
  assert.equal(bytes, patch.bytes)

  const vt = new VirtualTerminal(PROFILE)
  vt.write(encoded)
  const actual = vt.snapshot()
  const expected = canonicalizeFrame(frame)
  const comparison = compareGrid(actual, { gridEncoding: 'readable', value: expected })
  assert.ok(comparison.ok, `vt grid mismatch: ${JSON.stringify(comparison.diffs)}`)
})

test('fullscreen frame: buildFrame rejects degenerate geometry', () => {
  assert.throws(() => buildFrame({ ...baseInput([]), width: 0 }), TypeError)
  assert.throws(() => buildFrame({ ...baseInput([]), height: -1 }), TypeError)
})
