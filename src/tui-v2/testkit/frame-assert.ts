/**
 * tui-v2 testkit frame/patch assertions (WP-02, plan §9.2).
 *
 * Two entry points:
 *   - `applyPatchToCanonicalGrid`: pure replay of a `TerminalPatch` onto a
 *     canonical grid (the "actual" side of differential equivalence). This
 *     is a TEST tool: contract violations (out-of-bounds coordinates, orphan
 *     continuation updates, missing pool ids, unknown image storeKeys) throw.
 *   - `assertFrameEquivalence`: differential-equivalence comparator —
 *     `renderFull(state)` vs replaying the renderer's patches onto the
 *     previous grid — with `compareGrid` as the only grid assertion, plus
 *     cursor/modes and the physical-line-width invariant. Failures persist a
 *     replayable JSONL artifact via `writeTraceFailure` (trace id, seed,
 *     frame id, profile, state/generation, sanitized diff coordinates, last
 *     N events) and then throw.
 *
 * The product renderFull is wired in WP-04+; this WP proves the harness with
 * hand-built frames/patches and a toy text-line renderFull (see
 * test/tui-v2/frame-assert.test.ts).
 */
import os from 'node:os'
import path from 'node:path'
import type { AppEvent } from '../model/events.js'
import type {
  FrameResources,
  PatchOperation,
  TerminalModeSnapshot,
  TerminalPatch,
} from '../renderer/frame.js'
import type { TerminalProfile } from '../terminal/profile.js'
import {
  compareGrid,
  type CanonicalCell,
  type CanonicalGridV1,
  type CanonicalHyperlink,
  type CanonicalImagePlacement,
  type CanonicalStyle,
  type GridDiff,
} from './canonical.js'
import { writeTraceFailure, TRACE_GENERATOR_VERSION } from './trace.js'

const DEFAULT_STYLE: CanonicalStyle = Object.freeze({
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
})

const BLANK: CanonicalCell = Object.freeze({
  grapheme: '',
  width: 1,
  continuation: false,
  resolvedStyle: DEFAULT_STYLE,
  hyperlink: null,
})

function fail(message: string): never {
  throw new TypeError(`applyPatchToCanonicalGrid: ${message}`)
}

// ---------------------------------------------------------------------------
// Physical line width invariant (plan §5.5 line ~700 / §9.2
// "noPhysicalLineExceedsViewport"): every row's cell widths must sum to the
// row length, a wide head must be followed by its continuation inside the
// same row, and a continuation must follow a wide head. Returns violations
// as sanitized coordinate strings (never graphemes).
// ---------------------------------------------------------------------------

export function findLineWidthViolations(grid: CanonicalGridV1): string[] {
  const violations: string[] = []
  const checkRow = (cells: readonly CanonicalCell[], label: string) => {
    let physical = 0
    for (let x = 0; x < cells.length; x++) {
      const cell = cells[x]
      if (cell.width === 2) {
        const next = x + 1 < cells.length ? cells[x + 1] : undefined
        if (!next || !(next.width === 0 && next.grapheme === '')) {
          violations.push(`${label}:x${x}:dangling-wide-head`)
        }
      } else if (cell.width === 0 && cell.grapheme === '') {
        const prev = x > 0 ? cells[x - 1] : undefined
        if (!prev || prev.width !== 2) {
          violations.push(`${label}:x${x}:orphan-continuation`)
        }
      }
      physical += cell.width === 0 && cell.grapheme !== '' ? 0 : cell.width
    }
    if (physical > cells.length) {
      violations.push(`${label}:physical-width ${physical} exceeds ${cells.length}`)
    }
  }
  for (let y = 0; y < grid.height; y++) {
    checkRow(grid.cells.slice(y * grid.width, (y + 1) * grid.width), `row${y}`)
  }
  grid.scrollback.forEach((line, i) => checkRow(line, `scrollback${i}`))
  return violations
}

// ---------------------------------------------------------------------------
// applyPatchToCanonicalGrid
// ---------------------------------------------------------------------------

