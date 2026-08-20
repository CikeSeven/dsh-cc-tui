/** Pure local/provider workspace picker component (WP-08d1). */
import type { WorkspaceDialogPayload } from '../../model/catalog-overlay-payloads.js'
import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'
import { renderInputLine, renderLine, renderSegments } from './overlay-text.js'

export interface WorkspaceDialogRenderOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

export function createWorkspaceDialog(
  view: WorkspaceDialogPayload,
  options: WorkspaceDialogRenderOptions,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const { profile, theme } = options
      const lines = [renderSegments([
        { text: view.title, style: theme.roles.toolName },
        { text: ` · ${view.filteredCount}/${view.sourceCount}`, style: theme.roles.subtle },
      ], width, profile)]
      lines.push(renderInputLine(
        'Filter: ',
        view.query,
        view.cursor,
        width,
        profile,
        { text: theme.roles.text, caret: { ...theme.roles.accent, inverse: true }, placeholder: theme.roles.subtle },
        view.view === 'targets' ? 'workspace name, path or provider' : 'provider choice',
      ))

      if (view.phase === 'loading') {
        lines.push(renderLine('Loading workspaces…', width, profile, theme.roles.subtle))
      } else if (view.items.length === 0) {
        lines.push(renderLine(
          view.sourceCount === 0 ? 'No workspace targets are available.' : 'No workspace entries match this filter.',
          width,
          profile,
          view.phase === 'error' ? theme.roles.error : theme.roles.subtle,
        ))
      } else {
        if (view.hasMoreAbove) lines.push(renderLine('↑ more workspaces', width, profile, theme.roles.subtle))
        for (const item of view.items) {
          const selected = item.id === view.selectedId
          const suffix = [
            item.current === true ? 'current' : '',
            item.hasInput === true ? 'Tab to configure' : '',
          ].filter(Boolean).join(' · ')
          lines.push(renderSegments([
            { text: selected ? '❯ ' : '  ', style: selected ? theme.roles.accent : theme.roles.subtle },
            ...(item.badge === undefined ? [] : [{ text: `${item.badge} · `, style: theme.roles.warning }]),
            { text: item.label, style: selected ? { ...theme.roles.accent, bold: true } : theme.roles.text },
            ...(suffix === '' ? [] : [{ text: ` (${suffix})`, style: theme.roles.subtle }]),
          ], width, profile))
          if (item.description !== undefined && item.description !== '') {
            lines.push(renderLine(`    ${item.description}`, width, profile, theme.roles.subtle))
          }
        }
        if (view.hasMoreBelow) lines.push(renderLine('↓ more workspaces', width, profile, theme.roles.subtle))
      }

      if (view.input !== undefined) {
        lines.push(renderInputLine(
          'Value: ',
          view.input.value,
          view.input.cursor,
          width,
          profile,
          { text: theme.roles.text, caret: { ...theme.roles.accent, inverse: true }, placeholder: theme.roles.subtle },
          view.input.placeholder ?? 'provider value',
        ))
      }
      if (view.notice !== undefined) {
        const style = view.notice.tone === 'error'
          ? theme.roles.error
          : view.notice.tone === 'warning'
            ? theme.roles.warning
            : view.notice.tone === 'success'
              ? theme.roles.success
              : theme.roles.subtle
        lines.push(renderLine(view.notice.text, width, profile, style))
      }
      if (view.phase === 'pending' && view.notice === undefined) {
        lines.push(renderLine('Workspace operation pending…', width, profile, theme.roles.subtle))
      }
      if (view.error !== undefined) lines.push(renderLine(view.error, width, profile, theme.roles.error))
      lines.push(renderLine(view.hint, width, profile, theme.roles.subtle))
      return lines
    },
    invalidate() {},
  }
}
