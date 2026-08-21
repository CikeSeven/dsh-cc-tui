/**
 * Kitty keyboard negotiation state machine (WP-08g, §5.6/§6.6).
 *
 * Query, enable and cleanup are kept behind the terminal writer boundary.  A
 * failed/late query is a normal fallback to legacy keys, never a startup or
 * shutdown exception.  The state snapshot contains protocol labels and
 * bounded reasons only; response bytes are owned by the query broker.
 */
import type { Clock } from '../model/schema.js'
import * as ansi from './ansi.js'
import {
  QUERY_ATTEMPT_TIMEOUT_MS,
  QUERY_MAX_RETRIES,
  QUERY_TOTAL_BUDGET_MS,
  type QueryResponse,
} from './query.js'
import type { TerminalWriter, WriteResult } from './writer.js'

export type KittyKeyboardState = 'idle' | 'querying' | 'enabling' | 'active' | 'fallback' | 'disabling' | 'disabled'
export type KittyKeyboardReason =
  | 'not-requested'
  | 'profile-denied'
  | 'query-confirmed'
  | 'query-timeout'
  | 'query-error'
  | 'generation-mismatch'
  | 'late-response'
  | 'enable-failed'
  | 'disable-failed'
  | 'cleanup'

export interface KittyKeyboardSnapshot {
  readonly schemaVersion: 1
  readonly generation: number
  readonly state: KittyKeyboardState
  readonly reason: KittyKeyboardReason
  readonly attempts: number
  readonly legacyFallback: boolean
}

export interface KittyKeyboardNegotiatorOptions {
  readonly writer: Pick<TerminalWriter, 'query' | 'writeControl'>
  readonly clock: Clock
  readonly generation: () => number
  /** Avoids dereferencing a lifecycle closure while the graph is assembled. */
  readonly initialGeneration?: number
  readonly setInputActive?: (active: boolean) => void
  readonly onDiagnostic?: (diagnostic: { readonly code: string; readonly generation: number; readonly reason: KittyKeyboardReason }) => void
}

export interface KittyKeyboardNegotiator {
  readonly snapshot: () => KittyKeyboardSnapshot
  readonly negotiate: (generation?: number) => Promise<KittyKeyboardSnapshot>
  readonly disable: (generation?: number) => Promise<KittyKeyboardSnapshot>
  readonly cleanup: () => Promise<KittyKeyboardSnapshot>
}

const QUERY_REQUEST = {
  kind: 'kitty-keyboard' as const,
  timeoutMs: QUERY_ATTEMPT_TIMEOUT_MS,
  retry: QUERY_MAX_RETRIES,
  expected: 'kitty-keyboard-report' as const,
}

function frozen<T>(value: T): T {
  return Object.freeze(value)
}

function isValidQueryResponse(response: QueryResponse, generation: number): boolean {
  if (response.kind !== 'kitty-keyboard' || response.generation !== generation || response.value === null || typeof response.value !== 'object' || Array.isArray(response.value)) return false
  const flags = (response.value as { flags?: unknown }).flags
  return Number.isInteger(flags) && (flags as number) >= 0 && (flags as number) <= 15
}

