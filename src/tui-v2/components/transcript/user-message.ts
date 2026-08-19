/**
 * tui-v2 user message component (WP-04b).
 *
 * Visual form mirrors the legacy `src/components/messages/UserPromptMessage.tsx`:
 * a subtle `❯ ` prefix followed by the prompt text, wrapping with a hanging
 * indent. The legacy grey bubble background is a WP-08 concern (line-level
 * background fill needs the frame builder). Text is untrusted input: it goes
 * through `sanitizeText` + the §6.1 pipeline before styling.
 */
import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import { hangingTextLines, singleLine, type HangingLayoutOptions } from './block-lines.js'
import type { TranscriptRowView } from './row-view.js'

export const USER_POINTER = '❯'

export function createUserMessage(view: TranscriptRowView, profile: TerminalProfile): Component {
  let cache: { width: number; lines: string[] } | null = null
  const layout: HangingLayoutOptions = {
    prefix: `${USER_POINTER} `,
    indent: '  ',
    prefixStyle: view.theme.roles.subtle,
    textStyle: view.theme.roles.text,
    profile,
  }
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      if (cache !== null && cache.width === width) return cache.lines
      const lines: string[] = []
      for (const block of view.blocks) {
        if (block.type === 'label') {
          lines.push(singleLine(block.text, view.theme.roles.subtle, profile, width))
        } else if (block.type === 'text') {
          lines.push(...hangingTextLines(block.text, layout, width))
        }
        // 'meta' blocks (time/folded/restored) render nothing in the skeleton.
      }
      cache = { width, lines }
      return lines
    },
    invalidate() {
      cache = null
    },
  }
}
