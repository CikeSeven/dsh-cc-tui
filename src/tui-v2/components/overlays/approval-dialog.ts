/** Pure, cell-safe approval overlay (WP-08c). */
import type { ApprovalDialogPayload } from '../../model/overlay-payloads.js'
import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'
import { renderLine, renderSegments, renderWrapped, safeInline } from './overlay-text.js'

export interface ApprovalDialogOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

const APPROVAL_TEXT_LIMIT = 8_000

function bounded(text: string): string {
  const safe = safeInline(text)
  return safe.length <= APPROVAL_TEXT_LIMIT
    ? safe
    : `${safe.slice(0, APPROVAL_TEXT_LIMIT)} … [truncated]`
}

export function createApprovalDialog(
  view: ApprovalDialogPayload,
  options: ApprovalDialogOptions,
): Component {
  const { profile, theme } = options
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const status = view.status ?? 'ready'
      const content: string[] = []
      if (view.command !== undefined && view.command !== '') {
        content.push(...renderWrapped(`$ ${bounded(view.command)}`, width, profile, theme.roles.code))
      }
      if (view.reason !== undefined && view.reason !== '') {
        content.push(...renderWrapped(`Reason: ${bounded(view.reason)}`, width, profile, theme.roles.subtle))
      }

      const rows = Math.max(1, view.contentWindowRows ?? 6)
      const maxOffset = Math.max(0, content.length - rows)
      const offset = Math.max(0, Math.min(view.selection.contentOffset ?? 0, maxOffset))
      const end = Math.min(content.length, offset + rows)
      const lines: string[] = [
        renderLine(`⚠ Approval required: ${view.toolName}`, width, profile, theme.roles.warning),
      ]
      if (offset > 0) lines.push(renderLine('↑ more command/reason', width, profile, theme.roles.subtle))
      lines.push(...content.slice(offset, end))
      if (end < content.length) lines.push(renderLine('↓ more command/reason', width, profile, theme.roles.subtle))

      if (status !== 'ready') {
        lines.push(renderLine(
          view.statusMessage ?? (status === 'unavailable'
            ? 'Approval service unavailable; proceeding is disabled.'
            : 'Approval failed; reject or cancel to remain safe.'),
          width,
          profile,
          theme.roles.error,
        ))
      }
      lines.push(renderLine('Do you want to proceed?', width, profile))

      const labels = ['Proceed once', 'Reject'] as const
      labels.forEach((label, index) => {
        const unavailable = index === 0 && status !== 'ready'
        const focused = view.selection.focusIndex === index
        lines.push(renderSegments([
          { text: focused ? '❯ ' : '  ', style: focused ? theme.roles.accent : theme.roles.subtle },
          { text: `${index + 1}. ${label}${unavailable ? ' (unavailable)' : ''}`, style: unavailable
            ? theme.roles.subtle
            : focused ? theme.roles.accent : undefined },
        ], width, profile))
      })
      lines.push(renderLine(
        content.length > rows
          ? '↑/↓ choose · PgUp/PgDn scroll · Enter select · Esc reject'
          : '↑/↓ choose · 1/2 quick select · Enter select · Esc reject',
        width,
        profile,
        theme.roles.subtle,
      ))
      return lines
    },
    invalidate() {},
  }
}
