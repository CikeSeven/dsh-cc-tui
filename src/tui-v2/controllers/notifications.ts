/**
 * Bounded notification controller for the v2 dock (WP-08f).
 *
 * Notifications are UI-only state. They never enter the session row cache or
 * trigger a rows-reset, so a timeout/dismiss cannot invalidate completed rows.
 * All expiry uses the injected Clock and every callback is exception-isolated.
 */
import type { Clock } from '../model/schema.js'
import {
  sanitizeChildText,
  type ExternalActionTraceSink,
  type ExternalActionSummary,
} from '../capabilities/external-actions.js'

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'

export interface NotificationView {
  readonly notificationId: string
  readonly text: string
  readonly severity: NotificationSeverity
  readonly sticky: boolean
  readonly createdAt: number
  readonly expiresAt: number | null
  readonly dedupeKey: string | null
  readonly count: number
}

export interface NotificationInput {
  readonly text: string
  readonly severity?: NotificationSeverity
  readonly timeoutMs?: number
  readonly sticky?: boolean
  readonly dedupeKey?: string
  readonly notificationId?: string
}

export interface NotificationControllerDiagnostics {
  readonly enqueued: number
  readonly dismissed: number
  readonly expired: number
  readonly deduped: number
  readonly truncated: number
  readonly ignored: number
}

export interface NotificationController {
  enqueue(input: NotificationInput): string
  dismiss(notificationId: string): boolean
  dismissByKey(dedupeKey: string): number
  clear(): void
  advance(): void
  view(): readonly NotificationView[]
  diagnostics(): NotificationControllerDiagnostics
  stop(): void
}

export interface NotificationControllerOptions {
  readonly clock: Clock
  readonly maxEntries?: number
  readonly maxTextChars?: number
  readonly onChange?: (view: readonly NotificationView[]) => void
  readonly trace?: ExternalActionTraceSink
}

interface Entry {
  notificationId: string
  text: string
  severity: NotificationSeverity
  sticky: boolean
  createdAt: number
  expiresAt: number | null
  dedupeKey: string | null
  count: number
  timer: unknown | null
}

