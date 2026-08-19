/**
 * tui-v2 stdin owner + tokenizer (WP-03b part 2, plan §6.6).
 *
 * Pipeline:
 *
 *   stdin bytes
 *     -> vendored StdinBuffer (partial reassembly across arbitrary chunks,
 *        including bracketed paste spanning chunks and ESC bytes inside paste
 *        content)
 *     -> protocol classification (focus / mouse / query-response / key)
 *     -> TerminalInputEvent
 *
 * Design notes (spec mapping):
 *
 * - `TerminalInputEvent` is the ONLY structured stdin output (§6.6); it is
 *   defined in `query.ts` (next to the query types it embeds) and re-exported
 *   here as the unified entry point. Raw bytes never enter events beyond the
 *   key payload's own `raw` sequence and never reach AppEvent/transcript; they
 *   are retained only in a bounded diagnostic ring (default 4 KiB, tail-keep).
 *
 * - `sequence` is monotonically increasing within this owner (one counter,
 *   shared by stdin-originated and lifecycle-injected events). `generation`
 *   is stamped per event; `setGeneration()` drops any buffered partial bytes
 *   (they belong to the old generation and can never complete safely) and
 *   counts the discard. Input arriving after `stop()` is dropped + counted.
 *
 * - Query responses: a complete sequence matching one of the pinned report
 *   grammars (query.ts `parseQueryResponse`) becomes a `query-response` event
 *   offered ONLY to the broker via `broker.accept(token, event)`. Active
 *   tokens are tracked through `registerQueryToken` — the designated consumer
 *   of the writer's `queryTokenSink` hook (§5.6). Candidates are pre-filtered
 *   by grammar-detected kind + generation so a foreign-kind token never sees
 *   the response; unclaimed (forged/late/stale-generation) responses are
 *   counted and dropped — never echoed, never emitted as keys.
 *
 * - Mouse: SGR 1006 (`CSI < b ; x ; y M/m`), urxvt 1015 (`CSI b+32 ; x ; y M`)
 *   and X10 (`ESC [ M` + 3 bytes) are decoded into a normalized payload.
 *
 * - Bracketed paste: reassembled by StdinBuffer whenever the 200~/201~ markers
 *   appear, even when the profile never enabled mode 2004 — markers are then
 *   still consumed defensively instead of leaking into the key stream. The
 *   paste payload is plain text only (§6.6).
 *
 * - win32 DEC 9001 input mode: NOT wired up. The §5.6 DEC allowlist has no
 *   9001 builder and the vendored keys.ts has no win32 input-record parser,
 *   so the lifecycle reports the capability as declined instead of enabling
 *   it (see lifecycle.ts). xterm-mode VT input keeps working on Windows.
 *
 * - Timers: this module creates timers ONLY through the injected Clock
 *   (`drainInput`). The vendored StdinBuffer keeps its own real-timer
 *   partial/escape timeouts (upstream behavior, unchanged); tests drive it
 *   deterministically by completing sequences or calling `flushPending()`.
 *
 * - No process-signal listeners here: `signal`/`resize` events are injected
 *   by the lifecycle layer via `emitSignal`/`emitResize` so the sequence
 *   space stays single-owner.
 *
 * Dependency rule (§4.3): node + pi facade + import type model/renderer only.
 */
import type { Readable } from 'node:stream'

import type { Clock } from '../model/schema.js'
import {
  StdinBuffer,
  decodePrintableKey,
  isKeyRelease,
  isKeyRepeat,
  parseKey,
  setKittyProtocolActive,
} from './pi.js'
import type { TerminalProfile } from './profile.js'
import {
  expectedReportForKind,
  parseQueryResponse,
  type QueryKind,
  type QueryToken,
  type TerminalInputEvent,
  type TerminalQueryBroker,
} from './query.js'

