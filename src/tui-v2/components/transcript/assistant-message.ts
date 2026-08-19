/**
 * tui-v2 assistant message component (WP-04b).
 *
 * Visual form mirrors the legacy `AssistantTextMessage.tsx`: a `● ` glyph on
 * the first line, markdown body with a two-space hanging indent. Markdown is
 * the WP-04 reduced form (full markdown is WP-08): fenced code blocks render
 * literal in the code role, `#`-headings render bold without the hashes, and
 * the inline spans `**bold**` / `` `code` `` are honored; everything else is
 * plain text. Untrusted text always passes sanitizeText before styling.
 */
import type { Component } from '../../renderer/component.js'
import {
  lineStyle,
  lineToCells,
  sanitizeText,
  type LineCell,
  type LineStyle,
} from '../../renderer/lines.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import { hangingSegmentLines, withStyle, type HangingLayoutOptions } from './block-lines.js'
import type { TranscriptRowView } from './row-view.js'

export const ASSISTANT_BULLET = '●'

/** Inline spans: `**bold**` and `` `code` ``; unmatched delimiters stay literal. */
const INLINE_SPAN_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g

interface InlineSegment {
  readonly text: string
  readonly bold: boolean
  readonly code: boolean
}

function inlineSegments(line: string): InlineSegment[] {
  const out: InlineSegment[] = []
  let last = 0
  for (const match of line.matchAll(INLINE_SPAN_RE)) {
    const index = match.index
    if (index > last) out.push({ text: line.slice(last, index), bold: false, code: false })
    const token = match[0]
    if (token.startsWith('**')) out.push({ text: token.slice(2, -2), bold: true, code: false })
    else out.push({ text: token.slice(1, -1), bold: false, code: true })
    last = index + token.length
  }
  if (last < line.length) out.push({ text: line.slice(last), bold: false, code: false })
  return out
}

/** Reduced markdown -> styled cell spans for one logical line stream. */
function markdownCells(text: string, profile: TerminalProfile, theme: TranscriptRowView['theme']): LineCell[] {
  const clean = sanitizeText(text)
  const out: LineCell[] = []
  let inFence = false
  for (const rawLine of clean.split('\n')) {
    const isFence = /^```/.test(rawLine.trimStart())
    if (isFence) {
      inFence = !inFence
      continue // the fence marker itself renders nothing in the reduced form
    }
    if (inFence) {
      out.push(...withStyle(lineToCells(rawLine, profile), theme.roles.code))
      out.push({ grapheme: '\n', width: 0, style: theme.roles.text, hyperlink: null })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(rawLine)
    if (heading !== null) {
      out.push(
        ...withStyle(lineToCells(heading[2] as string, profile), lineStyle({ bold: true })),
      )
      out.push({ grapheme: '\n', width: 0, style: theme.roles.text, hyperlink: null })
      continue
    }
    for (const segment of inlineSegments(rawLine)) {
      let style: LineStyle = theme.roles.text
      if (segment.bold) style = lineStyle({ bold: true })
      else if (segment.code) style = theme.roles.code
      out.push(...withStyle(lineToCells(segment.text, profile), style))
    }
    out.push({ grapheme: '\n', width: 0, style: theme.roles.text, hyperlink: null })
  }
  // Drop the trailing paragraph separator.
  if (out.length > 0 && (out[out.length - 1] as LineCell).grapheme === '\n') out.pop()
  return out
}

/** Split a cell stream on the '\n' marker cells emitted by markdownCells. */
function splitCellParagraphs(cells: readonly LineCell[]): LineCell[][] {
  const paragraphs: LineCell[][] = [[]]
  for (const cell of cells) {
    if (cell.grapheme === '\n' && cell.width === 0) {
      paragraphs.push([])
    } else {
      ;(paragraphs[paragraphs.length - 1] as LineCell[]).push(cell)
    }
  }
  return paragraphs
}

export function createAssistantMessage(view: TranscriptRowView, profile: TerminalProfile): Component {
  let cache: { width: number; lines: string[] } | null = null
  const layout: HangingLayoutOptions = {
    prefix: `${ASSISTANT_BULLET} `,
    indent: '  ',
    prefixStyle: view.theme.roles.text,
    textStyle: view.theme.roles.text,
    profile,
  }
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      if (cache !== null && cache.width === width) return cache.lines
      const lines: string[] = []
      let firstParagraph = true
      for (const block of view.blocks) {
        if (block.type === 'markdown' || block.type === 'text') {
          const cells =
            block.type === 'markdown'
              ? markdownCells(block.text, profile, view.theme)
              : withStyle(lineToCells(sanitizeText(block.text), profile), view.theme.roles.text)
          for (const paragraph of splitCellParagraphs(cells)) {
            const options = firstParagraph ? layout : { ...layout, prefix: layout.indent }
            lines.push(...hangingSegmentLines(paragraph, options, width))
            firstParagraph = false
          }
        } else if (block.type === 'reasoning') {
          const reasoningLayout: HangingLayoutOptions = {
            ...layout,
            prefix: firstParagraph ? layout.prefix : layout.indent,
            textStyle: view.theme.roles.subtle,
          }
          lines.push(...hangingSegmentLines(withStyle(lineToCells(sanitizeText(block.text), profile), view.theme.roles.subtle), reasoningLayout, width))
          firstParagraph = false
        }
        // 'meta' blocks render nothing in the skeleton.
      }
      cache = { width, lines }
      return lines
    },
    invalidate() {
      cache = null
    },
  }
}
