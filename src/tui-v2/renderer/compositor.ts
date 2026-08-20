/**
 * tui-v2 compositor (WP-06b, plan §6.3).
 *
 * Fixed composition order:
 *
 *   baseFrame (this frame's buildFrame output)
 *     + overlay stack (back -> front, model stack order)
 *     + selection/search highlight regions (skeleton, see below)
 *     + cursor (hardware cursor metadata = Frame.cursor, passed through)
 *     = finalFrame
 *
 * HARD RULE (§6.3): the cells under an overlay ALWAYS come from THIS frame's
 * baseFrame. The compositor rebuilds the final grid from `base` on every
 * call and never blits from the previous final frame, so closing or moving
 * an overlay repaints the revealed region with current base content by
 * construction. `previous` is used ONLY to compute `affectedRegions` (the
 * compositor-introduced damage rectangles vs the last composition) and the
 * `changedRows` metadata — never as a cell source.
 *
 * Overlay layout mirrors the vendored pi `resolveOverlayLayout` semantics
 * (vendor/pi-tui/src/tui.ts): margins inset the available region; `width` /
 * `maxHeight` / `minWidth` accept absolute columns/rows or `<n>%` of the
 * FRAME dimension; `row`/`col` accept absolute positions or `<n>%` of the
 * available slack; otherwise the anchor (center/edge/corner) places the
 * rect; offsetX/offsetY shift it; the result is clamped inside the margins.
 * Differences forced by the cell grid: every resolved value is an integer
 * (fractional absolutes are truncated), and the rect height is clamped to
 * the available height (pi lets an oversized overlay overflow and relies on
 * line-index clipping; a cell grid clips by clamping instead).
 *
 * Overlay content: the injected `renderOverlay` bridge turns an
 * OverlayState payload into trusted logical lines (components/overlays/*
 * minimal dialog components). Each line is re-parsed through the §6.1 cell
 * pipeline, fitted to the rect width (`fitCellsToWidth` — clip + pad), and
 * blitted into the rect. Overlays paint exactly their content rows (at most
 * `maxHeight`); transparent areas below the content stay base. Blitting
 * heals wide-grapheme pairs at the rect edges (an overwritten head blanks
 * its surviving continuation and vice versa — exactly what a real terminal
 * does), so the composed grid never carries dangling heads or orphan
 * continuations.
 *
 * Resource identity: the composed frame gets a fresh ResourceTable; base
 * cells are re-interned by RESOLVED content (style/hyperlink ids are
 * frame-local, §5.5 — never borrowed across frames), overlay/highlight
 * cells intern alongside them. When no overlay and no highlight region is
 * present the compositor returns the base frame UNCHANGED (identity), so
 * the base-only degradation path stays byte-equivalent to the WP-06a
 * output.
 *
 * Selection/search highlight SKELETON: the model has no selection/search
 * state yet (WP-06c/WP-08). The compositor accepts optional `highlights`
 * regions (cell rects + style, painted above the overlay stack per §6.3);
 * absent/empty regions are a no-op. The full producers land with the
 * selection/search work packages (registered in plan §15.1).
 *
 * `affectedRegions` proof rule: compositor damage is enumerable by
 * construction — the union of current overlay/highlight rects whose
 * (id, revision, clip) changed vs `previous`, plus the previous rects of
 * layers that vanished or moved. When `previous` has a different geometry
 * the proof is impossible and the frame is forced to fullRedraw
 * (`fullRedrawReason` from the base frame, defaulting to 'resize'). Base
 * frame damage is NOT part of affectedRegions: the diff planner's
 * cell-level diff handles it exactly.
 *
 * Dependency rule (§4.3): renderer imports runtime helpers from model
 * (`deepFreeze`, same as frame-builder) and `import type` from terminal.
 * The compositor is a PURE function: no timers, no subscriptions, no writer
 * access.
 */
