/**
 * tui-v2 model reducer (WP-04, plan §5.2/§5.3, §4.3 rule: the reducer runs no
 * async side effects, no I/O, no timers, no randomness).
 *
 * Pipeline per event (deterministic, §5.2 ordering rules verbatim):
 *
 *   1. Meta assertion: schemaVersion === 1 (boundary already shape-validated
 *      via `validateAppEvent`) and adapterInstanceId discipline — events from
 *      a foreign adapter instance are dropped, except `session/rows-reset`
 *      which rebinds the adapter (cross-process resume re-establishes order
 *      with a new adapterInstanceId + uiSessionGeneration, §5.2).
 *   2. Seq ordering against `bookkeeping.lastAppliedSeq`:
 *        seq <= last      -> drop, diagnostics.duplicate++
 *        seq === last + 1 -> apply, then drain the gap buffer while contiguous
 *        seq >  last + 1  -> gap buffer (sorted, bounded); when the buffer
 *                          would exceed GAP_BUFFER_MAX_EVENTS entries or the
 *                          first buffered event has waited longer than
 *                          GAP_BUFFER_MAX_WAIT_MS (measured on event-carried
 *                          `at`, never a wall clock), mark
 *                          `session.pendingReset` (snapshot-gap) and discard
 *                          the buffer — the reducer requests the reset,
 *                          a controller performs it (no side effects here).
 *   3. Semantics per variant (see apply* functions). Business events carrying
 *      a stale sessionEpoch are dropped (droppedOldEpoch++). rows-reset is
 *      atomic: every check passes or no row is accepted.
 *
 * Viewport scroll (WP-05): the reducer maintains `viewport.maxScroll` in row
 * units (max(0, rows - height)) on every content/resize mutation, and the
 * `input/command` {type:'scroll'} variant applies scroll semantics (sticky /
 * unseenCount / clamped scrollTop) so live and replay derive identical
 * viewport state. All other input commands stay journal-only.
 *
 * Immutability: output states are fresh object graphs (structural sharing for
 * untouched sections). Row/overlay snapshots are deep-frozen when stored —
 * the adapter is assumed to have frozen event payloads at ingress (§5.2); the
 * reducer completes that for snapshots it constructs itself (stream appends).
 * The reducer never freezes whole states and never mutates its input.
 */
import type { AppEvent } from './events.js'
import { canonicalJson } from './canonical-json.js'
import { computeSnapshotHash } from './projections.js'
import {
  deepFreeze,
  type Clock,
  type OverlayState,
  type RandomSource,
  type UiRowSnapshot,
} from './schema.js'
import {
  DIAGNOSTIC_MESSAGE_MAX,
  GAP_BUFFER_MAX_EVENTS,
  GAP_BUFFER_MAX_WAIT_MS,
  PENDING_COMMANDS_MAX,
  type GapBufferEntry,
  type UiDiagnosticsState,
  type UiSessionState,
  type UiState,
} from './state.js'

// Re-exported for convenience: row identity constructors live in row-id.ts.
export { encodeRowId, rowCacheKey, type RowCacheKey, type RowCacheKeyContext } from './row-id.js'

type RowsResetEvent = Extract<AppEvent, { type: 'session/rows-reset' }>
type RowUpsertEvent = Extract<AppEvent, { type: 'session/row-upsert' }>

export interface ReducerDeps {
  /**
   * Injected clock (§5.2). Used ONLY as the gap-buffer timing fallback when an
   * event's own `at` is unusable — ordering and gap windows are computed from
   * event-carried `at` values so replay stays deterministic. The reducer never
   * calls `Date.now()` directly.
   */
  readonly clock?: Clock
  /** Reserved for future deterministic tie-breaks; unused by WP-04a semantics. */
  readonly random?: RandomSource
}

export interface Reducer {
  readonly reduce: (state: UiState, event: AppEvent) => UiState
}

/** Standalone pure entry point (no injected clock/random). */
export function reduce(state: UiState, event: AppEvent): UiState {
  return reduceWith(state, event, {})
}

export function createReducer(deps: ReducerDeps = {}): Reducer {
  return { reduce: (state, event) => reduceWith(state, event, deps) }
}

// ---------------------------------------------------------------------------
// Small state helpers
// ---------------------------------------------------------------------------

