/**
 * tui-v2 PiTerminalAdapter (WP-03c, plan §5.6).
 *
 * The synchronous pi `Terminal` facade on top of the dsh terminal stack
 * (writer + lifecycle + input, all constructor-injected). The vendored
 * Tui/TuiMainScreen/TuiAltScreen hold a pi `Terminal`; on the dsh runtime
 * that object is this adapter — `ProcessTerminal` stays the pristine
 * upstream reference implementation and is never used by dsh.
 *
 * Semantics (plan §5.6, "保留完整 facade，同时 fork 所有生产调用点"):
 *
 * - Every synchronous method only ENQUEUES a typed operation into the
 *   writer's serialized queue (lifecycle op or branded ansi.ts sequence).
 *   Nothing touches a Node stream here; backpressure, generation checks and
 *   error conversion are the writer's job. A sync method returning means
 *   "accepted into the queue", never "bytes flushed".
 * - `write(string)` is the compat boundary: the partial tail of the previous
 *   write is prepended, then `parsePiTerminalString` strictly parses the
 *   buffer. Data-plane spans (text/SGR/OSC 8/newlines) are re-validated by
 *   `ansi.piCellDataRun` (defense in depth — the writer's trust registry
 *   never brands an unchecked string); control ops map to lifecycle ops or
 *   ansi.ts builders. An unknown/rejected sequence fails the WHOLE write
 *   with `unsupported-pi-sequence` and zero bytes of that write go out.
 * - `stop()` kicks the §5.7 lifecycle barrier; `awaitStop()` is its promise
 *   (writer stop + in-flight settle + cleanup flush + stdin drain + signal
 *   listener removal). Async failures surface through `onError` and the
 *   lifecycle diagnostics channel, never through the sync return value.
 * - Input flows the other way: the factory wires the input source's
 *   `onEvent` to `dispatchInputEvent`, which translates typed input events
 *   back into the pi wire strings the vendored TUI parses (key raw bytes,
 *   bracketed paste markers, SGR 1006 mouse, focus in/out).
 *
 * Documented deviations from pi `ProcessTerminal` (see
 * docs/tui-v2/pi-terminal-method-matrix.md):
 * - setTitle uses OSC 2 (ansi.setTitle default scope) where pi uses OSC 0 —
 *   both set the window title.
 * - setProgress(true) maps to lifecycle progress state 'normal' (OSC 9;4;1)
 *   where pi emits OSC 9;4;3 (indeterminate) with a keepalive interval; the
 *   pinned lifecycle progress op has no 'indeterminate' state (the parsed
 *   OSC 9;4;3 form round-trips through the sequence lane instead).
 * - clearScreen emits ED 2 + CUP 1;1 (`\x1b[2J\x1b[1;1H`) where pi emits
 *   `\x1b[2J\x1b[H` — byte-normalized, semantically identical.
 * - pi queries (cell size / background color / color scheme) only SEND the
 *   query bytes; responses are detected by the input layer's query grammar
 *   and dropped when no broker token claims them — pi-side response
 *   consumers are not wired (known boundary).
 */

import type { Writable } from 'node:stream'

import type { Clock } from '../model/schema.js'
import * as ansi from './ansi.js'
import {
  createInputSource,
  type InputStdin,
  type KeyPayload,
  type MousePayload,
  type PastePayload,
  type FocusPayload,
  type TerminalInputSource,
} from './input.js'
import {
  createTerminalLifecycle,
  type LifecycleDiagnostic,
  type LifecycleStartOptions,
  type LifecycleStartResult,
  type LifecycleStopReason,
  type ProcessSignalHost,
  type TerminalLifecycle,
} from './lifecycle.js'
import {
  parsePiTerminalString,
  PI_STRING_MAX_PAYLOAD_BYTES,
  type PiParsedOperation,
} from './pi.js'
import type { TerminalProfile } from './profile.js'
import type { TerminalInputEvent, TerminalQueryBroker } from './query.js'
import {
  createTerminalWriter,
  type TerminalControlOperation,
  type TerminalLifecycleState,
  type TerminalWriter,
  type WriteResult,
} from './writer.js'

// ---------------------------------------------------------------------------
// contract (verbatim from plan §5.6)
// ---------------------------------------------------------------------------

