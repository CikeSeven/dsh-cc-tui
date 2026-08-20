/**
 * tui-v2 WP-02 frame/patch assertion harness tests (plan §9.2 first class).
 *
 * Proves the differential-equivalence harness with hand-built frames and a
 * toy text-line renderFull (the product renderFull lands in WP-04+):
 *   - applyPatchToCanonicalGrid replays every patch op kind correctly
 *   - contract violations (out-of-bounds, orphan continuation, missing pool
 *     ids, unknown image storeKeys) throw
 *   - assertFrameEquivalence passes when patch replay equals a fresh render
 *   - assertFrameEquivalence rejects on a mismatch AND persists a replayable
 *     failure artifact that readTrace can load
 *
 * Top-level test names contain "virtual terminal" so
 * `--test-name-pattern 'trace|virtual terminal|redaction'` selects this file.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TerminalModeSnapshot, TerminalPatch } from '../../src/tui-v2/renderer/frame.js'
import type { CanonicalCell, CanonicalGridV1, CanonicalStyle } from '../../src/tui-v2/testkit/canonical.js'
import {
  applyPatchToCanonicalGrid,
  assertFrameEquivalence,
  findLineWidthViolations,
} from '../../src/tui-v2/testkit/frame-assert.js'
import { readTrace } from '../../src/tui-v2/testkit/trace.js'

const STYLE: CanonicalStyle = {
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
}

const RED: CanonicalStyle = { ...STYLE, foreground: 'ansi16:1' }

function blankCell(): CanonicalCell {
  return { grapheme: '', width: 1, continuation: false, resolvedStyle: STYLE, hyperlink: null }
}

function textCell(grapheme: string, style: CanonicalStyle = STYLE): CanonicalCell {
  return { grapheme, width: 1, continuation: false, resolvedStyle: style, hyperlink: null }
}

function defaultModes(): TerminalModeSnapshot {
  return {
    alternateScreen: false,
    rawInput: false,
    mouse: 'off',
    bracketedPaste: false,
    syncOutput: false,
    autowrap: true,
    wrapPending: false,
    scrollRegion: { top: 0, bottom: 2 },
    cursorStyle: 'block',
    cursorVisible: true,
    kittyKeyboard: false,
    modifyOtherKeys: false,
    focusReporting: false,
    windowsDec9001: false,
    osc133: false,
    title: null,
    progress: { state: 'none' },
  }
}

function blankGrid(width = 6, height = 3): CanonicalGridV1 {
  return {
    width,
    height,
    cells: Array.from({ length: width * height }, blankCell),
    cursor: { x: 0, y: 0, visible: true },
    modes: defaultModes(),
    scrollback: [],
    images: [],
  }
}

/** Toy renderFull: narrow text lines, one cell per char, default style. */
function renderLines(lines: readonly string[], width = 6, height = 3): CanonicalGridV1 {
  const grid = blankGrid(width, height)
  const cells = [...grid.cells]
  lines.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) cells[y * width + x] = textCell(line[x])
  })
  return { ...grid, cells }
}

function patch(operations: TerminalPatch['operations']): TerminalPatch {
  return { frameId: 'f1', stateRevision: 1, patchSeq: 1, generation: 1, operations, bytes: 0, fullRedraw: false }
}

const DEFAULT_RESOURCES = {
  kind: 'resources' as const,
  resources: { styles: [{ id: 1, ...STYLE }], hyperlinks: [] },
}

function row(grid: CanonicalGridV1, y: number): string {
  return grid.cells
    .slice(y * grid.width, (y + 1) * grid.width)
    .map((c) => (c.continuation ? '→' : c.grapheme === '' ? '·' : c.grapheme))
    .join('')
}

test('virtual terminal patch replay: write-cells resolves styles and hyperlinks via the resources pool', () => {
  const grid = applyPatchToCanonicalGrid(
    blankGrid(),
    patch([
      {
        kind: 'resources',
        resources: {
          styles: [{ id: 1, ...RED }],
          hyperlinks: [{ id: 7, uri: 'https://example.com', params: 'id=x' }],
        },
      },
      {
        kind: 'write-cells',
        x: 1,
        y: 1,
        cells: [
          { grapheme: 'A', width: 1, styleId: 1, hyperlinkId: 7 },
          { grapheme: '字', width: 2, styleId: 1 },
          { grapheme: '', width: 0, styleId: 1 },
        ],
      },
    ]),
  )
  assert.equal(row(grid, 1), '·A字→··')
  const a = grid.cells[grid.width + 1]
  assert.equal(a.resolvedStyle.foreground, 'ansi16:1')
  assert.deepEqual(a.hyperlink, { uri: 'https://example.com', params: 'id=x' })
  const head = grid.cells[grid.width + 2]
  assert.equal(head.width, 2)
  assert.equal(grid.cells[grid.width + 3].continuation, true)
})

