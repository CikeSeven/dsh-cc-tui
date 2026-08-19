/**
 * tui-v2 model events (WP-02, plan §5.2).
 *
 * `AppEvent` is the only ingress into the v2 reducer; every variant must be
 * JSONL-serializable. `validateAppEvent` performs shape validation at the
 * boundary (meta, per-variant fields, serializable payloads); ordering and
 * cross-field epoch consistency (rows-reset vs row sessionEpoch, seq gaps,
 * duplicate sourceSeq conflicts) are reducer responsibilities, not shape
 * checks (§5.2).
 *
 * Dependency rule (§4.3): model imports nothing from other layers.
 */
import {
  isEventSource,
  isSerializableValue,
  validateOverlayState,
  type EventMeta,
  type InputCommand,
  type OverlayState,
  type ResetReason,
  type SerializableError,
  type UiRowSnapshot,
} from './schema.js'

export type AppEvent =
  | (EventMeta & { type: 'session/row-upsert'; row: UiRowSnapshot })
  | (EventMeta & { type: 'session/row-complete'; rowId: string; revision: number })
  | (EventMeta & { type: 'session/rows-reset'; resetId: string; rows: readonly UiRowSnapshot[]; snapshotHash: string; revision: number; ready: true; reason: ResetReason })
  | (EventMeta & { type: 'stream/chunk'; rowId: string; text: string })
  | (EventMeta & { type: 'stream/settled'; rowId: string; revision: number })
  | (EventMeta & { type: 'input/command'; command: InputCommand })
  | (EventMeta & { type: 'viewport/resize'; width: number; height: number })
  | (EventMeta & { type: 'overlay/open'; overlay: OverlayState })
  | (EventMeta & { type: 'overlay/close'; overlayId: string })
  | (EventMeta & { type: 'terminal/suspended' | 'terminal/resumed' })
  | (EventMeta & { type: 'app/error'; error: SerializableError })

const RESET_REASONS: readonly ResetReason[] = ['new-session', 'resume', 'rewind', 'clear', 'snapshot-gap', 'adapter-reconnect']
const APP_EVENT_TYPES = [
  'session/row-upsert',
  'session/row-complete',
  'session/rows-reset',
  'stream/chunk',
  'stream/settled',
  'input/command',
  'viewport/resize',
  'overlay/open',
  'overlay/close',
  'terminal/suspended',
  'terminal/resumed',
  'app/error',
] as const

function fail(field: string): never {
  throw new TypeError(`invalid AppEvent: ${field}`)
}

function isNonNegativeInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function validateMeta(e: Record<string, unknown>): void {
  if (e.schemaVersion !== 1) fail('meta.schemaVersion must be 1')
  if (typeof e.adapterInstanceId !== 'string' || e.adapterInstanceId === '') fail('meta.adapterInstanceId must be a non-empty string')
  if (typeof e.durableSessionId !== 'string' || e.durableSessionId === '') fail('meta.durableSessionId must be a non-empty string')
  if (typeof e.uiSessionGeneration !== 'string' || e.uiSessionGeneration === '') fail('meta.uiSessionGeneration must be a non-empty string')
  if (!isNonNegativeInt(e.resetEpoch)) fail('meta.resetEpoch must be a non-negative integer')
  if (typeof e.sessionEpoch !== 'string' || e.sessionEpoch === '') fail('meta.sessionEpoch must be a non-empty string')
  if (!isEventSource(e.source)) fail('meta.source is not a known EventSource')
  if (typeof e.sourceSeq !== 'string' || e.sourceSeq === '') fail('meta.sourceSeq must be a non-empty string')
  if (!Number.isInteger(e.seq) || (e.seq as number) < 1) fail('meta.seq must be a positive integer')
  if (e.causalSeq !== undefined && !Number.isInteger(e.causalSeq)) fail('meta.causalSeq must be an integer when present')
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) fail('meta.at must be a finite number')
}

