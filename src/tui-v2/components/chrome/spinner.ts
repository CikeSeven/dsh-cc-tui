/**
 * tui-v2 spinner component (WP-04b).
 *
 * Frame glyphs mirror the legacy `Spinner/spinnerUtils.ts` fallback set
 * (`·✢*✶✻✽` + reverse). Frame advancement goes through the injected
 * `Clock` (`model/schema.ts`) — the component never creates real timers, so
 * tests drive animation with a fake clock and the scheduler owns repaint
 * cadence.
 */
import type { Clock } from '../../model/schema.js'
import type { Component } from '../../renderer/component.js'
import { assertLineWidth, styleText, type LineStyle, DEFAULT_LINE_STYLE } from '../../renderer/lines.js'
import type { TerminalProfile } from '../../terminal/profile.js'

/** Legacy fallback frame set + reverse (SpinnerGlyph's SPINNER_FRAMES). */
export const DEFAULT_SPINNER_FRAMES: readonly string[] = Object.freeze([
  '·', '✢', '*', '✶', '✻', '✽', '✻', '✶', '*', '✢',
])

export const SPINNER_DEFAULT_INTERVAL_MS = 80

export interface SpinnerOptions {
  readonly profile: TerminalProfile
  readonly clock: Clock
  readonly frames?: readonly string[]
  readonly intervalMs?: number
  readonly style?: LineStyle
  /** Called after each frame advance (the scheduler re-renders). */
  readonly onFrame?: (frameIndex: number) => void
}

export interface Spinner extends Component {
  start(): void
  stop(): void
  readonly running: boolean
  readonly frameIndex: number
}

export function createSpinner(options: SpinnerOptions): Spinner {
  const frames = options.frames ?? DEFAULT_SPINNER_FRAMES
  const intervalMs = Math.max(1, options.intervalMs ?? SPINNER_DEFAULT_INTERVAL_MS)
  const style = options.style ?? DEFAULT_LINE_STYLE
  const clock = options.clock
  let frameIndex = 0
  let running = false
  let timer: unknown = null

  const tick = (): void => {
    if (!running) return
    frameIndex = (frameIndex + 1) % frames.length
    options.onFrame?.(frameIndex)
    timer = clock.setTimeout(tick, intervalMs)
  }

  const spinner: Spinner = {
    get running() {
      return running
    },
    get frameIndex() {
      return frameIndex
    },
    start() {
      if (running) return
      running = true
      timer = clock.setTimeout(tick, intervalMs)
    },
    stop() {
      if (!running) return
      running = false
      if (timer !== null) {
        clock.clearTimeout(timer)
        timer = null
      }
    },
    render(width: number): string[] {
      if (width <= 0) return []
      const frame = frames[frameIndex % frames.length] as string
      return [assertLineWidth(styleText(frame, style), options.profile, width)]
    },
    invalidate() {},
  }
  return spinner
}
