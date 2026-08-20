/** Visible-frame transcript search highlight producer (WP-08c). */
import type { Frame } from './frame.js'
import { sanitizeText, segmentGraphemes, type LineStyle } from './lines.js'
import type { HighlightRegion } from './compositor.js'

export interface SearchHighlightStyles {
  readonly match: LineStyle
  readonly current: LineStyle
}

interface VisibleGrapheme {
  readonly text: string
  readonly x: number
  readonly width: number
}

function folded(value: string): string {
  return value.toLocaleLowerCase('en-US')
}

/**
 * Search only cells present in the current base frame. This is deliberately a
 * visible-frame capability: WP-08c does not invent an off-screen physical-line
 * index. Matches never cross a terminal row and wide graphemes produce a rect
 * covering both cells. `current` indexes visible occurrences in scan order.
 * `maxYExclusive` excludes dock rows below the visible transcript.
 */
export function buildSearchHighlightRegions(
  frame: Frame,
  query: string,
  current: number,
  styles: SearchHighlightStyles,
  maxYExclusive = frame.height,
): readonly HighlightRegion[] {
  const needle = segmentGraphemes(sanitizeText(query).replace(/[\r\n]+/gu, ' '))
  const scanHeight = Math.max(0, Math.min(frame.height, Math.floor(maxYExclusive)))
  if (needle.length === 0 || frame.width <= 0 || scanHeight <= 0) return []
  const foldedNeedle = needle.map(folded)
  const occurrences: { x: number; y: number; width: number }[] = []

  for (let y = 0; y < scanHeight; y++) {
    const row: VisibleGrapheme[] = []
    for (let x = 0; x < frame.width; x++) {
      const cell = frame.cells[y * frame.stride + x]
      if (cell === undefined || cell.width === 0) continue
      row.push({ text: cell.grapheme, x, width: cell.width })
    }
    for (let start = 0; start <= row.length - foldedNeedle.length; start++) {
      let same = true
      for (let offset = 0; offset < foldedNeedle.length; offset++) {
        if (folded(row[start + offset]?.text ?? '') !== foldedNeedle[offset]) {
          same = false
          break
        }
      }
      if (!same) continue
      const first = row[start]
      const last = row[start + foldedNeedle.length - 1]
      if (first === undefined || last === undefined) continue
      occurrences.push({ x: first.x, y, width: last.x + last.width - first.x })
    }
  }

  const selected = occurrences.length === 0
    ? 0
    : Math.max(0, Math.min(current, occurrences.length - 1))
  return occurrences.map((match, index) => ({
    kind: 'search' as const,
    x: match.x,
    y: match.y,
    width: match.width,
    height: 1,
    style: index === selected ? styles.current : styles.match,
  }))
}
