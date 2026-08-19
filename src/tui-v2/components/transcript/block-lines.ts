/**
 * tui-v2 transcript text layout helper (WP-04b).
 *
 * Shared "hanging indent" block layout: first line carries `prefix`
 * (`❯ ` / `● ` / `  ⎿  ` …), continuation lines carry `indent`, text is
 * sanitized, measured and wrapped through the §6.1 pipeline at
 * `width - indentWidth`. Every emitted line is width-guaranteed.
 */
import type { TerminalProfile } from '../../terminal/profile.js'
import {
  assertLineWidth,
  cellsToString,
  cellsWidth,
  lineToCells,
  sanitizeText,
  truncateCells,
  wrapCells,
  type LineCell,
  type LineStyle,
} from '../../renderer/lines.js'

export interface HangingLayoutOptions {
  /** First-line prefix (already trusted text, e.g. '● '). */
  readonly prefix: string
  /** Continuation-line prefix; must be the same column width as `prefix` for alignment. */
  readonly indent: string
  readonly prefixStyle: LineStyle
  readonly textStyle: LineStyle
  readonly profile: TerminalProfile
}

function styledPrefixCells(text: string, style: LineStyle, profile: TerminalProfile): LineCell[] {
  if (text === '') return []
  const cells = lineToCells(sanitizeText(text), profile)
  return cells.map((cell) => ({ ...cell, style }))
}

/** Apply a style to every cell (continuations ride with their owner). */
export function withStyle(cells: readonly LineCell[], style: LineStyle): LineCell[] {
  return cells.map((cell) => ({ ...cell, style }))
}

/**
 * Render pre-segmented cell spans (inline-styled) with hanging indent.
 * Wrap is the pipeline's word-aware `wrapCells`; wrapped continuation lines
 * get the indent prefix, so the block reads as one hanging unit.
 */
export function hangingSegmentLines(
  segments: readonly LineCell[],
  options: HangingLayoutOptions,
  width: number,
): string[] {
  if (width <= 0) return []
  const { profile } = options
  const prefixCells = styledPrefixCells(options.prefix, options.prefixStyle, profile)
  const indentCells = styledPrefixCells(options.indent, options.prefixStyle, profile)
  const indentWidth = cellsWidth(indentCells)
  const wrapWidth = width - indentWidth > 0 ? width - indentWidth : width
  const wrapped = wrapCells(segments, wrapWidth)
  const out: string[] = []
  for (let i = 0; i < wrapped.length; i++) {
    const lead = i === 0 && prefixCells.length > 0 ? prefixCells : indentCells
    const line = cellsToString([...lead, ...(wrapped[i] as LineCell[])])
    out.push(assertLineWidth(line, profile, width))
  }
  return out
}

/**
 * Plain-text variant: sanitize + uniform text style + wrap. One logical
 * paragraph per `\n`-separated line; empty paragraphs still emit their
 * prefix line so the message shape survives.
 */
export function hangingTextLines(
  text: string,
  options: HangingLayoutOptions,
  width: number,
): string[] {
  if (width <= 0) return []
  const clean = sanitizeText(text)
  const logical = clean.split('\n')
  const out: string[] = []
  for (let i = 0; i < logical.length; i++) {
    const cells = withStyle(lineToCells(logical[i] as string, options.profile), options.textStyle)
    const lines = hangingSegmentLines(
      cells,
      i === 0 ? options : { ...options, prefix: options.indent },
      width,
    )
    out.push(...lines)
  }
  return out
}

/** Single clipped line (no wrap): sanitize + style + truncate + replay. */
export function singleLine(
  text: string,
  style: LineStyle,
  profile: TerminalProfile,
  width: number,
): string {
  if (width <= 0) return ''
  const cells = withStyle(lineToCells(sanitizeText(text), profile), style)
  return cellsToString(truncateCells(cells, width))
}