/** Exact synchronous facade required by the pinned pi-tui Terminal interface. */
export interface PiTerminalAdapter {
  start(onInput: (data: string) => void, onResize: () => void): void
  stop(): void
  awaitStop(): Promise<void>
  drainInput(maxMs?: number, idleMs?: number): Promise<void>
  write(data: string): void
  readonly columns: number
  readonly rows: number
  readonly kittyProtocolActive: boolean
  moveBy(lines: number): void
  hideCursor(): void
  showCursor(): void
  clearLine(): void
  clearFromCursor(): void
  clearScreen(): void
  setTitle(title: string): void
  setProgress(active: boolean): void
}

// ---------------------------------------------------------------------------
// adapter-specific surface (not part of the pi contract)
// ---------------------------------------------------------------------------

export interface PiAdapterError {
  readonly code: string
  readonly message: string
  readonly recoverable: boolean
  /** Parser offset for `unsupported-pi-sequence`; -1 when not applicable. */
  readonly offset: number
}

export interface PiAdapterDiagnostics {
  /** Total write(string) calls seen. */
  readonly writeCalls: number
  /** Writes rejected by the strict parser / payload cap (zero bytes out). */
  readonly rejectedWrites: number
  /** Control/data operations handed to the writer queue. */
  readonly enqueuedOperations: number
  /** WriteResults with status 'error' observed from the writer. */
  readonly errorResults: number
  /** WriteResults with status 'stale' (old generation / quiesced). */
  readonly staleResults: number
  /** WriteResults with status 'stopped' (writer stopping/stopped). */
  readonly stoppedResults: number
  /** Input events dropped because no start() callbacks are registered. */
  readonly undeliveredInputEvents: number
  /** Current buffered partial-tail length (UTF-16 code units). */
  readonly remainderLength: number
}

/** dsh-only extras beyond the pinned pi contract (tests/backends use these). */
export interface PiTerminalAdapterExtras {
  /** The lifecycle.start() promise kicked by start() (dsh barrier hook). */
  whenStarted(): Promise<LifecycleStartResult>
  /** Input-source event entry point (wired by createPiTerminalStack). */
  dispatchInputEvent(event: TerminalInputEvent): void
  diagnostics(): PiAdapterDiagnostics
}

export type PiTerminalAdapterHandle = PiTerminalAdapter & PiTerminalAdapterExtras

export interface PiTerminalAdapterOptions {
  readonly writer: TerminalWriter & { lifecycleState(): TerminalLifecycleState }
  readonly lifecycle: TerminalLifecycle
  readonly input: TerminalInputSource
  readonly profile: TerminalProfile
  /** Live dimensions source (process.stdout in production). */
  readonly stdout: { readonly columns?: number | undefined; readonly rows?: number | undefined }
  /** LifecycleStartOptions used when start() kicks the takeover. */
  readonly startOptions?: LifecycleStartOptions
  readonly onError?: (error: PiAdapterError) => void
}

// ---------------------------------------------------------------------------
// adapter implementation
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Rebuild the SGR 1006 mouse wire form the vendored TUI parses. */
function encodeMouseAsSgr(payload: MousePayload): string {
  let code: number
  if (payload.action === 'wheel') {
    const direction = payload.wheel === 'down' ? 1 : payload.wheel === 'left' ? 2 : payload.wheel === 'right' ? 3 : 0
    code = 64 + direction
  } else {
    code = payload.button === 'middle' ? 1 : payload.button === 'right' ? 2 : payload.button === 'none' ? 3 : 0
    if (payload.action === 'move') code += 32
  }
  if (payload.modifiers.shift) code += 4
  if (payload.modifiers.alt) code += 8
  if (payload.modifiers.ctrl) code += 16
  const final = payload.action === 'release' ? 'm' : 'M'
  return `\x1b[<${code};${payload.x + 1};${payload.y + 1}${final}`
}

class PiTerminalAdapterImpl implements PiTerminalAdapterHandle {
  private readonly writer: PiTerminalAdapterOptions['writer']
  private readonly lifecycle: TerminalLifecycle
  private readonly input: TerminalInputSource
  private readonly profile: TerminalProfile
  private readonly stdout: PiTerminalAdapterOptions['stdout']
  private readonly startOptions: LifecycleStartOptions
  private readonly onError: PiTerminalAdapterOptions['onError']