// Unified input entry point (§6.6): the event type itself lives in query.ts.
export type { TerminalInputEvent } from './query.js'

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Default capacity of the diagnostic raw-byte ring (§6.6 bounded ring). */
export const INPUT_DIAGNOSTIC_RING_BYTES = 4096
export const DRAIN_INPUT_DEFAULT_MAX_MS = 1000
export const DRAIN_INPUT_DEFAULT_IDLE_MS = 50
/** Safety cap for tracked (unsettled) query tokens; queries are short-lived. */
const MAX_TRACKED_QUERY_TOKENS = 64

/** Grammar detection order for query responses (all eight pinned reports). */
const QUERY_KIND_DETECTION_ORDER: readonly QueryKind[] = [
  'cursor',
  'size',
  'cell-size',
  'capability',
  'version',
  'color',
  'kitty-keyboard',
  'focus',
]

// ---------------------------------------------------------------------------
// public payload shapes (all SerializableValue-compatible)
// ---------------------------------------------------------------------------

// Payload shapes are `type` aliases (not interfaces) so they stay assignable
// to the SerializableValue index-signature contract of TerminalInputEvent.

export type KeyPayload = {
  /** Vendored keys.ts KeyId (e.g. 'ctrl+c', 'up'), or null when unrecognized. */
  readonly key: string | null
  /** The complete raw sequence for this event (keybinding matching input). */
  readonly raw: string
  /** Printable text to insert when applicable (kitty/modifyOtherKeys decoded). */
  readonly text: string | null
  readonly eventType: 'press' | 'repeat' | 'release'
}

export type PastePayload = {
  readonly text: string
}

export type MouseButtonName = 'left' | 'middle' | 'right' | 'none'
export type MouseProtocol = 'sgr-1006' | 'urxvt-1015' | 'x10'

export type MousePayload = {
  readonly protocol: MouseProtocol
  readonly action: 'press' | 'release' | 'move' | 'wheel'
  readonly button: MouseButtonName
  /** 0-based column/row. */
  readonly x: number
  readonly y: number
  readonly modifiers: { readonly shift: boolean; readonly alt: boolean; readonly ctrl: boolean }
  readonly wheel: 'up' | 'down' | 'left' | 'right' | null
}

export type FocusPayload = {
  readonly focused: boolean
}

export type ResizePayload = {
  readonly columns: number
  readonly rows: number
}

export type SignalPayload = {
  readonly signal: string
}

export interface InputDiagnostics {
  readonly bytesReceived: number
  readonly chunksReceived: number
  readonly eventsEmitted: number
  readonly keyEvents: number
  readonly pasteEvents: number
  readonly mouseEvents: number
  readonly focusEvents: number
  /** Chunks/sequences/injected events dropped because input was stopped. */
  readonly droppedAfterStop: number
  /** Buffered partial bytes discarded by a generation bump. */
  readonly droppedGenerationMismatch: number
  /** Query-grammar responses no active token claimed (forged/late/stale). */
  readonly unclaimedQueryResponses: number
  /** Query responses successfully routed to a broker waiter. */
  readonly routedQueryResponses: number
  /** onEvent consumer exceptions (swallowed, counted). */
  readonly consumerErrors: number
  readonly ringCapacity: number
}

/** Minimal stdin contract: a pausable/resumable Readable with optional raw mode. */
export interface InputStdin extends Readable {
  readonly isTTY?: boolean
  setRawMode?(raw: boolean): void
}

export interface TerminalInputSourceOptions {
  readonly stdin: InputStdin
  readonly generation: number
  readonly clock: Clock
  readonly profile: TerminalProfile
  readonly queryBroker?: TerminalQueryBroker
  readonly onEvent: (event: TerminalInputEvent) => void
  /** Diagnostic ring capacity in UTF-16 code units (default 4 KiB). */
  readonly diagnosticRingBytes?: number
}

