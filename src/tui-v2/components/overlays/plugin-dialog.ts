/**
 * tui-v2 managed plugin dialog component (WP-05b minimal; pane chrome,
 * windowed lists and the block caret are WP-08).
 *
 * Pure renderer of the `PluginDialogPayload` the DialogsController publishes
 * for the ctx.tuiDialogs seam. Three kinds share one component, mirroring the
 * legacy ExtensionDialog: `select` (pointer list + descriptions), `confirm`
 * (message + two labelled rows; '' labels fall back to Yes/No), `input`
 * (single-line draft seeded from `initial`, dim placeholder when empty).
 * Text arrives pre-sanitized by TuiDialogRuntime and still goes through
 * `sanitizeText` + the §6.1 width pipeline here.
 */
import type { PluginDialogPayload } from '../../model/overlay-payloads.js'
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

export interface PluginDialogOptions {
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

export function createPluginDialog(
  view: PluginDialogPayload,
  options: PluginDialogOptions,
): Component {
  const { profile, theme } = options
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const lines: string[] = []
      pushLine(lines, view.title, width, profile, theme.roles.toolName)
      switch (view.dialogKind) {
        case 'select': {
          for (const [index, option] of (view.options ?? []).entries()) {
            const focused = view.selection.focusIndex === index
            pushLine(
              lines,
              `${focused ? '❯ ' : '  '}${option.label}`,
              width,
              profile,
              focused ? theme.roles.accent : undefined,
            )
            if (option.description !== undefined && option.description !== '') {
              pushLine(lines, `    ${option.description}`, width, profile, theme.roles.subtle)
            }
          }
          break
        }
        case 'confirm': {
          if (view.message !== undefined && view.message !== '') {
            pushLine(lines, view.message, width, profile, theme.roles.subtle)
          }
          const labels = [
            view.confirmLabel !== undefined && view.confirmLabel !== '' ? view.confirmLabel : 'Yes',
            view.cancelLabel !== undefined && view.cancelLabel !== '' ? view.cancelLabel : 'No',
          ]
          labels.forEach((label, index) => {
            const focused = view.selection.focusIndex === index
            pushLine(
              lines,
              `${focused ? '❯ ' : '  '}${label}`,
              width,
              profile,
              focused ? theme.roles.accent : undefined,
            )
          })
          break
        }
        case 'input': {
          if (view.selection.text === '' && view.placeholder !== undefined && view.placeholder !== '') {
            pushLine(lines, `❯ ${view.placeholder}`, width, profile, theme.roles.subtle)
          } else {
            pushLine(lines, `❯ ${view.selection.text}▏`, width, profile)
          }
          break
        }
      }
      pushLine(lines, 'Enter to confirm · Esc to cancel', width, profile, theme.roles.subtle)
      return lines
    },
    invalidate() {},
  }
}
