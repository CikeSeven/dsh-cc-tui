/**
 * tui-v2 terminal QueryBroker (WP-03b, plan §5.6).
 *
 * The broker owns query/response correlation. It creates the ONLY branded
 * `QueryToken`s: tokens are `Object.freeze`d at creation and registered in a
 * module-instance `WeakSet`; `isRegistered` recognizes registered instances
 * by identity, so a plain object copying the same fields never passes.
 *
 * Response waiters are keyed by token identity — never by QueryKind or by a
 * writer slot. The stdin owner hands the broker only `kind: 'query-response'`
 * TerminalInputEvents; `accept` additionally requires token identity + id +
 * generation + QueryKind + a per-kind grammar match on the raw response
 * bytes. Late, duplicate and same-generation-mismatch responses are dropped
 * and counted in a fixed set of diagnostic counters.
 *
 * Timing policy (fixed, plan §5.4/§5.6): single-attempt deadline 150 ms, at
 * most 1 retry, ≤ 300 ms total per token; all timers go through the injected
 * `Clock`. The broker NEVER writes to stdout itself — retransmission on retry
 * is delegated to the writer through the `hooks.retransmit` callback passed
 * to `begin()`.
 *
 * `TerminalInputEvent` is defined here (with the query types it embeds) so
 * this module has no import cycle; WP-03b2's input layer should import it
 * from this file or re-export it from `input.ts`.
 *
 * Dependency rule (§4.3): `import type` from model only; no node APIs beyond
 * the injected clock.
 */
import type { Clock, SerializableValue } from '../model/schema.js'

// ---------------------------------------------------------------------------
// contract types (verbatim from plan §5.6)
// ---------------------------------------------------------------------------

export type QueryKind = 'cursor' | 'size' | 'cell-size' | 'version' | 'capability' | 'color' | 'kitty-keyboard' | 'focus'

export interface TerminalInputEvent {
  kind: 'key' | 'paste' | 'mouse' | 'focus' | 'resize' | 'signal' | 'query-response'
  sequence: number
  generation: number
  payload: SerializableValue
  query?: { tokenId: string; kind: QueryKind; value: SerializableValue }
}

export type QueryResponse = { tokenId: string; generation: number; kind: QueryKind; value: SerializableValue; receivedAt: number }

export interface QueryRequest {
  kind: QueryKind
  generation: number
  timeoutMs: number
  retry: number
  expected:
    | 'cursor-report'
    | 'size-report'
    | 'cell-size-report'
    | 'version-report'
    | 'capability-report'
    | 'color-report'
    | 'kitty-keyboard-report'
    | 'focus-report'
}

export interface QueryToken {
  readonly id: string
  readonly generation: number
  readonly kind: QueryKind
  readonly __opaqueQueryToken: unique symbol
}

export interface QueryBroker {
  request(request: QueryRequest): Promise<QueryResponse>
  accept(token: QueryToken, input: TerminalInputEvent): boolean
  cancel(token: QueryToken): void
  isRegistered(token: QueryToken): boolean
}

// ---------------------------------------------------------------------------
// extended concrete broker (internal surface used by TerminalWriter)
// ---------------------------------------------------------------------------

export interface QueryHooks {
  /** Re-enqueue the query bytes for a retry attempt. Never called >1 time. */
  retransmit(token: QueryToken, request: QueryRequest): void
}

export interface QueryBrokerDiagnostics {
  readonly requests: number
  readonly responses: number
  readonly timeouts: number
  readonly cancellations: number
  /** accept() called with an unregistered/unknown/settled token. */
  readonly lateOrUnknown: number
  /** accept() called with a registered token but non-matching payload. */
  readonly mismatches: number
}

export interface TerminalQueryBroker extends QueryBroker {
  /**
   * Register a new query and return its token + response promise. Only
   * `TerminalWriter.query()` calls this (§5.6); the token never leaves the
   * terminal layer except through the writer's query-token sink.
   */
  begin(request: QueryRequest, hooks?: QueryHooks): { token: QueryToken; response: Promise<QueryResponse> }
  diagnostics(): QueryBrokerDiagnostics
}

/** Rejection value for settled-by-failure query promises. */
export class QueryError extends Error {
  readonly code: 'query-timeout' | 'query-cancelled' | 'query-invalid'
  readonly generation: number
  constructor(code: QueryError['code'], message: string, generation: number) {
    super(message)
    this.name = 'QueryError'
    this.code = code
    this.generation = generation
  }
}

// ---------------------------------------------------------------------------
// fixed timing budget (plan §5.4/§5.6)
// ---------------------------------------------------------------------------

export const QUERY_ATTEMPT_TIMEOUT_MS = 150
export const QUERY_MAX_RETRIES = 1
export const QUERY_TOTAL_BUDGET_MS = 300

const KIND_TO_EXPECTED: Readonly<Record<QueryKind, QueryRequest['expected']>> = {
  cursor: 'cursor-report',
  size: 'size-report',
  'cell-size': 'cell-size-report',
  version: 'version-report',
  capability: 'capability-report',
  color: 'color-report',
  'kitty-keyboard': 'kitty-keyboard-report',
  focus: 'focus-report',
}

