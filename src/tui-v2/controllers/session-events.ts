/**
 * tui-v2 Channel UI adapter (WP-04c, plan §7.2 + §5.2/§5.3).
 *
 * The bridge from the legacy `Channel` store to the v2 event pipeline:
 *
 *   Channel.subscribe/version/rows/status/actions
 *     -> ChannelUiAdapter (deep snapshot + diff)
 *     -> AppEvent stream (single adapter seq space, shared via EventMetaFactory)
 *     -> streaming controller -> reducer ingress
 *
 * What §7.2 pins down and how this module implements it:
 *
 *  - `Channel.subscribe` (and the channel-internal `emitStream`) only WAKE the
 *    adapter; they carry no payload. Every wakeup re-reads `channel.rows` and
 *    deep-snapshots it (nested `ToolRow` included, plus notifications/pending/
 *    status for the boundary copy), then diffs against the previously
 *    published snapshot via `computeSnapshotHash` + adapter-assigned seq. The
 *    adapter NEVER claims chunk/time/completion boundaries from the wakeup:
 *    stream/chunk events are merged per-wakeup text deltas produced by the
 *    diff, marked `meta.source: 'session'` with the row's durable sourceSeq
 *    (session event seq) or the adapter-assigned epoch ordinal.
 *  - Row identity (§5.3): rows with a durable `ChatRow.seq` map to
 *    `source 'session'`, `sourceSeq = String(seq)`, `durableEventId` set.
 *    Rows without one (local/notice/...) get a per-(source, sourceId) ordinal
 *    allocated by the adapter inside the current reset epoch; the assignment
 *    is pinned to the row OBJECT (WeakMap) so in-place channel mutations keep
 *    their identity, and it is never derived from the array index, the text
 *    or the reusable `ChatRow.id`. rowIds come from `projectRow`/`encodeRowId`
 *    under `<uiSessionGeneration>:<resetEpoch>`.
 *  - Revisions: the injected `RevisionAllocator` owns row revisions. A
 *    stream/chunk emission ALSO advances the row's allocator counter so the
 *    adapter's view of the row revision tracks the reducer's (+1 per applied
 *    chunk) even when a downstream controller merges chunk events — the
 *    settle event then pins the final revision and the reducer's
 *    `max(applied, pinned)` absorbs the merge. Settled rows never republish
 *    at the same revision; tool `running -> result/error` publishes a new row
 *    revision AND a new `ToolLifecycleSnapshot` (`lifecycleRevision` from the
 *    allocator's separate domain — spinner/notification noise never bumps it).
 *  - Streaming channel: the reducer accepts chunks for ONE streaming row (the
 *    latest non-settled upsert). The adapter tracks the same rule: chunks go
 *    to the current chunk-channel row only; any other streaming row's growth
 *    is republished as row-upsert revisions (documented WP-04 degradation;
 *    the legacy channel streams at most one assistant/reasoning row at a time
 *    in practice).
 *  - Resets: resume/new session/rewind/clear publish a full
 *    `session/rows-reset` (`computeSnapshotHash` over the reset rows,
 *    `ready: true`, reason mapped from the initiating command) and invalidate
 *    every cached identity/revision (allocator reset, ordinal counters
 *    cleared). A structural break detected at the diff boundary (rows
 *    removed/reordered, identity drift, or the adapter's published mirror
 *    failing the post-diff self-check against the fresh snapshot) takes
 *    priority and resets with reason `snapshot-gap` — rows are never silently
 *    dropped. `recoverSnapshotGap()` answers the reducer's
 *    `state.session.pendingReset` marker the same way.
 *  - Commands: submit/steer/cancel/clear/loadOlder/newSession/resumeTo/
 *    rewindTo are exposed as the `ChannelCommands` surface; components never
 *    touch the channel (§5.1). Reset-causing commands set the mapped reason
 *    and flush the reset once the channel call settled, with the diff
 *    suspended in between so a mid-resume wakeup cannot fire a wrong-reason
 *    structural reset. `withReset` is async-aware (WP-05): when the channel
 *    operation returns a promise, the diff stays suspended until it settles;
 *    a rejection clears the pending reason, reports a diagnostic and flushes
 *    so the structural-break detector re-syncs.
 *  - Reset suppression: `suspendDiff()`/`resumeDiff()` bracket reset-causing
 *    channel operations.
 *  - Dock mirror (WP-05): dock dynamics (status/working/model/tokens/cwd/
 *    branch + notifications + pending) are NOT AppEvents — the canonical
 *    state excludes them by design (§5.2). The adapter publishes a deduped
 *    `DockStoreView` (canonicalJson signature) through `onDockChange` at the
 *    end of every flush; the coordinator merges it into the DockView the way
 *    it mirrors the editor. If a later WP needs dock data in canonical state,
 *    the §5.2 event schema must be extended first.
 *
 * Store subscription priorities (§7.2 bullet 4 — WP-05 wires the dock mirror
 * through `onDockChange`; question/approval/dialog stores remain a later WP):
 *   1. session rows (this adapter's channel subscribe) — drives transcript;
 *   2. question/approval/dialog stores — overlay capture priority above the
 *      editor (input routing must see them before the editor);
 *   3. status/notification/pending stores — dock-level, lowest priority,
 *      coalesced with stream wakeups (the dock mirror below).
 *   The wakeup handler below therefore keeps a single subscription and leaves
 *   `attachStores` as the documented seam for bullet 2.
 *
 * Dependency rule (§4.3): controllers import model + dsh-adapter TYPES; they
 * never write stdout, never build ANSI, never touch component internals.
 */
