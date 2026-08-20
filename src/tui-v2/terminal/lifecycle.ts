/**
 * tui-v2 terminal lifecycle orchestration (WP-03b part 2, plan §5.7/§6.6).
 *
 * Owns takeover/cleanup ordering on top of the already-built primitives:
 * every terminal byte goes through the single `TerminalWriter` queue
 * (`writeControl`), termios raw mode goes through the input source
 * (`stdin.setRawMode`), and the profile gates every advanced capability —
 * `'unknown'` is never treated as supported (§5.4), and
 * `supportsAlternateScreen !== 'yes'` refuses takeover with
 * `unsupported-alternate-screen` BEFORE any byte or raw-mode change.
 *
 * Startup order (§6.6 checklist): enter-raw (termios side only; the writer op
 * encodes zero bytes by contract) -> enter-alt (1049h) -> bracketed paste
 * (2004h) -> mouse (1002h+1006h) -> focus reporting (1004h) -> kitty keyboard
 * push (when supported) -> sync output (2026h, when supported) -> hide cursor.
 *
 * Shutdown (`stop`) is the exact reverse for the modes this instance enabled:
 * sync-output end -> kitty pop -> mouse off -> paste off -> focus off ->
 * show cursor -> exit-alt (unless preserveScreen), then writer flush,
 * `writer.stop()` (its own best-effort bundle is the safety net), raw-mode
 * restore and `input.drainInput()`. Deadlines are fixed by §5.7: 500 ms per
 * writer op, 2 s total cleanup budget, both on the injected Clock; expiry is
 * best-effort — stop still returns, and a diagnostic records WHICH deadline
 * was hit. `stop` is idempotent: repeated calls (user exit + signal +
 * teardown) return the same promise and never re-emit sequences.
 *
 * State machine (shared semantics with the writer, §5.7):
 *   created -> starting -> active -> stopping -> stopped
 *   + failed-before-takeover / failed-after-takeover (terminal).
 * State, the fixed owner label and the generation are exposed for traces.
 *
 * Process handlers (`attachProcessHandlers`, all removed by
 * `detachProcessHandlers`, both idempotent):
 *   SIGWINCH -> resize event (via input's sequence space, dimensions re-read
 *               from stdout with profile fallback)
 *   SIGCONT  -> onResume callback (full-redraw-required marker)
 *   SIGHUP/SIGINT/SIGTERM -> signal event + onRequestStop(reason); the FIRST
 *               occurrence per signal only — repeats never re-emit cleanup
 *               sequences, they just set the force flag (forceStopRequested);
 *               handlers stay attached until the stop barrier finishes for
 *               exactly this reason
 *   stdin close/error -> onRequestStop('stdin-close' | 'stdin-error')
 *   uncaughtException/unhandledRejection -> onProcessError callback +
 *               best-effort cleanup via stop('error'); rethrow/exit-code
 *               semantics are left to the coordinator (never process.exit here)
 *
 * Signal/error events are registered on `process` by default; tests inject a
 * `processHost` emitter so synthetic signals never touch the real process.
 *
 * ScreenTakeover (§6.6) is NOT implemented here (WP-04+): the contract types
 * are pinned below, and this module already maintains everything they need —
 * `currentModeSnapshot()` (mode restore), `generation()`/`setGeneration()`
 * (generation++ on restore) and the writer's quiesce/resume barrier.
 *
 * Dependency rule (§4.3): node + import type model/renderer contracts only.
 */
import type { Clock, SerializableValue } from '../model/schema.js'
import type { TerminalModeSnapshot } from '../renderer/frame.js'
import * as ansi from './ansi.js'
import type { InputStdin, TerminalInputSource } from './input.js'
import type { Capability, TerminalProfile } from './profile.js'
import type {
  TerminalControlOperation,
  TerminalLifecycleOperation,
  TerminalLifecycleState,
  TerminalWriter,
  WriteResult,
  WriterBarrier,
} from './writer.js'

export type { TerminalLifecycleState } from './writer.js'

// ---------------------------------------------------------------------------
// fixed deadlines (plan §5.7)
// ---------------------------------------------------------------------------

