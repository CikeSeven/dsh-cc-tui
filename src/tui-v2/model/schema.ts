/**
 * tui-v2 model schema (WP-02, plan §5.2).
 *
 * This file is the root of the v2 dependency graph (§4.3): `model` imports
 * nothing from other layers. Every value that crosses into an AppEvent,
 * snapshot, fixture or trace must be a `SerializableValue`; the runtime
 * helpers below (`isSerializableValue`, `deepFreeze`, `deepCopySerializable`,
 * `validateOverlayState`) enforce that at the adapter/reducer boundary.
 *
 * Type definitions are verbatim from the development plan; do not widen
 * `unknown` into non-serializable objects.
 */

export type SerializablePrimitive = string | number | boolean | null
export type SerializableValue = SerializablePrimitive | readonly SerializableValue[] | { readonly [key: string]: SerializableValue }
export type DeepReadonly<T> = T extends SerializablePrimitive ? T : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type ResetReason = 'new-session' | 'resume' | 'rewind' | 'clear' | 'snapshot-gap' | 'adapter-reconnect'
export type EventSource = 'session' | 'stream' | 'input' | 'terminal' | 'overlay' | 'app' | 'plugin'
export interface EventMeta {
  readonly schemaVersion: 1
  readonly adapterInstanceId: string
  readonly durableSessionId: string
  readonly uiSessionGeneration: string
  readonly resetEpoch: number
  readonly sessionEpoch: string
  readonly source: EventSource
  /** Monotonic within source, or a durable source event id. */
  readonly sourceSeq: string
  /** Adapter order; never inferred from `at`. */
  readonly seq: number
  readonly causalSeq?: number
  readonly at: number
}
export type InputCommand =
  | { readonly type: 'editor'; readonly command: 'insert' | 'delete' | 'move' | 'submit' | 'cancel'; readonly text?: string }
  | { readonly type: 'scroll'; readonly delta: number }
  | { readonly type: 'overlay'; readonly command: 'open' | 'close' | 'focus'; readonly overlayId?: string }
  | { readonly type: 'app'; readonly command: 'interrupt' | 'exit' | 'redraw' }
export type TerminalMode = 'fullscreen' | 'inline'
/** Serializable transcript-search state. The controller owns interaction and
 * publishes complete immutable snapshots through `search/update` events. */
export interface TranscriptSearchState {
  readonly query: string
  /** True while matching cells should be highlighted (editing or committed). */
  readonly active: boolean
  /** Zero-based current match row; always 0 when `matches` is empty. */
  readonly current: number
  /** Bounded row ids containing the query, in transcript order. */
  readonly matches: readonly string[]
}
export type OverlayAnchor = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top-center' | 'bottom-center' | 'left-center' | 'right-center'
export interface UiRowSnapshot {
  readonly rowId: string
  readonly durableRowId?: string
  readonly durableSessionId: string
  readonly uiSessionGeneration: string
  readonly sessionEpoch: string
  readonly source: 'session' | 'local' | 'notice' | 'activity' | 'plugin'
  readonly sourceId: string
  /** Stable source/durable event identity used to derive `rowId`. */
  readonly sourceSeq: string
  readonly durableEventId?: string
  readonly revision: number
  readonly kind: string
  readonly blocks: readonly SerializableValue[]
  readonly settled: boolean
  readonly tool?: ToolLifecycleSnapshot
}
export interface ToolLifecycleSnapshot {
  readonly phase: 'running' | 'result' | 'error'
  readonly lifecycleRevision: number
  readonly durationMs?: number
  readonly callView?: SerializableValue
  readonly resultView?: SerializableValue
  readonly error?: SerializableError
}
export interface OverlayState {
  readonly overlayId: string
  readonly revision: number
  readonly anchor: OverlayAnchor
  readonly minWidth?: number | `${number}%`
  readonly width?: number | `${number}%`
  readonly maxHeight?: number | `${number}%`
  readonly row?: number | `${number}%`
  readonly col?: number | `${number}%`
  readonly margin?: { readonly top?: number; readonly right?: number; readonly bottom?: number; readonly left?: number } | number
  readonly offsetX?: number
  readonly offsetY?: number
  readonly visible: boolean
  readonly captureInput: boolean
  readonly nonCapturing: boolean
  readonly payload: SerializableValue
}
export interface SceneViewModel { readonly sceneId: string; readonly revision: number; readonly data: SerializableValue }
export interface SerializableError { readonly code: string; readonly message: string; readonly recoverable: boolean; readonly details?: SerializableValue }
export interface UiSnapshot {
  readonly schemaVersion: 1
  readonly adapterInstanceId: string
  readonly durableSessionId: string
  readonly uiSessionGeneration: string
  readonly resetEpoch: number
  readonly sessionEpoch: string
  readonly revision: number
  readonly rows: readonly UiRowSnapshot[]
  readonly snapshotHash: string
  readonly status: SerializableValue
}

export interface Clock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}
export interface RandomSource { next(): number }

// ---------------------------------------------------------------------------
// Runtime boundary helpers
// ---------------------------------------------------------------------------