  private onInput: ((data: string) => void) | null = null
  private onResize: (() => void) | null = null
  private startPromise: Promise<LifecycleStartResult> | null = null
  private stopPromise: Promise<void> | null = null
  /** Buffered partial tail of the previous write (chunk-split sequence). */
  private remainder = ''

  private writeCalls = 0
  private rejectedWrites = 0
  private enqueuedOperations = 0
  private errorResults = 0
  private staleResults = 0
  private stoppedResults = 0
  private undeliveredInputEvents = 0

  constructor(options: PiTerminalAdapterOptions) {
    this.writer = options.writer
    this.lifecycle = options.lifecycle
    this.input = options.input
    this.profile = options.profile
    this.stdout = options.stdout
    this.startOptions = options.startOptions ?? {}
    this.onError = options.onError
  }

  // ------------------------------------------------------------ pi contract

  start(onInput: (data: string) => void, onResize: () => void): void {
    if (typeof onInput !== 'function' || typeof onResize !== 'function') {
      throw new TypeError('PiTerminalAdapter.start requires onInput and onResize callbacks')
    }
    // The latest TUI instance's callbacks win (main/alt backends share one
    // adapter); the lifecycle takeover itself is idempotent (shared promise).
    this.onInput = onInput
    this.onResize = onResize
    if (this.startPromise === null) {
      this.startPromise = this.lifecycle.start(this.startOptions)
    }
  }

  stop(): void {
    if (this.stopPromise === null) {
      this.stopPromise = this.lifecycle.stop('user-exit')
    }
  }