import type { AppEvent } from '../model/events.js'
import { canonicalJson } from '../model/canonical-json.js'
import { computeSnapshotHash, projectRow, type ProjectionRowKind, type ProjectionToolInput } from '../model/projections.js'
import { createRevisionAllocator, type RevisionAllocator } from '../model/revisions.js'
import {
  deepCopySerializable,
  deepFreeze,
  type Clock,
  type EventMeta,
  type EventSource,
  type ResetReason,
  type SerializableValue,
  type UiRowSnapshot,
  type UiSnapshot,
} from '../model/schema.js'
import type { Channel, ChatRow, ResumeResult, ToolRow } from '../../dsh-adapter/channel.js'

// ---------------------------------------------------------------------------
// EventMetaFactory — the single seq space shared by every event producer
// (adapter, input controller, terminal-lifecycle controller). The streaming
// controller re-sequences on emission; factory seqs stay the causal order.
// ---------------------------------------------------------------------------

export interface EventMetaFactoryOptions {
  readonly adapterInstanceId: string
  readonly durableSessionId: string
  readonly uiSessionGeneration: string
  readonly clock: Clock
}

export interface EventMetaFactory {
  readonly adapterInstanceId: string
  readonly durableSessionId: string
  readonly uiSessionGeneration: string
  /** Current reset epoch; advanced by the adapter on every rows-reset. */
  readonly resetEpoch: number
  /** `<uiSessionGeneration>:<resetEpoch>` of the current epoch. */
  readonly sessionEpoch: string
  /** Last allocated seq (diagnostics; the streaming controller re-sequences). */
  readonly lastSeq: number
  /** Allocate the next event meta. `sourceSeq` must be stable per source. */
  next(source: EventSource, sourceSeq: string): EventMeta
  /** Advance the reset epoch (rows-reset publisher only). */
  advanceResetEpoch(): { readonly resetEpoch: number; readonly sessionEpoch: string }
}

export function createEventMetaFactory(options: EventMetaFactoryOptions): EventMetaFactory {
  let seq = 0
  let resetEpoch = 0
  const factory: EventMetaFactory = {
    adapterInstanceId: options.adapterInstanceId,
    durableSessionId: options.durableSessionId,
    uiSessionGeneration: options.uiSessionGeneration,
    get resetEpoch() {
      return resetEpoch
    },
    get sessionEpoch() {
      return `${options.uiSessionGeneration}:${resetEpoch}`
    },
    get lastSeq() {
      return seq
    },
    next(source, sourceSeq) {
      seq += 1
      return {
        schemaVersion: 1,
        adapterInstanceId: options.adapterInstanceId,
        durableSessionId: options.durableSessionId,
        uiSessionGeneration: options.uiSessionGeneration,
        resetEpoch,
        sessionEpoch: factory.sessionEpoch,
        source,
        sourceSeq,
        seq,
        at: options.clock.now(),
      }
    },
    advanceResetEpoch() {
      resetEpoch += 1
      return { resetEpoch, sessionEpoch: factory.sessionEpoch }
    },
  }
  return factory
}

// ---------------------------------------------------------------------------
// Channel surface the adapter reads (structural subset of the legacy Channel)
// ---------------------------------------------------------------------------

export type ChannelUiChannel = Pick<
  Channel,
  | 'version'
  | 'rows'
  | 'status'
  | 'working'
  | 'model'
  | 'tokens'
  | 'cwd'
  | 'gitBranch'
  | 'notifications'
  | 'pending'
  | 'subscribe'
  | 'submit'
  | 'steer'
  | 'cancel'
  | 'clear'
  | 'loadOlder'
  | 'newSession'
  | 'resumeTo'
  | 'rewindTo'
>

/** Controller command surface (§7.2: components never call the channel). */
export interface ChannelCommands {
  submit(text: string): void
  steer(text: string): void
  /** Abort the in-flight turn. */
  cancel(): void
  /** `/clear`: reset the visible transcript (reason 'clear'). */
  clear(): void
  /** Restore folded rows from the session log; returns the restored count. */
  loadOlder(): number
  /** `/new`: fresh session (reason 'new-session'). */
  newSession(): Promise<boolean>
  /** Switch to a persisted session (reason 'resume'). */
  resumeTo(sessionId: string): Promise<ResumeResult>
  /** Rewind to the user message behind `rowId` (reason 'rewind'). `mode` is
   *  the plugin-offered rewind mode the user picked, null for the plain one. */
  rewindTo(rowId: string, mode?: string | null): Promise<string | null>
}

