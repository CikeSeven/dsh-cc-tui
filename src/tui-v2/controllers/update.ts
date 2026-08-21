/** Update/restart controller (WP-08f).
 *
 * The controller never calls process.exit.  A host-provided RestartRunner owns
 * package-manager/exec details; this layer owns confirmation, takeover,
 * cleanup ordering, cancellation and late-result suppression.
 */
import { randomUUID } from 'node:crypto'

import type { ScreenTakeover, TakeoverLease } from '../terminal/lifecycle.js'
import type {
  ExternalActionPhase,
  ExternalActionTraceSink,
  RestartRequest,
  RestartResult,
  RestartRunner,
} from '../capabilities/external-actions.js'

export type UpdateControllerPhase =
  | 'idle'
  | 'checking'
  | 'pending-confirmation'
  | 'running'
  | 'success'
  | 'failure'
  | 'cancelled'

export interface UpdateRequest {
  readonly sessionId: string
  readonly profile: string
  readonly targetVersion?: string
  readonly requireConfirmation?: boolean
}

export interface UpdateControllerOptions {
  readonly runner: RestartRunner
  readonly takeover?: ScreenTakeover
  readonly confirm?: (request: UpdateRequest) => Promise<boolean> | boolean
  readonly cleanup?: () => Promise<void>
  readonly notify: (text: string, options?: { color?: 'error' | 'warning' | 'success' }) => void
  readonly trace?: ExternalActionTraceSink
  readonly onSuccess?: (result: RestartResult) => void
}

export interface UpdateControllerDiagnostics {
  readonly requested: number
  readonly confirmed: number
  readonly rejected: number
  readonly started: number
  readonly succeeded: number
  readonly failed: number
  readonly cancelled: number
  readonly late: number
  readonly restoreErrors: number
}

export interface UpdateController {
  request(request: UpdateRequest): Promise<boolean>
  cancel(): boolean
  phase(): UpdateControllerPhase
  activeOperationId(): string | null
  diagnostics(): UpdateControllerDiagnostics
}

export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  let active: { id: string; abort: AbortController; lease: TakeoverLease | null } | null = null
  let currentPhase: UpdateControllerPhase = 'idle'
  let serial = 0
  const counts = {
    requested: 0,
    confirmed: 0,
    rejected: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    late: 0,
    restoreErrors: 0,
  }

  const trace = (phase: ExternalActionPhase, id: string, generation: number, result?: RestartResult): void => {
    try {
      options.trace?.record({
        kind: 'update',
        phase,
        operationId: id,
        generation,
        ...(result === undefined ? {} : {
          exitCode: result.restartCode,
          signal: result.signal ?? null,
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        }),
      })
    } catch {
      // Best effort diagnostics.
    }
  }

  const restore = async (activeState: { lease: TakeoverLease | null }, reason: 'completed' | 'cancelled' | 'error' | 'teardown'): Promise<void> => {
    if (activeState.lease === null || options.takeover === undefined) return
    try {
      await options.takeover.restore(activeState.lease.token, { reason })
    } catch {
      counts.restoreErrors += 1
      options.notify('Terminal restore after update failed', { color: 'error' })
    }
  }

  const request = async (requestInput: UpdateRequest): Promise<boolean> => {
    counts.requested += 1
    if (active !== null || currentPhase === 'running' || currentPhase === 'pending-confirmation') {
      options.notify('An update is already running', { color: 'warning' })
      return false
    }
    const id = `update-${++serial}-${randomUUID()}`
    const abort = new AbortController()
    const state = { id, abort, lease: null as TakeoverLease | null }
    active = state
    currentPhase = 'checking'
    trace('checking', id, 0)
    try {
      if (requestInput.requireConfirmation !== false) {
        currentPhase = 'pending-confirmation'
        trace('pending-confirmation', id, 0)
        const confirmed = await options.confirm?.(requestInput)
        if (active !== state) {
          counts.late += 1
          return false
        }
        if (confirmed !== true) {
          counts.rejected += 1
          currentPhase = 'cancelled'
          trace('cancelled', id, 0)
          return false
        }
      }
      counts.confirmed += 1
      if (options.takeover !== undefined) {
        state.lease = await options.takeover.request('update', 'package update and restart')
      }
      if (active !== state) {
        counts.late += 1
        return false
      }
      currentPhase = 'running'
      counts.started += 1
      trace('running', id, state.lease?.generation ?? 0)
      options.notify('Updating dsh-tui…')
      await options.cleanup?.()
      const runnerRequest: RestartRequest = {
        sessionId: requestInput.sessionId,
        profile: requestInput.profile,
        ...(requestInput.targetVersion === undefined ? {} : { targetVersion: requestInput.targetVersion }),
      }
      const result = await options.runner.run(runnerRequest, abort.signal)
      if (active !== state) {
        counts.late += 1
        return false
      }
      if (result.phase === 'cancelled' || abort.signal.aborted) {
        counts.cancelled += 1
        currentPhase = 'cancelled'
        trace('cancelled', id, state.lease?.generation ?? 0, result)
        options.notify('Update cancelled', { color: 'warning' })
        return false
      }
      if (result.phase === 'success' && result.updateCode === 0 && result.restartCode === 0) {
        counts.succeeded += 1
        currentPhase = 'success'
        trace('success', id, state.lease?.generation ?? 0, result)
        options.notify('Update complete; restarting dsh-tui…', { color: 'success' })
        options.onSuccess?.(result)
        return true
      }
      counts.failed += 1
      currentPhase = 'failure'
      trace('failure', id, state.lease?.generation ?? 0, result)
      options.notify('Update failed; the current session was preserved', { color: 'error' })
      return false
    } catch (error) {
      if (active !== state) {
        counts.late += 1
        return false
      }
      counts.failed += 1
      currentPhase = 'failure'
      trace('failure', id, state.lease?.generation ?? 0, {
        phase: 'failure',
        updateCode: 1,
        restartCode: 1,
        errorCode: error instanceof Error ? 'update-error' : 'update-rejected',
      })
      options.notify('Update failed; the current session was preserved', { color: 'error' })
      return false
    } finally {
      const reason = currentPhase === 'cancelled' ? 'cancelled' : currentPhase === 'success' ? 'completed' : 'error'
      await restore(state, reason)
      if (active === state) active = null
      if (currentPhase === 'checking' || currentPhase === 'pending-confirmation' || currentPhase === 'running') currentPhase = 'failure'
    }
  }

  return {
    request,
    cancel() {
      if (active === null) return false
      active.abort.abort()
      currentPhase = 'cancelled'
      return true
    },
    phase: () => currentPhase,
    activeOperationId: () => active?.id ?? null,
    diagnostics: () => ({ ...counts }),
  }
}
