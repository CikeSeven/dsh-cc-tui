/**
 * tui-v2 approval overlay component (WP-05b minimal; full visual parity —
 * divider chrome, permission colors, hint i18n — is WP-08).
 *
 * Pure renderer of the `ApprovalDialogPayload` the DialogsController publishes
 * on the overlay stack: tool name, gated command, reason, and the two-row
 * Yes/No list with the focused row marked. Input capture and the decide call
 * live in the controller; this component never sees a store (§4.3).
 */
import type { ApprovalDialogPayload } from '../../model/overlay-payloads.js'
import type { Component } from '../../renderer/component.js'
import {
  cellsToString,
  lineToCells,
  sanitizeText,
  truncateCells,
  type LineCell,
  type LineStyle,
} from '../../renderer/lines.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'

export interface ApprovalDialogOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

function pushLine(
  lines: string[],
  text: string,
  width: number,
  profile: TerminalProfile,
  style?: LineStyle,
): void {
  let cells: LineCell[] = lineToCells(sanitizeText(text), profile)
  if (style !== undefined) cells = cells.map((cell) => ({ ...cell, style }))
  lines.push(cellsToString(truncateCells(cells, width)))
}

const APPROVAL_LABELS = ['1. Yes', '2. No'] as const

export function createApprovalDialog(
  view: ApprovalDialogPayload,
  options: ApprovalDialogOptions,
): Component {
  const { profile, theme } = options
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const lines: string[] = []
      pushLine(lines, `⚠ Approval required: ${view.toolName}`, width, profile, theme.roles.warning)
      if (view.command !== undefined && view.command !== '') {
        pushLine(lines, `$ ${view.command}`, width, profile, theme.roles.subtle)
      }
      if (view.reason !== undefined && view.reason !== '') {
        pushLine(lines, view.reason, width, profile, theme.roles.subtle)
      }
      pushLine(lines, 'Do you want to proceed?', width, profile)
      APPROVAL_LABELS.forEach((label, index) => {
        const focused = view.selection.focusIndex === index
        pushLine(
          lines,
          `${focused ? '❯ ' : '  '}${label}`,
          width,
          profile,
          focused ? theme.roles.accent : undefined,
        )
      })
      pushLine(lines, 'Enter to select · Esc to reject', width, profile, theme.roles.subtle)
      return lines
    },
    invalidate() {},
  }
}
