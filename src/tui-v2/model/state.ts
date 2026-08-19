/**
 * tui-v2 model state (WP-04, plan §5.2 "UiState 至少包含").
 *
 * `UiState` is the single source of truth for the v2 UI. It is pure data:
 * every field is a `SerializableValue`-compatible structure (the reducer
 * bookkeeping included) so a state value can be inspected, diffed and — via
 * `serializeCanonicalUiState` — compared byte-for-byte between live and
 * replay runs. The reducer never mutates a published state; every `reduce`
 * call returns a fresh object graph (structural sharing where untouched).
 *
 * Dependency rule (§4.3): model imports nothing from other layers.
 */
import type { AppEvent } from './events.js'
import type {
  InputCommand,
  OverlayState,
  TerminalMode,
  UiRowSnapshot,
} from './schema.js'

// ---------------------------------------------------------------------------
// Bounded capacities (§5.2: diagnostics and buffers are bounded).
// ---------------------------------------------------------------------------

/** Gap buffer hard cap: at most this many out-of-order events are held. */
export const GAP_BUFFER_MAX_EVENTS = 64
/** Gap buffer time cap: the first buffered event may wait at most this long. */
export const GAP_BUFFER_MAX_WAIT_MS = 150
/** Bounded echo of the most recent input commands (pending command journal). */
export const PENDING_COMMANDS_MAX = 32
/** Bounded notification list in the dock. */
export const NOTIFICATIONS_MAX = 8
/** Bounded pending-message (steer/followup) list in the dock. */
export const PENDING_MESSAGES_MAX = 16
/** Bounded editor history entries. */
export const EDITOR_HISTORY_MAX = 64
/** `diagnostics.lastError.message` is truncated to this many characters. */
export const DIAGNOSTIC_MESSAGE_MAX = 240

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type ResetReadiness = 'awaiting-reset' | 'ready'

/**
 * Durable + UI session identity and the ordered row table. `rowOrder` holds
 * rowIds in transcript order; `rowsById` maps rowId -> immutable snapshot.
 * Both are replaced atomically by `session/rows-reset`.
 */
export interface UiSessionState {
  /** Business identity of the session log; '' until the first rows-reset binds it. */
  readonly durableSessionId: string
  /** Per-adapter-start UI identity; '' until bound. Never reused across resumes. */
  readonly uiSessionGeneration: string
  /** -1 until the first rows-reset; afterwards taken from the reset event meta. */
  readonly resetEpoch: number
  /** `<uiSessionGeneration>:<resetEpoch>`; '' until bound. */
  readonly sessionEpoch: string
  readonly rowOrder: readonly string[]
  readonly rowsById: Readonly<Record<string, UiRowSnapshot>>
  /** Row currently accepting stream/chunk appends; null when settled/none. */
  readonly streamingRowId: string | null
  /** Fold/loadOlder cursor: oldest source seq currently loaded (null = unknown). */
  readonly oldestLoadedSourceSeq: string | null
  /** Newest source seq currently loaded (null = unknown). */
  readonly newestLoadedSourceSeq: string | null
  /** Business events are dropped until the first rows-reset completes. */
  readonly readiness: ResetReadiness
  /**
   * Set when the reducer detected a seq gap it could not heal: a controller
   * must issue a `session/rows-reset` (reason `snapshot-gap`). The reducer
   * never performs the reset itself (§5.2: no side effects in the reducer).
   */
  readonly pendingReset: {
    readonly reason: 'snapshot-gap'
    /** Adapter seq at which the gap was detected. */
    readonly detectedAtSeq: number
    /** Gap window start (lastAppliedSeq when the gap opened). */
    readonly gapAfterSeq: number
  } | null
}

// ---------------------------------------------------------------------------
// Focus / viewport
// ---------------------------------------------------------------------------

export type FocusTarget = 'editor' | 'overlay' | 'scene'

export interface UiFocusState {
  readonly target: FocusTarget
  /** Overlay currently capturing input; must be the topmost capturing overlay. */
  readonly overlayId: string | null
}

