/**
 * tui-v2 status line component (WP-04b).
 *
 * Reduced form of the legacy `src/screens/StatusLine.tsx` footer row: left
 * group `model · mode · ⬆in ⬇out · extras…`, right group `branch · cwd`
 * right-aligned when there is room, otherwise a single truncated line.
 * The WP-08e1 context bar is injected as a separate dock component; this
 * one-row footer contract (never exceeds width, fields degrade left-to-right)
 * remains preserved.
 */
import type { StatusLineView } from '../../model/selectors.js'
import type { Component } from '../../renderer/component.js'
import {
  cellsToString,
  cellsWidth,
  lineToCells,
  padCells,
  sanitizeText,
  truncateCells,
  type LineCell,
  type LineStyle,
} from '../../renderer/lines.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'

/** Apply a style to every cell (local copy of the transcript helper). */
function withStyleIf(cells: readonly LineCell[], style: LineStyle): LineCell[] {
  return cells.map((cell) => ({ ...cell, style }))
}

/** `1234` -> `1.2k`, `2500000` -> `2.5M` (cc/format.ts formatTokens reduced). */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.floor(n)))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

export function createStatusLine(
  view: StatusLineView,
  options: { profile: TerminalProfile; theme: ComponentTheme },
): Component {
  const { profile, theme } = options
  const subtle = theme.roles.subtle
  const accent: LineStyle = theme.roles.accent
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const leftParts: string[] = []
      if (view.model !== null && view.model !== '') leftParts.push(view.model)
      if (view.mode !== null && view.mode !== '') leftParts.push(view.mode)
      if (view.tokens !== null) {
        leftParts.push(`⬆${formatTokenCount(view.tokens.input)} ⬇${formatTokenCount(view.tokens.output)}`)
      }
      for (const [key, value] of Object.entries(view.extras)) {
        if (value === null) continue
        leftParts.push(`${key} ${String(value)}`)
      }
      const rightParts: string[] = []
      if (view.branch !== null && view.branch !== '') rightParts.push(view.branch)
      if (view.cwd !== null && view.cwd !== '') rightParts.push(basename(view.cwd))

      const leftCells = withStyleIf(
        lineToCells(sanitizeText(leftParts.join(' · ')), profile),
        subtle,
      )
      const rightCells = withStyleIf(
        lineToCells(sanitizeText(rightParts.join(' · ')), profile),
        accent,
      )
      let cells: LineCell[]
      const gap = 2
      if (rightCells.length > 0 && cellsWidth(leftCells) + gap + cellsWidth(rightCells) <= width) {
        const spaces = width - cellsWidth(leftCells) - cellsWidth(rightCells)
        cells = [...leftCells, ...padCells([], spaces), ...rightCells]
      } else {
        const joined = rightCells.length > 0 ? [...leftCells, ...lineToCells(' · ', profile), ...rightCells] : leftCells
        cells = truncateCells(joined, width)
      }
      return [cellsToString(cells)]
    },
    invalidate() {},
  }
}
