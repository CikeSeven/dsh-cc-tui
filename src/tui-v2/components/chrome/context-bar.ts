/** WP-08e1 segmented context bar. */
import type { Component } from '../../renderer/component.js'
import { cellsToString, lineStyle, styledCells, truncateCells } from '../../renderer/lines.js'
import type { ContextBarView } from '../../model/surfaces.js'
import type { TerminalProfile } from '../../terminal/profile.js'

export const CONTEXT_BAR_MIN_WIDTH = 14

function pct(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)))
}

export function contextBarText(view: ContextBarView): string {
  const total = view.contextWindow ?? 0
  const segments = view.contextSegments
  const used = view.usage === null ? 0 : view.usage.input + view.usage.cacheRead + view.usage.cacheWrite
  const pieces = [
    `sys ${pct(segments.system, total)}%`,
    `prompt ${pct(segments.prompt, total)}%`,
    `asst ${pct(segments.assistant, total)}%`,
    `think ${pct(segments.thinking, total)}%`,
    `tools ${pct(segments.tools, total)}%`,
  ]
  const usedText = total > 0 ? `ctx ${pct(used, total)}%/${total}` : 'ctx unknown'
  return `${pieces.join(' · ')} · ${usedText}`
}

export function createContextBar(view: ContextBarView, profile: TerminalProfile): Component {
  return {
    render(width) {
      if (width <= 0 || view.contextWindow === null) return []
      const cells = styledCells(contextBarText(view), lineStyle({ foreground: 'bright-black' }), profile)
      return [cellsToString(truncateCells(cells, width))]
    },
    invalidate() {},
  }
}