const EVENT_SOURCES: readonly EventSource[] = ['session', 'stream', 'input', 'terminal', 'overlay', 'app', 'plugin']
const OVERLAY_ANCHORS: readonly OverlayAnchor[] = ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center', 'left-center', 'right-center']

export function isEventSource(value: unknown): value is EventSource {
  return typeof value === 'string' && (EVENT_SOURCES as readonly string[]).includes(value)
}

export function isOverlayAnchor(value: unknown): value is OverlayAnchor {
  return typeof value === 'string' && (OVERLAY_ANCHORS as readonly string[]).includes(value)
}

/**
 * Recursive runtime check for `SerializableValue`. Rejects functions, symbols,
 * undefined, bigint, non-finite numbers, cyclic structures and non-plain
 * objects (class instances, Map/Set, Date, ...). `unknown` must never degrade
 * into a non-serializable object at the model boundary.
 */
export function isSerializableValue(value: unknown): value is SerializableValue {
  return checkSerializable(value, new Set())
}

function checkSerializable(value: unknown, seen: Set<object>): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object': {
      if (seen.has(value as object)) return false
      seen.add(value as object)
      try {
        if (Array.isArray(value)) {
          return value.every((item) => checkSerializable(item, seen))
        }
        if (!isPlainObject(value)) return false
        return Object.values(value as Record<string, unknown>).every((item) => checkSerializable(item, seen))
      } finally {
        seen.delete(value as object)
      }
    }
    default:
      // function | symbol | undefined | bigint
      return false
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Recursively `Object.freeze` a value (including nested arrays/objects).
 * Already-frozen subtrees are skipped; cyclic input is tolerated (each object
 * is frozen once). The return type advertises the published immutability
 * contract (§5.2): reducers/controllers must never mutate published values.
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  freeze(value, new Set())
  return value as DeepReadonly<T>
}

function freeze(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value !== 'object') return
  const object = value as object
  if (seen.has(object)) return
  seen.add(object)
  if (Object.isFrozen(object)) return
  const children: unknown[] = Array.isArray(value) ? value : Object.values(value)
  for (const child of children) freeze(child, seen)
  Object.freeze(object)
}

/**
 * Structural deep copy restricted to `SerializableValue`. Unlike
 * `structuredClone` this cannot succeed on values we must reject (class
 * instances, functions, cycles); it throws unless the input passes
 * `isSerializableValue`. Output is a fresh plain-object/array graph.
 */
export function deepCopySerializable<T extends SerializableValue>(value: T): T {
  if (!isSerializableValue(value)) {
    throw new TypeError('deepCopySerializable: value is not serializable')
  }
  return copySerializable(value) as T
}

function copySerializable(value: SerializableValue): SerializableValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((item) => copySerializable(item))
  }
  const out: Record<string, SerializableValue> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = copySerializable(item)
  }
  return out
}

function fail(field: string): never {
  throw new TypeError(`invalid OverlayState: ${field}`)
}

function isDimension(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0
  if (typeof value === 'string') return /^\d+(\.\d+)?%$/.test(value)
  return false
}

/**
 * Shape + normalization-rule validation for `OverlayState` (§5.2):
 * `captureInput === !nonCapturing`; contradictory combinations are rejected.
 */
export function validateOverlayState(value: unknown): OverlayState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('not an object')
  const o = value as Record<string, unknown>
  if (typeof o.overlayId !== 'string' || o.overlayId === '') fail('overlayId must be a non-empty string')
  if (!Number.isInteger(o.revision) || (o.revision as number) < 0) fail('revision must be a non-negative integer')
  if (!isOverlayAnchor(o.anchor)) fail(`anchor must be one of ${OVERLAY_ANCHORS.join('|')}`)
  for (const field of ['minWidth', 'width', 'maxHeight', 'row', 'col'] as const) {
    if (o[field] !== undefined && !isDimension(o[field])) fail(`${field} must be a non-negative number or a "<n>%" string`)
  }
  if (o.margin !== undefined) {
    const m = o.margin
    if (typeof m === 'number') {
      if (!Number.isFinite(m) || m < 0) fail('margin must be non-negative')
    } else if (m !== null && typeof m === 'object' && !Array.isArray(m)) {
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const v = (m as Record<string, unknown>)[side]
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) fail(`margin.${side} must be a non-negative number`)
      }
    } else {
      fail('margin must be a number or an object with optional top/right/bottom/left')
    }
  }
  if (o.offsetX !== undefined && (typeof o.offsetX !== 'number' || !Number.isFinite(o.offsetX))) fail('offsetX must be a finite number')
  if (o.offsetY !== undefined && (typeof o.offsetY !== 'number' || !Number.isFinite(o.offsetY))) fail('offsetY must be a finite number')
  if (typeof o.visible !== 'boolean') fail('visible must be boolean')
  if (typeof o.captureInput !== 'boolean') fail('captureInput must be boolean')
  if (typeof o.nonCapturing !== 'boolean') fail('nonCapturing must be boolean')
  if (o.captureInput === o.nonCapturing) fail('captureInput must be the negation of nonCapturing')
  if (!isSerializableValue(o.payload)) fail('payload must be a SerializableValue')
  return o as unknown as OverlayState
}