import { deepFreeze } from '../model/schema.js'
import type { OverlayState } from '../model/schema.js'
import type { TerminalProfile } from '../terminal/profile.js'
import {
  createResourceTable,
  fitCellsToWidth,
  terminalCellsFromLineCells,
  trustedLineCells,
  type CellPipelineDiagnostics,
} from './cells.js'
import type { Frame, FrameLayer, FrameMetadata, TerminalCell } from './frame.js'
import type { LineStyle } from './lines.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Integer cell rectangle inside the frame. */
export interface OverlayRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Selection/search highlight region (WP-06b skeleton): a cell rect painted
 * with `style` ABOVE the overlay stack (§6.3 composition order). Producers
 * (model selection/search state) land in WP-06c/WP-08; until then callers
 * pass nothing and the stage is a no-op.
 */
export interface HighlightRegion {
  readonly kind: 'selection' | 'search'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly style: LineStyle
}

/**
 * Bridge from an overlay payload to trusted logical lines at the resolved
 * content width (components/overlays/* live above the renderer, so the
 * bridge is injected — §4.3). Unknown payloads must render as zero lines.
 */
export type CompositorOverlayRenderer = (overlay: OverlayState, width: number) => readonly string[]

export interface CompositorInput {
  /** This frame's base layer (buildFrame output). Never mutated. */
  readonly base: Frame
  readonly profile: TerminalProfile
  /** Ordered overlay stack, back -> front (model order). Invisible overlays are skipped. */
  readonly overlays?: readonly OverlayState[]
  readonly renderOverlay?: CompositorOverlayRenderer
  /** Selection/search highlight skeleton; empty/absent = no-op. */
  readonly highlights?: readonly HighlightRegion[]
  /**
   * Previous FINAL (composed) frame — used only for affectedRegions proof
   * and changedRows metadata. Never a cell source.
   */
  readonly previous?: Frame | null
  readonly diagnostics?: CellPipelineDiagnostics
}

export interface CompositorOutput {
  readonly frame: Frame
  /** Compositor-introduced damage rectangles vs `previous` (see header). */
  readonly affectedRegions: readonly OverlayRect[]
}

// ---------------------------------------------------------------------------
// Overlay layout (mirrors vendor/pi-tui resolveOverlayLayout)
// ---------------------------------------------------------------------------

type Dimension = number | `${number}%`

function parseSize(value: Dimension | undefined, referenceSize: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') return Math.max(0, Math.trunc(value))
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value)
  if (match === null) return undefined
  return Math.floor((referenceSize * Number.parseFloat(match[1] as string)) / 100)
}

