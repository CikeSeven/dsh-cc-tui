/**
 * Replay controller (WP-05, plan §5.2 live/replay equivalence).
 *
 * Two halves:
 *
 *  1. `replayTrace` — the canonical replay entry point: feed a Trace (or a
 *     plain AppEvent array) through validateAppEvent + deepFreeze + reduce and
 *     return the resulting UiState. Live and replay MUST converge to identical
 *     canonical state (serializeCanonicalUiState bytes); the controllers test
 *     suite asserts that equivalence over adversarial scenarios (duplicates,
 *     out-of-order/gap healing, resets, resume, rewind, cancel).
 *
 *  2. `ReplayController` — session-navigation commands with their async
 *     lifecycle owned here (a controller concern, §4.3):
 *       - newSession / resume / clear passthrough to the adapter commands
 *         surface, with failures journaled as app/error and surfaced via
 *         notify (the dock mirror carries them to the UI).
 *       - the rewind three-phase flow: list candidates (user rows without a
 *         label, newest first), request a rewind decision (channel
 *         promptRewind seam — a plugin may veto or offer extra modes), then
 *         confirm (adapter rewindTo; the returned text is refilled into the
 *         editor draft and journaled as an editor/insert command so replay
 *         sees the same intent). A monotonic token supersedes stale async
 *         completions (a later request cancels an earlier in-flight one).
 *       - the update-restart mini state machine: prepared -> committed ->
 *         stopped|cancelled. Commit asks the coordinator to stop with reason
 *         'teardown'; cancelling before commit leaves the session running.
 *         The actual self-update orchestration is WP-08; this controller only
 *         owns the UI-side state transitions.
 *
 * Dependency rule (§4.3): model + dsh-adapter types only; no stdout, no ANSI,
 * no component internals.
 */

import { validateAppEvent, type AppEvent } from '../model/events.js'
import type { Reducer } from '../model/reducer.js'
import type { EventMeta, SerializableError } from '../model/schema.js'
import { deepFreeze } from '../model/schema.js'
import type { UiState } from '../model/state.js'
import type { Trace } from '../testkit/trace.js'
import type { ChannelCommands } from './session-events.js'
import type { ChatRow, ResumeResult } from '../../dsh-adapter/channel.js'
import type { TuiRewindMode } from '../../dsh-adapter/extension-events.js'
import type { LifecycleStopReason } from '../terminal/lifecycle.js'

// ---------------------------------------------------------------------------
// replayTrace — deterministic re-execution of an event stream
// ---------------------------------------------------------------------------

function traceEventsOf(input: Trace | readonly AppEvent[]): readonly AppEvent[] {
  if ('lines' in input) {
    return input.lines
      .filter((line) => line.kind === 'event')
      .map((line) => (line as { event: AppEvent }).event)
  }
  return input
}

/**
 * Replay a trace (or raw event array) through the reducer. Every event is
 * shape-validated and deep-frozen exactly like live ingress, so the result is
 * comparable to a live run via serializeCanonicalUiState.
 */
export function replayTrace(
  input: Trace | readonly AppEvent[],
  reducer: Reducer,
  initialState: UiState,
): UiState {
  let state = initialState
  for (const raw of traceEventsOf(input)) {
    const event = validateAppEvent(raw)
    state = reducer.reduce(state, deepFreeze(event) as AppEvent)
  }
  return state
}

// ---------------------------------------------------------------------------
// ReplayController
// ---------------------------------------------------------------------------

export interface RewindCandidate {
  readonly rowId: string
  readonly text: string
  readonly time?: number
}

/** The rewind decision seam (channel.promptRewind), rowId-mapped. */
export type PromptRewind = (
  row: ChatRow,
) => Promise<{ readonly modes: readonly TuiRewindMode[] } | 'cancel' | null>

export type RewindRequest =
  | { readonly kind: 'ready'; readonly rowId: string; readonly modes: readonly TuiRewindMode[] }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unknown-row' }
  | { readonly kind: 'superseded' }

export type RewindConfirm =
  | { readonly kind: 'rewound'; readonly text: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'superseded' }

