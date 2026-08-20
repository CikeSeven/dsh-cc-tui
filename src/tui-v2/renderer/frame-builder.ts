/**
 * tui-v2 frame builder (WP-06a, plan §5.5).
 *
 * Turns the base renderer's logical-line output into a complete, immutable
 * `Frame`: every logical line is re-parsed through the §6.1 cell pipeline
 * (`cells.ts`), clipped/padded to exactly `width` columns (the per-physical-
 * row `assertLineWidth <= viewport.width` hard guard), and laid out row-major
 * into a dense `width * height` cell grid with `stride === width`.
 *
 * Scope (WP-06a): a single base layer. `layers`/`images` are pass-through
 * fields reserved for the WP-06b+ compositor and image store; this module
 * never composites. The diff planner (`terminal/screen-plan.ts`) and the
 * fixed writer-side SGR/OSC 8 encoder (`terminal/ansi.ts` `encodeCells`)
 * consume the published frame as-is.
 *
 * Contract enforcement at the boundary:
 *  - styleId/hyperlinkId are frame-local ids interned by content; resources
 *    carry full, unique, id-keyed definitions (never array-position ids);
 *  - a hidden cursor is normalized to (0,0); a visible cursor outside the
 *    frame is a contract violation and throws (§5.5);
 *  - the published frame is deep-frozen (§5.1 immutable data): any reducer/
 *    controller/backend that tries to mutate it fails instead of corrupting
 *    canonical state.
 *
 * Dependency rule (§4.3): renderer imports runtime helpers from model
 * (`deepFreeze`, same as base-renderer imports `rowCacheKey`) and
 * `import type` from terminal.
 */
import { deepFreeze } from '../model/schema.js'
import type { TerminalProfile } from '../terminal/profile.js'
import {
  createResourceTable,
  fitCellsToWidth,
  terminalCellsFromLineCells,
  trustedLineCells,
  type CellPipelineDiagnostics,
} from './cells.js'
import type {
  Frame,
  FrameImagePlacement,
  FrameLayer,
  FrameMetadata,
  TerminalCell,
  TerminalModeSnapshot,
} from './frame.js'
import type { LineCell } from './lines.js'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface FrameBuilderInput {
  /** Unique frame identity (caller-owned sequencing, e.g. `frame-${seq}`). */
  readonly frameId: string
  readonly stateRevision: number
  readonly width: number
  readonly height: number
  /**
   * TRUSTED styled logical lines (component output; ANSI only from the
   * lines.ts style builders). Untrusted text must go through
   * `untrustedLineCells`/components first — never handed here raw.
   * Missing rows are blank-filled; extra rows beyond `height` are dropped.
   */
  readonly lines: readonly string[]
  readonly profile: TerminalProfile
  /** Complete terminal mode snapshot at commit time (§5.5); never invented here. */
  readonly modes: TerminalModeSnapshot
  /** Hidden cursor is normalized to {0,0,false}; default is hidden. */
  readonly cursor?: { readonly x: number; readonly y: number; readonly visible: boolean }
  readonly generation: number
  readonly fullRedraw?: boolean
  readonly fullRedrawReason?: FrameMetadata['fullRedrawReason']
  /**
   * Rows changed vs the previous frame. WP-06a publishes whole frames, so the
   * honest default is `height`; the compositor/diff stage will supply exact
   * counts.
   */
  readonly changedRows?: number
  readonly renderMs?: number
  readonly diffMs?: number
  /** Reserved for the compositor; base-only frames leave it empty. */
  readonly layers?: readonly FrameLayer[]
  /** Reserved for the image store; base-only frames leave it empty. */
  readonly images?: readonly FrameImagePlacement[]
  /** Optional sink for pipeline diagnostics (dropped controls, clipping). */
  readonly diagnostics?: CellPipelineDiagnostics
}

// ---------------------------------------------------------------------------
// Row/cursor invariants
// ---------------------------------------------------------------------------

/**
 * Internal invariant check (never user-input dependent — fitCellsToWidth
 * already clipped): a physical row is exactly `width` cells whose widths sum
 * to `width`, wide heads are immediately followed by their continuation, and
 * continuations never stand alone (§5.5).
 */
