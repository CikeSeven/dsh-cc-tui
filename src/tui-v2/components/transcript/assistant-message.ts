/**
 * tui-v2 assistant message component (WP-04b; markdown upgraded in WP-06c).
 *
 * Visual form mirrors the legacy `AssistantTextMessage.tsx`: a `● ` glyph on
 * the first line, body hung under a two-space indent. Markdown blocks render
 * through the WP-06c basic markdown line component (`markdown.ts`: headings,
 * paragraphs, lists, quotes, fenced code via code.ts, inline code/bold/italic
 * and profile-gated OSC 8 links; tables degrade to verbatim lines — full
 * CommonMark is WP-08). Plain `text` blocks stay unstyled, `reasoning` blocks
 * render in the subtle role. Untrusted text always passes the §6.1
 * sanitize-then-restyle boundary inside those renderers.
 */
import type { Component } from '../../renderer/component.js'
import { lineToCells, sanitizeText } from '../../renderer/lines.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import { hangingSegmentLines, withStyle, type HangingLayoutOptions } from './block-lines.js'
import { renderMarkdownLines } from './markdown.js'
import type { TranscriptRowView } from './row-view.js'

export const ASSISTANT_BULLET = '●'

export function createAssistantMessage(view: TranscriptRowView, profile: TerminalProfile): Component {
  let cache: { width: number; lines: string[] } | null = null
  const bullet = `${ASSISTANT_BULLET} `
  const indent = '  '
  const layout: HangingLayoutOptions = {
    prefix: bullet,
    indent,
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
        if (block.type === 'markdown') {
          lines.push(
            ...renderMarkdownLines(
              block.text,
              {
                theme: view.theme,
                profile,
                prefix: firstParagraph ? bullet : indent,
                indent,
              },
              width,
            ),
          )
          firstParagraph = false
        } else if (block.type === 'text') {
          // Multi-line plain text is hung line by line (mirrors user-message;
          // lineToCells would silently join raw '\n'-separated lines).
          for (const textLine of sanitizeText(block.text).split('\n')) {
            const options = firstParagraph ? layout : { ...layout, prefix: layout.indent }
            const cells = withStyle(lineToCells(textLine, profile), view.theme.roles.text)
            lines.push(...hangingSegmentLines(cells, options, width))
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