export type UpdateRestartPhase = 'idle' | 'prepared' | 'committed' | 'stopped' | 'cancelled'

export interface ReplayControllerOptions {
  /** Outgoing event journal (coordinator dispatch pipeline). */
  readonly dispatch: (event: AppEvent) => void
  /** Allocate the journal event envelope; controller sourceSeqs are `replay-N`. */
  readonly nextMeta: (sourceSeq: string) => EventMeta
  /** Adapter command surface (reset-causing ops run under withReset). */
  readonly commands: Pick<ChannelCommands, 'newSession' | 'resumeTo' | 'clear' | 'rewindTo'>
  /** Canonical rowId -> legacy ChatRow (rewind decision mapping). */
  readonly chatRowForRowId: (rowId: string) => ChatRow | undefined
  /** Rewind decision prompt (plugin seam); see Channel.promptRewind. */
  readonly promptRewind: PromptRewind
  /** Current model state (rewind candidates are derived from it). */
  readonly getState: () => UiState
  /** Editor draft refill after a successful rewind. */
  readonly setEditorDraft: (text: string) => void
  /** Dock-level notification sink. */
  readonly notify: (text: string, options?: { color?: 'error' | 'warning' | 'success' }) => void
  /** Coordinator stop request (update-restart commit). */
  readonly requestStop: (reason: LifecycleStopReason) => void
}

export interface ReplayControllerDiagnostics {
  readonly newSessions: number
  readonly resumes: number
  readonly resumeFailures: number
  readonly clears: number
  readonly rewindRequests: number
  readonly rewindCancels: number
  readonly rewinds: number
  readonly superseded: number
  readonly updateRestarts: number
}

export interface ReplayController {
  /** `/new`: fresh session; failure journals app/error + notifies. */
  readonly newSession: () => Promise<boolean>
  /** `/resume <id>`: adopt a persisted session; non-ok results notify, and
   *  'failed' additionally journals app/error. */
  readonly resume: (sessionId: string) => Promise<ResumeResult>
  /** `/clear`: reset the visible transcript. */
  readonly clear: () => void
  /** Rewind candidates: user rows without a label, newest first. */
  readonly listRewindCandidates: () => readonly RewindCandidate[]
  /** Phase 1 of rewind: ask the decision seam (veto/extra modes). */
  readonly requestRewind: (rowId: string) => Promise<RewindRequest>
  /** Phase 2 of rewind: execute; refills the editor draft on success. */
  readonly confirmRewind: (rowId: string, mode?: string | null) => Promise<RewindConfirm>
  /** Update-restart mini state machine (WP-08 owns the updater itself). */
  readonly updateRestart: {
    readonly phase: () => UpdateRestartPhase
    readonly prepare: () => void
    /** Commit: stop the UI for teardown. Returns false unless prepared. */
    readonly commit: () => boolean
    /** Cancel before commit: back to idle, session keeps running. */
    readonly cancel: () => void
    /** Mark the stopped terminal state after commit (test hook / WP-08). */
    readonly markStopped: () => void
  }
  readonly diagnostics: () => ReplayControllerDiagnostics
}

