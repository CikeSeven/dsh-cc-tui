/**
 * tui-v2 revision allocation (WP-04, plan §5.3).
 *
 * Pure per-adapter revision allocator. The adapter (not the reducer) owns
 * revision assignment for the snapshots it publishes:
 *
 * - Row revisions grow monotonically per rowId; while streaming, only the
 *   current row's revision grows, and it is fixed once the row settles.
 * - Tool rows additionally carry a `lifecycleRevision` in a separate domain
 *   that increases only on tool lifecycle changes (running -> result/error);
 *   spinner ticks and notifications must never bump it (§5.3).
 * - A reset epoch invalidates every identity, so `reset()` clears both maps.
 *
 * The allocator holds no clock, no I/O and no randomness; identical call
 * sequences produce identical revisions.
 */

export interface RevisionAllocator {
  /** Allocate the next row revision for `rowId` (0 on first allocation). */
  next(rowId: string): number
  /** Last allocated row revision for `rowId`; -1 if none. */
  current(rowId: string): number
  /** Allocate the next tool lifecycle revision for `rowId` (0 on first). */
  nextLifecycle(rowId: string): number
  /** Last allocated tool lifecycle revision for `rowId`; -1 if none. */
  currentLifecycle(rowId: string): number
  /** Drop all allocation state (on reset epoch change). */
  reset(): void
}

export function createRevisionAllocator(): RevisionAllocator {
  const rowRevisions = new Map<string, number>()
  const lifecycleRevisions = new Map<string, number>()

  const allocate = (map: Map<string, number>, rowId: string): number => {
    const nextValue = (map.get(rowId) ?? -1) + 1
    map.set(rowId, nextValue)
    return nextValue
  }

  return {
    next: (rowId) => allocate(rowRevisions, rowId),
    current: (rowId) => rowRevisions.get(rowId) ?? -1,
    nextLifecycle: (rowId) => allocate(lifecycleRevisions, rowId),
    currentLifecycle: (rowId) => lifecycleRevisions.get(rowId) ?? -1,
    reset: () => {
      rowRevisions.clear()
      lifecycleRevisions.clear()
    },
  }
}
