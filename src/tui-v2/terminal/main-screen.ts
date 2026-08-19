/**
 * tui-v2 pi main-screen backend (WP-03c, plan §5.5/§5.6).
 *
 * ScreenBackend ('inline') on top of the vendored `TuiMainScreen`, driven
 * through the shared PiTerminalAdapter stack. The vendored TUI owns the
 * interactive line diffing/rendering exactly as upstream; this backend adds
 * the v2 lifecycle/generation wiring and the Frame → TerminalPatch planner
 * (screen-plan.ts) the v2 kernel uses for state-driven frames.
 *
 * Lifecycle wiring:
 * - start(generation): generation must be a non-negative integer and not go
 *   backwards while running; a newer generation is propagated to the
 *   lifecycle/input layer. The first start runs `tui.start()` (which calls
 *   `adapter.start(...)` and kicks the terminal takeover) and then awaits
 *   the adapter's `whenStarted()` barrier so a failed takeover rejects
 *   start() instead of rendering into a half-owned terminal.
 * - stop(generation): a stale generation is ignored (an older backend must
 *   never tear down a newer session); otherwise `tui.stop()` runs the pi
 *   teardown and `adapter.awaitStop()` awaits the §5.7 barrier (writer stop,
 *   cleanup flush, stdin drain, signal listener removal).
 */

import type { Frame, ScreenBackend, ScreenBackendCapabilities, TerminalPatch } from '../renderer/frame.js'
import { TuiMainScreen } from './pi.js'
import type { PiTerminalStack } from './pi-adapter.js'
import { planScreenPatch } from './screen-plan.js'

function requireGeneration(name: string, generation: number): number {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${generation}`)
  }
  return generation
}

export class PiTuiMainScreenBackend implements ScreenBackend {
  readonly mode = 'inline' as const
  readonly capabilities: ScreenBackendCapabilities = {
    supportsViewportLayout: false,
    supportsNestedOverlay: false,
    supportsScrollRegion: false,
    supportsInlineLiveRegion: true,
  }

  /** The vendored TUI instance (integration tests drive it directly). */
  readonly tui: TuiMainScreen

  private readonly stack: PiTerminalStack
  private started = false
  private activeGeneration: number | null = null
  private patchSeq = 0

  constructor(stack: PiTerminalStack) {
    this.stack = stack
    this.tui = new TuiMainScreen(stack.adapter)
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
    await this.stack.adapter.awaitStop()
  }
}
