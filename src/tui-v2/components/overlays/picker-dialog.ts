/** Pure generic picker overlay and shared interactive-list renderer (WP-08c). */
import type {
  InteractiveListView,
  PickerDialogPayload,
} from '../../model/interactive-overlay-payloads.js'
import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'
import {
  centeredWindow,
  renderHighlightedLine,
  renderInputLine,
  renderLine,
} from './overlay-text.js'

export interface InteractiveOverlayRenderOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

function visibleRange(list: InteractiveListView): { start: number; end: number } {
  if (list.items.length === 0) return { start: 0, end: 0 }
  if (list.windowEnd > list.windowStart) {
    const start = Math.max(0, Math.min(list.windowStart, list.items.length - 1))
    return { start, end: Math.max(start + 1, Math.min(list.windowEnd, list.items.length)) }
  }
  return centeredWindow(
    list.items.map((item) => 1 + (item.description !== undefined ? 1 : 0)),
    list.activeIndex,
    8,
  )
}

export function renderInteractiveList(
  list: InteractiveListView,
  width: number,
  options: InteractiveOverlayRenderOptions,
  inputLabel = 'Filter: ',
  placeholder = 'type to filter',
): string[] {
  const { profile, theme } = options
  if (width <= 0) return []
  const lines = [renderInputLine(
    inputLabel,
    list.query,
    list.cursor,
    width,
    profile,
    { text: theme.roles.text, caret: { ...theme.roles.accent, inverse: true }, placeholder: theme.roles.subtle },
    placeholder,
  )]

  if (list.sourceCount === 0) {
    lines.push(renderLine(list.emptyMessage, width, profile, theme.roles.subtle))
  } else if (list.items.length === 0) {
    lines.push(renderLine(list.noResultsMessage, width, profile, theme.roles.subtle))
  } else {
    const range = visibleRange(list)
    if (range.start > 0) lines.push(renderLine('↑ more results', width, profile, theme.roles.subtle))
    for (let index = range.start; index < range.end; index++) {
      const item = list.items[index]
      if (item === undefined) continue
      const focused = list.activeIndex === index
      const disabled = item.disabled === true
      lines.push(renderHighlightedLine(
        focused ? '❯ ' : '  ',
        `${item.label}${disabled ? ' (unavailable)' : ''}`,
        list.query,
        width,
        profile,
        {
          base: disabled ? theme.roles.subtle : focused ? theme.roles.accent : theme.roles.text,
          match: theme.roles.warning,
        },
      ))
      if (item.description !== undefined && item.description !== '') {
        lines.push(renderHighlightedLine('    ', item.description, list.query, width, profile, {
          base: theme.roles.subtle,
          match: theme.roles.warning,
        }))
      }
      if (item.disabledReason !== undefined && item.disabledReason !== '') {
        lines.push(renderLine(`    ${item.disabledReason}`, width, profile, theme.roles.warning))
      }
    }
    if (range.end < list.items.length) lines.push(renderLine('↓ more results', width, profile, theme.roles.subtle))
  }
  if (list.error !== undefined && list.error !== '') {
    lines.push(renderLine(list.error, width, profile, theme.roles.error))
  }
  lines.push(renderLine(list.hint, width, profile, theme.roles.subtle))
  return lines
}

export function createPickerDialog(
  view: PickerDialogPayload,
  options: InteractiveOverlayRenderOptions,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const lines = [renderLine(view.title, width, options.profile, options.theme.roles.toolName)]
      if (view.subtitle !== undefined && view.subtitle !== '') {
        lines.push(renderLine(view.subtitle, width, options.profile, options.theme.roles.subtle))
      }
      lines.push(...renderInteractiveList(view.list, width, options))
      return lines
    },
    invalidate() {},
  }
}
