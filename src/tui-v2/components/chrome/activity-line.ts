/** WP-08e1 deterministic working-activity line component. */
import type { Component } from '../../renderer/component.js'
import { cellsToString, lineStyle, styledCells, truncateCells } from '../../renderer/lines.js'
import type { ActivityView } from '../../model/surfaces.js'
import type { TerminalProfile } from '../../terminal/profile.js'

export interface ActivityLineOptions {
  readonly suffix?: string
  readonly warnPct?: number
  readonly warnDanger?: boolean
}

export function activityLineText(view: ActivityView, options: ActivityLineOptions = {}): string {
  const frame = view.phase === 'done' || view.phase === 'idle' ? '' : `${view.frame} `
  const warning = options.warnPct !== undefined && options.warnPct >= 80
    ? `⚠ ctx ${Math.max(0, Math.min(100, Math.round(options.warnPct)))}% · `
    : ''
  const stalled = view.phase === 'stalled' ? 'stalled: ' : ''
  return `${frame}${warning}${stalled}${view.line}${options.suffix ?? ''}`
}

/** No timer is created here. A controller advances `view.frameIndex/frame`. */
export function createActivityLine(view: ActivityView | null, profile: TerminalProfile, options: ActivityLineOptions = {}): Component | null {
  if (view === null || view.phase === 'idle' || view.line === '') return null
  return {
    render(width) {
      if (width <= 0) return []
      const foreground = view.phase === 'stalled' ? 'yellow' : view.phase === 'done' ? 'cyan' : null
      const cells = styledCells(activityLineText(view, options), lineStyle({ foreground }), profile)
      return [cellsToString(truncateCells(cells, width))]
    },
    invalidate() {},
  }
}