  awaitStop(): Promise<void> {
    this.stop()
    return this.stopPromise as Promise<void>
  }

  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.input.drainInput(maxMs, idleMs)
  }

  get columns(): number {
    return this.stdout.columns ?? this.profile.columns
  }

  get rows(): number {
    return this.stdout.rows ?? this.profile.rows
  }

  get kittyProtocolActive(): boolean {
    return this.lifecycle.currentModeSnapshot().kittyKeyboard
  }

  moveBy(lines: number): void {
    if (!Number.isInteger(lines) || lines < -9999 || lines > 9999) {
      throw new RangeError(`moveBy lines must be an integer in [-9999, 9999], got ${lines}`)
    }
    if (lines === 0) return
    // Positive delta moves DOWN, negative moves UP (writer contract).
    this.enqueue({ kind: 'lifecycle', operation: { kind: 'cursor-move', delta: lines } })
  }

  hideCursor(): void {
    this.enqueue({ kind: 'lifecycle', operation: { kind: 'lifecycle', action: 'cursor', enabled: false } })
  }

  showCursor(): void {
    this.enqueue({ kind: 'lifecycle', operation: { kind: 'lifecycle', action: 'cursor', enabled: true } })
  }

  clearLine(): void {
    this.enqueue({ kind: 'lifecycle', operation: { kind: 'clear', scope: 'line' } })
  }

  clearFromCursor(): void {
    this.enqueue({ kind: 'lifecycle', operation: { kind: 'clear', scope: 'from-cursor' } })
  }

  clearScreen(): void {
    // pi semantics: erase display + cursor home. The pinned lifecycle clear
    // op only carries the erase; the home half rides the sequence lane.
    this.enqueue({ kind: 'lifecycle', operation: { kind: 'clear', scope: 'screen' } })
    this.enqueue({ kind: 'sequence', sequence: ansi.cursorTo(1, 1), purpose: 'pi-compatible' })
  }

  setTitle(title: string): void {
    if (typeof title !== 'string') throw new TypeError('setTitle title must be a string')
    this.enqueue({ kind: 'lifecycle', operation: { kind: 'title', value: title } })
  }

  setProgress(active: boolean): void {
    this.enqueue({
      kind: 'lifecycle',
      operation: { kind: 'progress', state: active ? 'normal' : 'none' },
    })
  }

  // ------------------------------------------------- write(string) boundary

  write(data: string): void {
    if (typeof data !== 'string') throw new TypeError('PiTerminalAdapter.write data must be a string')
    this.writeCalls += 1
    const combined = this.remainder + data
    if (Buffer.byteLength(combined, 'utf8') > PI_STRING_MAX_PAYLOAD_BYTES) {
      // Cap breach: drop the buffered tail and reject the whole write.
      this.remainder = ''
      this.reject('unsupported-pi-sequence', `write payload exceeds ${PI_STRING_MAX_PAYLOAD_BYTES} bytes`, 0)
      return
    }
    const parsed = parsePiTerminalString(combined)
    if (!parsed.ok) {
      // Atomic rejection: zero bytes of this write reach the writer.
      this.remainder = ''
      this.reject(parsed.error.code, parsed.error.message, parsed.error.offset)
      return
    }
    this.remainder = parsed.remainder
    this.emitOperations(parsed.operations)
  }

  // ------------------------------------------------------------- dsh extras

  whenStarted(): Promise<LifecycleStartResult> {
    if (this.startPromise === null) {
      this.startPromise = this.lifecycle.start(this.startOptions)
    }
    return this.startPromise
  }

  dispatchInputEvent(event: TerminalInputEvent): void {
    if (event.kind === 'resize') {
      if (this.onResize !== null) this.onResize()
      else this.undeliveredInputEvents += 1
      return
    }
    if (this.onInput === null) {
      this.undeliveredInputEvents += 1
      return
    }
    switch (event.kind) {
      case 'key':
        this.onInput((event.payload as KeyPayload).raw)
        break
      case 'paste':
        this.onInput(`\x1b[200~${(event.payload as PastePayload).text}\x1b[201~`)
        break
      case 'mouse':
        this.onInput(encodeMouseAsSgr(event.payload as MousePayload))
        break
      case 'focus':
        this.onInput((event.payload as FocusPayload).focused ? '\x1b[I' : '\x1b[O')
        break
      default:
        // signal / query-response: consumed by the dsh layer, never by pi.
        break
    }
  }

  diagnostics(): PiAdapterDiagnostics {
    return {
      writeCalls: this.writeCalls,
      rejectedWrites: this.rejectedWrites,
      enqueuedOperations: this.enqueuedOperations,
      errorResults: this.errorResults,
      staleResults: this.staleResults,
      stoppedResults: this.stoppedResults,
      undeliveredInputEvents: this.undeliveredInputEvents,
      remainderLength: this.remainder.length,
    }
  }

  // ---------------------------------------------------------------- internals

  private reject(code: string, message: string, offset: number): void {
    this.rejectedWrites += 1
    this.onError?.({ code, message, recoverable: true, offset })
  }

  /** Enqueue one typed operation; async settlement is observed, never thrown. */
  private enqueue(operation: TerminalControlOperation): void {
    this.enqueuedOperations += 1
    let result: Promise<WriteResult>
    try {
      result = this.writer.writeControl(operation, this.lifecycle.generation())
    } catch (error) {
      this.errorResults += 1
      this.onError?.({ code: 'control-enqueue-throw', message: messageOf(error), recoverable: false, offset: -1 })
      return
    }
    void result.then((settled) => {
      if (settled.status === 'error') {
        this.errorResults += 1
        this.onError?.({
          code: settled.error.code,
          message: settled.error.message,
          recoverable: settled.error.recoverable,
          offset: -1,
        })
      } else if (settled.status === 'stale') {
        this.staleResults += 1
      } else if (settled.status === 'stopped') {
        this.stoppedResults += 1
      }
    })
  }

  /** Segment parsed operations into data runs + control operations. */
  private emitOperations(operations: readonly PiParsedOperation[]): void {
    let dataRun = ''
    const flushData = (): void => {
      if (dataRun === '') return
      const raw = dataRun
      dataRun = ''
      let sequence: ansi.ControlSequence
      try {
        // Re-validated inside ansi.ts (the trust registry never brands an
        // unchecked string); parser output passes by construction.
        sequence = ansi.piCellDataRun(raw)
      } catch (error) {
        this.reject('unsupported-pi-sequence', messageOf(error), -1)
        return
      }
      this.enqueue({ kind: 'sequence', sequence, purpose: 'pi-compatible' })
    }
    for (const operation of operations) {
      switch (operation.kind) {
        case 'text':
          dataRun += operation.text
          break
        case 'newline':
          dataRun += '\r\n'
          break
        case 'carriage-return':
          dataRun += '\r'
          break
        case 'line-feed':
          dataRun += '\n'
          break
        case 'sgr':
        case 'hyperlink':
          dataRun += operation.raw
          break
        default:
          flushData()
          this.emitControl(operation)
          break
      }
    }
    flushData()
  }

  /** Map one parsed control operation onto the writer's typed operations. */
  private emitControl(operation: PiParsedOperation): void {
    try {
      switch (operation.kind) {
        case 'cursor-up':
          this.enqueue({ kind: 'lifecycle', operation: { kind: 'cursor-move', delta: -operation.count } })
          break
        case 'cursor-down':
          this.enqueue({ kind: 'lifecycle', operation: { kind: 'cursor-move', delta: operation.count } })
          break
        case 'cursor-forward':
          this.enqueue({ kind: 'sequence', sequence: ansi.cursorForward(operation.count), purpose: 'pi-compatible' })
          break
        case 'cursor-back':
          this.enqueue({ kind: 'sequence', sequence: ansi.cursorBack(operation.count), purpose: 'pi-compatible' })
          break
        case 'cursor-column':
          this.enqueue({ kind: 'sequence', sequence: ansi.cursorColumn(operation.column), purpose: 'pi-compatible' })
          break
        case 'cursor-to':
          this.enqueue({ kind: 'sequence', sequence: ansi.cursorTo(operation.row, operation.column), purpose: 'pi-compatible' })
          break
        case 'erase-line':
          if (operation.mode === 2) {
            this.enqueue({ kind: 'lifecycle', operation: { kind: 'clear', scope: 'line' } })
          } else {
            this.enqueue({ kind: 'sequence', sequence: ansi.eraseInLine(operation.mode), purpose: 'pi-compatible' })
          }
          break
        case 'erase-display':
          if (operation.mode === 0) {
            this.enqueue({ kind: 'lifecycle', operation: { kind: 'clear', scope: 'from-cursor' } })
          } else if (operation.mode === 2) {
            this.enqueue({ kind: 'lifecycle', operation: { kind: 'clear', scope: 'screen' } })
          } else {
            this.enqueue({ kind: 'sequence', sequence: ansi.eraseInDisplay(operation.mode), purpose: 'pi-compatible' })
          }
          break
        case 'mode':
          this.emitMode(operation.mode, operation.enabled)
          break
        case 'query':
          this.enqueue({
            kind: 'sequence',
            sequence:
              operation.query === 'cell-size'
                ? ansi.queryCellSize()
                : operation.query === 'background-color'
                  ? ansi.queryBackgroundColor()
                  : ansi.queryColorScheme(),
            purpose: 'query-write',
          })
          break
        case 'title':
          this.enqueue({ kind: 'lifecycle', operation: { kind: 'title', value: operation.value } })
          break
        case 'progress':
          if (operation.state === 3) {
            // 'indeterminate' is not in the pinned lifecycle progress op.
            this.enqueue({ kind: 'sequence', sequence: ansi.progress('indeterminate'), purpose: 'pi-compatible' })
          } else {
            const state = operation.state === 0 ? 'none' : operation.state === 1 ? 'normal' : operation.state === 2 ? 'error' : 'paused'
            this.enqueue({
              kind: 'lifecycle',
              operation:
                operation.value === undefined
                  ? { kind: 'progress', state }
                  : { kind: 'progress', state, value: operation.value },
            })
          }
          break
        case 'clipboard':
          this.enqueue({ kind: 'sequence', sequence: ansi.osc52Clipboard(operation.payloadBase64), purpose: 'pi-compatible' })
          break
        case 'image':
          if (operation.protocol === 'kitty') {
            this.enqueue({
              kind: 'sequence',
              sequence: ansi.kittyImage(Object.fromEntries(operation.keys), operation.payloadBase64),
              purpose: 'pi-compatible',
            })
          } else {
            this.enqueue({
              kind: 'sequence',
              sequence: ansi.iterm2Image(iterm2Options(operation.params, operation.payloadBase64), operation.payloadBase64),
              purpose: 'pi-compatible',
            })
          }
          break
        default:
          this.reject('unsupported-pi-sequence', `no writer mapping for parsed operation kind '${String((operation as { kind?: unknown }).kind)}'`, -1)
      }
    } catch (error) {
      // A builder rejecting parser-validated output is an adapter bug; surface
      // it through the error channel instead of throwing into pi's sync call.
      this.errorResults += 1
      this.onError?.({ code: 'pi-operation-encode-error', message: messageOf(error), recoverable: false, offset: -1 })
    }
  }

  /** DEC modes: the lifecycle-owned subset rides lifecycle ops, the rest ansi. */
  private emitMode(mode: number, enabled: boolean): void {
    switch (mode) {
      case 25:
        this.enqueue({ kind: 'lifecycle', operation: { kind: 'lifecycle', action: 'cursor', enabled } })
        break
      case 1049:
        this.enqueue({ kind: 'lifecycle', operation: { kind: 'lifecycle', action: 'enter-alt', enabled } })
        break
      case 2026:
        this.enqueue({ kind: 'lifecycle', operation: { kind: 'lifecycle', action: 'sync-output', enabled } })
        break
      default:
        this.enqueue({
          kind: 'sequence',
          sequence: enabled ? ansi.decset(mode) : ansi.decrst(mode),
          purpose: 'pi-compatible',
        })
        break
    }
  }
}