interface WorkingPlacement {
  readonly storeKey: string
  readonly placement: CanonicalImagePlacement
}

/**
 * Pure patch application on a canonical grid. `resources` operations rebuild
 * the frame-local style/hyperlink pools; subsequent `write-cells` resolve
 * their ids through the pools (a missing id is a contract violation).
 */
export function applyPatchToCanonicalGrid(grid: CanonicalGridV1, patch: TerminalPatch): CanonicalGridV1 {
  const width = grid.width
  const height = grid.height
  const cells: CanonicalCell[] = [...grid.cells]
  let cursor = { ...(grid.cursor as { x: number; y: number; visible: boolean }) }
  let modes: TerminalModeSnapshot = { ...grid.modes }
  // WP-07: append/line-feed are the only ops that may grow scrollback
  // (full-height main-screen LF semantics, mirroring VirtualTerminal).
  let scrollback: CanonicalCell[][] | null = null
  const styles = new Map<number, CanonicalStyle>()
  const hyperlinks = new Map<number, CanonicalHyperlink>()
  const uploads = new Map<string, { protocol: 'kitty' | 'iterm2'; payloadHash: string }>()
  let placements: WorkingPlacement[] = grid.images.map((placement) => ({
    // Canonical grids carry no storeKey; pre-existing placements are keyed
    // by imageId so image-delete on them is a no-op unless re-uploaded.
    storeKey: `preexisting:${placement.imageId}`,
    placement,
  }))

  const blankAt = (index: number) => {
    cells[index] = BLANK
  }
  const healAroundWrite = (x: number, y: number, length: number) => {
    // Overwriting half of a wide char blanks the other half (never orphans).
    if (x > 0) {
      const head = cells[y * width + x - 1]
      if (head.width === 2) blankAt(y * width + x - 1)
    }
    const last = x + length - 1
    if (last + 1 < width) {
      const written = cells[y * width + last]
      if (written.width === 2) blankAt(y * width + last + 1)
      const beyond = cells[y * width + last + 1]
      if (beyond.width === 0 && beyond.grapheme === '' && written.width !== 2) blankAt(y * width + last + 1)
    }
  }

  const resolveCell = (op: Extract<PatchOperation, { kind: 'write-cells' }>, i: number): CanonicalCell => {
    const cell = op.cells[i]
    const style = styles.get(cell.styleId)
    if (!style) fail(`write-cells at (${op.x + i},${op.y}) references missing styleId ${cell.styleId}`)
    let hyperlink: CanonicalHyperlink | null = null
    if (cell.hyperlinkId !== undefined) {
      const link = hyperlinks.get(cell.hyperlinkId)
      if (!link) fail(`write-cells at (${op.x + i},${op.y}) references missing hyperlinkId ${cell.hyperlinkId}`)
      hyperlink = link.params === undefined ? { uri: link.uri } : { uri: link.uri, params: link.params }
    }
    return {
      grapheme: cell.grapheme,
      width: cell.width,
      continuation: cell.width === 0 && cell.grapheme === '',
      resolvedStyle: style,
      hyperlink,
    }
  }

  const applyWriteCells = (op: Extract<PatchOperation, { kind: 'write-cells' }>) => {
    if (!Number.isInteger(op.x) || !Number.isInteger(op.y)) fail('write-cells coordinates must be integers')
    if (op.y < 0 || op.y >= height || op.x < 0 || op.x + op.cells.length > width) {
      fail(`write-cells out of bounds: (${op.x},${op.y}) + ${op.cells.length} cells in ${width}x${height}`)
    }
    // Continuation integrity INSIDE the op: a wide head must be immediately
    // followed by its continuation cell, and a continuation cell must
    // immediately follow a wide head (§5.5: no patch may update only a
    // continuation cell).
    for (let i = 0; i < op.cells.length; i++) {
      const cell = op.cells[i]
      if (cell.width === 2) {
        const next = op.cells[i + 1]
        if (!next || next.width !== 0 || next.grapheme !== '') {
          fail(`write-cells at (${op.x + i},${op.y}): wide head without in-patch continuation`)
        }
      } else if (cell.width === 0 && cell.grapheme === '') {
        const prev = i > 0 ? op.cells[i - 1] : undefined
        if (!prev || prev.width !== 2) {
          fail(`write-cells at (${op.x + i},${op.y}): orphan continuation update`)
        }
      }
    }
    healAroundWrite(op.x, op.y, op.cells.length)
    for (let i = 0; i < op.cells.length; i++) {
      cells[op.y * width + op.x + i] = resolveCell(op, i)
    }
  }

  const applyErase = (op: Extract<PatchOperation, { kind: 'erase' }>) => {
    if (op.x < 0 || op.y < 0 || op.x + op.width > width || op.y + op.height > height) {
      fail(`erase out of bounds: (${op.x},${op.y}) ${op.width}x${op.height} in ${width}x${height}`)
    }
    if (op.width === 0 || op.height === 0) return
    for (let y = op.y; y < op.y + op.height; y++) {
      healAroundWrite(op.x, y, op.width)
      for (let x = op.x; x < op.x + op.width; x++) blankAt(y * width + x)
    }
  }

  const applyScroll = (op: Extract<PatchOperation, { kind: 'scroll' }>) => {
    if (op.top < 0 || op.bottom >= height || op.top > op.bottom || !Number.isInteger(op.delta)) {
      fail(`scroll out of bounds: top=${op.top} bottom=${op.bottom} delta=${op.delta} in ${width}x${height}`)
    }
    // Screen-local region scroll; scrollback is a VirtualTerminal concern and
    // is never mutated by patches.
    const region = op.bottom - op.top + 1
    const count = Math.min(Math.abs(op.delta), region)
    if (op.delta > 0) {
      for (let i = 0; i < count; i++) {
        cells.copyWithin(op.top * width, (op.top + 1) * width, (op.bottom + 1) * width)
        for (let x = 0; x < width; x++) blankAt(op.bottom * width + x)
      }
    } else if (op.delta < 0) {
      for (let i = 0; i < count; i++) {
        cells.copyWithin((op.top + 1) * width, op.top * width, op.bottom * width)
        for (let x = 0; x < width; x++) blankAt(op.top * width + x)
      }
    }
  }

  /**
   * One LF at the replay-tracked cursor (WP-07): at the scroll region bottom
   * the region scrolls up one line — and only a FULL-HEIGHT MAIN-screen
   * region pushes the removed top line into scrollback (xterm semantics,
   * mirrored from VirtualTerminal.advanceRow); otherwise the cursor moves
   * down one row. Column unchanged; wrap-pending clears (not tracked: the
   * final cursor op always re-homes it before comparison).
   */
  const lineFeedOnce = () => {
    const top = modes.scrollRegion.top
    const bottom = modes.scrollRegion.bottom
    if (cursor.y === bottom) {
      if (top < 0 || bottom >= height || top >= bottom) fail(`line-feed with degenerate scroll region ${top}..${bottom}`)
      if (scrollback === null) scrollback = grid.scrollback.map((line) => [...line])
      const removed = cells.slice(top * width, (top + 1) * width)
      if (top === 0 && bottom === height - 1 && !modes.alternateScreen) {
        scrollback.push(removed)
      }
      cells.copyWithin(top * width, (top + 1) * width, (bottom + 1) * width)
      for (let x = 0; x < width; x++) blankAt(bottom * width + x)
    } else {
      cursor = { ...cursor, y: Math.min(height - 1, cursor.y + 1) }
    }
  }

  const applyAppend = (op: Extract<PatchOperation, { kind: 'append' }>) => {
    if (!Array.isArray(op.cells) || op.cells.length === 0) fail('append.cells must be a non-empty full row')
    if (op.cells.length > width) fail(`append row of ${op.cells.length} cells exceeds grid width ${width}`)
    if (cursor.y < 0 || cursor.y >= height) fail(`append with cursor row ${cursor.y} outside ${width}x${height}`)
    const y = cursor.y
    // CR semantics: column home + wrap-pending clears. Continuation
    // integrity inside the row is the §5.5 write-cells rule.
    for (let i = 0; i < op.cells.length; i++) {
      const cell = op.cells[i]
      if (cell.width === 2) {
        const next = op.cells[i + 1]
        if (!next || next.width !== 0 || next.grapheme !== '') {
          fail(`append at (${i},${y}): wide head without in-patch continuation`)
        }
      } else if (cell.width === 0 && cell.grapheme === '') {
        const prev = i > 0 ? op.cells[i - 1] : undefined
        if (!prev || prev.width !== 2) {
          fail(`append at (${i},${y}): orphan continuation update`)
        }
      }
    }
    healAroundWrite(0, y, op.cells.length)
    for (let i = 0; i < op.cells.length; i++) {
      const cell = op.cells[i]
      const style = styles.get(cell.styleId)
      if (!style) fail(`append at (${i},${y}) references missing styleId ${cell.styleId}`)
      let hyperlink: CanonicalHyperlink | null = null
      if (cell.hyperlinkId !== undefined) {
        const link = hyperlinks.get(cell.hyperlinkId)
        if (!link) fail(`append at (${i},${y}) references missing hyperlinkId ${cell.hyperlinkId}`)
        hyperlink = link.params === undefined ? { uri: link.uri } : { uri: link.uri, params: link.params }
      }
      cells[y * width + i] = {
        grapheme: cell.grapheme,
        width: cell.width,
        continuation: cell.width === 0 && cell.grapheme === '',
        resolvedStyle: style,
        hyperlink,
      }
    }
    // A full row leaves the cursor on the last column (pending wrap); a
    // shorter row leaves it just past the last written cell.
    cursor = { ...cursor, x: op.cells.length >= width ? width - 1 : op.cells.length }
    if (op.feed) lineFeedOnce()
  }

  const applyLineFeed = (op: Extract<PatchOperation, { kind: 'line-feed' }>) => {
    if (!Number.isInteger(op.y) || op.y < 0 || op.y >= height) fail(`line-feed y=${op.y} outside ${width}x${height}`)
    if (!Number.isInteger(op.count) || op.count < 0) fail(`line-feed count ${op.count} must be a non-negative integer`)
    // CUP(y+1, 1): row home + column 0 + wrap-pending clears.
    cursor = { ...cursor, x: 0, y: op.y }
    for (let i = 0; i < op.count; i++) lineFeedOnce()
  }

  const applyMode = (op: Extract<PatchOperation, { kind: 'mode' }>) => {
    modes = { ...modes, [op.name]: op.value } as TerminalModeSnapshot
  }

  const applyResources = (resources: FrameResources) => {
    styles.clear()
    hyperlinks.clear()
    for (const style of resources.styles) {
      if (styles.has(style.id)) fail(`resources: duplicate style id ${style.id}`)
      const { id: _id, ...canonical } = style
      styles.set(style.id, canonical)
    }
    for (const link of resources.hyperlinks) {
      if (hyperlinks.has(link.id)) fail(`resources: duplicate hyperlink id ${link.id}`)
      const { id: _id, ...canonical } = link
      hyperlinks.set(link.id, canonical)
    }
  }

  for (const op of patch.operations) {
    switch (op.kind) {
      case 'write-cells':
        applyWriteCells(op)
        break
      case 'erase':
        applyErase(op)
        break
      case 'scroll':
        applyScroll(op)
        break
      case 'append':
        applyAppend(op)
        break
      case 'line-feed':
        applyLineFeed(op)
        break
      case 'cursor':
        if (op.visible ? op.x < 0 || op.y < 0 || op.x >= width || op.y >= height : op.x !== 0 || op.y !== 0) {
          fail(`cursor out of bounds: (${op.x},${op.y}) visible=${op.visible} in ${width}x${height}`)
        }
        cursor = { x: op.x, y: op.y, visible: op.visible }
        break
      case 'mode':
        applyMode(op)
        break
      case 'resources':
        applyResources(op.resources)
        break
      case 'image-upload':
        if (op.storeKey === '') fail('image-upload: empty storeKey')
        uploads.set(op.storeKey, { protocol: op.protocol, payloadHash: op.payloadHash })
        break
      case 'image-place': {
        const upload = uploads.get(op.placement.storeKey)
        if (!upload) fail(`image-place references unknown storeKey ${op.placement.storeKey}`)
        placements.push({
          storeKey: op.placement.storeKey,
          placement: {
            imageId: op.placement.imageId,
            protocol: op.placement.protocol,
            x: op.placement.x,
            y: op.placement.y,
            width: op.placement.width,
            height: op.placement.height,
            payloadHash: op.placement.payloadHash,
          },
        })
        break
      }
      case 'image-delete':
        placements = placements.filter((p) => p.storeKey !== op.storeKey)
        uploads.delete(op.storeKey)
        break
      case 'image-clear':
        placements = []
        uploads.clear()
        break
      default:
        fail(`unknown patch operation ${(op as { kind: string }).kind}`)
    }
  }

  return {
    width,
    height,
    cells,
    cursor,
    modes,
    scrollback: scrollback ?? grid.scrollback,
    images: placements.map((p) => p.placement),
  }
}