/** Per-writer-operation wait budget during lifecycle start/stop. */
export const LIFECYCLE_OP_TIMEOUT_MS = 500
/** Total cleanup budget for stop() (§5.7 coordinator cleanup deadline). */
export const LIFECYCLE_CLEANUP_DEADLINE_MS = 2000
/** Idle window for the teardown stdin drain. */
export const LIFECYCLE_DRAIN_IDLE_MS = 50

/** Fixed trace owner label for diagnostics emitted by this module. */
export const LIFECYCLE_OWNER = 'terminal-lifecycle'

// ---------------------------------------------------------------------------
// ScreenTakeover contract (§6.6) — pinned here, implemented in WP-04+.
// ---------------------------------------------------------------------------

export interface TakeoverToken {
  readonly id: string
  readonly ownerKind: 'scene' | 'external-editor' | 'update' | 'shutdown'
  readonly generation: number
  readonly __opaqueTakeoverToken: unique symbol
}
export interface TakeoverLease {
  readonly token: TakeoverToken
  readonly generation: number
  readonly modeBeforeTakeover: TerminalModeSnapshot
  readonly barrier: WriterBarrier
}
export interface ScreenTakeover {
  request(ownerKind: TakeoverToken['ownerKind'], reason: string): Promise<TakeoverLease>
  restore(token: TakeoverToken, options?: { reason?: 'completed' | 'cancelled' | 'error' | 'teardown' }): Promise<void>
  current(): { token: TakeoverToken; generation: number } | null
}

// ---------------------------------------------------------------------------
// options / results
// ---------------------------------------------------------------------------

export type LifecycleStopReason =
  | 'user-exit'
  | 'sigint'
  | 'sigterm'
  | 'sighup'
  | 'stdin-close'
  | 'stdin-error'
  | 'error'
  | 'teardown'

export interface LifecycleDiagnostic {
  readonly code: string
  readonly message: string
  readonly owner: typeof LIFECYCLE_OWNER
  readonly generation: number
  readonly details?: SerializableValue
}

export interface LifecycleStartOptions {
  /** Default true. Requires profile.supportsAlternateScreen === 'yes'. */
  readonly alternateScreen?: boolean
  readonly bracketedPaste?: boolean
  readonly mouse?: boolean
  readonly focusReporting?: boolean
  readonly kittyKeyboard?: boolean
  readonly syncOutput?: boolean
  readonly hideCursor?: boolean
}

export type LifecycleStartResult =
  | { status: 'active' }
  | { status: 'error'; error: { code: string; message: string; recoverable: boolean; details?: SerializableValue } }

export interface TerminalLifecycleOptions {
  readonly writer: TerminalWriter & { lifecycleState(): TerminalLifecycleState }
  readonly input: TerminalInputSource
  readonly profile: TerminalProfile
  readonly clock: Clock
  readonly stdin: InputStdin
  /** Resize dimensions source (process.stdout in production). */
  readonly stdout: { readonly columns?: number | undefined; readonly rows?: number | undefined }
  /**
   * Signal host for attachProcessHandlers (default: the real `process`).
   * Tests inject an EventEmitter so synthetic signals never touch the real
   * process.
   */
  readonly processHost?: ProcessSignalHost
  readonly generation?: number
  readonly onDiagnostic?: (diagnostic: LifecycleDiagnostic) => void
  readonly onRequestStop?: (reason: LifecycleStopReason) => void
  /** SIGCONT: a full redraw is required after revival. */
  readonly onResume?: () => void
  readonly onProcessError?: (error: unknown, origin: 'uncaughtException' | 'unhandledRejection') => void
}

export interface TerminalLifecycle {
  /** Take the terminal over (idempotent: repeated calls share one promise). */
  start(options?: LifecycleStartOptions): Promise<LifecycleStartResult>
  /** Idempotent cleanup barrier; repeated calls return the same promise. */
  stop(reason?: LifecycleStopReason, options?: { preserveScreen?: boolean }): Promise<void>
  /** Runtime mouse toggle through the same writer queue (updates snapshot). */
  setMouseEnabled(enabled: boolean): Promise<WriteResult>
  attachProcessHandlers(): void
  detachProcessHandlers(): void
  lifecycleState(): TerminalLifecycleState
  generation(): number
  /** Takeover/resize generation bump (WP-04 hook); propagates to input. */
  setGeneration(generation: number): void
  /** True after a repeated stop signal (second SIGINT/SIGTERM/SIGHUP). */
  forceStopRequested(): boolean
  /** Modes this instance has issued — the takeover restore baseline. */
  currentModeSnapshot(): TerminalModeSnapshot
}

