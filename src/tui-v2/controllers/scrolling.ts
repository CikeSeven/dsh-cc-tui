/**
 * Scrolling controller (WP-05, plan §5.2 scroll semantics).
 *
 * Translates scroll intent (mouse wheel, pageUp/pageDown, ctrl+home/ctrl+end)
 * into `input/command` {type:'scroll', delta} journal events — the reducer
 * owns the resulting viewport semantics (sticky/unseenCount/clamp, in row
 * units), so live and replay derive identical scroll state. The controller
 * itself holds no UI truth beyond loadOlder anchor bookkeeping.
 *
 *   wheel up/down        → delta ∓ WHEEL_ROWS (3 rows per notch, v1 parity)
 *   pageUp / pageDown    → delta ∓ (viewport.height - 1)
 *   ctrl+home / ctrl+end → top / live tail
 *
 * Rules:
 *  - While `focus.target === 'overlay'` scroll keys are NOT intercepted (the
 *    capturing overlay owns its own scrolling, WP-05b); the wheel stays
 *    transcript-bound.
 *  - Scrolling to the very top with more history available triggers the
 *    synchronous loadOlder chain: capture the first visible row's
 *    (source, sourceId, sourceSeq) triple, run the channel load (the adapter
 *    funnels the prepend into a rows-reset), then locate the anchor row in
 *    the new state and issue the compensating scroll so the window does not
 *    jump. A missing anchor falls back to `prependFallback` ('top' default)
 *    and reports a diagnostic. restored === 0 is a complete no-op.
 *  - The editor's own pageUp/pageDown keybinding (vendored editor pageScroll)
 *    yields to transcript scrolling: the coordinator routes these keys here
 *    BEFORE the editor, so they never reach the editor while the transcript
 *    has focus.
 *
 * Dependency rule (§4.3): model + controller types only; no stdout, no ANSI,
 * no component internals.
 */

import type { AppEvent } from '../model/events.js'
import type { EventMeta } from '../model/schema.js'
import type { UiState } from '../model/state.js'
import type { ChannelCommands } from './session-events.js'

/** Rows scrolled per wheel notch (v1 parity). */
export const WHEEL_ROWS = 3

/** Row-identity triple used as the loadOlder anchor (survives a rows-reset). */
export interface RowAnchor {
  readonly source: string
  readonly sourceId: string
  readonly sourceSeq: string
}

/** Renderer seam: pin the render anchor to a transcript row (WP-06 HeightIndex
 *  turns this into physical-line anchoring). */
export interface ScrollBridge {
  readonly captureAnchor: (anchor: RowAnchor) => void
}

export interface ScrollingControllerOptions {
  /** Outgoing event journal (coordinator dispatch pipeline). */
  readonly dispatch: (event: AppEvent) => void
  /** Allocate the journal event envelope; controller sourceSeqs are `scroll-N`. */
  readonly nextMeta: (sourceSeq: string) => EventMeta
  readonly getState: () => UiState
  /** Adapter command surface (loadOlder prepends folded history). */
  readonly commands: Pick<ChannelCommands, 'loadOlder'>
  /** Optional renderer anchor bridge (coordinator wiring). */
  readonly bridge?: ScrollBridge
  /** Fallback window edge when the anchor row vanished mid-load. */
  readonly prependFallback?: 'top' | 'bottom'
  readonly onDiagnostic?: (diagnostic: { code: string; message: string }) => void
}

export interface ScrollingControllerDiagnostics {
  readonly scrollCommands: number
  readonly wheelScrolls: number
  readonly keyScrolls: number
  readonly loadOlderRuns: number
  readonly loadOlderRestored: number
  readonly anchorRestores: number
  readonly anchorFallbacks: number
}

export interface ScrollingController {
  /**
   * Wheel intent; returns true when consumed (always, unless an overlay
   * captures input).
   */
  readonly handleWheel: (direction: 'up' | 'down') => boolean
  /**
   * pageUp/pageDown/ctrl+home/ctrl+end; returns true when the key was
   * consumed (false → the coordinator forwards the key to the editor).
   */
  readonly handleKey: (key: string | null) => boolean
  /** Journal a scroll command (positive = towards the tail). */
  readonly scrollBy: (delta: number) => void
  /**
   * Synchronous loadOlder chain with anchor restore; returns the restored
   * count (0 = no-op).
   */
  readonly loadOlderAtTop: () => number
  /** Whether the channel has folded history left to restore. */
  readonly canLoadOlder: () => boolean
  /** Rows below the current window (the scroll-pill count). */
  readonly rowsBelowViewport: () => number
  readonly diagnostics: () => ScrollingControllerDiagnostics
}