export interface UiViewportState {
  readonly width: number
  readonly height: number
  /** First visible transcript row index (model rows, not physical lines). */
  readonly scrollTop: number
  /** Maximum scrollTop the content allows (maintained by the reducer, row units). */
  readonly maxScroll: number
  /** When true the viewport pins to the newest rows on every change. */
  readonly sticky: boolean
  /** Rows appended while the viewport was not sticky (new-message indicator). */
  readonly unseenCount: number
}

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------

/** Editor draft. Survives rows-reset (§5.2: reset clears non-draft references). */
export interface UiEditorState {
  readonly text: string
  /** Cursor as a UTF-16 code-unit offset into `text`. */
  readonly cursor: number
  readonly history: readonly string[]
  /** Index into history while browsing; null when editing a fresh draft. */
  readonly historyIndex: number | null
}

/** Status line payload (model/tokens/cwd/branch/mode ...); free-form but serializable. */
export interface UiStatusState {
  readonly model?: string
  readonly tokens?: { readonly input: number; readonly output: number }
  readonly cwd?: string
  readonly branch?: string
  readonly mode?: string
  readonly extras?: Readonly<Record<string, string | number | boolean | null>>
}

export interface UiActivityState {
  readonly label: string
  readonly detail?: string
  readonly startedAt?: number
}

export interface UiNotification {
  readonly notificationId: string
  readonly text: string
  readonly color?: 'error' | 'warning' | 'success'
}

export interface UiDockState {
  readonly editor: UiEditorState
  readonly status: UiStatusState
  readonly activity: UiActivityState | null
  /** Queued business messages (steer/followup); written by controllers. */
  readonly pendingMessages: readonly string[]
  readonly notifications: readonly UiNotification[]
}

/** Journal entry for an input/command the reducer observed (bounded echo). */
export interface PendingCommand {
  readonly seq: number
  readonly command: InputCommand
}

// ---------------------------------------------------------------------------
// Overlays / terminal / preferences
// ---------------------------------------------------------------------------

/** Ordered overlay stack; index 0 is the bottom, last is topmost. */
export interface UiOverlayStackState {
  readonly stack: readonly OverlayState[]
}

export interface UiTerminalState {
  readonly mode: TerminalMode
  readonly profileId: string
  /** Bumped on terminal/resumed; renderer treats it as a generation change. */
  readonly generation: number
  /** Set on width change / suspend-resume; cleared by the renderer once repainted. */
  readonly needsFullRedraw: boolean
  readonly suspended: boolean
}

export interface UiPreferencesState {
  readonly theme: string
  readonly language: string
  readonly diffLayout: 'unified' | 'split'
  readonly activity: boolean
}

// ---------------------------------------------------------------------------
// Diagnostics (bounded; excluded from canonical state, §5.2)
// ---------------------------------------------------------------------------

export interface UiDiagnosticsState {
  /** seq <= lastAppliedSeq (duplicate / late events). */
  readonly duplicate: number
  /** Events held in the gap buffer (cumulative). */
  readonly gapBuffered: number
  /** Times a gap triggered a snapshot-gap reset request. */
  readonly gapReset: number
  /** Same source identity applied twice with different payload. */
  readonly conflict: number
  /** Business events carrying a stale sessionEpoch. */
  readonly droppedOldEpoch: number
  /** Row/overlay updates whose revision did not increase. */
  readonly droppedStaleRevision: number
  /** Stream/complete events for unknown, settled or non-streaming rows. */
  readonly droppedUnknownRow: number
  /** overlay/close (or focus) for an overlay not on the stack. */
  readonly droppedUnknownOverlay: number
  /** Business events received before the first rows-reset. */
  readonly droppedNotReady: number
  /** Events from a foreign adapterInstanceId (non-reset). */
  readonly adapterMismatch: number
  /** rows-reset events that failed atomic validation. */
  readonly invalidReset: number
  readonly lastError: {
    readonly code: string
    readonly message: string
    readonly seq: number | null
  } | null
}