// ---------------------------------------------------------------------------
// implementation
// ---------------------------------------------------------------------------

/** Internal tracking of the modes this instance enabled (snapshot source). */
interface ModeTracking {
  rawInput: boolean
  alternateScreen: boolean
  bracketedPaste: boolean
  mouse: boolean
  focusReporting: boolean
  kittyKeyboard: boolean
  syncOutput: boolean
  cursorHidden: boolean
}

interface CleanupStep {
  readonly name: string
  readonly operation: TerminalControlOperation
  readonly apply: () => void
}

/** Minimal signal-host surface (`process` in production, EventEmitter in tests). */
export interface ProcessSignalHost {
  on(event: string, listener: (...args: never[]) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
}

type LifecycleAction = Extract<TerminalLifecycleOperation, { kind: 'lifecycle' }>['action']

function lifecycleOp(action: LifecycleAction, enabled: boolean): TerminalControlOperation {
  return { kind: 'lifecycle', operation: { kind: 'lifecycle', action, enabled } }
}

class TerminalLifecycleImpl implements TerminalLifecycle {
  private readonly writer: TerminalLifecycleOptions['writer']
  private readonly input: TerminalInputSource
  private readonly profile: TerminalProfile
  private readonly clock: Clock
  private readonly stdin: InputStdin
  private readonly stdout: TerminalLifecycleOptions['stdout']
  private readonly processHost: ProcessSignalHost
  private readonly onDiagnostic: TerminalLifecycleOptions['onDiagnostic']
  private readonly onRequestStop: TerminalLifecycleOptions['onRequestStop']
  private readonly onResume: TerminalLifecycleOptions['onResume']
  private readonly onProcessError: TerminalLifecycleOptions['onProcessError']

  private state: TerminalLifecycleState = 'created'
  private currentGeneration: number
  private startPromise: Promise<LifecycleStartResult> | null = null
  private stopPromise: Promise<void> | null = null
  /** True once the terminal has actually been taken over (raw mode set). */
  private tookOver = false
  private readonly mode: ModeTracking = {
    rawInput: false,
    alternateScreen: false,
    bracketedPaste: false,
    mouse: false,
    focusReporting: false,
    kittyKeyboard: false,
    syncOutput: false,
    cursorHidden: false,
  }

  private attached = false
  private readonly registered: Array<{ target: ProcessSignalHost; event: string; listener: (...args: never[]) => void }> = []
  private readonly stopSignalsSeen = new Set<string>()
  private forced = false

  constructor(options: TerminalLifecycleOptions) {
    this.writer = options.writer
    this.input = options.input
    this.profile = options.profile
    this.clock = options.clock
    this.stdin = options.stdin
    this.stdout = options.stdout
    this.processHost = options.processHost ?? (process as unknown as ProcessSignalHost)
    this.onDiagnostic = options.onDiagnostic
    this.onRequestStop = options.onRequestStop
    this.onResume = options.onResume
    this.onProcessError = options.onProcessError
    this.currentGeneration = options.generation ?? 0
  }

  // ------------------------------------------------------------------ start

  start(options: LifecycleStartOptions = {}): Promise<LifecycleStartResult> {
    if (this.startPromise !== null) return this.startPromise
    this.startPromise = this.doStart(options)
    return this.startPromise
  }