function withDiagnostics(state: UiState, diagnostics: UiDiagnosticsState): UiState {
  return { ...state, diagnostics }
}

function bump(state: UiState, field: keyof Omit<UiDiagnosticsState, 'lastError'>): UiState {
  return withDiagnostics(state, { ...state.diagnostics, [field]: state.diagnostics[field] + 1 })
}

function truncate(text: string): string {
  return text.length > DIAGNOSTIC_MESSAGE_MAX ? `${text.slice(0, DIAGNOSTIC_MESSAGE_MAX)}…` : text
}

function withLastError(state: UiState, code: string, message: string, seq: number | null): UiState {
  return withDiagnostics(state, {
    ...state.diagnostics,
    lastError: { code, message: truncate(message), seq },
  })
}

/** Source-identity key for conflict detection (same source+sourceId+sourceSeq). */
function sourceKey(row: { source: string; sourceId: string; sourceSeq: string }): string {
  return JSON.stringify([row.source, row.sourceId, row.sourceSeq])
}

// ---------------------------------------------------------------------------
// Sequencing
// ---------------------------------------------------------------------------

function reduceWith(state: UiState, event: AppEvent, deps: ReducerDeps): UiState {
  // Defensive re-assertion; ingress already ran validateAppEvent (§5.2).
  if ((event as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new TypeError('reducer: event meta.schemaVersion must be 1')
  }
  if (typeof event.adapterInstanceId !== 'string' || event.adapterInstanceId === '') {
    throw new TypeError('reducer: event meta.adapterInstanceId must be a non-empty string')
  }

  if (event.adapterInstanceId !== state.bookkeeping.adapterInstanceId) {
    return handleForeignAdapter(state, event)
  }

  const seq = event.seq
  const last = state.bookkeeping.lastAppliedSeq
  if (seq <= last) return bump(state, 'duplicate')

  // A rows-reset answering a pending snapshot-gap request jumps the queue: it
  // IS the gap heal, so it must not be held behind the gap it resolves.
  if (event.type === 'session/rows-reset' && state.session.pendingReset !== null) {
    return applyRowsReset(state, event)
  }

  if (seq === last + 1) {
    return drainBuffer(applySequenced(state, event))
  }
  return bufferOrGap(state, event, deps)
}

/**
 * Events from a foreign adapterInstanceId. Only a rows-reset may rebind the
 * reducer to a new adapter (cross-process resume, §5.2); the durable session
 * id must match once bound. Everything else is dropped.
 */
function handleForeignAdapter(state: UiState, event: AppEvent): UiState {
  const bound = state.session.durableSessionId !== ''
  if (
    event.type === 'session/rows-reset' &&
    (!bound || event.durableSessionId === state.session.durableSessionId)
  ) {
    return applyRowsReset(state, event)
  }
  // Before the first reset there is no adapter binding at all: non-reset
  // events are not-ready drops rather than adapter conflicts.
  return bump(state, bound ? 'adapterMismatch' : 'droppedNotReady')
}

/** Apply a contiguous event and advance lastAppliedSeq. */
function applySequenced(state: UiState, event: AppEvent): UiState {
  const applied = applyEvent(state, event)
  if (applied.diagnostics.invalidReset !== state.diagnostics.invalidReset) {
    // Failed rows-reset: do not advance (a valid reset must re-establish order).
    return applied
  }
  return {
    ...applied,
    bookkeeping: { ...applied.bookkeeping, lastAppliedSeq: event.seq },
  }
}

/** Drain buffered events while they are contiguous with lastAppliedSeq. */
function drainBuffer(state: UiState): UiState {
  let current = state
  for (;;) {
    const nextSeq = current.bookkeeping.lastAppliedSeq + 1
    const entry = current.bookkeeping.gapBuffer.entries.find((e) => e.seq === nextSeq)
    if (!entry) return current
    const remaining = current.bookkeeping.gapBuffer.entries.filter((e) => e.seq !== nextSeq)
    const without: UiState = {
      ...current,
      bookkeeping: {
        ...current.bookkeeping,
        gapBuffer: {
          firstBufferedAt: remaining.length > 0 ? (remaining[0]?.at ?? null) : null,
          entries: remaining,
        },
      },
    }
    current = applySequenced(without, entry.event)
  }
}

/**
 * Out-of-order event: hold it in the bounded gap buffer, or — when either
 * bound (64 entries / 150 ms first-event wait) is exceeded — request a
 * snapshot-gap reset via state and discard the buffer (§5.2).
 */
function bufferOrGap(state: UiState, event: AppEvent, deps: ReducerDeps): UiState {
  // While a snapshot-gap is pending the buffer stays discarded; further
  // stragglers from the unresolved gap are dropped (counted, bounded).
  if (state.session.pendingReset !== null) {
    return bump(state, 'gapBuffered')
  }
  const buffer = state.bookkeeping.gapBuffer
  if (buffer.entries.some((e) => e.seq === event.seq)) {
    return bump(state, 'duplicate')
  }
  const at = Number.isFinite(event.at) ? event.at : (deps.clock?.now() ?? 0)
  const firstAt = buffer.firstBufferedAt ?? at
  const overflowCount = buffer.entries.length + 1 > GAP_BUFFER_MAX_EVENTS
  const overflowWait = at - firstAt > GAP_BUFFER_MAX_WAIT_MS
  if (overflowCount || overflowWait) {
    return {
      ...state,
      session: {
        ...state.session,
        pendingReset: {
          reason: 'snapshot-gap',
          detectedAtSeq: event.seq,
          gapAfterSeq: state.bookkeeping.lastAppliedSeq,
        },
      },
      bookkeeping: {
        ...state.bookkeeping,
        gapBuffer: { firstBufferedAt: null, entries: [] },
      },
      diagnostics: { ...state.diagnostics, gapReset: state.diagnostics.gapReset + 1 },
    }
  }
  const entry: GapBufferEntry = { seq: event.seq, at, event }
  const entries = [...buffer.entries, entry].sort((a, b) => a.seq - b.seq)
  return {
    ...state,
    bookkeeping: {
      ...state.bookkeeping,
      gapBuffer: { firstBufferedAt: firstAt, entries },
    },
    diagnostics: { ...state.diagnostics, gapBuffered: state.diagnostics.gapBuffered + 1 },
  }
}

// ---------------------------------------------------------------------------
// Per-variant semantics
// ---------------------------------------------------------------------------

function applyEvent(state: UiState, event: AppEvent): UiState {
  if (event.type === 'session/rows-reset') return applyRowsReset(state, event)

  // Reset readiness + epoch guards (§5.2: stale-epoch business events are
  // dropped with bounded diagnostics only).
  if (state.session.readiness !== 'ready') return bump(state, 'droppedNotReady')
  if (event.sessionEpoch !== state.session.sessionEpoch) return bump(state, 'droppedOldEpoch')

  switch (event.type) {
    case 'session/row-upsert':
      return applyRowUpsert(state, event)
    case 'session/row-complete':
      return applyRowComplete(state, event.rowId, event.revision)
    case 'stream/chunk':
      return applyStreamChunk(state, event.rowId, event.text)
    case 'stream/settled':
      return applyStreamSettled(state, event.rowId, event.revision)
    case 'input/command': {
      // Journal (bounded echo for canonical-state comparison), then — for the
      // scroll variant only — apply viewport semantics. Every other command
      // stays journal-only: its visible effects are driven back in by
      // controller-emitted row/overlay events (§5.2 controller/reducer split).
      const journaled: UiState = {
        ...state,
        pendingCommands: [...state.pendingCommands, { seq: event.seq, command: event.command }].slice(
          -PENDING_COMMANDS_MAX,
        ),
      }
      return event.command.type === 'scroll'
        ? applyScrollCommand(journaled, event.command.delta)
        : journaled
    }
    case 'viewport/resize':
      return applyResize(state, event.width, event.height)
    case 'overlay/open':
      return applyOverlayOpen(state, event.overlay)
    case 'overlay/close':
      return applyOverlayClose(state, event.overlayId)
    case 'terminal/suspended':
      return {
        ...state,
        terminal: { ...state.terminal, suspended: true, needsFullRedraw: true },
      }
    case 'terminal/resumed':
      return {
        ...state,
        terminal: {
          ...state.terminal,
          suspended: false,
          generation: state.terminal.generation + 1,
          needsFullRedraw: true,
        },
      }
    case 'app/error':
      return withLastError(state, event.error.code, event.error.message, event.seq)
  }
}

// ---------------------------------------------------------------------------
// viewport scroll semantics (WP-05)
// ---------------------------------------------------------------------------

/** Maximum scrollTop the content allows, in row units (WP-06 maps to lines). */
function maxScrollFor(rowCount: number, viewportHeight: number): number {
  return Math.max(0, rowCount - viewportHeight)
}

/**
 * Apply a scroll input command. Rules (repro-pill / verify-scroll scripts):
 *   - maxScroll === 0: force-pinned to the live tail (scrollTop 0, sticky).
 *   - delta < 0: unstick; scrollTop clamps into [0, maxScroll].
 *   - delta > 0: scrollTop clamps; reaching maxScroll re-engages sticky.
 *   - sticky clears unseenCount; otherwise unseenCount is capped to the rows
 *     below the window (maxScroll - scrollTop), so the pill count decreases
 *     monotonically while scrolling down and never grows via scroll commands.
 *   - While sticky, the base position is the tail window (maxScroll), not the
 *     stale scrollTop, so the first wheel-up starts from the visible window.
 */
function applyScrollCommand(state: UiState, delta: number): UiState {
  if (delta === 0) return state
  const viewport = state.viewport
  const maxScroll = maxScrollFor(state.session.rowOrder.length, viewport.height)
  if (maxScroll === 0) {
    if (viewport.scrollTop === 0 && viewport.maxScroll === 0 && viewport.sticky && viewport.unseenCount === 0) {
      return state
    }
    return {
      ...state,
      viewport: { ...viewport, scrollTop: 0, maxScroll: 0, sticky: true, unseenCount: 0 },
    }
  }
  const base = viewport.sticky ? maxScroll : Math.min(viewport.scrollTop, maxScroll)
  const scrollTop = Math.min(Math.max(0, base + delta), maxScroll)
  const sticky = delta > 0 ? scrollTop >= maxScroll : false
  const unseenCount = sticky ? 0 : Math.min(viewport.unseenCount, maxScroll - scrollTop)
  if (
    scrollTop === viewport.scrollTop &&
    sticky === viewport.sticky &&
    unseenCount === viewport.unseenCount &&
    maxScroll === viewport.maxScroll
  ) {
    return state
  }
  return { ...state, viewport: { ...viewport, scrollTop, maxScroll, sticky, unseenCount } }
}

/**
 * Recompute viewport after a content-size or viewport-height mutation.
 * A sticky viewport follows the tail (scrollTop = maxScroll); a non-sticky
 * viewport keeps scrollTop (shrink freeze) and only caps unseenCount.
 */
function viewportAfterContentChange(viewport: UiState['viewport'], maxScroll: number): UiState['viewport'] {
  if (maxScroll === 0) {
    return { ...viewport, scrollTop: 0, maxScroll: 0, sticky: true, unseenCount: 0 }
  }
  const sticky = viewport.sticky
  const scrollTop = sticky ? maxScroll : viewport.scrollTop
  const unseenCount = sticky ? 0 : Math.min(viewport.unseenCount, Math.max(0, maxScroll - scrollTop))
  return { ...viewport, scrollTop, maxScroll, sticky, unseenCount }
}

// ---------------------------------------------------------------------------
// rows-reset: atomic, all-or-nothing (§5.2)
// ---------------------------------------------------------------------------

function rejectReset(state: UiState, message: string, seq: number): UiState {
  return withLastError(
    withDiagnostics(state, { ...state.diagnostics, invalidReset: state.diagnostics.invalidReset + 1 }),
    'invalid-rows-reset',
    message,
    seq,
  )
}

function applyRowsReset(state: UiState, event: RowsResetEvent): UiState {
  // Shape fields (ready === true, non-empty resetId, rows array) were enforced
  // by validateAppEvent at the boundary; cross-field consistency is checked
  // here. Any failure rejects the whole payload — no partial rows (§5.2).
  if (event.ready !== true) return rejectReset(state, 'ready must be true', event.seq)
  if (event.resetId === '') return rejectReset(state, 'resetId must be non-empty', event.seq)
  if (!Number.isInteger(event.revision) || event.revision < 1) {
    return rejectReset(state, 'revision must be a positive integer', event.seq)
  }
  const expectedEpoch = `${event.uiSessionGeneration}:${event.resetEpoch}`
  if (event.sessionEpoch !== expectedEpoch) {
    return rejectReset(state, `sessionEpoch ${event.sessionEpoch} !== ${expectedEpoch}`, event.seq)
  }
  // Within one generation, reset epochs must move forward (a replayed/stale
  // reset for an old epoch is rejected).
  if (
    state.session.uiSessionGeneration === event.uiSessionGeneration &&
    state.session.resetEpoch >= event.resetEpoch
  ) {
    return rejectReset(state, `stale resetEpoch ${event.resetEpoch}`, event.seq)
  }
  const seenRowIds = new Set<string>()
  for (const [i, row] of event.rows.entries()) {
    if (row.sessionEpoch !== event.sessionEpoch) {
      return rejectReset(state, `rows[${i}] sessionEpoch ${row.sessionEpoch} !== ${event.sessionEpoch}`, event.seq)
    }
    if (seenRowIds.has(row.rowId)) {
      return rejectReset(state, `duplicate rowId ${row.rowId}`, event.seq)
    }
    seenRowIds.add(row.rowId)
  }
  const recomputed = computeSnapshotHash(event.rows)
  if (recomputed !== event.snapshotHash) {
    return rejectReset(state, `snapshotHash ${event.snapshotHash} !== recomputed ${recomputed}`, event.seq)
  }

  // Commit: atomically replace rows and epoch identity, drop every old-epoch
  // reference (viewport anchors, overlays, streaming/pending-row references,
  // gap buffer) except the editor draft (§5.2).
  const rowsById: Record<string, UiRowSnapshot> = {}
  const rowOrder: string[] = []
  const sourceIndex: Record<string, string> = {}
  let streamingRowId: string | null = null
  let oldestLoadedSourceSeq: string | null = null
  let newestLoadedSourceSeq: string | null = null
  for (const row of event.rows) {
    const frozen = deepFreeze({ ...row }) as UiRowSnapshot
    rowsById[frozen.rowId] = frozen
    rowOrder.push(frozen.rowId)
    sourceIndex[sourceKey(frozen)] = frozen.rowId
    if (!frozen.settled) streamingRowId = frozen.rowId
    if (frozen.source === 'session') {
      if (oldestLoadedSourceSeq === null) oldestLoadedSourceSeq = frozen.sourceSeq
      newestLoadedSourceSeq = frozen.sourceSeq
    }
  }

  const session: UiSessionState = {
    durableSessionId: event.durableSessionId,
    uiSessionGeneration: event.uiSessionGeneration,
    resetEpoch: event.resetEpoch,
    sessionEpoch: event.sessionEpoch,
    rowOrder,
    rowsById,
    streamingRowId,
    oldestLoadedSourceSeq,
    newestLoadedSourceSeq,
    readiness: 'ready',
    pendingReset: null,
  }

  return {
    ...state,
    session,
    focus: { target: 'editor', overlayId: null },
    // Follow-end after any reset (rewind truncation, snapshot-gap heal, …):
    // pinned sticky at the tail window, scrollTop = maxScroll so the first
    // wheel-up starts from the visible window rather than the document top.
    viewport: viewportAfterContentChange(
      { ...state.viewport, sticky: true },
      maxScrollFor(rowOrder.length, state.viewport.height),
    ),
    dock: {
      ...state.dock,
      pendingMessages: [],
      notifications: [],
    },
    overlays: { stack: [] },
    terminal: { ...state.terminal, needsFullRedraw: true },
    bookkeeping: {
      adapterInstanceId: event.adapterInstanceId,
      lastAppliedSeq: event.seq,
      gapBuffer: { firstBufferedAt: null, entries: [] },
      sourceIndex,
    },
  }
}

// ---------------------------------------------------------------------------
// rows / streaming
// ---------------------------------------------------------------------------

function applyRowUpsert(state: UiState, event: RowUpsertEvent): UiState {
  const row = event.row
  if (row.sessionEpoch !== state.session.sessionEpoch) return bump(state, 'droppedOldEpoch')

  // SourceSeq conflict: a different rowId was already applied for the same
  // source identity — the later event never overwrites the applied one (§5.2).
  const key = sourceKey(row)
  const mappedRowId = state.bookkeeping.sourceIndex[key]
  if (mappedRowId !== undefined && mappedRowId !== row.rowId) {
    return bump(state, 'conflict')
  }
  return upsertRow(state, row, key)
}

/**
 * Insert or revision-replace one row. Revision must strictly increase for an
 * existing rowId; an equal revision with different bytes is a sourceSeq
 * conflict (first applied wins); an equal revision with identical bytes is an
 * idempotent redelivery (no-op).
 */
function upsertRow(state: UiState, row: UiRowSnapshot, key: string): UiState {
  const session = state.session
  const existing = session.rowsById[row.rowId]
  if (existing !== undefined) {
    if (row.revision < existing.revision) return bump(state, 'droppedStaleRevision')
    if (row.revision === existing.revision) {
      if (canonicalJson(row) !== canonicalJson(existing)) return bump(state, 'conflict')
      return state
    }
    const frozen = deepFreeze({ ...row }) as UiRowSnapshot
    return {
      ...state,
      session: {
        ...session,
        rowsById: { ...session.rowsById, [row.rowId]: frozen },
        streamingRowId: frozen.settled
          ? session.streamingRowId === frozen.rowId
            ? null
            : session.streamingRowId
          : frozen.rowId,
      },
    }
  }

  const frozen = deepFreeze({ ...row }) as UiRowSnapshot
  const isSessionRow = frozen.source === 'session'
  const rowOrder = [...session.rowOrder, frozen.rowId]
  return {
    ...state,
    session: {
      ...session,
      rowOrder,
      rowsById: { ...session.rowsById, [frozen.rowId]: frozen },
      streamingRowId: frozen.settled ? session.streamingRowId : frozen.rowId,
      oldestLoadedSourceSeq:
        isSessionRow && session.oldestLoadedSourceSeq === null
          ? frozen.sourceSeq
          : session.oldestLoadedSourceSeq,
      newestLoadedSourceSeq: isSessionRow ? frozen.sourceSeq : session.newestLoadedSourceSeq,
    },
    viewport: (() => {
      const viewport = viewportAfterContentChange(
        state.viewport,
        maxScrollFor(rowOrder.length, state.viewport.height),
      )
      if (viewport.sticky) return viewport
      // Rows appended below a non-sticky window count as unseen (pill), capped
      // to the rows actually below the window.
      return {
        ...viewport,
        unseenCount: Math.min(
          state.viewport.unseenCount + 1,
          Math.max(0, viewport.maxScroll - viewport.scrollTop),
        ),
      }
    })(),
    bookkeeping: {
      ...state.bookkeeping,
      sourceIndex: { ...state.bookkeeping.sourceIndex, [key]: frozen.rowId },
    },
  }
}

/** Block types whose trailing text a stream/chunk may append to. */
const APPENDABLE_BLOCK_TYPES = new Set(['text', 'markdown', 'reasoning'])

function appendChunkToBlocks(blocks: readonly unknown[], text: string): UiRowSnapshot['blocks'] {
  const next = [...blocks]
  const last = next[next.length - 1]
  if (typeof last === 'string') {
    next[next.length - 1] = last + text
  } else if (
    last !== null &&
    typeof last === 'object' &&
    !Array.isArray(last) &&
    typeof (last as { type?: unknown }).type === 'string' &&
    APPENDABLE_BLOCK_TYPES.has((last as { type: string }).type) &&
    typeof (last as { text?: unknown }).text === 'string'
  ) {
    next[next.length - 1] = { ...(last as Record<string, unknown>), text: (last as { text: string }).text + text }
  } else {
    next.push(text)
  }
  return next as UiRowSnapshot['blocks']
}

function applyStreamChunk(state: UiState, rowId: string, text: string): UiState {
  const session = state.session
  // Chunks only ever append to the current streaming row (§5.3: while
  // streaming only the current row's revision grows).
  if (session.streamingRowId === null || rowId !== session.streamingRowId) {
    return bump(state, 'droppedUnknownRow')
  }
  const row = session.rowsById[rowId]
  if (row === undefined || row.settled) return bump(state, 'droppedUnknownRow')
  const updated: UiRowSnapshot = {
    ...row,
    blocks: appendChunkToBlocks(row.blocks, text),
    revision: row.revision + 1,
  }
  const frozen = deepFreeze(updated) as UiRowSnapshot
  return {
    ...state,
    session: { ...session, rowsById: { ...session.rowsById, [rowId]: frozen } },
  }
}

function applyStreamSettled(state: UiState, rowId: string, revision: number): UiState {
  const session = state.session
  if (session.streamingRowId === null || rowId !== session.streamingRowId) {
    return bump(state, 'droppedUnknownRow')
  }
  const row = session.rowsById[rowId]
  if (row === undefined) return bump(state, 'droppedUnknownRow')
  // Settle pins the revision: take the adapter's claimed final revision, never
  // moving backwards past what chunk appends already published.
  const updated: UiRowSnapshot = {
    ...row,
    settled: true,
    revision: Math.max(row.revision, revision),
  }
  const frozen = deepFreeze(updated) as UiRowSnapshot
  return {
    ...state,
    session: {
      ...session,
      rowsById: { ...session.rowsById, [rowId]: frozen },
      streamingRowId: null,
    },
  }
}

function applyRowComplete(state: UiState, rowId: string, revision: number): UiState {
  const session = state.session
  const row = session.rowsById[rowId]
  if (row === undefined) return bump(state, 'droppedUnknownRow')
  if (row.settled && row.revision >= revision) return state // idempotent completion
  const updated: UiRowSnapshot = {
    ...row,
    settled: true,
    revision: Math.max(row.revision, revision),
  }
  const frozen = deepFreeze(updated) as UiRowSnapshot
  return {
    ...state,
    session: {
      ...session,
      rowsById: { ...session.rowsById, [rowId]: frozen },
      streamingRowId: session.streamingRowId === rowId ? null : session.streamingRowId,
    },
  }
}

// ---------------------------------------------------------------------------
// viewport / overlays
// ---------------------------------------------------------------------------

function applyResize(state: UiState, width: number, height: number): UiState {
  const widthChanged = width !== state.viewport.width
  const maxScroll = maxScrollFor(state.session.rowOrder.length, height)
  const sized = { ...state.viewport, width, height }
  // Shrink freeze (WP-05, verify-scroll): when the viewport grows so scrollTop
  // now exceeds maxScroll, hold the position instead of jumping to 0 — the
  // selector clamps defensively and the next scroll command re-validates.
  // A sticky viewport keeps following the tail; a fully-fitting transcript
  // re-pins (handled inside viewportAfterContentChange).
  const viewport =
    maxScroll === 0 || state.viewport.sticky
      ? viewportAfterContentChange(sized, maxScroll)
      : {
          ...sized,
          maxScroll,
          unseenCount: Math.min(sized.unseenCount, Math.max(0, maxScroll - sized.scrollTop)),
        }
  return {
    ...state,
    viewport,
    terminal: widthChanged
      ? { ...state.terminal, needsFullRedraw: true }
      : state.terminal,
  }
}

function applyOverlayOpen(state: UiState, overlay: OverlayState): UiState {
  const stack = state.overlays.stack
  const index = stack.findIndex((o) => o.overlayId === overlay.overlayId)
  const frozen = deepFreeze({ ...overlay }) as OverlayState
  let nextStack: readonly OverlayState[]
  if (index >= 0) {
    const existing = stack[index] as OverlayState
    if (overlay.revision <= existing.revision) return bump(state, 'droppedStaleRevision')
    nextStack = stack.map((o, i) => (i === index ? frozen : o))
  } else {
    nextStack = [...stack, frozen]
  }
  // captureInput was normalized at the boundary (§5.1: captureInput ===
  // !nonCapturing); a capturing overlay takes input focus.
  const focus = frozen.captureInput
    ? { target: 'overlay' as const, overlayId: frozen.overlayId }
    : state.focus
  return { ...state, overlays: { stack: nextStack }, focus }
}

function applyOverlayClose(state: UiState, overlayId: string): UiState {
  const stack = state.overlays.stack
  if (!stack.some((o) => o.overlayId === overlayId)) return bump(state, 'droppedUnknownOverlay')
  const nextStack = stack.filter((o) => o.overlayId !== overlayId)
  let focus = state.focus
  if (state.focus.overlayId === overlayId) {
    const topCapturing = [...nextStack].reverse().find((o) => o.captureInput)
    focus = topCapturing
      ? { target: 'overlay', overlayId: topCapturing.overlayId }
      : { target: 'editor', overlayId: null }
  }
  return { ...state, overlays: { stack: nextStack }, focus }
}
