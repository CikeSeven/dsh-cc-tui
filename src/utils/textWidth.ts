import { eastAsianWidth } from 'get-east-asian-width'

const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof (Intl as Record<string, unknown>).Segmenter === 'function'
    ? new Intl.Segmenter('und', { granularity: 'grapheme' })
    : null

const ZERO_WIDTH = /\p{Mn}|\p{Mc}|\p{Me}|\p{Cf}/u

/** Measure neutral, already-plain text in terminal cells. */
export function textWidth(value: string, ambiguousAsWide = false): number {
  if (value === '') return 0
  if (segmenter === null) throw new Error('Intl.Segmenter is unavailable')
  let width = 0
  for (const { segment } of segmenter.segment(value)) {
    let graphemeWidth = 0
    for (const character of segment) {
      const codePoint = character.codePointAt(0) as number
      if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
        graphemeWidth = 0
        break
      }
      if (ZERO_WIDTH.test(character)) continue
      graphemeWidth = Math.max(graphemeWidth, eastAsianWidth(codePoint, { ambiguousAsWide }))
    }
    width += graphemeWidth
  }
  return width
}

/** Truncate plain text to a cell budget without adding or removing content. */
export function truncateTextCells(value: string, maxCells: number, ambiguousAsWide = false): string {
  if (maxCells <= 0) return ''
  if (textWidth(value, ambiguousAsWide) <= maxCells) return value
  let result = ''
  if (segmenter === null) throw new Error('Intl.Segmenter is unavailable')
  for (const { segment } of segmenter.segment(value)) {
    if (textWidth(result + segment, ambiguousAsWide) > maxCells) break
    result += segment
  }
  return result
}