/** The expected report grammar pinned to each QueryKind. */
export function expectedReportForKind(kind: QueryKind): QueryRequest['expected'] {
  return KIND_TO_EXPECTED[kind]
}

// ---------------------------------------------------------------------------
// per-kind response grammars (parse failure === mismatch === drop)
// ---------------------------------------------------------------------------

function parseIntegerList(text: string): number[] {
  if (text === '') return []
  return text.split(';').map((part) => Number.parseInt(part, 10))
}

/**
 * Parse the raw response bytes for one expected report kind. Returns the
 * structured value, or null when the grammar does not match.
 */
export function parseQueryResponse(expected: QueryRequest['expected'], raw: string): SerializableValue | null {
  let match: RegExpExecArray | null
  switch (expected) {
    case 'cursor-report':
      match = /^\x1b\[(\d+);(\d+)R$/.exec(raw)
      return match === null
        ? null
        : { row: Number.parseInt(match[1] as string, 10), column: Number.parseInt(match[2] as string, 10) }
    case 'size-report':
      // CSI 8 ; rows ; columns t (reply to CSI 18 t)
      match = /^\x1b\[8;(\d+);(\d+)t$/.exec(raw)
      return match === null
        ? null
        : { rows: Number.parseInt(match[1] as string, 10), columns: Number.parseInt(match[2] as string, 10) }
    case 'cell-size-report':
      // CSI 6 ; heightPx ; widthPx t (reply to CSI 16 t)
      match = /^\x1b\[6;(\d+);(\d+)t$/.exec(raw)
      return match === null
        ? null
        : { heightPixels: Number.parseInt(match[1] as string, 10), widthPixels: Number.parseInt(match[2] as string, 10) }
    case 'version-report': {
      // XTVERSION: DCS > | text ST (a BEL terminator is also accepted; some
      // terminals terminate DCS with it).
      match = /^\x1bP>\|([^\x1b\x07]*)(?:\x1b\\|\x07)$/.exec(raw)
      return match === null ? null : { version: match[1] as string }
    }
    case 'capability-report':
      // Primary DA reply: CSI ? Pp ; ... c
      match = /^\x1b\[\?([0-9;]*)c$/.exec(raw)
      if (match === null) return null
      const params = parseIntegerList(match[1] as string)
      if (params.some((n) => !Number.isFinite(n))) return null
      return { params }
    case 'color-report': {
      // OSC 11 reply: OSC 11 ; rgb:r/g/b (BEL|ST). Components are 1-4 hex
      // digits each; the raw spec string is preserved verbatim.
      match = /^\x1b\]11;(rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4})(?:\x07|\x1b\\)$/.exec(raw)
      return match === null ? null : { color: match[1] as string }
    }
    case 'kitty-keyboard-report':
      match = /^\x1b\[\?(\d+)u$/.exec(raw)
      return match === null ? null : { flags: Number.parseInt(match[1] as string, 10) }
    case 'focus-report': {
      // DECRPM for mode 1004: CSI ? 1004 ; Ps $ y (0 not-recognized, 1 set,
      // 2 reset, 3 permanently set, 4 permanently reset).
      match = /^\x1b\[\?1004;([0-4])\$y$/.exec(raw)
      if (match === null) return null
      const mode = Number.parseInt(match[1] as string, 10)
      return { mode, enabled: mode === 1 || mode === 3, recognized: mode !== 0 }
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// broker implementation
// ---------------------------------------------------------------------------

export interface QueryBrokerOptions {
  readonly clock: Clock
}

interface PendingQuery {
  readonly request: QueryRequest
  readonly hooks: QueryHooks | undefined
  readonly startedAt: number
  attempt: number
  timer: unknown
  resolve: (response: QueryResponse) => void
  reject: (error: QueryError) => void
}

export function createQueryBroker(options: QueryBrokerOptions): TerminalQueryBroker {
  const clock = options.clock
  /** Identity registry: only instances created here are ever added. */
  const registered = new WeakSet<object>()
  const pending = new Map<QueryToken, PendingQuery>()
  let nextId = 0
  const counters = {
    requests: 0,
    responses: 0,
    timeouts: 0,
    cancellations: 0,
    lateOrUnknown: 0,
    mismatches: 0,
  }

  function validateRequest(request: QueryRequest): void {
    if (request === null || typeof request !== 'object') throw new TypeError('QueryRequest must be an object')
    if (KIND_TO_EXPECTED[request.kind] === undefined) throw new TypeError(`unknown QueryKind: ${String(request.kind)}`)
    if (request.expected !== KIND_TO_EXPECTED[request.kind]) {
      throw new TypeError(`QueryKind ${request.kind} requires expected '${KIND_TO_EXPECTED[request.kind]}', got '${String(request.expected)}'`)
    }
    if (!Number.isInteger(request.generation) || request.generation < 0) {
      throw new TypeError('QueryRequest.generation must be a non-negative integer')
    }
    if (typeof request.timeoutMs !== 'number' || !(request.timeoutMs > 0) || request.timeoutMs > QUERY_ATTEMPT_TIMEOUT_MS) {
      throw new RangeError(`QueryRequest.timeoutMs must be in (0, ${QUERY_ATTEMPT_TIMEOUT_MS}]`)
    }
    if (!Number.isInteger(request.retry) || request.retry < 0 || request.retry > QUERY_MAX_RETRIES) {
      throw new RangeError(`QueryRequest.retry must be 0..${QUERY_MAX_RETRIES}`)
    }
  }

  function settleFailure(token: QueryToken, record: PendingQuery, error: QueryError): void {
    if (record.timer !== null) clock.clearTimeout(record.timer)
    pending.delete(token)
    registered.delete(token)
    record.reject(error)
  }

  function scheduleAttempt(token: QueryToken, record: PendingQuery): void {
    const elapsed = clock.now() - record.startedAt
    const remaining = QUERY_TOTAL_BUDGET_MS - elapsed
    const delay = Math.min(record.request.timeoutMs, remaining)
    if (delay <= 0) {
      counters.timeouts += 1
      settleFailure(token, record, new QueryError('query-timeout', `query ${token.id} exceeded the ${QUERY_TOTAL_BUDGET_MS} ms total budget`, token.generation))
      return
    }
    record.timer = clock.setTimeout(() => onAttemptTimeout(token), delay)
  }

  function onAttemptTimeout(token: QueryToken): void {
    const record = pending.get(token)
    if (record === undefined) return
    if (record.attempt <= record.request.retry) {
      // One bounded retry: same token identity, retransmitted through the
      // writer hook (the broker never touches stdout itself).
      record.attempt += 1
      record.hooks?.retransmit(token, record.request)
      scheduleAttempt(token, record)
      return
    }
    counters.timeouts += 1
    settleFailure(
      token,
      record,
      new QueryError('query-timeout', `query ${token.id} (${record.request.kind}) timed out after ${record.attempt} attempt(s)`, token.generation),
    )
  }

  function begin(request: QueryRequest, hooks?: QueryHooks): { token: QueryToken; response: Promise<QueryResponse> } {
    validateRequest(request)
    counters.requests += 1
    nextId += 1
    const token = Object.freeze({
      id: `q${nextId}`,
      generation: request.generation,
      kind: request.kind,
    }) as QueryToken

    let resolvePromise!: (response: QueryResponse) => void
    let rejectPromise!: (error: QueryError) => void
    const response = new Promise<QueryResponse>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })

    const record: PendingQuery = {
      request,
      hooks,
      startedAt: clock.now(),
      attempt: 1,
      timer: null,
      resolve: resolvePromise,
      reject: rejectPromise,
    }
    registered.add(token)
    pending.set(token, record)
    scheduleAttempt(token, record)
    return { token, response }
  }

  function isRegistered(token: QueryToken): boolean {
    // Identity check only: a forged object with copied fields was never
    // added to the WeakSet and fails here (§5.6).
    return (typeof token === 'object' && token !== null && registered.has(token)) || false
  }

  function accept(token: QueryToken, input: TerminalInputEvent): boolean {
    const record = (typeof token === 'object' && token !== null && pending.get(token)) || undefined
    if (!isRegistered(token) || record === undefined) {
      // Late, duplicate (already settled) or outright unknown token.
      counters.lateOrUnknown += 1
      return false
    }
    const queryField = input !== null && typeof input === 'object' ? input.query : undefined
    const ok =
      input !== null &&
      typeof input === 'object' &&
      input.kind === 'query-response' &&
      input.generation === token.generation &&
      input.generation === record.request.generation &&
      queryField !== undefined &&
      queryField.tokenId === token.id &&
      queryField.kind === token.kind &&
      typeof queryField.value === 'string'
    if (!ok || queryField === undefined) {
      counters.mismatches += 1
      return false
    }
    const value = parseQueryResponse(record.request.expected, queryField.value as string)
    if (value === null) {
      counters.mismatches += 1
      return false
    }
    counters.responses += 1
    if (record.timer !== null) clock.clearTimeout(record.timer)
    pending.delete(token)
    registered.delete(token)
    record.resolve({
      tokenId: token.id,
      generation: token.generation,
      kind: token.kind,
      value,
      receivedAt: clock.now(),
    })
    return true
  }

  function cancel(token: QueryToken): void {
    const record = (typeof token === 'object' && token !== null && pending.get(token)) || undefined
    if (record === undefined) return // idempotent
    counters.cancellations += 1
    settleFailure(token, record, new QueryError('query-cancelled', `query ${token.id} cancelled`, token.generation))
  }

  return {
    begin,
    request(request: QueryRequest): Promise<QueryResponse> {
      // Contract method (§5.6): no retransmit hook; the caller is
      // responsible for having the query bytes sent through the writer.
      return begin(request).response
    },
    accept,
    cancel,
    isRegistered,
    diagnostics() {
      return { ...counters }
    },
  }
}