function validateRow(value: unknown, field: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
  const r = value as Record<string, unknown>
  if (typeof r.rowId !== 'string' || r.rowId === '') fail(`${field}.rowId must be a non-empty string`)
  if (r.durableRowId !== undefined && typeof r.durableRowId !== 'string') fail(`${field}.durableRowId must be a string`)
  if (typeof r.durableSessionId !== 'string') fail(`${field}.durableSessionId must be a string`)
  if (typeof r.uiSessionGeneration !== 'string') fail(`${field}.uiSessionGeneration must be a string`)
  if (typeof r.sessionEpoch !== 'string' || r.sessionEpoch === '') fail(`${field}.sessionEpoch must be a non-empty string`)
  if (!['session', 'local', 'notice', 'activity', 'plugin'].includes(r.source as string)) fail(`${field}.source is not a known row source`)
  if (typeof r.sourceId !== 'string') fail(`${field}.sourceId must be a string`)
  if (typeof r.sourceSeq !== 'string') fail(`${field}.sourceSeq must be a string`)
  if (r.durableEventId !== undefined && typeof r.durableEventId !== 'string') fail(`${field}.durableEventId must be a string`)
  if (!isNonNegativeInt(r.revision)) fail(`${field}.revision must be a non-negative integer`)
  if (typeof r.kind !== 'string' || r.kind === '') fail(`${field}.kind must be a non-empty string`)
  if (!Array.isArray(r.blocks)) fail(`${field}.blocks must be an array`)
  for (const [i, block] of (r.blocks as unknown[]).entries()) {
    if (!isSerializableValue(block)) fail(`${field}.blocks[${i}] must be a SerializableValue`)
  }
  if (typeof r.settled !== 'boolean') fail(`${field}.settled must be boolean`)
  if (r.tool !== undefined) validateToolLifecycle(r.tool, `${field}.tool`)
}

function validateToolLifecycle(value: unknown, field: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
  const t = value as Record<string, unknown>
  if (!['running', 'result', 'error'].includes(t.phase as string)) fail(`${field}.phase must be running|result|error`)
  if (!isNonNegativeInt(t.lifecycleRevision)) fail(`${field}.lifecycleRevision must be a non-negative integer`)
  if (t.durationMs !== undefined && (typeof t.durationMs !== 'number' || !Number.isFinite(t.durationMs) || t.durationMs < 0)) fail(`${field}.durationMs must be a non-negative finite number`)
  if (t.callView !== undefined && !isSerializableValue(t.callView)) fail(`${field}.callView must be a SerializableValue`)
  if (t.resultView !== undefined && !isSerializableValue(t.resultView)) fail(`${field}.resultView must be a SerializableValue`)
  if (t.error !== undefined) validateSerializableError(t.error, `${field}.error`)
}

function validateSerializableError(value: unknown, field: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
  const err = value as Record<string, unknown>
  if (typeof err.code !== 'string' || err.code === '') fail(`${field}.code must be a non-empty string`)
  if (typeof err.message !== 'string') fail(`${field}.message must be a string`)
  if (typeof err.recoverable !== 'boolean') fail(`${field}.recoverable must be boolean`)
  if (err.details !== undefined && !isSerializableValue(err.details)) fail(`${field}.details must be a SerializableValue`)
}

function validateInputCommand(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('command must be an object')
  const c = value as Record<string, unknown>
  switch (c.type) {
    case 'editor':
      if (!['insert', 'delete', 'move', 'submit', 'cancel'].includes(c.command as string)) fail('command.command is not a known editor command')
      if (c.text !== undefined && typeof c.text !== 'string') fail('command.text must be a string')
      return
    case 'scroll':
      if (typeof c.delta !== 'number' || !Number.isFinite(c.delta)) fail('command.delta must be a finite number')
      return
    case 'overlay':
      if (!['open', 'close', 'focus'].includes(c.command as string)) fail('command.command is not a known overlay command')
      if (c.overlayId !== undefined && typeof c.overlayId !== 'string') fail('command.overlayId must be a string')
      return
    case 'app':
      if (!['interrupt', 'exit', 'redraw'].includes(c.command as string)) fail('command.command is not a known app command')
      return
    default:
      fail('command.type must be editor|scroll|overlay|app')
  }
}