// ---------------------------------------------------------------------------
// diagnostics / options
// ---------------------------------------------------------------------------

export interface AdapterDiagnostics {
  readonly wakeups: number
  readonly resets: number
  readonly upserts: number
  readonly chunks: number
  readonly settled: number
  /** Settled rows republished with a bumped revision (fold/restore/etc.). */
  readonly settledRevisionBumps: number
  /** Structural breaks that forced a snapshot-gap reset. */
  readonly structuralResets: number
  /** Post-diff mirror self-check mismatches that forced a snapshot-gap reset. */
  readonly selfCheckResets: number
  /** Rows whose tool views were dropped as non-serializable. */
  readonly droppedToolViews: number
}

// ---------------------------------------------------------------------------
// dock mirror (WP-05): dock dynamics are deliberately NOT AppEvents — the
// canonical state excludes them (§5.2). The adapter publishes a deduped view
// through `onDockChange`; the coordinator merges it into the DockView.
// ---------------------------------------------------------------------------

export interface DockStatusView {
  readonly status: string
  readonly working: boolean
  readonly model: string
  readonly tokens: { readonly input: number; readonly output: number }
  readonly cwd: string
  readonly branch: string | null
}

export interface DockNotificationView {
  readonly notificationId: string
  readonly text: string
  readonly color?: 'error' | 'warning' | 'success'
}

export interface DockPendingView {
  readonly id: string
  readonly text: string
  readonly placement: 'steer' | 'followup'
}

export interface DockStoreView {
  /** Monotonic per-adapter publication counter (changes only on real diffs). */
  readonly revision: number
  readonly status: DockStatusView
  readonly notifications: readonly DockNotificationView[]
  readonly pending: readonly DockPendingView[]
}

export interface ChannelUiAdapterOptions {
  readonly channel: ChannelUiChannel
  /** Shared event identity/seq space (coordinator-owned). */
  readonly meta: EventMetaFactory
  /** Event ingress (the coordinator's pipeline, via the streaming controller). */
  readonly dispatch: (event: AppEvent) => void
  readonly revisions?: RevisionAllocator
  /** Reason recorded for the initial rows-reset (default 'new-session'). */
  readonly initialResetReason?: ResetReason
  /**
   * Optional welcome text published as one local row right after the initial
   * reset (the legacy Chat welcome panel's skeleton stand-in).
   */
  readonly welcomeText?: string
  /** Dock mirror sink (WP-05); called at flush end when the dock diff changed. */
  readonly onDockChange?: (dock: DockStoreView) => void
  readonly onDiagnostic?: (diagnostic: { code: string; message: string }) => void
}

export interface ChannelUiAdapter {
  /** Subscribe + publish the initial rows-reset (and the welcome row). */
  start(): void
  /** Unsubscribe; later wakeups do nothing. */
  stop(): void
  readonly commands: ChannelCommands
  /** Channel wakeup handler (subscribe listener; exposed for tests). */
  handleWakeup(): void
  /** Force a full re-snapshot + rows-reset with `reason` (synchronous). */
  requestReset(reason: ResetReason): void
  /**
   * Answer the reducer's `state.session.pendingReset` marker: re-snapshot and
   * publish a rows-reset with reason 'snapshot-gap' (§5.2 gap healing).
   */
  recoverSnapshotGap(): void
  /** Latest published immutable snapshot (rows + hash + status). */
  currentSnapshot(): UiSnapshot
  /** Legacy ChatRow behind a canonical rowId (rewind command mapping, WP-05). */
  chatRowForRowId(rowId: string): ChatRow | undefined
  diagnostics(): AdapterDiagnostics
}

// ---------------------------------------------------------------------------
// internal snapshot model
// ---------------------------------------------------------------------------

interface RowIdentity {
  readonly source: UiRowSnapshot['source']
  readonly sourceId: string
  readonly sourceSeq: string
  readonly durableEventId?: string
}

interface SnapshotTool {
  readonly status: 'running' | 'ok' | 'error'
  readonly durationMs?: number
  readonly callView?: SerializableValue
  readonly resultView?: SerializableValue
  readonly errorText?: string
}

/** Content-complete, deep-copied image of one ChatRow at wakeup time. */
interface SnapshotRow {
  /** The legacy row object (identity re-pinning + rewind command mapping). */
  readonly row: ChatRow
  readonly identity: RowIdentity
  readonly kind: ProjectionRowKind
  readonly text: string
  readonly streaming: boolean
  readonly label?: string
  readonly time?: number
  readonly durationMs?: number
  readonly folded?: boolean
  readonly restored?: boolean
  readonly tool?: SnapshotTool
}

/** Adapter-side mirror of one published row (revision/chunk bookkeeping). */
interface PublishedRow {
  readonly identity: RowIdentity
  readonly snapshot: UiRowSnapshot
  /** Content signature used by the diff (excludes revision). */
  readonly signature: string
  /** True while the row receives stream/chunk appends. */
  readonly chunkChannel: boolean
  /**
   * Text watermark after emitted stream/chunks: the snapshot object is NOT
   * replaced per chunk, so without this the next delta would be computed
   * against the stale upsert text and re-append cumulative suffixes.
   */
  readonly chunkedText?: string
  settled: boolean
}