export interface TerminalInputSource {
  /** Attach the data path and resume stdin. Idempotent. */
  start(): void
  /**
   * Stop emitting events: detach the data listener, discard buffered partial
   * input and pause stdin. Idempotent; later input is dropped + counted.
   */
  stop(): void
  /**
   * Wait for input silence (teardown helper): stdin data is consumed and
   * DISCARDED (never tokenized into events) until `idleMs` pass with no data
   * or `maxMs` elapse — whichever first. All timers on the injected Clock.
   */
  drainInput(maxMs?: number, idleMs?: number): Promise<void>
  /** Force-emit buffered partial sequences (deterministic test/production flush). */
  flushPending(): void
  /** termios raw mode toggle (no-op false when the stream cannot). */
  setRawMode(enabled: boolean): boolean
  /**
   * Mirror the kitty-keyboard state into the vendored keys.ts global so
   * `parseKey` disambiguates kitty-mode legacy sequences correctly.
   */
  setKittyKeyboardActive(active: boolean): void
  /** Bump the generation; buffered partial bytes are dropped + counted. */
  setGeneration(generation: number): void
  /** Inject a signal event (lifecycle-owned; single sequence space). */
  emitSignal(signal: string): void
  /** Inject a resize event (lifecycle-owned SIGWINCH translation). */
  emitResize(columns: number, rows: number): void
  /** Track a live query token (wire as the writer's `queryTokenSink`). */
  registerQueryToken(token: QueryToken): void
  generation(): number
  isAccepting(): boolean
  diagnostics(): InputDiagnostics
  /** Tail of the bounded raw-byte diagnostic ring (never leaves diagnostics). */
  diagnosticRing(): string
}

