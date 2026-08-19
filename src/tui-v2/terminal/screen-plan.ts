/**
 * tui-v2 pi screen-backend frame planner (WP-03c, plan §5.5/§5.6).
 *
 * Shared synchronous Frame → TerminalPatch planning for the pi-backed screen
 * backends (main-screen.ts / alt-screen.ts). Conservative on purpose:
 *
 * - previous === null, a geometry change or next.fullRedraw forces a FULL
 *   row rewrite (every row one write-cells run at x:0) plus fullRedraw: true;
 *   otherwise rows are diffed cell-by-cell and changed rows are rewritten
 *   whole (no intra-row run splitting yet).
 * - One resources op always precedes the cell runs (the writer's encoder
 *   requires it and it pins the style/hyperlink tables for this patch).
 * - Cursor and mode ops are emitted only on change (modes shallow-compared;
 *   scrollRegion/progress compared by JSON). On the very first frame no mode
 *   ops are emitted — start() already established the session modes through
 *   the lifecycle.
 * - `patch.bytes` is computed with the writer's own
 *   `encodePatchOperationsSync`, so the bytes the writer validates against
 *   are identical to what it will encode.
 *
 * Scope cut (documented in pi-terminal-method-matrix.md): frames carrying
 * `images` placements are rejected — image bytes reach the terminal through
 * the pi compat write path (declared kitty/iTerm2 markers), not through
 * backend patches, until the ImageStore plumbing lands.
 */

import type { Frame, PatchOperation, TerminalCell, TerminalModeSnapshot, TerminalPatch } from '../renderer/frame.js'
import { encodePatchOperationsSync } from './writer.js'

function cellsEqual(a: TerminalCell, b: TerminalCell): boolean {
  return (
    a.grapheme === b.grapheme &&
    a.width === b.width &&
    a.styleId === b.styleId &&
    a.hyperlinkId === b.hyperlinkId
  )
}

function rowChanged(previous: Frame, next: Frame, y: number): boolean {
  const base = y * next.stride
  const previousBase = y * previous.stride
  for (let x = 0; x < next.width; x++) {
    if (!cellsEqual(previous.cells[previousBase + x] as TerminalCell, next.cells[base + x] as TerminalCell)) {
      return true
    }
  }
  return false
}

/** Mode names whose snapshot values are objects and need deep equality. */
const OBJECT_MODES: ReadonlySet<keyof TerminalModeSnapshot> = new Set(['scrollRegion', 'progress'])

type ModeOpValue = Extract<PatchOperation, { kind: 'mode' }>['value']

function changedModes(previous: Frame, next: Frame): PatchOperation[] {
  const operations: PatchOperation[] = []
  for (const name of Object.keys(next.modes) as (keyof TerminalModeSnapshot)[]) {
    const nextValue = next.modes[name]
    const previousValue = previous.modes[name]
    const same = OBJECT_MODES.has(name)
      ? JSON.stringify(nextValue) === JSON.stringify(previousValue)
      : nextValue === previousValue
    if (!same) {
      operations.push({ kind: 'mode', name, value: nextValue as ModeOpValue })
    }
  }
  return operations
}

function validateFrame(frame: Frame): void {
  if (frame === null || typeof frame !== 'object') throw new TypeError('frame must be an object')
  if (!Number.isInteger(frame.width) || frame.width < 1) throw new TypeError('frame.width must be a positive integer')
  if (!Number.isInteger(frame.height) || frame.height < 0) throw new TypeError('frame.height must be a non-negative integer')
  if (!Number.isInteger(frame.stride) || frame.stride < frame.width) {
    throw new TypeError('frame.stride must be an integer >= frame.width')
  }
  if (!Array.isArray(frame.cells) || frame.cells.length < frame.stride * frame.height) {
    throw new TypeError('frame.cells must cover stride * height')
  }
  if (frame.images.length > 0) {
    throw new RangeError(
      'pi screen backends do not route frame images yet: image bytes flow through the pi compat write path (declared kitty/iTerm2 markers)',
    )
  }
}

/**
 * Plan the patch that turns `previous` into `next`. Pure + synchronous; the
 * caller owns patchSeq/generation bookkeeping and generation validation.
 */
export function planScreenPatch(previous: Frame | null, next: Frame, patchSeq: number): TerminalPatch {
  validateFrame(next)
  if (previous !== null) validateFrame(previous)

  const full =
    previous === null ||
    previous.width !== next.width ||
    previous.height !== next.height ||
    next.fullRedraw

  const operations: PatchOperation[] = [{ kind: 'resources', resources: next.resources }]

  if (full) {
    for (let y = 0; y < next.height; y++) {
      operations.push({
        kind: 'write-cells',
        x: 0,
        y,
        cells: next.cells.slice(y * next.stride, y * next.stride + next.width),
      })
    }
    if (previous !== null && previous.height > next.height) {
      // Rows below the new content survive a shrink without an explicit erase.
      operations.push({
        kind: 'erase',
        x: 0,
        y: next.height,
        width: previous.width,
        height: previous.height - next.height,
      })
    }
  } else if (previous !== null) {
    for (let y = 0; y < next.height; y++) {
      if (!rowChanged(previous, next, y)) continue
      operations.push({
        kind: 'write-cells',
        x: 0,
        y,
        cells: next.cells.slice(y * next.stride, y * next.stride + next.width),
      })
    }
  }

  const cursorChanged =
    previous === null ||
    previous.cursor.x !== next.cursor.x ||
    previous.cursor.y !== next.cursor.y ||
    previous.cursor.visible !== next.cursor.visible
  if (cursorChanged) {
    operations.push({ kind: 'cursor', x: next.cursor.x, y: next.cursor.y, visible: next.cursor.visible })
  }

  if (previous !== null) {
    operations.push(...changedModes(previous, next))
  }

  const { bytes } = encodePatchOperationsSync(operations)
  return {
    frameId: next.frameId,
    stateRevision: next.stateRevision,
    patchSeq,
    generation: next.generation,
    operations,
    bytes,
    fullRedraw: full,
  }
}
