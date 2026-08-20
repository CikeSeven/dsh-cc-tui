/**
 * tui-v2 model selectors (WP-04, plan §5.2 "model -> selectors -> components").
 *
 * Pure derivations from `UiState` into ViewModels consumed by components.
 * Every call returns fresh wrapper objects; there is deliberately no memoization
 * here (WP-06 adds it if profiling says so). Selectors never mutate state and
 * never read clocks/randomness.
 */
import type { OverlayState, UiRowSnapshot } from './schema.js'
import type {
  UiActivityState,
  UiEditorState,
  UiNotification,
  UiState,
  UiStatusState,
} from './state.js'

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptView {
  /** Rows inside the viewport window (model rows, in transcript order). */
  readonly visibleRows: readonly UiRowSnapshot[]
  /** Total rows currently loaded. */
  readonly totalRows: number
  /** Window bounds into the full row list: [windowStart, windowEnd). */
  readonly windowStart: number
  readonly windowEnd: number
  readonly streamingRowId: string | null
  readonly showUnseenIndicator: boolean
  readonly unseenCount: number
}

/**
 * Window the transcript by viewport state. With `sticky` the window pins to
 * the newest `height` rows; otherwise it shows `height` rows from
 * `scrollTop`. Row-vs-physical-line mapping is the renderer's job (WP-06);
 * the model windows in row units only.
 */
export function selectTranscriptView(state: UiState): TranscriptView {
  const session = state.session
  const rows: UiRowSnapshot[] = []
  for (const rowId of session.rowOrder) {
    const row = session.rowsById[rowId]
    if (row !== undefined) rows.push(row)
  }
  const total = rows.length
  const windowSize = Math.max(0, state.viewport.height)
  let start: number
  if (state.viewport.sticky) {
    start = Math.max(0, total - windowSize)
  } else {
    start = Math.min(Math.max(0, state.viewport.scrollTop), Math.max(0, total - 1))
  }
  const end = Math.min(total, start + windowSize)
  return {
    visibleRows: rows.slice(start, end),
    totalRows: total,
    windowStart: start,
    windowEnd: end,
    streamingRowId: session.streamingRowId,
    showUnseenIndicator: state.viewport.unseenCount > 0,
    unseenCount: state.viewport.unseenCount,
  }
}

// ---------------------------------------------------------------------------
// Dock / editor / status
// ---------------------------------------------------------------------------

export interface DockView {
  readonly editor: UiEditorState
  readonly status: UiStatusState
  readonly activity: UiActivityState | null
  readonly pendingMessages: readonly string[]
  readonly notifications: readonly UiNotification[]
  readonly surface?: UiState['surface']
}

export function selectDockView(state: UiState): DockView {
  return {
    editor: state.dock.editor,
    status: state.dock.status,
    activity: state.dock.activity,
    pendingMessages: state.dock.pendingMessages,
    notifications: state.dock.notifications,
    surface: state.surface,
  }
}

export function selectSurfaceView(state: UiState): UiState['surface'] {
  return state.surface
}

export interface EditorView {
  readonly text: string
  readonly cursor: number
  readonly history: readonly string[]
  readonly historyIndex: number | null
  readonly focused: boolean
}

export function selectEditorView(state: UiState): EditorView {
  const editor = state.dock.editor
  return {
    text: editor.text,
    cursor: editor.cursor,
    history: editor.history,
    historyIndex: editor.historyIndex,
    focused: state.focus.target === 'editor',
  }
}

export interface StatusLineView {
  readonly model: string | null
  readonly tokens: { readonly input: number; readonly output: number } | null
  readonly cwd: string | null
  readonly branch: string | null
  readonly mode: string | null
  readonly extras: Readonly<Record<string, string | number | boolean | null>>
}

export function selectStatusLine(state: UiState): StatusLineView {
  const status = state.dock.status
  return {
    model: status.model ?? null,
    tokens: status.tokens ?? null,
    cwd: status.cwd ?? null,
    branch: status.branch ?? null,
    mode: status.mode ?? null,
    extras: status.extras ?? {},
  }
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/** Ordered overlay stack (bottom first); fresh array per call. */
export function selectOverlayStack(state: UiState): readonly OverlayState[] {
  return [...state.overlays.stack]
}

/** Topmost input-capturing overlay, if any (drives input routing). */
export function selectCapturingOverlay(state: UiState): OverlayState | null {
  const stack = state.overlays.stack
  for (let i = stack.length - 1; i >= 0; i--) {
    const overlay = stack[i] as OverlayState
    if (overlay.captureInput) return overlay
  }
  return null
}