export function createReplayController(options: ReplayControllerOptions): ReplayController {
  let journalSeq = 0
  /** Monotonic token: a newer async op supersedes every earlier one. */
  let opToken = 0
  let restartPhase: UpdateRestartPhase = 'idle'
  const counts = {
    newSessions: 0,
    resumes: 0,
    resumeFailures: 0,
    clears: 0,
    rewindRequests: 0,
    rewindCancels: 0,
    rewinds: 0,
    superseded: 0,
    updateRestarts: 0,
  }

  const journal = (body: Pick<AppEvent, 'type'> & Record<string, unknown>): void => {
    journalSeq += 1
    options.dispatch({ ...options.nextMeta(`replay-${journalSeq}`), ...body } as AppEvent)
  }

  const journalError = (code: string, message: string): void => {
    const error: SerializableError = { code, message, recoverable: true }
    journal({ type: 'app/error', error })
  }

  return {
    async newSession() {
      counts.newSessions += 1
      const token = ++opToken
      const ok = await options.commands.newSession()
      if (token !== opToken) {
        counts.superseded += 1
        return false
      }
      if (!ok) {
        journalError('new-session-failed', 'newSession returned false')
        options.notify('Failed to start a new session', { color: 'error' })
      }
      return ok
    },

    async resume(sessionId) {
      counts.resumes += 1
      const token = ++opToken
      const result = await options.commands.resumeTo(sessionId)
      if (token !== opToken) {
        counts.superseded += 1
        return { ok: false, reason: 'cancelled' }
      }
      if (!result.ok) {
        counts.resumeFailures += 1
        if (result.reason === 'failed') {
          journalError('resume-failed', result.error)
        }
        if (result.reason !== 'cancelled') {
          const message =
            result.reason === 'working'
              ? 'Cannot resume while the model is working'
              : result.reason === 'unavailable'
                ? 'Session is unavailable'
                : `Resume failed: ${result.error}`
          options.notify(message, { color: 'error' })
        }
      }
      return result
    },

    clear() {
      counts.clears += 1
      options.commands.clear()
    },

    listRewindCandidates() {
      const state = options.getState()
      const out: RewindCandidate[] = []
      for (const rowId of state.session.rowOrder) {
        const row = state.session.rowsById[rowId]
        if (row === undefined) continue
        if (row.kind !== 'user') continue
        const label = (row.blocks.find(
          (block) =>
            typeof block === 'object' && block !== null && !Array.isArray(block) && 'label' in block,
        ) as { label?: unknown } | undefined)?.label
        if (typeof label === 'string' && label !== '') continue
        const text = row.blocks
          .map((block) =>
            typeof block === 'string'
              ? block
              : typeof block === 'object' && block !== null && !Array.isArray(block) && 'text' in block
                ? String((block as { text: unknown }).text)
                : '',
          )
          .join('')
        const time = (
          row.blocks.find(
            (block) =>
              typeof block === 'object' && block !== null && !Array.isArray(block) && 'time' in block,
          ) as { time?: unknown } | undefined
        )?.time
        out.unshift({
          rowId,
          text,
          ...(typeof time === 'number' ? { time } : {}),
        })
      }
      return out
    },

    async requestRewind(rowId) {
      counts.rewindRequests += 1
      const token = ++opToken
      const row = options.chatRowForRowId(rowId)
      if (row === undefined) return { kind: 'unknown-row' }
      const decision = await options.promptRewind(row)
      if (token !== opToken) {
        counts.superseded += 1
        return { kind: 'superseded' }
      }
      if (decision === 'cancel') {
        counts.rewindCancels += 1
        return { kind: 'cancelled' }
      }
      return { kind: 'ready', rowId, modes: decision?.modes ?? [] }
    },

    async confirmRewind(rowId, mode = null) {
      const token = ++opToken
      const text = await options.commands.rewindTo(rowId, mode)
      if (token !== opToken) {
        counts.superseded += 1
        return { kind: 'superseded' }
      }
      if (text === null) {
        options.notify('Rewind unavailable', { color: 'error' })
        return { kind: 'empty' }
      }
      counts.rewinds += 1
      options.setEditorDraft(text)
      journal({ type: 'input/command', command: { type: 'editor', command: 'insert', text } })
      options.notify('Rewound to the selected message', { color: 'success' })
      return { kind: 'rewound', text }
    },

    updateRestart: {
      phase: () => restartPhase,
      prepare() {
        if (restartPhase === 'idle' || restartPhase === 'cancelled') {
          restartPhase = 'prepared'
          counts.updateRestarts += 1
        }
      },
      commit() {
        if (restartPhase !== 'prepared') return false
        restartPhase = 'committed'
        // WP-08: the updater performs the self-update around this teardown.
        options.requestStop('teardown')
        return true
      },
      cancel() {
        if (restartPhase === 'prepared') restartPhase = 'cancelled'
      },
      markStopped() {
        if (restartPhase === 'committed') restartPhase = 'stopped'
      },
    },

    diagnostics: () => ({ ...counts }),
  }
}