/**
 * Boundary shape validation for `AppEvent`. Throws `TypeError` on any
 * violation; returns the value typed as `AppEvent` on success. Only shape is
 * checked here — seq ordering, gap/reset handling and rows-reset epoch
 * consistency belong to the reducer (§5.2).
 */
export function validateAppEvent(value: unknown): AppEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('event must be an object')
  const e = value as Record<string, unknown>
  validateMeta(e)
  if (typeof e.type !== 'string' || !(APP_EVENT_TYPES as readonly string[]).includes(e.type)) {
    fail(`type must be one of ${APP_EVENT_TYPES.join('|')}`)
  }
  switch (e.type) {
    case 'session/row-upsert':
      validateRow(e.row, 'row')
      break
    case 'session/row-complete':
      if (typeof e.rowId !== 'string' || e.rowId === '') fail('rowId must be a non-empty string')
      if (!isNonNegativeInt(e.revision)) fail('revision must be a non-negative integer')
      break
    case 'session/rows-reset': {
      // Shape only: ready/resetId/snapshotHash/revision presence and row
      // shapes. Cross-field epoch consistency (every row.sessionEpoch matches
      // the new epoch, snapshotHash matches rows) is checked by the reducer.
      if (e.ready !== true) fail('ready must be exactly true')
      if (typeof e.resetId !== 'string' || e.resetId === '') fail('resetId must be a non-empty string')
      if (!Array.isArray(e.rows)) fail('rows must be an array')
      for (const [i, row] of (e.rows as unknown[]).entries()) validateRow(row, `rows[${i}]`)
      if (typeof e.snapshotHash !== 'string' || e.snapshotHash === '') fail('snapshotHash must be a non-empty string')
      if (!isNonNegativeInt(e.revision)) fail('revision must be a non-negative integer')
      if (!RESET_REASONS.includes(e.reason as ResetReason)) fail(`reason must be one of ${RESET_REASONS.join('|')}`)
      break
    }
    case 'stream/chunk':
      if (typeof e.rowId !== 'string' || e.rowId === '') fail('rowId must be a non-empty string')
      if (typeof e.text !== 'string') fail('text must be a string')
      break
    case 'stream/settled':
      if (typeof e.rowId !== 'string' || e.rowId === '') fail('rowId must be a non-empty string')
      if (!isNonNegativeInt(e.revision)) fail('revision must be a non-negative integer')
      break
    case 'input/command':
      validateInputCommand(e.command)
      break
    case 'viewport/resize':
      if (!Number.isInteger(e.width) || (e.width as number) < 1) fail('width must be a positive integer')
      if (!Number.isInteger(e.height) || (e.height as number) < 1) fail('height must be a positive integer')
      break
    case 'overlay/open':
      validateOverlayState(e.overlay)
      break
    case 'overlay/close':
      if (typeof e.overlayId !== 'string' || e.overlayId === '') fail('overlayId must be a non-empty string')
      break
    case 'terminal/suspended':
    case 'terminal/resumed':
      break
    case 'app/error':
      validateSerializableError(e.error, 'error')
      break
  }
  return e as unknown as AppEvent
}

/** JSON round-trip: serialize one event to a single trace line (no newline). */
export function serializeAppEvent(event: AppEvent): string {
  return JSON.stringify(event)
}

/** JSON round-trip counterpart; parses and shape-validates one line. */
export function parseAppEvent(line: string): AppEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new SyntaxError(`invalid AppEvent JSON: ${String((error as Error)?.message ?? error)}`)
  }
  return validateAppEvent(parsed)
}