test('virtual terminal patch replay: erase, scroll, mode and cursor ops', () => {
  let grid = renderLines(['abcdef', 'ghijkl', 'mnopqr'])
  grid = applyPatchToCanonicalGrid(grid, patch([{ kind: 'erase', x: 2, y: 0, width: 2, height: 1 }]))
  assert.equal(row(grid, 0), 'ab··ef')

  grid = applyPatchToCanonicalGrid(grid, patch([{ kind: 'scroll', top: 0, bottom: 2, delta: 1 }]))
  assert.equal(row(grid, 0), 'ghijkl')
  assert.equal(row(grid, 1), 'mnopqr')
  assert.equal(row(grid, 2), '······')
  // Scroll is screen-local: scrollback is a VirtualTerminal concern.
  assert.equal(grid.scrollback.length, 0)

  grid = applyPatchToCanonicalGrid(grid, patch([{ kind: 'scroll', top: 1, bottom: 2, delta: -1 }]))
  assert.equal(row(grid, 1), '······')
  assert.equal(row(grid, 2), 'mnopqr')

  grid = applyPatchToCanonicalGrid(
    grid,
    patch([
      { kind: 'mode', name: 'bracketedPaste', value: true },
      { kind: 'cursor', x: 3, y: 2, visible: true },
    ]),
  )
  assert.equal(grid.modes.bracketedPaste, true)
  assert.deepEqual(grid.cursor, { x: 3, y: 2, visible: true })
})

test('virtual terminal patch replay: image upload/place/delete/clear lifecycle', () => {
  const kittyHash = '1'.repeat(64)
  const itermHash = '2'.repeat(64)
  const kittyKey = `image:kitty:${kittyHash}`
  const itermKey = `image:iterm2:${itermHash}`
  const placement = {
    imageId: 'img-1',
    protocol: 'kitty' as const,
    x: 0,
    y: 0,
    width: 2,
    height: 1,
    payloadHash: kittyHash,
    storeKey: kittyKey,
  }
  let grid = applyPatchToCanonicalGrid(
    blankGrid(),
    patch([
      { kind: 'image-upload', storeKey: kittyKey, protocol: 'kitty', payloadHash: kittyHash },
      { kind: 'image-place', placement },
    ]),
  )
  assert.equal(grid.images.length, 1)
  assert.match(grid.images[0].imageId, /^kitty-p[1-9]\d*$/)
  assert.equal(grid.images[0].payloadHash, kittyHash)

  grid = applyPatchToCanonicalGrid(
    grid,
    patch([
      // Canonical replay reconstructs the deterministic protocol+hash storeKey.
      { kind: 'image-delete', storeKey: kittyKey },
    ]),
  )
  assert.equal(grid.images.length, 0)

  grid = applyPatchToCanonicalGrid(
    grid,
    patch([
      { kind: 'image-upload', storeKey: itermKey, protocol: 'iterm2', payloadHash: itermHash },
      { kind: 'image-place', placement: { ...placement, storeKey: itermKey, protocol: 'iterm2', payloadHash: itermHash } },
      // Same-patch delete removes the placement.
      { kind: 'image-delete', storeKey: itermKey },
    ]),
  )
  assert.equal(grid.images.length, 0)

  grid = applyPatchToCanonicalGrid(grid, patch([{ kind: 'image-clear' }]))
  assert.equal(grid.images.length, 0)
})