  private async doStart(options: LifecycleStartOptions): Promise<LifecycleStartResult> {
    if (this.state !== 'created') {
      return this.startError('start-state', `lifecycle.start() in state '${this.state}'`, false)
    }
    this.state = 'starting'
    const want = {
      alternateScreen: options.alternateScreen ?? true,
      bracketedPaste: options.bracketedPaste ?? true,
      mouse: options.mouse ?? true,
      focusReporting: options.focusReporting ?? true,
      kittyKeyboard: options.kittyKeyboard ?? true,
      syncOutput: options.syncOutput ?? true,
      hideCursor: options.hideCursor ?? true,
    }

    // §5.4: alt screen requires a confirmed capability — refuse BEFORE any
    // takeover byte or raw-mode change (failed-before-takeover).
    if (want.alternateScreen && this.profile.supportsAlternateScreen !== 'yes') {
      this.diagnostic('unsupported-alternate-screen', 'alternate screen refused: capability is not confirmed', {
        capability: this.profile.supportsAlternateScreen,
      })
      this.state = 'failed-before-takeover'
      return this.startError('unsupported-alternate-screen', 'terminal profile does not confirm alternate-screen support', false)
    }

    // win32 DEC 9001: no §5.6 ansi builder exists and the vendored keys.ts
    // does not parse win32 input records — the capability is DECLINED (input
    // stays in xterm VT mode) instead of guessed on (§5.4 unknown ≠ yes).
    if (this.profile.supportsWindowsDec9001 === 'yes') {
      this.diagnostic('capability-declined', 'windows DEC 9001 input mode not enabled: no allowlisted builder/parser', {
        capability: 'windowsDec9001',
      })
    }

    // enter-raw first: termios side via stdin.setRawMode (input owns it); the
    // writer-side op encodes zero bytes by contract but keeps the trace
    // complete and advances the writer's own lifecycle state machine.
    this.input.setRawMode(true)
    this.mode.rawInput = true
    this.tookOver = true

    const steps: CleanupStep[] = [{ name: 'enter-raw', operation: lifecycleOp('enter-raw', true), apply: () => undefined }]
    if (want.alternateScreen) {
      steps.push({ name: 'enter-alt', operation: lifecycleOp('enter-alt', true), apply: () => (this.mode.alternateScreen = true) })
    }
    if (want.bracketedPaste) {
      this.pushCapabilityStep(steps, 'supportsBracketedPaste', {
        name: 'paste',
        operation: lifecycleOp('paste', true),
        apply: () => (this.mode.bracketedPaste = true),
      })
    }
    if (want.mouse) {
      this.pushCapabilityStep(steps, 'supportsMouse', {
        name: 'mouse',
        operation: lifecycleOp('mouse', true),
        apply: () => (this.mode.mouse = true),
      })
    }
    if (want.focusReporting) {
      this.pushCapabilityStep(steps, 'supportsFocusReporting', {
        name: 'focus',
        operation: lifecycleOp('focus', true),
        apply: () => (this.mode.focusReporting = true),
      })
    }
    if (want.kittyKeyboard) {
      // No kitty action exists in the §5.6 lifecycle allowlist; the sequence
      // lane carries it. Purpose 'pi-compatible': this is exactly the vendored
      // ProcessTerminal negotiation sequence (push disambiguate flags = 1).
      this.pushCapabilityStep(steps, 'supportsKittyKeyboard', {
        name: 'kitty-keyboard',
        operation: { kind: 'sequence', sequence: ansi.kittyKeyboardPush(1), purpose: 'pi-compatible' },
        apply: () => {
          this.mode.kittyKeyboard = true
          this.input.setKittyKeyboardActive(true)
        },
      })
    }
    if (want.syncOutput) {
      this.pushCapabilityStep(steps, 'supportsSyncOutput', {
        name: 'sync-output',
        operation: lifecycleOp('sync-output', true),
        apply: () => (this.mode.syncOutput = true),
      })
    }
    if (want.hideCursor) {
      // Basic CSI (DECSET 25): always sent, not capability-gated.
      steps.push({ name: 'cursor', operation: lifecycleOp('cursor', false), apply: () => (this.mode.cursorHidden = true) })
    }

    const applied: CleanupStep[] = []
    for (const step of steps) {
      const outcome = await this.withDeadline(step.name, this.writer.writeControl(step.operation, this.currentGeneration), LIFECYCLE_OP_TIMEOUT_MS)
      if (outcome.timedOut || outcome.result === null || outcome.result.status === 'error') {
        const code = outcome.timedOut ? 'start-op-timeout' : outcome.result?.status === 'error' ? outcome.result.error.code : 'start-op-failed'
        const message = outcome.timedOut
          ? `startup operation '${step.name}' exceeded ${LIFECYCLE_OP_TIMEOUT_MS} ms`
          : `startup operation '${step.name}' failed: ${outcome.result?.status === 'error' ? outcome.result.error.message : 'no result'}`
        this.diagnostic('start-failed', message, { operation: step.name, code })
        // Cleanup everything applied so far (reverse), best-effort (§5.7).
        await this.runCleanupSequence(false)
        this.restoreRawMode()
        this.state = 'failed-after-takeover'
        return this.startError('failed-after-takeover', message, false, { operation: step.name, code })
      }
      step.apply()
      applied.push(step)
    }

    // Only now start the stdin tokenizer (modes are in place; query responses
    // and paste markers arriving from here on are parsed with full context).
    this.input.start()
    this.state = 'active'
    this.diagnostic('active', 'terminal takeover complete', { profileId: this.profile.id })
    return { status: 'active' }
  }

