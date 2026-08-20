/** Pure transcript-search control overlay (WP-08c). */
import type { TranscriptSearchDialogPayload } from '../../model/interactive-overlay-payloads.js'
import type { Component } from '../../renderer/component.js'
import type { InteractiveOverlayRenderOptions } from './picker-dialog.js'
import { renderInputLine, renderLine } from './overlay-text.js'

export function createTranscriptSearchDialog(
  view: TranscriptSearchDialogPayload,
  options: InteractiveOverlayRenderOptions,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const { profile, theme } = options
      const lines = [
        renderLine(view.title, width, profile, theme.roles.toolName),
        renderInputLine(
          'Search: ',
          view.query,
          view.cursor,
          width,
          profile,
          { text: theme.roles.text, caret: { ...theme.roles.accent, inverse: true }, placeholder: theme.roles.subtle },
          'find in visible transcript',
        ),
      ]
      if (view.query !== '') {
        lines.push(renderLine(
          view.total === 0 ? view.noResultsMessage : `${view.current + 1}/${view.total} matches`,
          width,
          profile,
          view.total === 0 ? theme.roles.subtle : theme.roles.accent,
        ))
      }
      if (view.error !== undefined && view.error !== '') {
        lines.push(renderLine(view.error, width, profile, theme.roles.error))
      }
      lines.push(renderLine(view.hint, width, profile, theme.roles.subtle))
      return lines
    },
    invalidate() {},
  }
}