interface Margins {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

function normalizeMargins(margin: OverlayState['margin']): Margins {
  if (typeof margin === 'number') {
    const m = Math.max(0, Math.trunc(margin))
    return { top: m, right: m, bottom: m, left: m }
  }
  const side = (value: number | undefined): number => Math.max(0, Math.trunc(value ?? 0))
  return {
    top: side(margin?.top),
    right: side(margin?.right),
    bottom: side(margin?.bottom),
    left: side(margin?.left),
  }
}

function anchorRow(anchor: OverlayState['anchor'], height: number, availHeight: number, marginTop: number): number {
  switch (anchor) {
    case 'top-left':
    case 'top-center':
    case 'top-right':
      return marginTop
    case 'bottom-left':
    case 'bottom-center':
    case 'bottom-right':
      return marginTop + availHeight - height
    default:
      return marginTop + Math.floor((availHeight - height) / 2)
  }
}

function anchorCol(anchor: OverlayState['anchor'], width: number, availWidth: number, marginLeft: number): number {
  switch (anchor) {
    case 'top-left':
    case 'left-center':
    case 'bottom-left':
      return marginLeft
    case 'top-right':
    case 'right-center':
    case 'bottom-right':
      return marginLeft + availWidth - width
    default:
      return marginLeft + Math.floor((availWidth - width) / 2)
  }
}

/**
 * Resolve an overlay's frame-rect. `contentHeight` is the overlay's rendered
 * line count (width/maxHeight/positioning do not depend on it; pi resolves
 * width first with height 0, renders, then resolves the position with the
 * actual height — this function is the two-pass equivalent when called
 * twice). The rect is always inside the margin box; height is clamped to
 * the available height and to `maxHeight` (content beyond is clipped).
 */
export function resolveOverlayRect(
  overlay: OverlayState,
  frameWidth: number,
  frameHeight: number,
  contentHeight: number,
): OverlayRect {
  const margin = normalizeMargins(overlay.margin)
  const availWidth = Math.max(1, frameWidth - margin.left - margin.right)
  const availHeight = Math.max(1, frameHeight - margin.top - margin.bottom)

  // === width ===
  let width = parseSize(overlay.width, frameWidth) ?? Math.min(80, availWidth)
  const minWidth = parseSize(overlay.minWidth, frameWidth)
  if (minWidth !== undefined) width = Math.max(width, minWidth)
  width = Math.max(1, Math.min(width, availWidth))

  // === height (maxHeight clip + available clamp) ===
  const maxHeight = parseSize(overlay.maxHeight, frameHeight)
  let height = Math.max(0, Math.trunc(contentHeight))
  if (maxHeight !== undefined) height = Math.min(height, Math.max(1, Math.min(maxHeight, availHeight)))
  height = Math.min(height, availHeight)

  // === position: explicit row/col (absolute or % of slack) or anchor ===
  let row: number
  if (overlay.row !== undefined) {
    if (typeof overlay.row === 'string') {
      const pct = parseSize(overlay.row, 100)
      const maxRow = Math.max(0, availHeight - height)
      row = margin.top + Math.floor((maxRow * (pct ?? 50)) / 100)
    } else {
      row = Math.trunc(overlay.row)
    }
  } else {
    row = anchorRow(overlay.anchor, height, availHeight, margin.top)
  }
  let col: number
  if (overlay.col !== undefined) {
    if (typeof overlay.col === 'string') {
      const pct = parseSize(overlay.col, 100)
      const maxCol = Math.max(0, availWidth - width)
      col = margin.left + Math.floor((maxCol * (pct ?? 50)) / 100)
    } else {
      col = Math.trunc(overlay.col)
    }
  } else {
    col = anchorCol(overlay.anchor, width, availWidth, margin.left)
  }

  row += Math.trunc(overlay.offsetY ?? 0)
  col += Math.trunc(overlay.offsetX ?? 0)

  row = Math.max(margin.top, Math.min(row, frameHeight - margin.bottom - height))
  col = Math.max(margin.left, Math.min(col, frameWidth - margin.right - width))

  return { x: col, y: row, width, height }
}

// ---------------------------------------------------------------------------
// Internals: resource remap, blit with wide-pair healing, region diff
// ---------------------------------------------------------------------------

function rectEquals(a: OverlayRect, b: OverlayRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Layer ids that are not overlays (base + highlight skeleton). */
function isOverlayLayerId(id: string): boolean {
  return id !== 'base' && !id.startsWith('highlight:')
}

/**
 * Copy `base` cells into a fresh grid, re-interning every style/hyperlink
 * into `table` by RESOLVED content (ids are frame-local, §5.5). Throws
 * TypeError on unresolvable ids — a base-frame contract violation.
 */
function remapBaseCells(base: Frame, table: ReturnType<typeof createResourceTable>): TerminalCell[] {
  const styles = new Map<number, LineStyle>()
  for (const style of base.resources.styles) {
    styles.set(style.id, {
      foreground: style.foreground,
      background: style.background,
      bold: style.bold,
      dim: style.dim,
      italic: style.italic,
      underline: style.underline,
      inverse: style.inverse,
      strike: style.strike,
    })
  }
  const links = new Map<number, { uri: string; params?: string }>()
  for (const link of base.resources.hyperlinks) {
    links.set(link.id, link.params === undefined ? { uri: link.uri } : { uri: link.uri, params: link.params })
  }
  return base.cells.map((cell, index) => {
    const style = styles.get(cell.styleId)
    if (style === undefined) {
      throw new TypeError(`compositor: base cell ${index} references missing styleId ${cell.styleId}`)
    }
    const styleId = table.internStyle(style)
    if (cell.hyperlinkId === undefined) {
      return { grapheme: cell.grapheme, width: cell.width, styleId }
    }
    const link = links.get(cell.hyperlinkId)
    if (link === undefined) {
      throw new TypeError(`compositor: base cell ${index} references missing hyperlinkId ${cell.hyperlinkId}`)
    }
    return { grapheme: cell.grapheme, width: cell.width, styleId, hyperlinkId: table.internHyperlink(link.uri, link.params) }
  })
}

/**
 * Blit one content row of an overlay into the grid, healing wide-grapheme
 * pairs at the rect's vertical edges: overwriting one half of a wide pair
 * blanks the surviving half (terminal semantics), so no dangling head or
 * orphan continuation can survive an overlay edge. The overlay's own cells
 * never straddle the rect edge (`fitCellsToWidth` clipped them whole).
 */
function blitOverlayRow(
  grid: TerminalCell[],
  stride: number,
  width: number,
  y: number,
  rect: OverlayRect,
  rowCells: readonly TerminalCell[],
): void {
  const base = y * stride
  const blank = (x: number): void => {
    grid[base + x] = { grapheme: ' ', width: 1, styleId: 0 }
  }
  if (rect.x > 0) {
    const target = grid[base + rect.x] as TerminalCell
    if (target.width === 0) blank(rect.x - 1) // surviving head of a pair we overwrite
  }
  const rightEdge = rect.x + rect.width
  if (rightEdge < width) {
    const lastOverwritten = grid[base + rightEdge - 1] as TerminalCell
    if (lastOverwritten.width === 2) blank(rightEdge) // surviving continuation of a pair we overwrite
  }
  for (let i = 0; i < rowCells.length; i++) {
    grid[base + rect.x + i] = rowCells[i] as TerminalCell
  }
}

/**
 * Row invariant after compositing (same contract as frame-builder): every
 * wide head is immediately followed by its continuation and no continuation
 * stands alone. Only rows an overlay touched can diverge from the base
 * frame's verified state; highlights change styles only.
 */
function assertComposedRow(grid: readonly TerminalCell[], stride: number, width: number, y: number): void {
  for (let x = 0; x < width; x++) {
    const cell = grid[y * stride + x] as TerminalCell
    if (cell.width === 2) {
      const next = x + 1 < width ? (grid[y * stride + x + 1] as TerminalCell) : undefined
      if (next === undefined || next.width !== 0 || next.grapheme !== '') {
        throw new TypeError(`compositor row ${y}: dangling wide head at column ${x}`)
      }
    } else if (cell.width === 0) {
      const prev = x > 0 ? (grid[y * stride + x - 1] as TerminalCell) : undefined
      if (prev === undefined || prev.width !== 2) {
        throw new TypeError(`compositor row ${y}: orphan continuation at column ${x}`)
      }
    }
  }
}

/** Count rows whose cells differ between two same-geometry frames (resolved content). */
function countChangedRows(previous: Frame, nextCells: readonly TerminalCell[], nextResources: Frame['resources']): number {
  const prevStyles = styleKeyById(previous.resources)
  const prevLinks = linkKeyById(previous.resources)
  const styles = styleKeyById(nextResources)
  const links = linkKeyById(nextResources)
  let changed = 0
  for (let y = 0; y < previous.height; y++) {
    const rowBase = y * previous.stride
    for (let x = 0; x < previous.width; x++) {
      const a = previous.cells[rowBase + x] as TerminalCell
      const b = nextCells[rowBase + x] as TerminalCell
      if (a.grapheme !== b.grapheme || a.width !== b.width) {
        changed += 1
        break
      }
      if (prevStyles.get(a.styleId) !== styles.get(b.styleId)) {
        changed += 1
        break
      }
      const aLink = a.hyperlinkId === undefined ? '' : prevLinks.get(a.hyperlinkId)
      const bLink = b.hyperlinkId === undefined ? '' : links.get(b.hyperlinkId)
      if (aLink !== bLink) {
        changed += 1
        break
      }
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
// compositeFrame
// ---------------------------------------------------------------------------

/**
 * Compose the final frame. Pure: same inputs -> same output, no side
 * effects. Returns the base frame object unchanged when nothing is
 * composited (base-only degradation path, byte-equivalent to WP-06a).
 */
export function compositeFrame(input: CompositorInput): CompositorOutput {
  const { base } = input
  const overlays = (input.overlays ?? []).filter((overlay) => overlay.visible)
  const highlights = input.highlights ?? []
  const previous = input.previous ?? null

  // --- affectedRegions proof (compositor damage only; base damage is the ---
  // --- diff planner's exact cell-level job).                           ---
  const previousLayers = previous !== null ? previous.layers : []
  const previousRegions = new Map<string, { revision: number; clip: OverlayRect | null; overlay: boolean }>()
  for (const layer of previousLayers) {
    previousRegions.set(layer.id, {
      revision: layer.revision,
      clip: layer.clip ?? null,
      overlay: isOverlayLayerId(layer.id),
    })
  }

  // --- base-only fast path: identity (byte-equivalent to WP-06a output). ---
  if (overlays.length === 0 && highlights.length === 0) {
    const affected: OverlayRect[] = []
    for (const { clip } of previousRegions.values()) {
      if (clip !== null) affected.push(clip) // closed overlays need a repaint
    }
    let frame = base
    if (previous !== null && (previous.width !== base.width || previous.height !== base.height)) {
      // The caller forgot to retire a stale previous frame across a geometry
      // change: the local-patch proof is impossible — force a full redraw.
      frame = {
        ...base,
        fullRedraw: true,
        metadata: {
          ...base.metadata,
          fullRedrawReason: base.metadata.fullRedrawReason ?? 'resize',
        },
      }
      return { frame: deepFreeze(frame) as Frame, affectedRegions: [{ x: 0, y: 0, width: base.width, height: base.height }] }
    }
    return { frame, affectedRegions: affected }
  }

  const width = base.width
  const height = base.height
  const table = createResourceTable()
  const grid = remapBaseCells(base, table)

  const layers: FrameLayer[] = [{ id: 'base', z: 0, revision: base.stateRevision }]
  const touchedRows = new Set<number>()

  // --- overlay stack, back -> front (model stack order = nesting order). ---
  overlays.forEach((overlay, index) => {
    // Pass 1: width/col are height-independent (pi resolves with height 0).
    const probe = resolveOverlayRect(overlay, width, height, 0)
    const lines = input.renderOverlay === undefined ? [] : input.renderOverlay(overlay, probe.width)
    // Pass 2: position with the real (clipped) content height.
    const rect = resolveOverlayRect(overlay, width, height, lines.length)
    if (rect.height <= 0) return // empty overlays paint nothing (and take no layer)
    const content = lines.slice(0, rect.height)
    for (let i = 0; i < content.length; i++) {
      const lineCells = trustedLineCells(content[i] as string, input.profile, { diagnostics: input.diagnostics })
      const fitted = fitCellsToWidth(lineCells, rect.width, input.diagnostics)
      const rowCells = terminalCellsFromLineCells(fitted, table)
      blitOverlayRow(grid, base.stride, width, rect.y + i, rect, rowCells)
      touchedRows.add(rect.y + i)
    }
    layers.push({ id: overlay.overlayId, z: index + 1, revision: overlay.revision, clip: rect })
  })

  // --- selection/search highlight skeleton (above the overlay stack). ---
  highlights.forEach((region, index) => {
    const clip: OverlayRect = {
      x: Math.max(0, Math.trunc(region.x)),
      y: Math.max(0, Math.trunc(region.y)),
      width: Math.max(0, Math.trunc(region.width)),
      height: Math.max(0, Math.trunc(region.height)),
    }
    if (clip.width === 0 || clip.height === 0) return
    const styleId = table.internStyle(region.style)
    const x1 = Math.min(width, clip.x + clip.width)
    const y1 = Math.min(height, clip.y + clip.height)
    for (let y = clip.y; y < y1; y++) {
      for (let x = clip.x; x < x1; x++) {
        const cell = grid[y * base.stride + x] as TerminalCell
        grid[y * base.stride + x] =
          cell.hyperlinkId === undefined
            ? { grapheme: cell.grapheme, width: cell.width, styleId }
            : { grapheme: cell.grapheme, width: cell.width, styleId, hyperlinkId: cell.hyperlinkId }
      }
    }
    layers.push({
      id: `highlight:${region.kind}:${index}`,
      z: 1000 + index,
      revision: 0,
      clip: { x: clip.x, y: clip.y, width: x1 - clip.x, height: y1 - clip.y },
    })
  })

  // Row invariant check on overlay-touched rows (contract violation throws).
  for (const y of touchedRows) assertComposedRow(grid, base.stride, width, y)

  // --- affectedRegions: changed/vanished compositor layers. ---
  const affected: OverlayRect[] = []
  const seen = new Set<string>()
  for (const layer of layers) {
    if (layer.id === 'base' || layer.clip === undefined) continue
    seen.add(layer.id)
    const prev = previousRegions.get(layer.id)
    const isOverlay = isOverlayLayerId(layer.id)
    // Highlights carry no meaningful revision yet (skeleton): treat them as
    // always-changed so a stale highlight rect is never left on screen.
    const unchanged =
      isOverlay &&
      prev !== undefined &&
      prev.revision === layer.revision &&
      prev.clip !== null &&
      rectEquals(prev.clip, layer.clip)
    if (!unchanged) {
      affected.push(layer.clip)
      if (prev?.clip != null && !rectEquals(prev.clip, layer.clip)) affected.push(prev.clip)
    }
  }
  for (const [id, prev] of previousRegions) {
    if (!seen.has(id) && prev.clip !== null) affected.push(prev.clip)
  }

  // --- fullRedraw: base flags pass through; geometry mismatch with a ---
  // --- live previous frame is unprovable locally.                      ---
  let fullRedraw = base.fullRedraw
  let fullRedrawReason = base.metadata.fullRedrawReason
  if (previous !== null && (previous.width !== width || previous.height !== height)) {
    fullRedraw = true
    fullRedrawReason = fullRedrawReason ?? 'resize'
  }

  const resources = table.snapshot()
  const metadata: FrameMetadata = {
    changedRows:
      previous !== null && previous.width === width && previous.height === height
        ? countChangedRows(previous, grid, resources)
        : height,
    renderMs: base.metadata.renderMs,
    diffMs: base.metadata.diffMs,
    terminalProfileId: base.metadata.terminalProfileId,
    ...(fullRedrawReason !== undefined ? { fullRedrawReason } : {}),
  }

  const frame: Frame = {
    frameId: base.frameId,
    stateRevision: base.stateRevision,
    width,
    height,
    stride: base.stride,
    cells: grid,
    cursor: base.cursor, // hardware cursor metadata passes through (§6.3 top layer)
    modes: base.modes,
    resources,
    images: base.images,
    layers,
    generation: base.generation,
    fullRedraw,
    metadata,
  }
  return { frame: deepFreeze(frame) as Frame, affectedRegions: affected }
}

/** styleId -> content key map for one frame's resources. */
function styleKeyById(resources: Frame['resources']): Map<number, string> {
  const map = new Map<number, string>()
  for (const style of resources.styles) {
    const { id, ...content } = style
    map.set(id, JSON.stringify(content))
  }
  return map
}

/** hyperlinkId -> content key map for one frame's resources. */
function linkKeyById(resources: Frame['resources']): Map<number, string> {
  const map = new Map<number, string>()
  for (const link of resources.hyperlinks) {
    map.set(link.id, JSON.stringify({ uri: link.uri, params: link.params ?? null }))
  }
  return map
}
