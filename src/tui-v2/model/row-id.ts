/**
 * tui-v2 row identity (WP-04, plan §5.3).
 *
 * `rowId` is UI identity: `encodeRowId(sessionEpoch, sourceKind, sourceId,
 * sourceSeq)`. Segments are length-prefixed (`<utf16-length>:<segment>`
 * concatenated) so external ids containing separators can never collide or
 * become ambiguous; identical input tuples always produce identical byte
 * strings. The reducer treats event-carried rowIds as opaque — this encoder
 * is the only constructor, used by projections/adapter.
 *
 * `RowCacheKey` is the renderer cache identity (§5.3): width/theme/profile
 * invalidate render cache without touching business row revision, and
 * sessionEpoch change makes every old entry unreachable.
 */

export interface RowCacheKey {
  readonly durableSessionId: string
  readonly uiSessionGeneration: string
  readonly sessionEpoch: string
  readonly rowId: string
  readonly revision: number
  readonly width: number
  readonly themeId: string
  readonly terminalProfileId: string
}

/** Length-prefix one segment: `<length>:<value>`; length is in UTF-16 code units. */
export function encodeRowIdSegment(segment: string): string {
  return `${segment.length}:${segment}`
}

/**
 * Canonical rowId encoding (§5.3). Segments are never joined with a raw
 * separator, so `('e', 'a:b', 'c', 's')` and `('e', 'a', 'b:c', 's')` encode
 * to different byte strings.
 */
export function encodeRowId(
  sessionEpoch: string,
  sourceKind: string,
  sourceId: string,
  sourceSeq: string,
): string {
  return (
    encodeRowIdSegment(sessionEpoch) +
    encodeRowIdSegment(sourceKind) +
    encodeRowIdSegment(sourceId) +
    encodeRowIdSegment(sourceSeq)
  )
}

export interface RowCacheKeyContext {
  readonly width: number
  readonly themeId: string
  readonly terminalProfileId: string
}

/** Build the renderer cache key for a published row snapshot. */
export function rowCacheKey(
  row: {
    readonly durableSessionId: string
    readonly uiSessionGeneration: string
    readonly sessionEpoch: string
    readonly rowId: string
    readonly revision: number
  },
  context: RowCacheKeyContext,
): RowCacheKey {
  return {
    durableSessionId: row.durableSessionId,
    uiSessionGeneration: row.uiSessionGeneration,
    sessionEpoch: row.sessionEpoch,
    rowId: row.rowId,
    revision: row.revision,
    width: context.width,
    themeId: context.themeId,
    terminalProfileId: context.terminalProfileId,
  }
}
