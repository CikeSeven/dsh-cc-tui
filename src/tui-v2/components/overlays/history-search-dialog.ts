/** Pure prompt-history search overlay (WP-08c). */
import type { HistorySearchDialogPayload } from '../../model/interactive-overlay-payloads.js'
import type { Component } from '../../renderer/component.js'
import { renderLine } from './overlay-text.js'
import {
  renderInteractiveList,
  type InteractiveOverlayRenderOptions,
} from './picker-dialog.js'

export function createHistorySearchDialog(
  view: HistorySearchDialogPayload,
  options: InteractiveOverlayRenderOptions,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      return [
        renderLine(view.title, width, options.profile, options.theme.roles.toolName),
        ...renderInteractiveList(view.list, width, options, 'Search: ', view.placeholder),
      ]
    },
    invalidate() {},
  }
}