  private pushCapabilityStep(steps: CleanupStep[], capability: 'supportsBracketedPaste' | 'supportsMouse' | 'supportsFocusReporting' | 'supportsKittyKeyboard' | 'supportsSyncOutput', step: CleanupStep): void {
    const value: Capability = this.profile[capability]
    if (value !== 'yes') {
      // 'unknown' is never treated as supported (§5.4): skip + record.
      this.diagnostic('capability-skipped', `capability ${capability} is '${value}': sequence not emitted`, { capability, value })
      return
    }
    steps.push(step)
  }

  private startError(code: string, message: string, recoverable: boolean, details?: SerializableValue): LifecycleStartResult {
    return { status: 'error', error: { code, message, recoverable, details } }
  }

  // ------------------------------------------------------------------- stop

  stop(reason: LifecycleStopReason = 'user-exit', options: { preserveScreen?: boolean } = {}): Promise<void> {
    // Idempotent under repeated signals/teardown: one shared promise (§5.7).
    if (this.stopPromise !== null) return this.stopPromise
    this.stopPromise = this.doStop(reason, options)
    return this.stopPromise
  }

  private async doStop(reason: LifecycleStopReason, options: { preserveScreen?: boolean }): Promise<void> {
    // NOTE: process handlers stay attached during cleanup so a repeated stop
    // signal still reaches the force-flag path (and never re-emits sequences);
    // they are detached at the end of the barrier (§5.7 listener removal).
    const deadlineAt = this.clock.now() + LIFECYCLE_CLEANUP_DEADLINE_MS
    const preserveScreen = options.preserveScreen === true
    // WP-07: a main-screen (inline) session parked the cursor below the frame
    // (the coordinator's exit-park patch); the writer's cleanup bundle must
    // not home it afterwards. preserveScreen keeps the visible screen too.
    const preserveCursor = preserveScreen || !this.mode.alternateScreen
    if (this.state !== 'failed-before-takeover' && this.state !== 'failed-after-takeover') {
      this.state = 'stopping'
    }

    // No new input events while cleaning up; listeners removed here.
    this.input.stop()

    let deadlineHit = false
    if (this.tookOver) {
      deadlineHit = await this.runCleanupSequence(preserveScreen, deadlineAt)
    }

    // Wait for the writer queue to settle, then run the writer's own stop
    // barrier (in-flight settle + best-effort cleanup bundle, §5.7).
    const remaining = () => deadlineAt - this.clock.now()
    if (remaining() > 0) {
      const flushed = await this.withDeadline('flush', this.writer.flush(), remaining())
      if (flushed.timedOut) {
        deadlineHit = true
        this.diagnostic('cleanup-deadline', 'writer.flush() did not settle within the cleanup budget', { deadlineMs: LIFECYCLE_CLEANUP_DEADLINE_MS })
      }
    } else {
      deadlineHit = true
      this.diagnostic('cleanup-deadline', 'cleanup budget exhausted before writer flush', { deadlineMs: LIFECYCLE_CLEANUP_DEADLINE_MS })
    }
    await this.writer.stop({ preserveScreen, preserveCursor })

    // termios restore, then drain stdin silence (kitty release events etc.).
    this.restoreRawMode()
    const drainBudget = remaining() > 0 ? remaining() : 0
    await this.input.drainInput(drainBudget, LIFECYCLE_DRAIN_IDLE_MS)

    // §5.7 barrier tail: signal listener removal.
    this.detachProcessHandlers()

    const failed = this.state === 'failed-before-takeover' || this.state === 'failed-after-takeover'
    const writerState = this.writer.lifecycleState()
    const writerFailed = writerState === 'failed-before-takeover' || writerState === 'failed-after-takeover'
    if (!failed) {
      // A failed writer leaves the physical mode state uncertain: surface that
      // through the lifecycle state rather than claiming a clean stop.
      this.state = writerFailed || deadlineHit ? 'failed-after-takeover' : 'stopped'
    }
    this.diagnostic('stopped', `terminal lifecycle stop barrier completed (${reason})`, {
      reason,
      deadlineHit,
      writerState,
      forced: this.forced,
    })
  }