// ---------------------------------------------------------------------------
// Reducer bookkeeping (never rendered; excluded from canonical state)
// ---------------------------------------------------------------------------

export interface GapBufferEntry {
  readonly seq: number
  /** Event-carried `at` of the buffered event (deterministic; never a wall clock). */
  readonly at: number
  readonly event: AppEvent
}

export interface GapBufferState {
  /** `at` of the first buffered event in the current gap window. */
  readonly firstBufferedAt: number | null
  /** Buffered events, sorted by ascending seq, capped at GAP_BUFFER_MAX_EVENTS. */
  readonly entries: readonly GapBufferEntry[]
}

export interface UiBookkeepingState {
  /** Adapter instance whose seq stream is currently being applied. */
  readonly adapterInstanceId: string
  /** Highest contiguous applied seq for the current adapter instance. */
  readonly lastAppliedSeq: number
  readonly gapBuffer: GapBufferState
  /**
   * Applied source identity (JSON [source, sourceId, sourceSeq]) -> rowId.
   * Detects same-sourceSeq/different-payload conflicts without guessing
   * winners from arrival time (§5.2). Rebuilt on every rows-reset.
   */
  readonly sourceIndex: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// UiState
// ---------------------------------------------------------------------------

export interface UiState {
  readonly session: UiSessionState
  readonly focus: UiFocusState
  readonly viewport: UiViewportState
  readonly dock: UiDockState
  readonly overlays: UiOverlayStackState
  readonly terminal: UiTerminalState
  readonly preferences: UiPreferencesState
  readonly diagnostics: UiDiagnosticsState
  /** input/command journal (bounded at PENDING_COMMANDS_MAX). */
  readonly pendingCommands: readonly PendingCommand[]
  readonly bookkeeping: UiBookkeepingState
}

export interface InitialUiStateOptions {
  readonly width: number
  readonly height: number
  readonly profileId: string
  readonly theme: string
  readonly language: string
  readonly mode?: TerminalMode
  readonly diffLayout?: 'unified' | 'split'
  readonly activity?: boolean
}

/**
 * Pre-bootstrap state: valid but unbound (no session identity, readiness
 * 'awaiting-reset'). The first `session/rows-reset` binds identity and rows.
 */
export function initialUiState(options: InitialUiStateOptions): UiState {
  return {
    session: {
      durableSessionId: '',
      uiSessionGeneration: '',
      resetEpoch: -1,
      sessionEpoch: '',
      rowOrder: [],
      rowsById: {},
      streamingRowId: null,
      oldestLoadedSourceSeq: null,
      newestLoadedSourceSeq: null,
      readiness: 'awaiting-reset',
      pendingReset: null,
    },
    focus: { target: 'editor', overlayId: null },
    viewport: {
      width: options.width,
      height: options.height,
      scrollTop: 0,
      maxScroll: 0,
      sticky: true,
      unseenCount: 0,
    },
    dock: {
      editor: { text: '', cursor: 0, history: [], historyIndex: null },
      status: {},
      activity: null,
      pendingMessages: [],
      notifications: [],
    },
    overlays: { stack: [] },
    terminal: {
      mode: options.mode ?? 'fullscreen',
      profileId: options.profileId,
      generation: 0,
      needsFullRedraw: true,
      suspended: false,
    },
    preferences: {
      theme: options.theme,
      language: options.language,
      diffLayout: options.diffLayout ?? 'unified',
      activity: options.activity ?? true,
    },
    diagnostics: {
      duplicate: 0,
      gapBuffered: 0,
      gapReset: 0,
      conflict: 0,
      droppedOldEpoch: 0,
      droppedStaleRevision: 0,
      droppedUnknownRow: 0,
      droppedUnknownOverlay: 0,
      droppedNotReady: 0,
      adapterMismatch: 0,
      invalidReset: 0,
      lastError: null,
    },
    pendingCommands: [],
    bookkeeping: {
      adapterInstanceId: '',
      lastAppliedSeq: 0,
      gapBuffer: { firstBufferedAt: null, entries: [] },
      sourceIndex: {},
    },
  }
}
