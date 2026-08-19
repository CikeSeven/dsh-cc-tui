/**
 * tui-v2 pi alt-screen backend (WP-03c, plan §5.5/§5.6).
 *
 * ScreenBackend ('fullscreen') on top of the vendored `TuiAltScreen`,
 * driven through the shared PiTerminalAdapter stack. The vendored TUI owns
 * the alternate-screen enter/exit bytes (via the typed piOutput builders),
 * the scrollable viewport, nested overlays, mouse/selection and the
 * main-screen restore-on-exit — exactly as upstream. This backend adds the
 * v2 lifecycle/generation wiring and the Frame → TerminalPatch planner
 * (screen-plan.ts).
 *
 * The backend shares the adapter/lifecycle with the main-screen backend:
 * entering the alt screen is a generation bump on the SAME terminal
 * session. The vendored TUI therefore gets a SCOPED pi `Terminal` facade:
 * every method delegates to the shared adapter except `stop()`/`awaitStop()`,
 * which are no-ops here — the alt screen's own afterTerminalStop bytes (DEC
 * 1049 exit + primary-screen redraw) are the scope teardown, and the §5.7
 * session barrier belongs to whoever ends the session (the main backend).
 * While the alt screen is open its input callbacks own the adapter; the
 * `onScopeStop` hook lets the session owner re-point input at the main TUI
 * after close (WP-04 wiring).
 */

import type { Frame, ScreenBackend, ScreenBackendCapabilities, TerminalPatch } from '../renderer/frame.js'
import { TuiAltScreen, type TuiAltScreenOptions } from './pi.js'
import type { PiTerminalAdapter, PiTerminalStack } from './pi-adapter.js'
import { planScreenPatch } from './screen-plan.js'

function requireGeneration(name: string, generation: number): number {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${generation}`)
  }
  return generation
}

/**
 * pi `Terminal` facade that delegates everything to the shared adapter
 * except session teardown: `stop()`/`awaitStop()` are scoped no-ops.
 */
class AltScreenTerminalScope implements PiTerminalAdapter {
  private readonly inner: PiTerminalAdapter

  constructor(inner: PiTerminalAdapter) {
    this.inner = inner
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start(onInput, onResize)
  }

  stop(): void {
    // Scoped no-op by design (see the file header).
  }

  awaitStop(): Promise<void> {
    return Promise.resolve()
  }

  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.inner.drainInput(maxMs, idleMs)
  }

  write(data: string): void {
    this.inner.write(data)
  }

  get columns(): number {
    return this.inner.columns
  }

  get rows(): number {
    return this.inner.rows
  }

  get kittyProtocolActive(): boolean {
    return this.inner.kittyProtocolActive
  }

  moveBy(lines: number): void {
    this.inner.moveBy(lines)
  }

  hideCursor(): void {
    this.inner.hideCursor()
  }

  showCursor(): void {
    this.inner.showCursor()
  }

  clearLine(): void {
    this.inner.clearLine()
  }

  clearFromCursor(): void {
    this.inner.clearFromCursor()
  }

  clearScreen(): void {
    this.inner.clearScreen()
  }

  setTitle(title: string): void {
    this.inner.setTitle(title)
  }

  setProgress(active: boolean): void {
    this.inner.setProgress(active)
  }
}

export interface PiTuiAltScreenBackendOptions {
  /** Passed through to the vendored TuiAltScreen (mouse, selection, …). */
  readonly tuiOptions?: TuiAltScreenOptions
  readonly showHardwareCursor?: boolean
  /** Invoked after the alt scope closed (input re-pointing hook, WP-04). */
  readonly onScopeStop?: () => void
}

export class PiTuiAltScreenBackend implements ScreenBackend {
  readonly mode = 'fullscreen' as const
  readonly capabilities: ScreenBackendCapabilities = {
    supportsViewportLayout: true,
    supportsNestedOverlay: true,
    supportsScrollRegion: true,
    supportsInlineLiveRegion: false,
  }

  /** The vendored TUI instance (integration tests drive it directly). */
  readonly tui: TuiAltScreen

  private readonly stack: PiTerminalStack
  private readonly onScopeStop: (() => void) | undefined
  private started = false
  private activeGeneration: number | null = null
  private patchSeq = 0

  constructor(stack: PiTerminalStack, options: PiTuiAltScreenBackendOptions = {}) {
    this.stack = stack
    this.onScopeStop = options.onScopeStop
    this.tui = new TuiAltScreen(new AltScreenTerminalScope(stack.adapter), options.showHardwareCursor, undefined, options.tuiOptions ?? {})
  }

  async start(generation: number): Promise<void> {
    requireGeneration('start generation', generation)
    if (this.activeGeneration !== null && generation < this.activeGeneration) {
      throw new RangeError(`start generation ${generation} goes backwards (active: ${this.activeGeneration})`)
    }
    const lifecycleGeneration = this.stack.lifecycle.generation()
    if (generation < lifecycleGeneration) {
      throw new RangeError(`start generation ${generation} is older than the lifecycle generation ${lifecycleGeneration}`)
    }
    this.activeGeneration = generation
    if (generation > lifecycleGeneration) {
      this.stack.lifecycle.setGeneration(generation)
    }
    if (this.started) return
    this.patchSeq = 0
    this.tui.start()
    this.started = true
    // The adapter/lifecycle takeover is shared with the main-screen backend;
    // when it already ran, whenStarted() resolves immediately.
    const result = await this.stack.adapter.whenStarted()
    if (result.status !== 'active') {
      throw new Error(`terminal lifecycle start failed: ${result.error.code}: ${result.error.message}`)
    }
  }

  plan(previous: Frame | null, next: Frame): TerminalPatch {
    if (this.activeGeneration !== null && next.generation < this.activeGeneration) {
      throw new RangeError(`frame generation ${next.generation} is older than the active generation ${this.activeGeneration}`)
    }
    return planScreenPatch(previous, next, this.patchSeq++)
  }

  async stop(generation: number): Promise<void> {
    requireGeneration('stop generation', generation)
    if (this.activeGeneration !== null && generation < this.activeGeneration) return // stale: ignore
    if (!this.started) return
    this.tui.stop()
    this.started = false
    this.onScopeStop?.()
  }
}