/** Structured iTerm2 params for ansi.iterm2Image (pi encodeITerm2 order). */
function iterm2Options(
  params: readonly [string, string][],
  payloadBase64: string,
): Parameters<typeof ansi.iterm2Image>[0] {
  const map = new Map(params)
  return {
    inline: map.get('inline') !== '0',
    // Decoded byte count, matching upstream encodeITerm2's size parameter.
    size: Buffer.byteLength(payloadBase64, 'base64'),
    width: map.get('width'),
    height: map.get('height'),
    name: map.get('name'),
    preserveAspectRatio: map.get('preserveAspectRatio') === '0' ? false : undefined,
  }
}

export function createPiTerminalAdapter(options: PiTerminalAdapterOptions): PiTerminalAdapterHandle {
  return new PiTerminalAdapterImpl(options)
}

// ---------------------------------------------------------------------------
// createPiTerminalStack — writer + lifecycle + input + adapter in one wiring
// ---------------------------------------------------------------------------

export interface PiTerminalStackOptions {
  readonly stdin: InputStdin
  /** Dimensions source (process.stdout in production). */
  readonly stdout: { readonly columns?: number | undefined; readonly rows?: number | undefined }
  /** The single output stream (the ONLY place bytes leave the process). */
  readonly stream: Writable
  readonly clock: Clock
  readonly profile: TerminalProfile
  readonly startOptions?: LifecycleStartOptions
  readonly processHost?: ProcessSignalHost
  readonly queryBroker?: TerminalQueryBroker
  readonly generation?: number
  readonly onError?: (error: PiAdapterError) => void
  readonly onDiagnostic?: (diagnostic: LifecycleDiagnostic) => void
  readonly onRequestStop?: (reason: LifecycleStopReason) => void
}