export function createNotificationController(options: NotificationControllerOptions): NotificationController {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 8))
  const maxTextChars = Math.max(1, Math.floor(options.maxTextChars ?? 4000))
  const entries: Entry[] = []
  const byId = new Map<string, Entry>()
  const byKey = new Map<string, Entry>()
  let sequence = 0
  let stopped = false
  const counts = { enqueued: 0, dismissed: 0, expired: 0, deduped: 0, truncated: 0, ignored: 0 }

  const emit = (): void => {
    const snapshot = entries.map(({ timer: _timer, ...entry }) => Object.freeze({ ...entry }))
    try {
      options.onChange?.(snapshot)
    } catch {
      // A render scheduler/diagnostic hook cannot break notification state.
    }
  }

  const trace = (phase: ExternalActionSummary['phase'], entry: Entry, reason?: string): void => {
    const summary: ExternalActionSummary = {
      kind: 'notification',
      phase,
      operationId: entry.notificationId,
      generation: 0,
      ...(reason === undefined ? {} : { reason }),
      outputChars: entry.text.length,
    }
    try {
      options.trace?.record(summary)
    } catch {
      // Trace is best effort.
    }
  }

  const clearTimer = (entry: Entry): void => {
    if (entry.timer !== null) {
      options.clock.clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  const remove = (entry: Entry, reason: 'dismissed' | 'expired'): boolean => {
    const index = entries.indexOf(entry)
    if (index < 0) return false
    entries.splice(index, 1)
    byId.delete(entry.notificationId)
    if (entry.dedupeKey !== null && byKey.get(entry.dedupeKey) === entry) byKey.delete(entry.dedupeKey)
    clearTimer(entry)
    if (reason === 'dismissed') counts.dismissed += 1
    else counts.expired += 1
    trace('completed', entry, reason)
    emit()
    return true
  }

  const expireAt = (entry: Entry): void => {
    if (stopped || !byId.has(entry.notificationId) || entry.expiresAt === null) return
    if (options.clock.now() < entry.expiresAt) {
      entry.timer = options.clock.setTimeout(() => expireAt(entry), Math.max(0, entry.expiresAt - options.clock.now()))
      return
    }
    remove(entry, 'expired')
  }

  const trim = (): void => {
    while (entries.length > maxEntries) {
      // Prefer dropping the oldest non-sticky item; if all are sticky, the
      // oldest sticky item is still bounded and is removed deterministically.
      const index = entries.findIndex((entry) => !entry.sticky)
      const victim = entries[index < 0 ? 0 : index]
      if (victim === undefined) break
      remove(victim, 'expired')
    }
  }

  return {
    enqueue(input) {
      if (stopped) {
        counts.ignored += 1
        return input.notificationId ?? `notification-stopped-${++sequence}`
      }
      const sanitized = sanitizeChildText(input.text, { maxChars: maxTextChars, maxLines: 8 })
      if (sanitized.text === '') {
        counts.ignored += 1
        return input.notificationId ?? `notification-empty-${++sequence}`
      }
      if (sanitized.truncated) counts.truncated += 1
      const severity = input.severity ?? 'info'
      const dedupeKey = input.dedupeKey?.trim() || null
      const existing = dedupeKey === null ? undefined : byKey.get(dedupeKey)
      if (existing !== undefined) {
        clearTimer(existing)
        existing.count += 1
        existing.text = sanitized.text
        existing.severity = severity
        existing.createdAt = options.clock.now()
        const timeoutMs = input.sticky === true ? 0 : Math.max(0, Math.floor(input.timeoutMs ?? 4000))
        existing.sticky = input.sticky === true || timeoutMs === 0
        existing.expiresAt = existing.sticky ? null : existing.createdAt + timeoutMs
        if (existing.expiresAt !== null) expireAt(existing)
        counts.deduped += 1
        trace('working', existing, 'dedupe')
        emit()
        return existing.notificationId
      }
      const now = options.clock.now()
      const timeoutMs = input.sticky === true ? 0 : Math.max(0, Math.floor(input.timeoutMs ?? 4000))
      const entry: Entry = {
        notificationId: input.notificationId ?? `notification-${++sequence}`,
        text: sanitized.text,
        severity,
        sticky: input.sticky === true || timeoutMs === 0,
        createdAt: now,
        expiresAt: input.sticky === true || timeoutMs === 0 ? null : now + timeoutMs,
        dedupeKey,
        count: 1,
        timer: null,
      }
      entries.push(entry)
      byId.set(entry.notificationId, entry)
      if (dedupeKey !== null) byKey.set(dedupeKey, entry)
      counts.enqueued += 1
      trace('working', entry)
      trim()
      if (entry.expiresAt !== null && byId.has(entry.notificationId)) expireAt(entry)
      emit()
      return entry.notificationId
    },
    dismiss(notificationId) {
      const entry = byId.get(notificationId)
      return entry === undefined ? false : remove(entry, 'dismissed')
    },
    dismissByKey(dedupeKey) {
      const entry = byKey.get(dedupeKey)
      return entry === undefined ? 0 : (remove(entry, 'dismissed') ? 1 : 0)
    },
    clear() {
      for (const entry of [...entries]) clearTimer(entry)
      if (entries.length === 0) return
      entries.length = 0
      byId.clear()
      byKey.clear()
      emit()
    },
    advance() {
      for (const entry of [...entries]) expireAt(entry)
    },
    view() {
      return entries.map(({ timer: _timer, ...entry }) => Object.freeze({ ...entry }))
    },
    diagnostics() {
      return { ...counts }
    },
    stop() {
      if (stopped) return
      stopped = true
      for (const entry of entries) clearTimer(entry)
    },
  }
}
