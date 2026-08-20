/** Pure searchable help overlay (WP-08c). */
import type { HelpDialogPayload } from '../../model/interactive-overlay-payloads.js'
import type { Component } from '../../renderer/component.js'
import { renderLine, renderSegments } from './overlay-text.js'
import {
  renderInteractiveList,
  type InteractiveOverlayRenderOptions,
} from './picker-dialog.js'

export function createHelpDialog(
  view: HelpDialogPayload,
  options: InteractiveOverlayRenderOptions,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const { profile, theme } = options
      const lines = [renderLine(view.title, width, profile, theme.roles.toolName)]
      for (const shortcut of view.shortcuts) {
        lines.push(renderSegments([
          { text: `${shortcut.keys} `, style: theme.roles.accent },
          { text: shortcut.label, style: theme.roles.subtle },
        ], width, profile))
      }
      lines.push(...renderInteractiveList(view.list, width, options, 'Search: ', 'commands and shortcuts'))
      return lines
    },
    invalidate() {},
  }
}
