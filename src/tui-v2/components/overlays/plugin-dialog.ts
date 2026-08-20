/** Pure, cell-safe managed plugin dialog overlay (WP-08c). */
import type { PluginDialogPayload } from '../../model/overlay-payloads.js'
import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'
import {
  centeredWindow,
  renderHighlightedLine,
  renderInputLine,
  renderLine,
  renderSegments,
} from './overlay-text.js'

export interface PluginDialogOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

function optionRange(view: PluginDialogPayload): { start: number; end: number } {
  const options = view.options ?? []
  if (options.length === 0) return { start: 0, end: 0 }
  if (view.selection.windowStart !== undefined && view.selection.windowEnd !== undefined) {
    const start = Math.max(0, Math.min(view.selection.windowStart, options.length - 1))
    return { start, end: Math.max(start + 1, Math.min(view.selection.windowEnd, options.length)) }
  }
  const heights = options.map((option) => 1 + (option.description !== undefined ? 1 : 0))
  return centeredWindow(heights, view.selection.focusIndex, view.optionWindowRows ?? 8)
}

function statusLine(view: PluginDialogPayload, width: number, profile: TerminalProfile, theme: ComponentTheme): string | null {
  if ((view.status ?? 'ready') === 'ready' && view.selection.error === undefined) return null
  return renderLine(
    view.selection.error ?? view.statusMessage ?? 'Dialog unavailable; submission is disabled.',
    width,
    profile,
    theme.roles.error,
  )
}

export function createPluginDialog(
  view: PluginDialogPayload,
  options: PluginDialogOptions,
): Component {
  const { profile, theme } = options
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const lines: string[] = [renderLine(view.title, width, profile, theme.roles.toolName)]
      switch (view.dialogKind) {
        case 'select': {
          const filter = view.selection.filter ?? ''
          lines.push(renderInputLine(
            'Filter: ',
            filter,
            view.selection.filterCursor ?? [...filter].length,
            width,
            profile,
            { text: theme.roles.text, caret: { ...theme.roles.accent, inverse: true }, placeholder: theme.roles.subtle },
            'type to narrow choices',
          ))
          const options_ = view.options ?? []
          if ((view.totalOptions ?? options_.length) === 0) {
            lines.push(renderLine('No options are available.', width, profile, theme.roles.subtle))
          } else if (options_.length === 0) {
            lines.push(renderLine(`No options match “${filter}”.`, width, profile, theme.roles.subtle))
          } else {
            const range = optionRange(view)
            if (range.start > 0) lines.push(renderLine('↑ more choices', width, profile, theme.roles.subtle))
            for (let index = range.start; index < range.end; index++) {
              const option = options_[index]
              if (option === undefined) continue
              const focused = view.selection.focusIndex === index
              const disabled = option.disabled === true
              lines.push(renderHighlightedLine(
                focused ? '❯ ' : '  ',
                `${option.label}${disabled ? ' (unavailable)' : ''}`,
                filter,
                width,
                profile,
                {
                  base: disabled ? theme.roles.subtle : focused ? theme.roles.accent : theme.roles.text,
                  match: theme.roles.warning,
                },
              ))
              if (option.description !== undefined && option.description !== '') {
                lines.push(renderHighlightedLine('    ', option.description, filter, width, profile, {
                  base: theme.roles.subtle,
                  match: theme.roles.warning,
                }))
              }
              if (option.disabledReason !== undefined && option.disabledReason !== '') {
                lines.push(renderLine(`    ${option.disabledReason}`, width, profile, theme.roles.warning))
              }
            }
            if (range.end < options_.length) lines.push(renderLine('↓ more choices', width, profile, theme.roles.subtle))
          }
          break
        }
        case 'confirm': {
          if (view.message !== undefined && view.message !== '') {
            lines.push(renderLine(view.message, width, profile, theme.roles.subtle))
          }
          const labels = [view.confirmLabel || 'Yes', view.cancelLabel || 'No']
          labels.forEach((label, index) => {
            const focused = view.selection.focusIndex === index
            lines.push(renderSegments([
              { text: focused ? '❯ ' : '  ', style: focused ? theme.roles.accent : theme.roles.subtle },
              { text: `${index + 1}. ${label}`, style: focused ? theme.roles.accent : undefined },
            ], width, profile))
          })
          break
        }
        case 'input': {
          lines.push(renderInputLine(
            '❯ ',
            view.selection.text,
            view.selection.cursor ?? [...view.selection.text].length,
            width,
            profile,
            { text: theme.roles.text, caret: { ...theme.roles.accent, inverse: true }, placeholder: theme.roles.subtle },
            view.placeholder ?? '',
          ))
          break
        }
      }
      const issue = statusLine(view, width, profile, theme)
      if (issue !== null) lines.push(issue)
      lines.push(renderLine(
        view.dialogKind === 'select'
          ? 'Type to filter · ↑/↓ choose · Enter confirm · Esc cancel'
          : 'Enter confirm · Esc cancel',
        width,
        profile,
        theme.roles.subtle,
      ))
      return lines
    },
    invalidate() {},
  }
}
