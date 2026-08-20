/**
 * tui-v2 DiffPlanner (WP-06b, plan line ~909).
 *
 * "DiffPlanner 只负责把同一 backend contract 的 frame metadata 转成候选
 * patch；物理算法由 backend 所有。" This module is the pure metadata half:
 *
 *   - `decidePatchShape(previous, next)`: frame metadata (geometry,
 *     generation, fullRedraw flags/reasons) -> the candidate patch shape
 *     (full vs incremental + the §5.5 fullRedrawReason). It performs NO
 *     cell-level work.
 *   - `changedModeOperations(previous, next)`: TerminalModeSnapshot diff ->
 *     candidate `mode` operations (the patch's mode transition).
 *   - `cursorOperation(previous, next)`: cursor metadata diff -> candidate
 *     `cursor` operation.
 *
 * The physical algorithm (which cells become which write-cells/erase runs)
 * belongs to the screen backend (`terminal/fullscreen-backend.ts` for the
 * alt screen); this module never emits cell operations. Everything here is
 * pure and side-effect free.
 *
 * Dependency rule (§4.3): `import type` from renderer contracts only.
 */
import type { Frame, FrameMetadata, PatchOperation, TerminalModeSnapshot } from './frame.js'

// ---------------------------------------------------------------------------
// Patch shape (full vs incremental) from frame metadata only
// ---------------------------------------------------------------------------

export interface PatchShapeDecision {
  readonly fullRedraw: boolean
  /**
   * The §5.5 reason attached to a full redraw; undefined for incremental
   * patches. Taken from the frame's own metadata when the frame declared
   * one, otherwise derived from the metadata transition.
   */
  readonly fullRedrawReason: FrameMetadata['fullRedrawReason'] | undefined
}

/**
 * Translate frame metadata into the candidate patch shape. A full redraw is
 * forced by: no previous frame ('initial'), a generation change
 * ('unknown-mode' — the terminal state across a generation boundary is not
 * provably tracked), a geometry change ('resize'), or the frame's own
 * fullRedraw flag (reason from its metadata, defaulting to 'damage').
 */
export function decidePatchShape(previous: Frame | null, next: Frame): PatchShapeDecision {
  if (previous === null) {
    return { fullRedraw: true, fullRedrawReason: next.metadata.fullRedrawReason ?? 'initial' }
  }
  if (previous.generation !== next.generation) {
    return { fullRedraw: true, fullRedrawReason: next.metadata.fullRedrawReason ?? 'unknown-mode' }
  }
  if (previous.width !== next.width || previous.height !== next.height) {
    return { fullRedraw: true, fullRedrawReason: next.metadata.fullRedrawReason ?? 'resize' }
  }
  if (next.fullRedraw) {
    return { fullRedraw: true, fullRedrawReason: next.metadata.fullRedrawReason ?? 'damage' }
  }
  return { fullRedraw: false, fullRedrawReason: undefined }
}

// ---------------------------------------------------------------------------
// Candidate mode/cursor operations (metadata diff only)
// ---------------------------------------------------------------------------

/** Mode names whose snapshot values are objects and need deep equality. */
const OBJECT_MODES: ReadonlySet<keyof TerminalModeSnapshot> = new Set(['scrollRegion', 'progress'])

type ModeOpValue = Extract<PatchOperation, { kind: 'mode' }>['value']

/**
 * Candidate `mode` operations for the transition previous -> next (the
 * patch's mode transition). Callers skip this on the very first frame of a
 * session — the lifecycle already established those modes physically.
 */
export function changedModeOperations(previous: Frame, next: Frame): PatchOperation[] {
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

/**
 * Candidate `cursor` operation, emitted only on change. With no previous
 * frame the cursor op is always emitted (a hidden cursor is normalized to
 * (0,0) upstream, so this is a cheap hide-at-home on the first frame).
 */
export function cursorOperation(previous: Frame | null, next: Frame): PatchOperation | null {
  const changed =
    previous === null ||
    previous.cursor.x !== next.cursor.x ||
    previous.cursor.y !== next.cursor.y ||
    previous.cursor.visible !== next.cursor.visible
  if (!changed) return null
  return { kind: 'cursor', x: next.cursor.x, y: next.cursor.y, visible: next.cursor.visible }
}