// ---------------------------------------------------------------------------
// assertFrameEquivalence
// ---------------------------------------------------------------------------

export interface FrameEquivalenceOptions {
  /** Directory for the replayable failure artifact (JSONL via writeTraceFailure). */
  readonly failureDir?: string
  readonly traceId?: string
  readonly seed?: number
  readonly terminalProfile?: string | TerminalProfile
  readonly frameId?: string
  readonly stateRevision?: number
  readonly generation?: number
  /** Recent events recorded into the failure artifact (bounded upstream). */
  readonly events?: readonly AppEvent[]
  readonly name?: string
}

/**
 * Differential equivalence (§9.2 first class): the patch-replayed grid must
 * equal a fresh full render, with cursor, modes and the physical line width
 * invariant intact. `compareGrid` is the only grid assertion. On any failure
 * a replayable, redacted JSONL artifact is persisted before throwing.
 */
export async function assertFrameEquivalence(
  renderFull: () => CanonicalGridV1,
  applyPatches: () => CanonicalGridV1,
  options: FrameEquivalenceOptions = {},
): Promise<void> {
  const expected = renderFull()
  const actual = applyPatches()

  const comparison = compareGrid(actual, { gridEncoding: 'readable', value: expected })
  const violations = findLineWidthViolations(actual)
  if (comparison.ok && violations.length === 0) return

  const diffs: readonly GridDiff[] = comparison.ok ? [] : comparison.diffs
  const failureDir = options.failureDir ?? path.join(os.tmpdir(), 'tui-v2', 'frame-equivalence-failures')
  const artifactPath = await writeTraceFailure(failureDir, {
    traceId: options.traceId ?? 'frame-equivalence',
    generatorVersion: TRACE_GENERATOR_VERSION,
    seed: options.seed ?? 0,
    terminalProfile: options.terminalProfile ?? 'unknown-conservative',
    ...(options.frameId !== undefined ? { frameId: options.frameId } : {}),
    ...(options.stateRevision !== undefined ? { stateRevision: options.stateRevision } : {}),
    ...(options.generation !== undefined ? { generation: options.generation } : {}),
    diffs,
    events: options.events ?? [],
    name: options.name,
  })
  const parts: string[] = []
  if (!comparison.ok) parts.push(`${diffs.length} sanitized grid diff(s)`)
  if (violations.length > 0) parts.push(`line-width violations: ${violations.join(', ')}`)
  throw new Error(`assertFrameEquivalence failed: ${parts.join('; ')} (replayable artifact: ${artifactPath})`)
}
