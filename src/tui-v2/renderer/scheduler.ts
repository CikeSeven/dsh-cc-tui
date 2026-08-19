/**
 * tui-v2 RenderScheduler (WP-04b, plan §5.7).
 *
 * Priority (high -> low): exit/error > user input > resize/terminal lifecycle
 * > synchronous state > streaming chunk > low-priority notification.
 *
 * Scheduling rules implemented here (§5.7):
 *  1. At most one render and one writer operation at a time — the scheduler
 *     serializes executions; a request arriving mid-render waits in the
 *     pending slot. This mirrors TerminalWriter's one-write-in-flight
 *     semantics: render output is handed to the writer in completion order.
 *  2. Stream chunks coalesce in a 16-33 ms window; inside the window only
 *     the latest renderable state is kept (getState is re-read at execution).
 *  3. Input/Ctrl+C (and above) preempt a *pending* lower-priority render —
 *     its timer is cancelled and the higher-priority render runs first. A
 *     render already writing its patch is never interrupted.
 *  4. Resize runs as a transaction: update geometry/profile -> registered
 *     listeners clear width/layout caches -> one forced full render commits.
 *  5. A request whose stateRevision is below the last committed revision is
 *     dropped (stale), never rendered.
 *  6. After stop() every request is rejected and all timers are released.
 *
 * The clock is injected (`model/schema.ts` Clock) so tests run on a fake
 * clock; this module never touches global timers.
 *
 * Dependency rule (§4.3): `import type` from model only.
 */
import type { Clock } from '../model/schema.js'

export type RenderPriority = 'exit' | 'input' | 'resize' | 'sync' | 'stream' | 'notify'

const PRIORITY_RANK: Record<RenderPriority, number> = {
  exit: 0,
  input: 1,
  resize: 2,
  sync: 3,
  stream: 4,
  notify: 5,
}

/** Stream coalescing window bounds (§5.7 rule 2), ms. */
export const STREAM_WINDOW_MIN_MS = 16
export const STREAM_WINDOW_MAX_MS = 33

/** A scheduled unit of render work; the state is re-read at execution time. */
export interface ScheduledFrame {
  readonly stateRevision: number
}

export interface RenderRequest<T extends ScheduledFrame> {
  readonly priority: RenderPriority
  /** Latest-state reader; called only when the request actually executes. */
  readonly getState: () => T
}

export type SchedulerPhase = 'created' | 'active' | 'stopping' | 'stopped'

export interface RenderSchedulerOptions<T extends ScheduledFrame> {
  readonly clock: Clock
  /** Execute one render. May be async (a writer op in flight counts as busy). */
  readonly render: (state: T, priority: RenderPriority) => void | Promise<void>
  /** Stream coalescing window in ms; clamped to [16, 33]. */
  readonly streamWindowMs?: number
  /** Diagnostics sink (dropped-stale / coalesced counts); optional. */
  readonly onDiagnostic?: (event: SchedulerDiagnostic) => void
}

export interface SchedulerDiagnostic {
  readonly kind:
    | 'coalesced' // a pending request was replaced/merged
    | 'preempted' // a pending lower-priority render was cancelled by a higher one
    | 'dropped-stale' // stateRevision below the committed watermark
    | 'rejected-stopped' // request after stop()
    | 'resize-transaction'
  readonly priority?: RenderPriority
  readonly stateRevision?: number
}

export interface RenderScheduler<T extends ScheduledFrame> {
  readonly phase: SchedulerPhase
  start(): void
  /** Returns false when rejected (stopped). Never throws after stop. */
  requestRender(priority: RenderPriority, getState: () => T): boolean
  /**
   * §5.7 rule 4 orchestration hook: cancel pending work, run the registered
   * listeners (cache clearing is the listeners' job), then force one render
   * at 'resize' priority. The geometry/profile update itself is performed by
   * the caller before invoking this.
   */
  onResize(listener: () => void): void
  beginResizeTransaction(getState: () => T): boolean
  /** Revision watermark of the last completed render. */
  readonly committedRevision: number
  stop(): void
}