function assertRowInvariant(row: readonly LineCell[], width: number, y: number): void {
  if (row.length !== width) {
    throw new TypeError(`frame-builder row ${y}: ${row.length} cells, expected ${width}`)
  }
  let columns = 0
  for (let x = 0; x < row.length; x++) {
    const cell = row[x] as LineCell
    if (cell.width === 2) {
      const next = x + 1 < row.length ? (row[x + 1] as LineCell) : undefined
      if (next === undefined || next.width !== 0 || next.grapheme !== '') {
        throw new TypeError(`frame-builder row ${y}: dangling wide head at column ${x}`)
      }
    } else if (cell.width === 0) {
      const prev = x > 0 ? (row[x - 1] as LineCell) : undefined
      if (prev === undefined || prev.width !== 2) {
        throw new TypeError(`frame-builder row ${y}: orphan continuation at column ${x}`)
      }
    }
    columns += cell.width
  }
  if (columns > width) {
    throw new TypeError(`frame-builder row ${y}: physical width ${columns} exceeds viewport width ${width}`)
  }
}

function normalizeCursor(
  cursor: FrameBuilderInput['cursor'],
  width: number,
  height: number,
): Frame['cursor'] {
  if (cursor === undefined || cursor.visible === false) {
    // §5.5: a hidden cursor is always (0,0).
    return { x: 0, y: 0, visible: false }
  }
  const { x, y } = cursor
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new TypeError(`frame-builder: visible cursor (${x},${y}) outside ${width}x${height} frame`)
  }
  return { x, y, visible: true }
}

// ---------------------------------------------------------------------------
// buildFrame
// ---------------------------------------------------------------------------

/**
 * Build and deep-freeze one complete Frame from trusted logical lines.
 * Throws TypeError only on contract violations (bad geometry, out-of-frame
 * visible cursor, internal row invariant) — over-wide graphemes and over-long
 * lines are clipped, never thrown (§5.5 "不得抛到用户路径").
 */
export function buildFrame(input: FrameBuilderInput): Frame {
  const { width, height } = input
  if (!Number.isInteger(width) || width <= 0) {
    throw new TypeError(`frame-builder: width must be a positive integer, got ${width}`)
  }
  if (!Number.isInteger(height) || height < 0) {
    throw new TypeError(`frame-builder: height must be a non-negative integer, got ${height}`)
  }

  const table = createResourceTable()
  const cells: TerminalCell[] = []
  const rowCount = Math.min(height, input.lines.length)
  for (let y = 0; y < height; y++) {
    const lineCells =
      y < rowCount
        ? trustedLineCells(input.lines[y] as string, input.profile, { diagnostics: input.diagnostics })
        : []
    const fitted = fitCellsToWidth(lineCells, width, input.diagnostics)
    assertRowInvariant(fitted, width, y)
    cells.push(...terminalCellsFromLineCells(fitted, table))
  }

  const fullRedraw = input.fullRedraw ?? false
  const frame: Frame = {
    frameId: input.frameId,
    stateRevision: input.stateRevision,
    width,
    height,
    stride: width,
    cells,
    cursor: normalizeCursor(input.cursor, width, height),
    // Copy before freezing: the modes snapshot may come from caller-owned
    // terminal-layer tracking objects; the published frame must not freeze
    // or alias them.
    modes: {
      ...input.modes,
      scrollRegion: { ...input.modes.scrollRegion },
      progress: { ...input.modes.progress },
    },
    resources: table.snapshot(),
    images: input.images ?? [],
    layers: input.layers ?? [],
    generation: input.generation,
    fullRedraw,
    metadata: {
      changedRows: input.changedRows ?? height,
      renderMs: input.renderMs ?? 0,
      diffMs: input.diffMs ?? 0,
      terminalProfileId: input.profile.id,
      ...(input.fullRedrawReason !== undefined ? { fullRedrawReason: input.fullRedrawReason } : {}),
    },
  }
  // §5.1: published frames are immutable data. Freeze the whole graph (cells,
  // resources, modes snapshot included) before handing it to backend/writer.
  return deepFreeze(frame) as Frame
}