const STATUS_SOURCES: Record<string, UiRowSnapshot['source']> = {
  notice: 'notice',
  local: 'local',
  'local-output': 'local',
}

function safeCopyView(value: unknown): SerializableValue | undefined {
  if (value === undefined) return undefined
  try {
    return deepCopySerializable(value as SerializableValue)
  } catch {
    return undefined
  }
}

function snapshotTool(tool: ToolRow, diagnostics: { dropped: boolean }): SnapshotTool {
  const callView = safeCopyView(tool.callView)
  let resultView = safeCopyView(tool.resultView)
  if (tool.callView !== undefined && callView === undefined) diagnostics.dropped = true
  if (tool.resultView !== undefined && resultView === undefined) diagnostics.dropped = true
  // No structured result view: degrade the plain result text to a string
  // payload — the tool row's payloadLines renders strings directly (WP-08
  // owns rich cards).
  if (resultView === undefined && tool.resultText !== undefined && tool.resultText !== '') {
    resultView = String(tool.resultText)
  }
  return {
    status: tool.status,
    ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
    ...(callView !== undefined ? { callView } : {}),
    ...(resultView !== undefined ? { resultView } : {}),
    ...(tool.errorText !== undefined ? { errorText: String(tool.errorText) } : {}),
  }
}

/** Legacy card header (`Bash(ls -la)` shape) when the row carries no text. */
function toolSummaryText(row: ChatRow): string {
  if (row.tool === undefined) return ''
  const args = row.tool.argsText.trim()
  return args === '' || args === '{}' ? row.tool.name : `${row.tool.name}(${args})`
}

/** Content signature: every diff-relevant field, revision excluded. */
function rowSignature(row: SnapshotRow): string {
  return JSON.stringify([
    row.kind,
    row.text,
    row.streaming,
    row.label ?? null,
    row.time ?? null,
    row.durationMs ?? null,
    row.folded ?? null,
    row.restored ?? null,
    row.tool ?? null,
  ])
}