export function createRenderScheduler<T extends ScheduledFrame>(
  options: RenderSchedulerOptions<T>,
): RenderScheduler<T> {
  const clock = options.clock
  const windowMs = Math.min(
    STREAM_WINDOW_MAX_MS,
    Math.max(STREAM_WINDOW_MIN_MS, options.streamWindowMs ?? STREAM_WINDOW_MIN_MS),
  )

  let phase: SchedulerPhase = 'created'
  let committedRevision = -1
  let pending: RenderRequest<T> | null = null
  let pendingTimer: unknown = null
  let executing = false
  /** Set when a render is in flight and a new request arrived. */
  let rerunRequested = false
  const resizeListeners: Array<() => void> = []

  const emit = (event: SchedulerDiagnostic): void => {
    options.onDiagnostic?.(event)
  }

  const clearPendingTimer = (): void => {
    if (pendingTimer !== null) {
      clock.clearTimeout(pendingTimer)
      pendingTimer = null
    }
  }

  const dropPending = (kind: SchedulerDiagnostic['kind'], priority?: RenderPriority): void => {
    if (pending !== null) emit({ kind, priority, stateRevision: undefined })
    pending = null
    clearPendingTimer()
  }

  const execute = async (request: RenderRequest<T>): Promise<void> => {
    const state = request.getState()
    if (state.stateRevision < committedRevision) {
      // §5.7 rule 5: stale frames never reach the render callback.
      emit({ kind: 'dropped-stale', priority: request.priority, stateRevision: state.stateRevision })
      return
    }
    executing = true
    try {
      await options.render(state, request.priority)
      committedRevision = Math.max(committedRevision, state.stateRevision)
    } finally {
      executing = false
    }
  }

  const pump = (): void => {
    if (phase !== 'active') return
    if (executing) return
    const request = pending
    if (request === null) return
    pending = null
    clearPendingTimer()
    void execute(request).then(() => {
      // Rule 1: work queued while a render/writer op was in flight runs now.
      if (rerunRequested) {
        rerunRequested = false
        pump()
      }
    })
  }

  const schedulePending = (request: RenderRequest<T>): void => {
    // Stream chunks coalesce inside the window; higher priorities run at the
    // next tick (immediately, unless preempted by something even higher).
    const delay = PRIORITY_RANK[request.priority] >= PRIORITY_RANK.stream ? windowMs : 0
    pendingTimer = clock.setTimeout(() => {
      pendingTimer = null
      pump()
    }, delay)
  }

  const scheduler: RenderScheduler<T> = {
    get phase() {
      return phase
    },
    get committedRevision() {
      return committedRevision
    },
    start() {
      if (phase === 'created') phase = 'active'
    },
    requestRender(priority, getState) {
      // §5.7 rule 6: after stop everything is rejected.
      if (phase !== 'active') {
        emit({ kind: 'rejected-stopped', priority })
        return false
      }
      const incoming: RenderRequest<T> = { priority, getState }
      if (executing) {
        // Rule 1/3: never interrupt an in-flight render/writer op; coalesce.
        if (pending !== null) emit({ kind: 'coalesced', priority: pending.priority })
        if (pending === null || PRIORITY_RANK[priority] <= PRIORITY_RANK[pending.priority]) {
          pending = incoming
        }
        rerunRequested = true
        return true
      }
      if (pending !== null) {
        const rankIncoming = PRIORITY_RANK[priority]
        const rankPending = PRIORITY_RANK[pending.priority]
        if (rankIncoming < rankPending) {
          // Rule 3: higher priority preempts the pending lower-priority render.
          dropPending('preempted', pending.priority)
        } else if (rankIncoming === rankPending) {
          // Rule 2: same priority inside the window keeps only the latest.
          dropPending('coalesced', priority)
        } else {
          // Lower priority than the pending one: keep the pending, merge away.
          emit({ kind: 'coalesced', priority })
          return true
        }
      }
      pending = incoming
      schedulePending(incoming)
      return true
    },
    onResize(listener) {
      resizeListeners.push(listener)
    },
    beginResizeTransaction(getState) {
      if (phase !== 'active') {
        emit({ kind: 'rejected-stopped', priority: 'resize' })
        return false
      }
      // Rule 4: pending work is obsolete after a geometry/profile change.
      dropPending('preempted', 'resize')
      for (const listener of resizeListeners) listener()
      emit({ kind: 'resize-transaction' })
      return scheduler.requestRender('resize', getState)
    },
    stop() {
      if (phase === 'stopped' || phase === 'stopping') return
      phase = 'stopping'
      dropPending('preempted')
      phase = 'stopped'
    },
  }
  return scheduler
}