// ---------------------------------------------------------------------------
// protocol parsers
// ---------------------------------------------------------------------------

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/
const URXVT_MOUSE_RE = /^\x1b\[(\d+);(\d+);(\d+)M$/
const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'

function mouseButtonName(low: number): MouseButtonName {
  switch (low) {
    case 0:
      return 'left'
    case 1:
      return 'middle'
    case 2:
      return 'right'
    default:
      return 'none'
  }
}

/**
 * Decode the shared mouse button bitmask. `explicitRelease` is the SGR 'm'
 * final (urxvt/X10 encode release as low bits 3 instead).
 */
function mousePayload(
  protocol: MouseProtocol,
  code: number,
  x: number,
  y: number,
  explicitRelease: boolean,
): MousePayload {
  const modifiers = { shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 }
  const low = code & 3
  const motion = (code & 32) !== 0
  if ((code & 64) !== 0) {
    const wheel = low === 0 ? 'up' : low === 1 ? 'down' : low === 2 ? 'left' : 'right'
    return { protocol, action: 'wheel', button: 'none', x, y, modifiers, wheel }
  }
  if (explicitRelease) {
    return { protocol, action: 'release', button: mouseButtonName(low), x, y, modifiers, wheel: null }
  }
  if (!motion && low === 3) {
    return { protocol, action: 'release', button: 'none', x, y, modifiers, wheel: null }
  }
  if (motion) {
    return { protocol, action: 'move', button: mouseButtonName(low), x, y, modifiers, wheel: null }
  }
  return { protocol, action: 'press', button: mouseButtonName(low), x, y, modifiers, wheel: null }
}

/** Parse SGR 1006 / urxvt 1015 / X10 mouse sequences; null when not a mouse shape. */
export function parseMouseSequence(sequence: string): MousePayload | null {
  let match = SGR_MOUSE_RE.exec(sequence)
  if (match !== null) {
    const code = Number.parseInt(match[1] as string, 10)
    const x = Math.max(0, Number.parseInt(match[2] as string, 10) - 1)
    const y = Math.max(0, Number.parseInt(match[3] as string, 10) - 1)
    return mousePayload('sgr-1006', code, x, y, match[4] === 'm')
  }
  // X10: ESC [ M + 3 single bytes (button+32, column+32, row+32).
  if (sequence.length === 6 && sequence.startsWith('\x1b[M')) {
    const code = sequence.charCodeAt(3) - 32
    if (code < 0) return null
    const x = Math.max(0, sequence.charCodeAt(4) - 33)
    const y = Math.max(0, sequence.charCodeAt(5) - 33)
    return mousePayload('x10', code, x, y, false)
  }
  match = URXVT_MOUSE_RE.exec(sequence)
  if (match !== null) {
    const code = Number.parseInt(match[1] as string, 10) - 32
    if (code < 0) return null
    const x = Math.max(0, Number.parseInt(match[2] as string, 10) - 1)
    const y = Math.max(0, Number.parseInt(match[3] as string, 10) - 1)
    return mousePayload('urxvt-1015', code, x, y, false)
  }
  return null
}

/** Identify which pinned report grammar (if any) a raw response matches. */
function detectQueryResponseKind(raw: string): QueryKind | null {
  for (const kind of QUERY_KIND_DETECTION_ORDER) {
    if (parseQueryResponse(expectedReportForKind(kind), raw) !== null) return kind
  }
  return null
}

/** Text-insertable sequences: every code point printable (no C0/DEL/ESC). */
function isPlainPrintable(sequence: string): boolean {
  if (sequence.length === 0) return false
  for (const ch of sequence) {
    const cp = ch.codePointAt(0) as number
    if (cp < 0x20 || cp === 0x7f) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// implementation
// ---------------------------------------------------------------------------

class TerminalInputSourceImpl implements TerminalInputSource {
  private readonly stdin: InputStdin
  private readonly clock: Clock
  private readonly profile: TerminalProfile
  private readonly broker: TerminalQueryBroker | undefined
  private readonly onEvent: (event: TerminalInputEvent) => void
  private readonly ringCapacity: number

  private currentGeneration: number
  private sequenceCounter = 0
  private started = false
  private accepting = false
  private draining = false
  private ring = ''

  private readonly buffer: StdinBuffer
  private readonly queryTokens: QueryToken[] = []
  private drainPromise: Promise<void> | null = null

  private readonly counters = {
    bytesReceived: 0,
    chunksReceived: 0,
    eventsEmitted: 0,
    keyEvents: 0,
    pasteEvents: 0,
    mouseEvents: 0,
    focusEvents: 0,
    droppedAfterStop: 0,
    droppedGenerationMismatch: 0,
    unclaimedQueryResponses: 0,
    routedQueryResponses: 0,
    consumerErrors: 0,
  }

  private readonly handleDataBound = (data: unknown): void => this.handleData(data)

  constructor(options: TerminalInputSourceOptions) {
    if (!Number.isInteger(options.generation) || options.generation < 0) {
      throw new RangeError('input generation must be a non-negative integer')
    }
    this.stdin = options.stdin
    this.clock = options.clock
    this.profile = options.profile
    this.broker = options.queryBroker
    this.onEvent = options.onEvent
    this.ringCapacity = options.diagnosticRingBytes ?? INPUT_DIAGNOSTIC_RING_BYTES
    this.currentGeneration = options.generation

    this.buffer = new StdinBuffer()
    this.buffer.on('data', (sequence: string) => this.classifySequence(sequence))
    this.buffer.on('paste', (text: string) => {
      if (!this.accepting) {
        this.counters.droppedAfterStop += 1
        return
      }
      this.counters.pasteEvents += 1
      this.emit('paste', { text } satisfies PastePayload)
    })
  }

  // --------------------------------------------------------------- lifecycle

  start(): void {
    if (this.started) return
    this.started = true
    this.accepting = true
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', this.handleDataBound)
    this.stdin.resume()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.accepting = false
    this.stdin.removeListener('data', this.handleDataBound)
    // destroy() clears pending partial bytes, paste state and vendored timers.
    this.buffer.destroy()
    this.stdin.pause()
  }

  drainInput(maxMs: number = DRAIN_INPUT_DEFAULT_MAX_MS, idleMs: number = DRAIN_INPUT_DEFAULT_IDLE_MS): Promise<void> {
    if (this.drainPromise !== null) return this.drainPromise
    this.draining = true
    this.drainPromise = new Promise<void>((resolve) => {
      let idleTimer: unknown = null
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        if (idleTimer !== null) this.clock.clearTimeout(idleTimer)
        this.clock.clearTimeout(maxTimer)
        this.stdin.removeListener('data', onDrainData)
        this.draining = false
        this.drainPromise = null
        resolve()
      }
      const onDrainData = (data: unknown): void => {
        // Teardown drain: bytes are consumed and discarded (e.g. kitty key
        // release events flushed on exit) — recorded in the ring only.
        const text = typeof data === 'string' ? data : String(data)
        this.counters.bytesReceived += Buffer.byteLength(text, 'utf8')
        this.counters.chunksReceived += 1
        this.appendRing(text)
        if (idleTimer !== null) this.clock.clearTimeout(idleTimer)
        idleTimer = this.clock.setTimeout(finish, idleMs)
      }
      const maxTimer = this.clock.setTimeout(finish, Math.max(0, maxMs))
      idleTimer = this.clock.setTimeout(finish, Math.max(0, idleMs))
      this.stdin.on('data', onDrainData)
    })
    return this.drainPromise
  }

  flushPending(): void {
    // Vendored flush() emits the pending (incomplete) buffer as-is; a paste in
    // progress stays buffered until its end marker arrives.
    for (const sequence of this.buffer.flush()) this.classifySequence(sequence)
  }

  setRawMode(enabled: boolean): boolean {
    if (typeof this.stdin.setRawMode !== 'function') return false
    this.stdin.setRawMode(enabled)
    return true
  }

  setKittyKeyboardActive(active: boolean): void {
    // Vendored keys.ts keeps this as module-global state (upstream design);
    // the lifecycle toggles it alongside the kitty push/pop sequences.
    setKittyProtocolActive(active)
  }

  setGeneration(generation: number): void {
    if (!Number.isInteger(generation) || generation <= this.currentGeneration) {
      throw new RangeError(`input generation must strictly increase (current ${this.currentGeneration}, got ${generation})`)
    }
    this.currentGeneration = generation
    // Buffered partial bytes belong to the old generation: they can never
    // complete into a well-formed new-generation event. Drop + count (§6.6).
    if (this.buffer.getBuffer().length > 0) this.counters.droppedGenerationMismatch += 1
    this.buffer.clear()
    // Tokens from older generations can never match again; drop them locally
    // (the broker still owns their deadlines/cancellation).
    for (let i = this.queryTokens.length - 1; i >= 0; i--) {
      if ((this.queryTokens[i] as QueryToken).generation !== generation) this.queryTokens.splice(i, 1)
    }
  }

  emitSignal(signal: string): void {
    if (!this.accepting) {
      this.counters.droppedAfterStop += 1
      return
    }
    this.emit('signal', { signal } satisfies SignalPayload)
  }

  emitResize(columns: number, rows: number): void {
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) {
      throw new RangeError(`emitResize: invalid geometry ${columns}x${rows}`)
    }
    if (!this.accepting) {
      this.counters.droppedAfterStop += 1
      return
    }
    this.emit('resize', { columns, rows } satisfies ResizePayload)
  }

  registerQueryToken(token: QueryToken): void {
    if (this.broker === undefined) return
    this.pruneQueryTokens()
    this.queryTokens.push(token)
    if (this.queryTokens.length > MAX_TRACKED_QUERY_TOKENS) this.queryTokens.shift()
  }

  generation(): number {
    return this.currentGeneration
  }

  isAccepting(): boolean {
    return this.accepting
  }

  diagnostics(): InputDiagnostics {
    return { ...this.counters, ringCapacity: this.ringCapacity }
  }

  diagnosticRing(): string {
    return this.ring
  }

  // ------------------------------------------------------------------ intake

  private handleData(data: unknown): void {
    const text = typeof data === 'string' ? data : String(data)
    this.counters.bytesReceived += Buffer.byteLength(text, 'utf8')
    this.counters.chunksReceived += 1
    this.appendRing(text)
    if (!this.accepting || this.draining) {
      this.counters.droppedAfterStop += 1
      return
    }
    this.buffer.process(text)
  }

  private appendRing(chunk: string): void {
    if (chunk.length === 0 || this.ringCapacity <= 0) return
    this.ring += chunk
    if (this.ring.length > this.ringCapacity) {
      this.ring = this.ring.slice(this.ring.length - this.ringCapacity)
    }
  }

  // ----------------------------------------------------------- classification

  private classifySequence(sequence: string): void {
    if (!this.accepting) {
      this.counters.droppedAfterStop += 1
      return
    }
    if (sequence.length === 0) return

    // Focus reporting (CSI I / CSI O).
    if (sequence === FOCUS_IN) {
      this.counters.focusEvents += 1
      this.emit('focus', { focused: true } satisfies FocusPayload)
      return
    }
    if (sequence === FOCUS_OUT) {
      this.counters.focusEvents += 1
      this.emit('focus', { focused: false } satisfies FocusPayload)
      return
    }

    // Mouse protocols (SGR 1006 / urxvt 1015 / X10).
    const mouse = parseMouseSequence(sequence)
    if (mouse !== null) {
      this.counters.mouseEvents += 1
      this.emit('mouse', mouse)
      return
    }

    // Query responses route to the broker only — never to the key stream.
    const queryKind = detectQueryResponseKind(sequence)
    if (queryKind !== null) {
      this.routeQueryResponse(queryKind, sequence)
      return
    }

    // Keys: vendored keys.ts parsing (CSI-u/kitty/modifyOtherKeys + legacy).
    // Note: StdinBuffer emits one UTF-16 unit at a time for plain text, so an
    // astral character arrives as a surrogate pair across two events — the
    // controller reassembles text (upstream pi behavior, unchanged).
    const key = parseKey(sequence) ?? null
    const text = decodePrintableKey(sequence) ?? (isPlainPrintable(sequence) ? sequence : null)
    const eventType = isKeyRelease(sequence) ? 'release' : isKeyRepeat(sequence) ? 'repeat' : 'press'
    this.counters.keyEvents += 1
    this.emit('key', { key, raw: sequence, text, eventType } satisfies KeyPayload)
  }

  /**
   * Offer a grammar-matched response to the active tokens of the matching
   * kind + generation (pre-filtered so foreign-kind tokens never see it;
   * `broker.accept` still re-validates token identity + grammar itself).
   */
  private routeQueryResponse(kind: QueryKind, raw: string): void {
    const broker = this.broker
    if (broker === undefined) {
      this.counters.unclaimedQueryResponses += 1
      return
    }
    this.pruneQueryTokens()
    const sequence = this.nextSequence()
    for (const token of this.queryTokens) {
      if (token.kind !== kind || token.generation !== this.currentGeneration) continue
      const event: TerminalInputEvent = {
        kind: 'query-response',
        sequence,
        generation: this.currentGeneration,
        payload: null,
        query: { tokenId: token.id, kind, value: raw },
      }
      if (broker.accept(token, event)) {
        this.counters.routedQueryResponses += 1
        this.queryTokens.splice(this.queryTokens.indexOf(token), 1)
        return
      }
    }
    // Forged, late or stale-generation response: counted drop (§6.6).
    this.counters.unclaimedQueryResponses += 1
  }

  private pruneQueryTokens(): void {
    if (this.broker === undefined) return
    for (let i = this.queryTokens.length - 1; i >= 0; i--) {
      if (!this.broker.isRegistered(this.queryTokens[i] as QueryToken)) this.queryTokens.splice(i, 1)
    }
  }

  private nextSequence(): number {
    const sequence = this.sequenceCounter
    this.sequenceCounter += 1
    return sequence
  }

  private emit(kind: TerminalInputEvent['kind'], payload: TerminalInputEvent['payload']): void {
    const event: TerminalInputEvent = {
      kind,
      sequence: this.nextSequence(),
      generation: this.currentGeneration,
      payload,
    }
    this.counters.eventsEmitted += 1
    try {
      this.onEvent(event)
    } catch {
      // A throwing consumer must never break stdin processing.
      this.counters.consumerErrors += 1
    }
  }
}

export function createInputSource(options: TerminalInputSourceOptions): TerminalInputSource {
  return new TerminalInputSourceImpl(options)
}