  /** Reverse-order exit sequences for the modes this instance enabled. */
  private async runCleanupSequence(preserveScreen: boolean, deadlineAt?: number): Promise<boolean> {
    const deadline = deadlineAt ?? this.clock.now() + LIFECYCLE_CLEANUP_DEADLINE_MS
    let deadlineHit = false
    const steps: CleanupStep[] = []
    if (this.mode.syncOutput) {
      steps.push({ name: 'sync-output-end', operation: lifecycleOp('sync-output', false), apply: () => (this.mode.syncOutput = false) })
    }
    if (this.mode.kittyKeyboard) {
      // Pop beyond our own push depth is harmless (protocol/VT oracle) and
      // covers entries a backend may have pushed on top (same convention as
      // the writer's cleanup bundle). Purpose 'cleanup': this is one.
      steps.push({
        name: 'kitty-keyboard-pop',
        operation: { kind: 'sequence', sequence: ansi.kittyKeyboardPop(99), purpose: 'cleanup' },
        apply: () => {
          this.mode.kittyKeyboard = false
          this.input.setKittyKeyboardActive(false)
        },
      })
    }
    if (this.mode.mouse) {
      steps.push({ name: 'mouse-off', operation: lifecycleOp('mouse', false), apply: () => (this.mode.mouse = false) })
    }
    if (this.mode.bracketedPaste) {
      steps.push({ name: 'paste-off', operation: lifecycleOp('paste', false), apply: () => (this.mode.bracketedPaste = false) })
    }
    if (this.mode.focusReporting) {
      steps.push({ name: 'focus-off', operation: lifecycleOp('focus', false), apply: () => (this.mode.focusReporting = false) })
    }
    if (this.mode.cursorHidden) {
      steps.push({ name: 'cursor-show', operation: lifecycleOp('cursor', true), apply: () => (this.mode.cursorHidden = false) })
    }
    if (this.mode.alternateScreen && !preserveScreen) {
      steps.push({ name: 'exit-alt', operation: lifecycleOp('exit-alt', true), apply: () => (this.mode.alternateScreen = false) })
    }

    for (const step of steps) {
      const remaining = deadline - this.clock.now()
      if (remaining <= 0) {
        deadlineHit = true
        this.diagnostic('cleanup-deadline', 'cleanup budget exhausted; remaining exit sequences skipped (best-effort)', {
          operation: step.name,
          deadlineMs: LIFECYCLE_CLEANUP_DEADLINE_MS,
        })
        break
      }
      const budget = Math.min(LIFECYCLE_OP_TIMEOUT_MS, remaining)
      const outcome = await this.withDeadline(step.name, this.writer.writeControl(step.operation, this.currentGeneration), budget)
      if (outcome.timedOut) {
        deadlineHit = true
        this.diagnostic('cleanup-op-timeout', `exit sequence '${step.name}' did not settle within ${budget} ms`, { operation: step.name, budgetMs: budget })
        continue
      }
      if (outcome.result !== null && outcome.result.status === 'error') {
        this.diagnostic('cleanup-op-failed', `exit sequence '${step.name}' failed: ${outcome.result.error.message}`, {
          operation: step.name,
          code: outcome.result.error.code,
        })
        continue
      }
      // Snapshot truthfulness: only settled ops update the tracked mode.
      if (outcome.result !== null && outcome.result.status === 'written') step.apply()
    }
    return deadlineHit
  }

