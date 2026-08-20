/**
 * tui-v2 question overlay component (WP-05b minimal; the plan-review card,
 * custom-input row alongside options, and error lines are WP-08).
 *
 * Pure renderer of the `QuestionDialogPayload` the DialogsController
 * publishes: batch progress, the question text, and either the option list
 * (single-select pointer / multi-select checkboxes) or the single-line draft
 * for optionless questions. Answering and cancel semantics live in the
 * controller (§4.3: components never see a store).
 */
import type { QuestionDialogPayload } from '../../model/overlay-payloads.js'
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

export interface QuestionDialogOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

const CHECKED = '◉'
const UNCHECKED = '○'

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

export function createQuestionDialog(
  view: QuestionDialogPayload,
  options: QuestionDialogOptions,
): Component {
  const { profile, theme } = options
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const lines: string[] = []
      const progress = view.total > 1 ? ` [${view.position}/${view.total}]` : ''
      const heading = view.header !== undefined && view.header !== '' ? `${view.header} · ` : ''
      pushLine(lines, `${heading}${view.question}${progress}`, width, profile, theme.roles.text)
      if (view.detail !== undefined && view.detail !== '') {
        pushLine(lines, view.detail, width, profile, theme.roles.subtle)
      }
      if (view.options.length > 0) {
        view.options.forEach((option, index) => {
          const focused = view.selection.focusIndex === index
          const pointer = focused ? '❯ ' : '  '
          const marker = view.multiSelect
            ? `${view.selection.checked.includes(index) ? CHECKED : UNCHECKED} `
            : ''
          pushLine(
            lines,
            `${pointer}${marker}${option.label}`,
            width,
            profile,
            focused ? theme.roles.accent : undefined,
          )
          if (option.description !== undefined && option.description !== '') {
            pushLine(lines, `    ${option.description}`, width, profile, theme.roles.subtle)
          }
        })
        const hint = view.multiSelect
          ? 'Space to toggle · Enter to answer · Esc to cancel'
          : 'Enter to answer · Esc to cancel'
        pushLine(lines, hint, width, profile, theme.roles.subtle)
      } else {
        // Optionless question: the running draft with an end caret.
        pushLine(lines, `❯ ${view.selection.text}▏`, width, profile)
        pushLine(lines, 'Enter to answer · Esc to cancel', width, profile, theme.roles.subtle)
      }
      return lines
    },
    invalidate() {},
  }
}