test('virtual terminal patch replay: contract violations throw', () => {
  const grid = blankGrid()
  // Out-of-bounds write.
  assert.throws(
    () => applyPatchToCanonicalGrid(grid, patch([DEFAULT_RESOURCES, { kind: 'write-cells', x: 5, y: 0, cells: [{ grapheme: 'A', width: 1, styleId: 1 }, { grapheme: 'B', width: 1, styleId: 1 }] }])),
    /out of bounds/,
  )
  // Orphan continuation update (continuation cell not preceded by a wide head).
  assert.throws(
    () => applyPatchToCanonicalGrid(grid, patch([DEFAULT_RESOURCES, { kind: 'write-cells', x: 0, y: 0, cells: [{ grapheme: '', width: 0, styleId: 1 }] }])),
    /orphan continuation/,
  )
  // Wide head without in-patch continuation.
  assert.throws(
    () => applyPatchToCanonicalGrid(grid, patch([DEFAULT_RESOURCES, { kind: 'write-cells', x: 0, y: 0, cells: [{ grapheme: '字', width: 2, styleId: 1 }] }])),
    /wide head without in-patch continuation/,
  )
  // Missing style pool id.
  assert.throws(
    () => applyPatchToCanonicalGrid(grid, patch([{ kind: 'write-cells', x: 0, y: 0, cells: [{ grapheme: 'A', width: 1, styleId: 99 }] }])),
    /missing styleId 99/,
  )
  // image-place without upload.
  assert.throws(
    () =>
      applyPatchToCanonicalGrid(
        grid,
        patch([
          {
            kind: 'image-place',
            placement: { imageId: 'i', protocol: 'kitty', x: 0, y: 0, width: 1, height: 1, payloadHash: 'h', storeKey: 'nope' },
          },
        ]),
      ),
    /unknown storeKey/,
  )
  // Cursor out of bounds.
  assert.throws(
    () => applyPatchToCanonicalGrid(grid, patch([{ kind: 'cursor', x: 6, y: 0, visible: true }])),
    /cursor out of bounds/,
  )
})

test('virtual terminal patch replay: overwriting half of a wide char heals the other half', () => {
  const wide = applyPatchToCanonicalGrid(
    blankGrid(),
    patch([
      DEFAULT_RESOURCES,
      {
        kind: 'write-cells',
        x: 1,
        y: 0,
        cells: [
          { grapheme: '字', width: 2, styleId: 1 },
          { grapheme: '', width: 0, styleId: 1 },
        ],
      },
    ]),
  )
  assert.equal(row(wide, 0), '·字→···')
  const healed = applyPatchToCanonicalGrid(
    wide,
    patch([DEFAULT_RESOURCES, { kind: 'write-cells', x: 2, y: 0, cells: [{ grapheme: 'X', width: 1, styleId: 1 }] }]),
  )
  assert.equal(row(healed, 0), '··X···')
  assert.deepEqual(findLineWidthViolations(healed), [])
})

test('virtual terminal frame equivalence: toy renderFull matches patch replay', async () => {
  const lines = ['hello', 'world', '!']
  const renderFull = () => renderLines(lines)
  const applyPatches = () =>
    applyPatchToCanonicalGrid(
      blankGrid(),
      patch([
        DEFAULT_RESOURCES,
        ...lines.map((line, y) => ({
          kind: 'write-cells' as const,
          x: 0,
          y,
          cells: Array.from(line, (grapheme) => ({ grapheme, width: 1 as const, styleId: 1 })),
        })),
      ]),
    )
  await assertFrameEquivalence(renderFull, applyPatches, { name: 'toy-pass' })
})

test('virtual terminal frame equivalence: mismatch rejects and persists a replayable artifact', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-frame-eq-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const renderFull = () => renderLines(['hello', 'world', '!'])
  const applyPatches = () =>
    applyPatchToCanonicalGrid(
      blankGrid(),
      patch([
        DEFAULT_RESOURCES,
        { kind: 'write-cells', x: 0, y: 0, cells: [{ grapheme: 'X', width: 1, styleId: 1 }] },
      ]),
    )
  await assert.rejects(
    assertFrameEquivalence(renderFull, applyPatches, {
      failureDir: dir,
      traceId: 'frame-eq-test',
      seed: 7,
      terminalProfile: 'unicode-ambiguous-narrow',
      name: 'toy-mismatch',
    }),
    /assertFrameEquivalence failed: \d+ sanitized grid diff/,
  )
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  const loaded = await readTrace(path.join(dir, files[0]))
  const failure = loaded.lines.find((l) => l.kind === 'failure')
  assert.ok(failure && failure.kind === 'failure')
  if (failure.kind === 'failure') {
    assert.equal(failure.traceId, 'frame-eq-test')
    assert.equal(failure.diffs?.[0].kind, 'cell')
  }
})