  private restoreRawMode(): void {
    if (!this.mode.rawInput) return
    this.input.setRawMode(false)
    this.mode.rawInput = false
  }

  // -------------------------------------------------------------- mouse toggle

  async setMouseEnabled(enabled: boolean): Promise<WriteResult> {
    if (enabled && this.profile.supportsMouse !== 'yes') {
      this.diagnostic('capability-refused', `mouse enable refused: supportsMouse is '${this.profile.supportsMouse}'`, {
        capability: 'supportsMouse',
        value: this.profile.supportsMouse,
      })
      return {
        status: 'error',
        error: { code: 'capability-refused', message: 'mouse support is not confirmed by the profile', generation: this.currentGeneration, recoverable: true },
      }
    }
    const result = await this.withDeadline('mouse', this.writer.writeControl(lifecycleOp('mouse', enabled), this.currentGeneration), LIFECYCLE_OP_TIMEOUT_MS)
    if (result.timedOut) {
      return { status: 'error', error: { code: 'op-timeout', message: 'mouse toggle timed out', generation: this.currentGeneration, recoverable: true } }
    }
    if (result.result !== null && result.result.status === 'written') this.mode.mouse = enabled
    return result.result ?? { status: 'error', error: { code: 'op-failed', message: 'mouse toggle failed', generation: this.currentGeneration, recoverable: true } }
  }

  // ------------------------------------------------------- process handlers

  attachProcessHandlers(): void {
    if (this.attached) return
    this.attached = true
    const host = this.processHost
    const register = (target: ProcessSignalHost, event: string, listener: (...args: never[]) => void): void => {
      target.on(event, listener)
      this.registered.push({ target, event, listener })
    }
    register(host, 'SIGWINCH', () => this.handleSigwinch())
    register(host, 'SIGCONT', () => this.handleSigcont())
    register(host, 'SIGINT', () => this.handleStopSignal('SIGINT', 'sigint'))
    register(host, 'SIGTERM', () => this.handleStopSignal('SIGTERM', 'sigterm'))
    register(host, 'SIGHUP', () => this.handleStopSignal('SIGHUP', 'sighup'))
    register(this.stdin as unknown as ProcessSignalHost, 'close', () => this.handleStdinClose())
    register(this.stdin as unknown as ProcessSignalHost, 'error', (error: unknown) => this.handleStdinError(error))
    register(host, 'uncaughtException', (error: unknown) => this.handleProcessError(error, 'uncaughtException'))
    register(host, 'unhandledRejection', (reason: unknown) => this.handleProcessError(reason, 'unhandledRejection'))
  }

  detachProcessHandlers(): void {
    if (!this.attached) return
    this.attached = false
    const registered = this.registered.splice(0)
    for (const { target, event, listener } of registered) target.removeListener(event, listener)
  }

  private handleSigwinch(): void {
    // Re-read live dimensions; fall back to the profile (§5.4: resize does
    // not re-probe capabilities — the profile object itself is untouched).
    const columns = this.stdout.columns ?? this.profile.columns
    const rows = this.stdout.rows ?? this.profile.rows
    this.diagnostic('signal', 'SIGWINCH received', { signal: 'SIGWINCH', columns, rows })
    this.input.emitResize(columns, rows)
  }

  private handleSigcont(): void {
    // Revival after job-control stop: a full redraw is required. The
    // coordinator owns the redraw; we only mark the need.
    this.diagnostic('signal', 'SIGCONT received: full redraw required', { signal: 'SIGCONT' })
    this.onResume?.()
  }