export function createChannelUiAdapter(options: ChannelUiAdapterOptions): ChannelUiAdapter {
  const channel = options.channel
  const meta = options.meta
  const revisions: RevisionAllocator = options.revisions ?? createRevisionAllocator()

  /** Ordinal counters per (source, sourceId) partition, per reset epoch (§5.3). */
  let ordinalCounters = new Map<string, number>()
  /** Identity pin for rows without a durable seq (row object identity). */
  let localIdentities = new WeakMap<ChatRow, { epoch: string; identity: RowIdentity }>()
  /** rowId -> legacy ChatRow (rewind command mapping); rebuilt per epoch. */
  let rowsByRowId = new Map<string, ChatRow>()

  let published: PublishedRow[] = []
  let started = false
  let unsubscribe: (() => void) | null = null
  let suspendDiffCount = 0
  let resetRevision = 0
  let snapshotRevision = 0
  let pendingResetReason: ResetReason | null = null

  let wakeups = 0
  let resets = 0
  let upserts = 0
  let chunks = 0
  let settledCount = 0
  let settledRevisionBumps = 0
  let structuralResets = 0
  let selfCheckResets = 0
  let droppedToolViews = 0

  const diagnostic = (code: string, message: string): void => {
    options.onDiagnostic?.({ code, message })
  }

  // ------------------------------------------------------------- snapshot

  const identityFor = (row: ChatRow): RowIdentity => {
    if (typeof row.seq === 'number' && Number.isFinite(row.seq)) {
      return {
        source: 'session',
        sourceId: row.kind,
        sourceSeq: String(row.seq),
        durableEventId: String(row.seq),
      }
    }
    const epoch = meta.sessionEpoch
    const pinned = localIdentities.get(row)
    if (pinned !== undefined && pinned.epoch === epoch) return pinned.identity
    const source = STATUS_SOURCES[row.kind] ?? 'local'
    const partition = `${source}:${row.kind}`
    const ordinal = (ordinalCounters.get(partition) ?? 0) + 1
    ordinalCounters.set(partition, ordinal)
    const identity: RowIdentity = {
      source,
      sourceId: row.kind,
      sourceSeq: `local-${ordinal}`,
    }
    localIdentities.set(row, { epoch, identity })
    return identity
  }

  /** Adapter-owned rows that live outside the channel (welcome banner). They
   *  participate in every snapshot, so the structural diff never sees them
   *  vanish. */
  const syntheticRows: ChatRow[] = []

  const snapshotRows = (): SnapshotRow[] => {
    const out: SnapshotRow[] = []
    const dropped = { dropped: false }
    for (const row of [...syntheticRows, ...channel.rows]) {
      const snap: SnapshotRow = {
        row,
        identity: identityFor(row),
        kind: row.kind as ProjectionRowKind,
        text: row.text !== undefined && row.text !== '' ? String(row.text) : toolSummaryText(row),
        streaming: row.streaming === true,
        ...(row.label !== undefined ? { label: String(row.label) } : {}),
        ...(row.time !== undefined ? { time: row.time } : {}),
        ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
        ...(row.folded === true ? { folded: true } : {}),
        ...(row.restored === true ? { restored: true } : {}),
        ...(row.tool !== undefined ? { tool: snapshotTool(row.tool, dropped) } : {}),
      }
      out.push(snap)
    }
    if (dropped.dropped) droppedToolViews += 1
    return out
  }

  const projectSnapshot = (snap: SnapshotRow, revision: number, lifecycleRevision?: number): UiRowSnapshot => {
    const tool: ProjectionToolInput | undefined =
      snap.tool === undefined
        ? undefined
        : {
            status: snap.tool.status,
            lifecycleRevision: lifecycleRevision ?? Math.max(0, revisions.currentLifecycle(encodeIdentityKey(snap.identity))),
            ...(snap.tool.durationMs !== undefined ? { durationMs: snap.tool.durationMs } : {}),
            ...(snap.tool.callView !== undefined ? { callView: snap.tool.callView } : {}),
            ...(snap.tool.resultView !== undefined ? { resultView: snap.tool.resultView } : {}),
            ...(snap.tool.errorText !== undefined
              ? { error: { code: 'tool-error', message: snap.tool.errorText, recoverable: true } }
              : {}),
          }
    return projectRow({
      durableSessionId: meta.durableSessionId,
      uiSessionGeneration: meta.uiSessionGeneration,
      sessionEpoch: meta.sessionEpoch,
      source: snap.identity.source,
      sourceId: snap.identity.sourceId,
      sourceSeq: snap.identity.sourceSeq,
      ...(snap.identity.durableEventId !== undefined ? { durableEventId: snap.identity.durableEventId } : {}),
      revision,
      kind: snap.kind,
      text: snap.text,
      streaming: snap.streaming,
      ...(snap.label !== undefined ? { label: snap.label } : {}),
      ...(snap.time !== undefined ? { time: snap.time } : {}),
      ...(snap.durationMs !== undefined ? { durationMs: snap.durationMs } : {}),
      ...(snap.folded !== undefined ? { folded: snap.folded } : {}),
      ...(snap.restored !== undefined ? { restored: snap.restored } : {}),
      ...(tool !== undefined ? { tool } : {}),
    })
  }

  const encodeIdentityKey = (identity: RowIdentity): string =>
    // The allocator's per-row key: the canonical rowId for this identity.
    // (Kept as a helper so the lifecycle domain stays rowId-keyed.)
    `${meta.sessionEpoch}|${identity.source}|${identity.sourceId}|${identity.sourceSeq}`

  // ---------------------------------------------------------------- events

  const emit = (event: AppEvent): void => {
    options.dispatch(event)
  }

  const emitReset = (rows: SnapshotRow[], reason: ResetReason): void => {
    meta.advanceResetEpoch()
    revisions.reset()
    ordinalCounters = new Map()
    localIdentities = new WeakMap()
    rowsByRowId = new Map()
    resetRevision += 1
    snapshotRevision += 1
    resets += 1

    const projected: UiRowSnapshot[] = []
    const mirror: PublishedRow[] = []
    for (const snap of rows) {
      const row = projectSnapshot(snap, revisions.next(encodeIdentityKey(snap.identity)))
      deepFreeze(row)
      projected.push(row)
      mirror.push({
        identity: snap.identity,
        snapshot: row,
        signature: rowSignature(snap),
        chunkChannel: !row.settled,
        settled: row.settled,
      })
      // Re-pin surviving row objects under the NEW epoch (the WeakMap was
      // just cleared) and seed the ordinal counters with the highest
      // surviving `local-N` per partition so fresh local rows in the new
      // epoch cannot collide with a survivor's sourceSeq.
      localIdentities.set(snap.row, { epoch: meta.sessionEpoch, identity: snap.identity })
      rowsByRowId.set(row.rowId, snap.row)
      const match = /^local-(\d+)$/.exec(snap.identity.sourceSeq)
      if (match !== null) {
        const partition = `${snap.identity.source}:${snap.identity.sourceId}`
        ordinalCounters.set(partition, Math.max(ordinalCounters.get(partition) ?? 0, Number(match[1])))
      }
    }
    published = mirror
    emit({
      ...meta.next('session', `reset-${resetRevision}`),
      type: 'session/rows-reset',
      resetId: `reset-${meta.uiSessionGeneration}-${resetRevision}`,
      rows: projected,
      snapshotHash: computeSnapshotHash(projected),
      revision: resetRevision,
      ready: true,
      reason,
    })
  }

  // -------------------------------------------------------------- diff run

  /**
   * Structural compatibility: every previously published identity must still
   * exist, in the same relative order, and new identities may only append at
   * the end. Anything else is a snapshot gap (resume/rewind/reorder) and
   * forces a reset — rows are never silently dropped (§7.2).
   */
  const findStructuralBreak = (fresh: SnapshotRow[]): boolean => {
    const freshKeys = fresh.map((snap) => encodeIdentityKey(snap.identity))
    let cursor = 0
    for (const old of published) {
      const key = encodeIdentityKey(old.identity)
      const at = freshKeys.indexOf(key, cursor)
      if (at === -1) return true
      cursor = at + 1
    }
    // New identities must append after the last previously-known one.
    if (published.length > 0) {
      const lastKnown = freshKeys.indexOf(encodeIdentityKey(published[published.length - 1].identity))
      for (let i = 0; i < fresh.length; i++) {
        const isKnown = published.some((old) => encodeIdentityKey(old.identity) === freshKeys[i])
        if (!isKnown && i < lastKnown) return true
      }
    }
    return false
  }

  const runDiff = (fresh: SnapshotRow[]): void => {
    const events: AppEvent[] = []
    const mirror: PublishedRow[] = []
    const publishedByKey = new Map(published.map((row) => [encodeIdentityKey(row.identity), row]))
    let chunkChannelKey: string | null = null
    // The chunk channel follows the reducer's rule: the LAST non-settled
    // upsert owns it. Pre-compute which fresh row that is.
    for (const snap of fresh) {
      if (snap.streaming) chunkChannelKey = encodeIdentityKey(snap.identity)
    }

    for (const snap of fresh) {
      const key = encodeIdentityKey(snap.identity)
      const previous = publishedByKey.get(key)
      const signature = rowSignature(snap)
      // Chunk-channel membership: the fresh LAST non-settled row owns it — and
      // a row that owned it last wakeup keeps it for this diff even when it
      // just settled, so the settle transition emits stream/settled on the
      // channel (mirroring the reducer's single-streaming-row rule) instead of
      // falling back to a full row republish.
      const isChunkChannel =
        chunkChannelKey === key || (previous !== undefined && previous.chunkChannel && !previous.settled)

      if (previous === undefined) {
        // New row (append): initial upsert at the row's first revision.
        const revision = revisions.next(key)
        if (snap.tool !== undefined) revisions.nextLifecycle(key)
        const row = projectSnapshot(snap, revision, snap.tool !== undefined ? revisions.currentLifecycle(key) : undefined)
        deepFreeze(row)
        events.push({ ...meta.next('session', snap.identity.sourceSeq), type: 'session/row-upsert', row })
        upserts += 1
        // Pin the rowId -> ChatRow mapping (rewind command mapping); resets
        // rebuild the whole map, appends must extend it (WP-05).
        rowsByRowId.set(row.rowId, snap.row)
        mirror.push({ identity: snap.identity, snapshot: row, signature, chunkChannel: isChunkChannel && !row.settled, settled: row.settled })
        continue
      }

      let working = previous
      const textGrew = snap.text !== previousTextOf(previous)
      if (previous.settled) {
        if (signature !== previous.signature) {
          // Settled-row content change (fold/restore, tool running->result,
          // duration latch): republish at a strictly newer revision (§5.3).
          const lifecycleChanged =
            snap.tool !== undefined &&
            (snap.tool.status !== toolStatusOf(previous) ||
              snap.tool.resultView !== undefined ||
              snap.tool.errorText !== undefined)
          const revision = revisions.next(key)
          const lifecycleRevision =
            snap.tool !== undefined
              ? lifecycleChanged
                ? revisions.nextLifecycle(key)
                : revisions.currentLifecycle(key)
              : undefined
          const row = projectSnapshot(snap, revision, lifecycleRevision)
          deepFreeze(row)
          events.push({ ...meta.next('session', snap.identity.sourceSeq), type: 'session/row-upsert', row })
          upserts += 1
          settledRevisionBumps += 1
          working = { ...working, snapshot: row, signature, settled: row.settled, chunkChannel: false, chunkedText: undefined }
        }
      } else if (isChunkChannel) {
        // Streaming row on the chunk channel: append-only growth is a merged
        // stream/chunk; any other change republishes the row (new revision).
        const previousText = previousTextOf(previous)
        if (snap.text.startsWith(previousText) && textGrew) {
          const delta = snap.text.slice(previousText.length)
          revisions.next(key) // keep the allocator in lockstep with the reducer's +1
          events.push({ ...meta.next('session', snap.identity.sourceSeq), type: 'stream/chunk', rowId: previous.snapshot.rowId, text: delta })
          chunks += 1
          working = { ...working, signature, chunkedText: snap.text }
        } else if (signature !== previous.signature) {
          const revision = revisions.next(key)
          const row = projectSnapshot(snap, revision, snap.tool !== undefined ? revisions.currentLifecycle(key) : undefined)
          deepFreeze(row)
          events.push({ ...meta.next('session', snap.identity.sourceSeq), type: 'session/row-upsert', row })
          upserts += 1
          working = { ...working, snapshot: row, signature, chunkedText: undefined }
        }
        if (!snap.streaming) {
          // Settled this wakeup (possibly right after the final chunk above).
          const revision = Math.max(0, revisions.current(key))
          events.push({
            ...meta.next('session', snap.identity.sourceSeq),
            type: 'stream/settled',
            rowId: previous.snapshot.rowId,
            revision,
          })
          settledCount += 1
          working = { ...working, settled: true, chunkChannel: false, signature }
        }
      } else {
        // Streaming but NOT on the chunk channel (concurrent stream, or the
        // channel moved on): republish via revision bumps. Chunks resume only
        // if the row becomes the latest non-settled upsert again.
        if (signature !== previous.signature) {
          const revision = revisions.next(key)
          const row = projectSnapshot(snap, revision, snap.tool !== undefined ? revisions.currentLifecycle(key) : undefined)
          deepFreeze(row)
          events.push({ ...meta.next('session', snap.identity.sourceSeq), type: 'session/row-upsert', row })
          upserts += 1
          working = { ...working, snapshot: row, signature }
        }
        if (!snap.streaming) {
          const revision = revisions.next(key)
          const row = projectSnapshot({ ...snap, streaming: false }, revision, snap.tool !== undefined ? revisions.currentLifecycle(key) : undefined)
          if (signature !== previous.signature || !working.settled) {
            deepFreeze(row)
            events.push({ ...meta.next('session', snap.identity.sourceSeq), type: 'session/row-upsert', row })
            upserts += 1
            working = { ...working, snapshot: row, settled: true, chunkChannel: false, signature, chunkedText: undefined }
          }
        }
      }
      mirror.push(working)
    }

    // Self-check: applying the computed diff to the published mirror must
    // reproduce the fresh snapshot content-wise. A mismatch means the diff
    // lost a row — reset instead of publishing a partial state (§7.2).
    if (events.length > 0 && !selfCheck(fresh, mirror)) {
      selfCheckResets += 1
      diagnostic('snapshot-self-check', 'diff/mirror mismatch; falling back to snapshot-gap reset')
      pendingResetReason = 'snapshot-gap'
      emitReset(fresh, 'snapshot-gap')
      return
    }
    published = mirror
    snapshotRevision += events.length > 0 ? 1 : 0
    for (const event of events) emit(event)
  }

  const previousTextOf = (row: PublishedRow): string => {
    // Chunks advance the text watermark without replacing the snapshot.
    if (row.chunkedText !== undefined) return row.chunkedText
    // Text of the published snapshot: join of its text-ish blocks.
    return row.snapshot.blocks
      .map((block) =>
        typeof block === 'object' && block !== null && !Array.isArray(block) && 'text' in block
          ? String((block as { text: unknown }).text)
          : typeof block === 'string'
            ? block
            : '',
      )
      .join('')
  }

  const toolStatusOf = (row: PublishedRow): string | undefined => row.snapshot.tool?.phase

  const selfCheck = (fresh: SnapshotRow[], mirror: PublishedRow[]): boolean => {
    if (fresh.length !== mirror.length) return false
    for (let i = 0; i < fresh.length; i++) {
      const snap = fresh[i] as SnapshotRow
      const row = mirror[i] as PublishedRow
      if (encodeIdentityKey(snap.identity) !== encodeIdentityKey(row.identity)) return false
      if (rowSignature(snap) !== row.signature) return false
    }
    return true
  }

  // ---------------------------------------------------------- dock mirror

  let dockRevision = 0
  let lastDockSignature: string | null = null

  /** Publish the dock view when its signature changed since the last flush. */
  const publishDock = (): void => {
    if (options.onDockChange === undefined) return
    const status: DockStatusView = {
      status: String(channel.status),
      working: channel.working === true,
      model: String(channel.model ?? ''),
      tokens: { input: channel.tokens?.input ?? 0, output: channel.tokens?.output ?? 0 },
      cwd: String(channel.cwd ?? ''),
      branch: channel.gitBranch === undefined ? null : String(channel.gitBranch),
    }
    const notifications: DockNotificationView[] = channel.notifications.map((item) => ({
      notificationId: String(item.id),
      text: String(item.text),
      ...(item.color !== undefined ? { color: item.color } : {}),
    }))
    const pending: DockPendingView[] = channel.pending.map((message) => ({
      id: String(message.id),
      text: String(message.text),
      placement: message.placement,
    }))
    const signature = canonicalJson({ status, notifications, pending })
    if (signature === lastDockSignature) return
    lastDockSignature = signature
    dockRevision += 1
    options.onDockChange(deepFreeze({ revision: dockRevision, status, notifications, pending }) as DockStoreView)
  }

  // --------------------------------------------------------------- driver

  /** Row diff/reset driver; `flush` additionally publishes the dock mirror. */
  const flushRows = (): void => {
    const fresh = snapshotRows()
    if (published.length === 0 && resetRevision === 0) {
      emitReset(fresh, options.initialResetReason ?? 'new-session')
      return
    }
    if (pendingResetReason !== null) {
      const reason = pendingResetReason
      pendingResetReason = null
      emitReset(fresh, reason)
      return
    }
    if (findStructuralBreak(fresh)) {
      structuralResets += 1
      diagnostic('snapshot-gap', 'structural break in the row stream; publishing rows-reset')
      emitReset(fresh, 'snapshot-gap')
      return
    }
    runDiff(fresh)
  }

  /** Flush rows, then publish the dock mirror (deduped by signature). */
  const flush = (): void => {
    flushRows()
    publishDock()
  }

  const handleWakeup = (): void => {
    if (!started) return
    wakeups += 1
    if (suspendDiffCount > 0) return
    flush()
  }

  /**
   * Publish the welcome banner as an adapter-owned local row. It joins the
   * synthetic prefix of every later snapshot, so it survives resets and never
   * trips the structural-break detector; the diff publishes its first upsert.
   */
  const publishWelcome = (): void => {
    if (options.welcomeText === undefined || options.welcomeText === '') return
    syntheticRows.push({ id: -1, kind: 'local', text: options.welcomeText })
    if (started) flush()
  }

  /**
   * Bracket a reset-causing channel call: suspend the diff, run it, flush.
   * Async-aware (WP-05): a promise-returning channel operation keeps the diff
   * suspended until it settles, so a mid-resume/newSession/rewind wakeup
   * cannot fire a wrong-reason structural reset. On rejection the pending
   * reason is cleared, a diagnostic is reported and the flush re-syncs via
   * the structural-break detector.
   */
  const withReset = <T>(reason: ResetReason, run: () => T): T => {
    suspendDiffCount += 1
    pendingResetReason = reason
    const settleSync = (): void => {
      suspendDiffCount -= 1
      if (suspendDiffCount === 0 && started) flush()
    }
    const settleAsync = (failed: boolean, error: unknown): void => {
      suspendDiffCount -= 1
      if (failed) {
        pendingResetReason = null
        diagnostic('reset-command-failed', `${reason} command rejected: ${String(error)}`)
      }
      if (suspendDiffCount === 0 && started) flush()
    }
    try {
      const result = run()
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof (result as unknown as PromiseLike<T>).then === 'function'
      ) {
        void (result as unknown as PromiseLike<T>).then(
          () => settleAsync(false, undefined),
          (error: unknown) => settleAsync(true, error),
        )
        return result
      }
      settleSync()
      return result
    } catch (error) {
      settleAsync(true, error)
      throw error
    }
  }

  const adapter: ChannelUiAdapter = {
    start() {
      if (started) return
      started = true
      unsubscribe = channel.subscribe(handleWakeup)
      flush()
      publishWelcome()
    },

    stop() {
      if (!started) return
      started = false
      unsubscribe?.()
      unsubscribe = null
    },

    handleWakeup,

    chatRowForRowId(rowId) {
      return rowsByRowId.get(rowId)
    },

    requestReset(reason) {
      pendingResetReason = reason
      if (started && suspendDiffCount === 0) flush()
    },

    recoverSnapshotGap() {
      diagnostic('snapshot-gap-recovery', 'reducer pendingReset observed; re-snapshotting')
      pendingResetReason = 'snapshot-gap'
      if (started && suspendDiffCount === 0) flush()
    },

    currentSnapshot() {
      snapshotRevision = Math.max(snapshotRevision, 0)
      const rows = published.map((row) => row.snapshot)
      const status: SerializableValue = {
        status: String(channel.status),
        working: channel.working === true,
        model: String(channel.model ?? ''),
        tokens: { input: channel.tokens?.input ?? 0, output: channel.tokens?.output ?? 0 },
        cwd: String(channel.cwd ?? ''),
        branch: channel.gitBranch === undefined ? null : String(channel.gitBranch),
        notifications: channel.notifications.length,
        pending: channel.pending.length,
      }
      return {
        schemaVersion: 1,
        adapterInstanceId: meta.adapterInstanceId,
        durableSessionId: meta.durableSessionId,
        uiSessionGeneration: meta.uiSessionGeneration,
        resetEpoch: meta.resetEpoch,
        sessionEpoch: meta.sessionEpoch,
        revision: snapshotRevision,
        rows,
        snapshotHash: computeSnapshotHash(rows),
        status,
      }
    },

    diagnostics() {
      return {
        wakeups,
        resets,
        upserts,
        chunks,
        settled: settledCount,
        settledRevisionBumps,
        structuralResets,
        selfCheckResets,
        droppedToolViews,
      }
    },

    commands: {
      submit(text) {
        channel.submit(text)
      },
      steer(text) {
        channel.steer(text)
      },
      cancel() {
        channel.cancel()
      },
      clear() {
        withReset('clear', () => channel.clear())
      },
      loadOlder() {
        const restored = channel.loadOlder()
        // Restored content lands via the wakeup diff (settled revision bumps).
        if (started && suspendDiffCount === 0) flush()
        return restored
      },
      newSession() {
        return withReset('new-session', () => channel.newSession())
      },
      resumeTo(sessionId) {
        return withReset('resume', () => channel.resumeTo(sessionId))
      },
      async rewindTo(rowId, mode = null) {
        const row = rowsByRowId.get(rowId)
        if (row === undefined) return null
        return withReset('rewind', () => channel.rewindTo(row, mode))
      },
    },
  }
  return adapter
}