export interface PiTerminalStack {
  readonly adapter: PiTerminalAdapterHandle
  readonly writer: TerminalWriter & { lifecycleState(): TerminalLifecycleState }
  readonly input: TerminalInputSource
  readonly lifecycle: TerminalLifecycle
}

/**
 * Wire the full stack. The input source needs its onEvent consumer at
 * construction time while the adapter needs the input source — the closure
 * indirection below is the single join point. The writer's query-token sink
 * is routed to input.registerQueryToken so brokered query responses resolve.
 */
export function createPiTerminalStack(options: PiTerminalStackOptions): PiTerminalStack {
  const generation = options.generation ?? 0
  let adapterRef: PiTerminalAdapterHandle | null = null
  const input = createInputSource({
    stdin: options.stdin,
    generation,
    clock: options.clock,
    profile: options.profile,
    queryBroker: options.queryBroker,
    onEvent: (event) => adapterRef?.dispatchInputEvent(event),
  })
  const writer = createTerminalWriter({
    stream: options.stream,
    clock: options.clock,
    profile: options.profile,
    queryBroker: options.queryBroker,
    queryTokenSink: options.queryBroker === undefined ? undefined : (token) => input.registerQueryToken(token),
  })
  const lifecycle = createTerminalLifecycle({
    writer,
    input,
    profile: options.profile,
    clock: options.clock,
    stdin: options.stdin,
    stdout: options.stdout,
    processHost: options.processHost,
    generation,
    onDiagnostic: options.onDiagnostic,
    onRequestStop: options.onRequestStop,
  })
  const adapter = createPiTerminalAdapter({
    writer,
    lifecycle,
    input,
    profile: options.profile,
    stdout: options.stdout,
    startOptions: options.startOptions,
    onError: options.onError,
  })
  adapterRef = adapter
  return { adapter, writer, input, lifecycle }
}