  private handleStopSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', reason: LifecycleStopReason): void {
    if (this.stopSignalsSeen.has(signal)) {
      // Repeated signal: never re-emit cleanup sequences (§6.6) — the shared
      // stop promise is already running; just mark the force flag.
      this.forced = true
      this.diagnostic('signal-repeat', `${signal} repeated: force flag set, no new sequences`, { signal, forced: true })
      return
    }
    this.stopSignalsSeen.add(signal)
    this.diagnostic('signal', `${signal} received: stop requested`, { signal })
    // Signal becomes an input event (§6.6) in the owner's sequence space…
    this.input.emitSignal(signal)
    // …and the coordinator is asked to stop (never process.exit here).
    this.onRequestStop?.(reason)
  }

  private handleStdinClose(): void {
    this.diagnostic('stdin-close', 'stdin closed: stop requested', {})
    this.onRequestStop?.('stdin-close')
  }

  private handleStdinError(error: unknown): void {
    this.diagnostic('stdin-error', `stdin error: ${error instanceof Error ? error.message : String(error)}`, {})
    this.onRequestStop?.('stdin-error')
  }

  private handleProcessError(error: unknown, origin: 'uncaughtException' | 'unhandledRejection'): void {
    this.diagnostic('process-error', `${origin}: best-effort cleanup started`, {
      origin,
      message: error instanceof Error ? error.message : String(error),
    })
    this.onProcessError?.(error, origin)
    // Cleanup from our side; rethrow/exit-code semantics belong to the
    // coordinator (§6.6) — this module never calls process.exit.
    void this.stop('error')
  }

  // ------------------------------------------------------------------ trace

  lifecycleState(): TerminalLifecycleState {
    return this.state
  }

  generation(): number {
    return this.currentGeneration
  }

  setGeneration(generation: number): void {
    if (!Number.isInteger(generation) || generation <= this.currentGeneration) {
      throw new RangeError(`lifecycle generation must strictly increase (current ${this.currentGeneration}, got ${generation})`)
    }
    this.currentGeneration = generation
    this.input.setGeneration(generation)
  }

  forceStopRequested(): boolean {
    return this.forced
  }

  currentModeSnapshot(): TerminalModeSnapshot {
    return {
      alternateScreen: this.mode.alternateScreen,
      rawInput: this.mode.rawInput,
      // The lifecycle mouse op enables 1002 tracking + 1006 encoding; the
      // VT oracle normalizes that combination to the flat enum value below.
      mouse: this.mode.mouse ? 'sgr-1006' : 'off',
      bracketedPaste: this.mode.bracketedPaste,
      syncOutput: this.mode.syncOutput,
      autowrap: true,
      wrapPending: false,
      scrollRegion: { top: 0, bottom: Math.max(0, this.profile.rows - 1) },
      cursorStyle: 'block',
      cursorVisible: !this.mode.cursorHidden,
      kittyKeyboard: this.mode.kittyKeyboard,
      // Never enabled by the lifecycle: no §5.6 builder (parsing of
      // modifyOtherKeys input still works when the terminal sends it).
      modifyOtherKeys: false,
      focusReporting: this.mode.focusReporting,
      // Declined (see doStart): no builder, no win32 record parser.
      windowsDec9001: false,
      osc133: false,
      title: null,
      progress: { state: 'none' },
    }
  }

  // ------------------------------------------------------------------ helpers

  private diagnostic(code: string, message: string, details?: SerializableValue): void {
    this.onDiagnostic?.({ code, message, owner: LIFECYCLE_OWNER, generation: this.currentGeneration, details })
  }

  /**
   * Race a writer operation against the injected clock. Never rejects:
   * a rejection (should not happen for writer promises) is folded into a
   * null result so cleanup stays best-effort.
   */
  private withDeadline<T>(name: string, promise: Promise<T>, ms: number): Promise<{ timedOut: boolean; result: T | null }> {
    if (ms <= 0) {
      promise.then(undefined, () => undefined)
      return Promise.resolve({ timedOut: true, result: null })
    }
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => resolve({ timedOut: true, result: null }), ms)
      promise.then(
        (result) => {
          this.clock.clearTimeout(timer)
          resolve({ timedOut: false, result })
        },
        () => {
          this.clock.clearTimeout(timer)
          resolve({ timedOut: false, result: null })
        },
      )
    })
  }
}

export function createTerminalLifecycle(options: TerminalLifecycleOptions): TerminalLifecycle {
  return new TerminalLifecycleImpl(options)
}
