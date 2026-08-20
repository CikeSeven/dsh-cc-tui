/** Shared cell-safe text builders for pure WP-08c overlay components. */
import {
  cellsToString,
  cellsWidth,
  lineToCells,
  sanitizeText,
  segmentGraphemes,
  truncateCells,
  wrapCells,
  type LineCell,
  type LineStyle,
} from '../../renderer/lines.js'
import type { TerminalProfile } from '../../terminal/profile.js'

export interface OverlayTextOptions {
  readonly profile: TerminalProfile
  readonly style?: LineStyle
}

export interface StyledSegment {
  readonly text: string
  readonly style?: LineStyle
}

export function safeInline(text: string): string {
  return sanitizeText(text).replace(/[\r\n]+/gu, ' ')
}

export function styledTextCells(text: string, options: OverlayTextOptions): LineCell[] {
  const cells = lineToCells(safeInline(text), options.profile)
  return options.style === undefined ? cells : cells.map((cell) => ({ ...cell, style: options.style as LineStyle }))
}

export function renderSegments(
  segments: readonly StyledSegment[],
  width: number,
  profile: TerminalProfile,
): string {
  if (width <= 0) return ''
  const cells = segments.flatMap((segment) => styledTextCells(segment.text, {
    profile,
    ...(segment.style !== undefined ? { style: segment.style } : {}),
  }))
  return cellsToString(truncateCells(cells, width))
}

export function renderLine(
  text: string,
  width: number,
  profile: TerminalProfile,
  style?: LineStyle,
): string {
  return renderSegments([{ text, ...(style !== undefined ? { style } : {}) }], width, profile)
}

/** Wrap untrusted multiline text. Newline boundaries are preserved. */
export function renderWrapped(
  text: string,
  width: number,
  profile: TerminalProfile,
  style?: LineStyle,
  maxLines = Number.POSITIVE_INFINITY,
): string[] {
  if (width <= 0 || maxLines <= 0) return []
  const safe = sanitizeText(text)
  const out: string[] = []
  for (const sourceLine of safe.split('\n')) {
    let cells = lineToCells(sourceLine, profile)
    if (style !== undefined) cells = cells.map((cell) => ({ ...cell, style }))
    for (const wrapped of wrapCells(cells, width)) {
      out.push(cellsToString(wrapped))
      if (out.length >= maxLines) return out
    }
  }
  return out
}

function graphemeMatches(text: string, query: string): ReadonlySet<number> {
  const source = segmentGraphemes(safeInline(text))
  const needle = segmentGraphemes(safeInline(query))
  const matched = new Set<number>()
  if (needle.length === 0 || source.length === 0 || needle.length > source.length) return matched
  const fold = (value: string): string => value.toLocaleLowerCase('en-US')
  for (let start = 0; start <= source.length - needle.length; start++) {
    let same = true
    for (let offset = 0; offset < needle.length; offset++) {
      if (fold(source[start + offset] as string) !== fold(needle[offset] as string)) {
        same = false
        break
      }
    }
    if (same) for (let offset = 0; offset < needle.length; offset++) matched.add(start + offset)
  }
  return matched
}

/** Render a single line with every query grapheme span restyled, then truncate. */
export function renderHighlightedLine(
  prefix: string,
  text: string,
  query: string,
  width: number,
  profile: TerminalProfile,
  options: { readonly base?: LineStyle; readonly match: LineStyle },
): string {
  if (width <= 0) return ''
  const matches = graphemeMatches(text, query)
  const prefixCells = styledTextCells(prefix, { profile, ...(options.base !== undefined ? { style: options.base } : {}) })
  const sourceCells = lineToCells(safeInline(text), profile)
  const cells: LineCell[] = [...prefixCells]
  let graphemeIndex = 0
  for (const cell of sourceCells) {
    if (cell.width === 0 && cell.grapheme === '') {
      const matched = matches.has(Math.max(0, graphemeIndex - 1))
      cells.push({ ...cell, style: matched ? options.match : (options.base ?? cell.style) })
      continue
    }
    const matched = matches.has(graphemeIndex)
    cells.push({ ...cell, style: matched ? options.match : (options.base ?? cell.style) })
    graphemeIndex += 1
  }
  return cellsToString(truncateCells(cells, width))
}

/**
 * Single-line draft with a visible block caret. The source cursor is a
 * code-point index; the visible window drops leading content until the caret
 * fits and then fills trailing cells. No surrogate or wide grapheme is split.
 */
export function renderInputLine(
  prefix: string,
  text: string,
  cursor: number,
  width: number,
  profile: TerminalProfile,
  styles: { readonly text?: LineStyle; readonly caret: LineStyle; readonly placeholder?: LineStyle },
  placeholder = '',
): string {
  if (width <= 0) return ''
  const prefixCells = styledTextCells(prefix, { profile, ...(styles.text !== undefined ? { style: styles.text } : {}) })
  const budget = Math.max(0, width - cellsWidth(prefixCells))
  if (budget === 0) return cellsToString(truncateCells(prefixCells, width))

  const safe = safeInline(text)
  const points = [...safe]
  const at = Math.max(0, Math.min(cursor, points.length))
  if (points.length === 0 && placeholder !== '') {
    const placeholderCells = styledTextCells(placeholder, {
      profile,
      ...(styles.placeholder !== undefined ? { style: styles.placeholder } : {}),
    })
    const caret: LineCell = { grapheme: ' ', width: 1, style: styles.caret, hyperlink: null }
    return cellsToString(truncateCells([...prefixCells, caret, ...placeholderCells], width))
  }

  const before = points.slice(0, at).join('')
  const caretText = points[at] ?? ' '
  const after = points.slice(at + (at < points.length ? 1 : 0)).join('')
  const caretCells = styledTextCells(caretText, { profile, style: styles.caret })
  let beforeCells = styledTextCells(before, { profile, ...(styles.text !== undefined ? { style: styles.text } : {}) })
  while (beforeCells.length > 0 && cellsWidth(beforeCells) + cellsWidth(caretCells) > budget) {
    const first = beforeCells[0]
    const drop = first?.width === 2 ? 2 : 1
    beforeCells = beforeCells.slice(drop)
  }
  const used = cellsWidth(beforeCells) + cellsWidth(caretCells)
  const afterCells = truncateCells(
    styledTextCells(after, { profile, ...(styles.text !== undefined ? { style: styles.text } : {}) }),
    Math.max(0, budget - used),
  )
  return cellsToString(truncateCells([...prefixCells, ...beforeCells, ...caretCells, ...afterCells], width))
}

export function centeredWindow(
  itemHeights: readonly number[],
  focusIndex: number,
  maxRows: number,
): { start: number; end: number } {
  if (itemHeights.length === 0) return { start: 0, end: 0 }
  const focus = Math.max(0, Math.min(focusIndex, itemHeights.length - 1))
  const budget = Math.max(1, maxRows)
  let start = focus
  let end = focus + 1
  let used = Math.max(1, itemHeights[focus] ?? 1)
  for (;;) {
    const up = start > 0 ? Math.max(1, itemHeights[start - 1] ?? 1) : Number.POSITIVE_INFINITY
    const down = end < itemHeights.length ? Math.max(1, itemHeights[end] ?? 1) : Number.POSITIVE_INFINITY
    if (used + up <= budget && (used + down > budget || focus - start <= end - focus - 1)) {
      start -= 1
      used += up
      continue
    }
    if (used + down <= budget) {
      end += 1
      used += down
      continue
    }
    return { start, end }
  }
}