export function createKittyKeyboardNegotiator(options: KittyKeyboardNegotiatorOptions): KittyKeyboardNegotiator {
  let current: KittyKeyboardSnapshot = frozen({
    schemaVersion: 1,
    generation: options.initialGeneration ?? 0,
    state: 'idle',
    reason: 'not-requested',
    attempts: 0,
    legacyFallback: false,
  })
  let operation: Promise<KittyKeyboardSnapshot> | null = null
  let operationGeneration: number | null = null
  let active = false

  const publish = (state: KittyKeyboardState, generation: number, reason: KittyKeyboardReason, attempts = current.attempts, legacyFallback = state === 'fallback'): KittyKeyboardSnapshot => {
    current = frozen({ schemaVersion: 1, generation, state, reason, attempts, legacyFallback })
    if (state === 'active') active = true
    if (state === 'fallback' || state === 'disabled' || state === 'idle') active = false
    try {
      options.onDiagnostic?.({ code: `kitty-keyboard/${state}`, generation, reason })
    } catch {
      // Diagnostics cannot alter negotiation or cleanup.
    }
    return current
  }

  const sameGeneration = (generation: number): boolean => options.generation() === generation

  const withDeadline = <T>(promise: Promise<T>, ms: number): Promise<T | null> => {
    if (ms <= 0) {
      promise.then(undefined, () => undefined)
      return Promise.resolve(null)
    }
    return new Promise<T | null>((resolve) => {
      const timer = options.clock.setTimeout(() => resolve(null), ms)
      promise.then(
        (value) => { options.clock.clearTimeout(timer); resolve(value) },
        () => { options.clock.clearTimeout(timer); resolve(null) },
      )
    })
  }

  const negotiate = (requestedGeneration = options.generation()): Promise<KittyKeyboardSnapshot> => {
    const actualGeneration = options.generation()
    if (!Number.isInteger(requestedGeneration) || requestedGeneration < 0 || requestedGeneration !== actualGeneration) {
      return Promise.resolve(publish('fallback', Number.isInteger(actualGeneration) && actualGeneration >= 0 ? actualGeneration : current.generation, 'generation-mismatch'))
    }
    if (operation !== null && operationGeneration === requestedGeneration) return operation
    if (current.state === 'active' && current.generation === requestedGeneration) return Promise.resolve(current)
    const run = (async (): Promise<KittyKeyboardSnapshot> => {
      const attempts = current.attempts + 1
      publish('querying', requestedGeneration, 'query-confirmed', attempts, false)
      let query: Promise<QueryResponse>
      try {
        query = options.writer.query({ ...QUERY_REQUEST, generation: requestedGeneration })
      } catch {
        return publish('fallback', requestedGeneration, 'query-error', attempts)
      }
      const response = await withDeadline(query, QUERY_TOTAL_BUDGET_MS)
      if (!sameGeneration(requestedGeneration)) return publish('fallback', options.generation(), 'generation-mismatch', attempts)
      if (response === null) return publish('fallback', requestedGeneration, 'query-timeout', attempts)
      if (!isValidQueryResponse(response, requestedGeneration)) return publish('fallback', requestedGeneration, 'late-response', attempts)

      publish('enabling', requestedGeneration, 'query-confirmed', attempts, false)
      let result: WriteResult
      try {
        result = await withDeadline(options.writer.writeControl({
          kind: 'sequence',
          sequence: ansi.kittyKeyboardPush(1),
          purpose: 'pi-compatible',
        }, requestedGeneration), QUERY_ATTEMPT_TIMEOUT_MS) as WriteResult | null ?? { status: 'stale' }
      } catch {
        result = { status: 'error', error: { code: 'kitty-enable-error', message: 'kitty keyboard enable failed', generation: requestedGeneration, recoverable: true } }
      }
      if (!sameGeneration(requestedGeneration)) return publish('fallback', options.generation(), 'generation-mismatch', attempts)
      if (result.status !== 'written') return publish('fallback', requestedGeneration, 'enable-failed', attempts)
      active = true
      options.setInputActive?.(true)
      return publish('active', requestedGeneration, 'query-confirmed', attempts, false)
    })()
    operation = run
    operationGeneration = requestedGeneration
    const clearOperation = (): void => {
      if (operation === run) {
        operation = null
        operationGeneration = null
      }
    }
    void run.then(clearOperation, clearOperation)
    return run
  }

  const disable = async (requestedGeneration = options.generation()): Promise<KittyKeyboardSnapshot> => {
    const actualGeneration = options.generation()
    if (!Number.isInteger(requestedGeneration) || requestedGeneration < 0 || requestedGeneration !== actualGeneration) {
      active = false
      options.setInputActive?.(false)
      return publish('fallback', Number.isInteger(actualGeneration) && actualGeneration >= 0 ? actualGeneration : current.generation, 'generation-mismatch', current.attempts, true)
    }
    if (operation !== null) {
      try { await operation } catch { /* operation is internally folded to fallback */ }
    }
    if (!active && current.state !== 'active') {
      options.setInputActive?.(false)
      return current.generation === requestedGeneration ? current : publish('disabled', requestedGeneration, 'cleanup')
    }
    publish('disabling', requestedGeneration, 'cleanup', current.attempts, false)
    let result: WriteResult | null = null
    try {
      result = await withDeadline(options.writer.writeControl({
        kind: 'sequence',
        sequence: ansi.kittyKeyboardPop(99),
        purpose: 'cleanup',
      }, requestedGeneration), QUERY_ATTEMPT_TIMEOUT_MS)
    } catch {
      result = null
    }
    active = false
    options.setInputActive?.(false)
    if (result?.status === 'written') return publish('disabled', requestedGeneration, 'cleanup', current.attempts, false)
    return publish('fallback', requestedGeneration, 'disable-failed', current.attempts, true)
  }

  return {
    snapshot: () => current,
    negotiate,
    disable,
    cleanup: () => disable(options.generation()),
  }
}