export function createScrollingController(options: ScrollingControllerOptions): ScrollingController {
  let journalSeq = 0
  /** Re-entrancy guard: loadOlder's own compensating scroll must not retrigger
   *  the auto-load check. */
  let inLoadOlder = false
  const counts = {
    scrollCommands: 0,
    wheelScrolls: 0,
    keyScrolls: 0,
    loadOlderRuns: 0,
    loadOlderRestored: 0,
    anchorRestores: 0,
    anchorFallbacks: 0,
  }

  const diagnostic = (code: string, message: string): void => {
    options.onDiagnostic?.({ code, message })
  }

  const journalScroll = (delta: number): void => {
    if (delta === 0) return
    journalSeq += 1
    counts.scrollCommands += 1
    options.dispatch({
      ...options.nextMeta(`scroll-${journalSeq}`),
      type: 'input/command',
      command: { type: 'scroll', delta },
    })
    // v1 parity: landing on the transcript top with the window unfollowed
    // pulls folded history in (a restored===0 loadOlder is a complete no-op).
    if (inLoadOlder) return
    const state = options.getState()
    if (state.session.readiness === 'ready' && !state.viewport.sticky && state.viewport.scrollTop === 0) {
      loadOlderAtTop()
    }
  }

  const overlayCaptures = (): boolean => options.getState().focus.target === 'overlay'

  /** First visible transcript row's identity triple (anchor for loadOlder). */
  const firstVisibleAnchor = (): RowAnchor | null => {
    const state = options.getState()
    const total = state.session.rowOrder.length
    if (total === 0) return null
    const start = state.viewport.sticky
      ? Math.max(0, total - Math.max(0, state.viewport.height))
      : Math.min(Math.max(0, state.viewport.scrollTop), Math.max(0, total - 1))
    const row = state.session.rowsById[state.session.rowOrder[start] as string]
    if (row === undefined) return null
    return { source: row.source, sourceId: row.sourceId, sourceSeq: row.sourceSeq }
  }

  /** Index of the anchor identity in the (possibly reset) current state. */
  const indexOfAnchor = (anchor: RowAnchor): number | null => {
    const state = options.getState()
    for (let i = 0; i < state.session.rowOrder.length; i++) {
      const row = state.session.rowsById[state.session.rowOrder[i] as string]
      if (
        row !== undefined &&
        row.source === anchor.source &&
        row.sourceId === anchor.sourceId &&
        row.sourceSeq === anchor.sourceSeq
      ) {
        return i
      }
    }
    return null
  }

  const loadOlderAtTop = (): number => {
    if (overlayCaptures()) return 0
    counts.loadOlderRuns += 1
    const anchor = firstVisibleAnchor()
    inLoadOlder = true
    let restored = 0
    try {
      restored = options.commands.loadOlder()
    } finally {
      inLoadOlder = false
    }
    if (restored <= 0) return 0
    counts.loadOlderRestored += restored
    if (anchor !== null) {
      const index = indexOfAnchor(anchor)
      if (index !== null) {
        // The prepend shifted every row right by `restored`; keep the anchor
        // row at the window top. The reducer clamped the raw scroll command,
        // so compute the delta against the fresh state's scrollTop.
        const state = options.getState()
        const base = state.viewport.sticky
          ? state.viewport.maxScroll
          : state.viewport.scrollTop
        options.bridge?.captureAnchor(anchor)
        journalScroll(index - base)
        counts.anchorRestores += 1
        return restored
      }
      counts.anchorFallbacks += 1
      diagnostic(
        'scroll-anchor-fallback',
        'loadOlder anchor row vanished; falling back to the window edge',
      )
    }
    if ((options.prependFallback ?? 'top') === 'top') {
      journalScroll(-(options.getState().session.rowOrder.length))
    }
    return restored
  }

  return {
    handleWheel(direction) {
      if (overlayCaptures()) return false
      counts.wheelScrolls += 1
      journalScroll(direction === 'up' ? -WHEEL_ROWS : WHEEL_ROWS)
      return true
    },

    handleKey(key) {
      if (key === null || overlayCaptures()) return false
      const state = options.getState()
      const page = Math.max(1, state.viewport.height - 1)
      if (key === 'pageUp') {
        counts.keyScrolls += 1
        journalScroll(-page)
        return true
      }
      if (key === 'pageDown') {
        counts.keyScrolls += 1
        journalScroll(page)
        return true
      }
      if (key === 'ctrl+home') {
        counts.keyScrolls += 1
        journalScroll(-state.session.rowOrder.length - Math.max(0, state.viewport.height))
        return true
      }
      if (key === 'ctrl+end') {
        counts.keyScrolls += 1
        journalScroll(state.session.rowOrder.length + Math.max(0, state.viewport.height))
        return true
      }
      return false
    },

    scrollBy(delta) {
      journalScroll(delta)
    },

    loadOlderAtTop,

    canLoadOlder() {
      const state = options.getState()
      // Folded history is a channel-side pool; the model can only tell whether
      // the window is at the transcript top (windowStart > 0 means unloaded
      // rows above the window, which loadOlder may restore).
      return state.session.readiness === 'ready' && state.session.rowOrder.length > 0
    },

    rowsBelowViewport() {
      const state = options.getState()
      const viewport = state.viewport
      if (viewport.sticky) return 0
      return Math.max(0, viewport.maxScroll - viewport.scrollTop)
    },

    diagnostics: () => ({ ...counts }),
  }
}
