/**
 * tui-v2 canonical state serializer (WP-04, plan §5.2 live/replay equivalence).
 *
 * `serializeCanonicalUiState` is THE equivalence definition between a live run
 * and a replay of the same event trace: two states are equivalent iff their
 * canonical serializations are byte-equal. The projection keeps only stable
 * business fields:
 *
 *   session identity + row id/revision/settled/kind, focus, viewport,
 *   overlays, terminal generation/mode/profile, pending commands.
 *
 * It drops everything volatile or diagnostic: event `at` values, clocks,
 * diagnostics counters, gap buffer, lastAppliedSeq, adapterInstanceId and
 * other object/identity bookkeeping, plus dock/editor drafts and preferences
 * (constant per run; not part of the equivalence contract).
 */
import { canonicalJson } from './canonical-json.js'
import type { DeepReadonly, SerializableValue } from './schema.js'
import type { UiState } from './state.js'

/**
 * Recursively drop `undefined`-valued keys so canonicalJson never trips on
 * them (canonical form has no undefined). Input is not mutated.
 */
function stripUndefined(value: SerializableValue): SerializableValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => stripUndefined(item))
  const out: Record<string, SerializableValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = stripUndefined(item)
  }
  return out
}

/** Byte-stable canonical serialization of a UiState (see module docstring). */
export function serializeCanonicalUiState(state: DeepReadonly<UiState>): string {
  const session = state.session
  const rows = session.rowOrder.map((rowId) => {
    const row = session.rowsById[rowId]
    if (row === undefined) {
      // rowOrder/rowsById inconsistency is a model bug; surface it loudly.
      throw new TypeError(`serializeCanonicalUiState: rowOrder references missing rowId ${rowId}`)
    }
    return { rowId: row.rowId, revision: row.revision, settled: row.settled, kind: row.kind }
  })
  const canonical = {
    focus: { target: state.focus.target, overlayId: state.focus.overlayId },
    overlays: state.overlays.stack.map((overlay) => stripUndefined(overlay)),
    pendingCommands: state.pendingCommands.map((pending) => ({
      seq: pending.seq,
      command: stripUndefined(pending.command as SerializableValue),
    })),
    rows,
    session: {
      durableSessionId: session.durableSessionId,
      uiSessionGeneration: session.uiSessionGeneration,
      resetEpoch: session.resetEpoch,
      sessionEpoch: session.sessionEpoch,
      streamingRowId: session.streamingRowId,
      oldestLoadedSourceSeq: session.oldestLoadedSourceSeq,
      newestLoadedSourceSeq: session.newestLoadedSourceSeq,
      readiness: session.readiness,
    },
    terminal: {
      generation: state.terminal.generation,
      mode: state.terminal.mode,
      needsFullRedraw: state.terminal.needsFullRedraw,
      profileId: state.terminal.profileId,
      suspended: state.terminal.suspended,
    },
    viewport: {
      width: state.viewport.width,
      height: state.viewport.height,
      scrollTop: state.viewport.scrollTop,
      maxScroll: state.viewport.maxScroll,
      sticky: state.viewport.sticky,
      unseenCount: state.viewport.unseenCount,
    },
  }
  return canonicalJson(canonical)
}
