/** Pure, cell-safe questionnaire and plan-review overlay (WP-08c). */
import type { DialogOptionView, QuestionDialogPayload } from '../../model/overlay-payloads.js'
import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'
import { renderMarkdownLines } from '../transcript/markdown.js'
import {
  centeredWindow,
  renderInputLine,
  renderLine,
  renderSegments,
} from './overlay-text.js'

export interface QuestionDialogOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

const CHECKED = '◉'
const UNCHECKED = '○'

function optionRange(view: QuestionDialogPayload): { start: number; end: number } {
  const length = view.options.length
  if (length === 0) return { start: 0, end: 0 }
  const suppliedStart = view.selection.windowStart
  const suppliedEnd = view.selection.windowEnd
  if (suppliedStart !== undefined && suppliedEnd !== undefined) {
    const start = Math.max(0, Math.min(suppliedStart, length - 1))
    return { start, end: Math.max(start + 1, Math.min(suppliedEnd, length)) }
  }
  const heights = view.options.map((option) => 1 + (option.description !== undefined ? 1 : 0))
  return centeredWindow(heights, view.selection.focusIndex, view.optionWindowRows ?? 8)
}

function optionLine(
  option: DialogOptionView,
  index: number,
  view: QuestionDialogPayload,
  width: number,
  profile: TerminalProfile,
  theme: ComponentTheme,
): string {
  const focused = view.selection.focusIndex === index
  const checked = view.selection.checked.includes(index)
  const marker = view.multiSelect ? `${checked ? CHECKED : UNCHECKED} ` : ''
  const disabled = option.disabled === true
  return renderSegments([
    { text: focused ? '❯ ' : '  ', style: focused ? theme.roles.accent : theme.roles.subtle },
    {
      text: `${marker}${option.label}${disabled ? ' (unavailable)' : ''}`,
      style: disabled ? theme.roles.subtle : focused ? theme.roles.accent : undefined,
    },
  ], width, profile)
}

function renderOptions(
  lines: string[],
  view: QuestionDialogPayload,
  width: number,
  profile: TerminalProfile,
  theme: ComponentTheme,
): void {
  const range = optionRange(view)
  if (range.start > 0) lines.push(renderLine('↑ more choices', width, profile, theme.roles.subtle))
  for (let index = range.start; index < range.end; index++) {
    const option = view.options[index]
    if (option === undefined) continue
    lines.push(optionLine(option, index, view, width, profile, theme))
    if (option.description !== undefined && option.description !== '') {
      lines.push(renderLine(`    ${option.description}`, width, profile, theme.roles.subtle))
    }
    if (option.disabledReason !== undefined && option.disabledReason !== '') {
      lines.push(renderLine(`    ${option.disabledReason}`, width, profile, theme.roles.warning))
    }
  }
  if (range.end < view.options.length) {
    lines.push(renderLine('↓ more choices', width, profile, theme.roles.subtle))
  }
}

function renderDraft(
  lines: string[],
  view: QuestionDialogPayload,
  width: number,
  profile: TerminalProfile,
  theme: ComponentTheme,
  planReview: boolean,
): void {
  const focused = view.selection.focusIndex === view.options.length
  const attached = view.selection.attachedOptionId
  const prefix = focused ? '❯ ✎ ' : '  ✎ '
  const placeholder = planReview
    ? 'Tell the model what to change…'
    : attached !== undefined
      ? `Add detail for ${attached}…`
      : 'Type another answer…'
  lines.push(renderInputLine(
    prefix,
    view.selection.text,
    view.selection.cursor ?? [...view.selection.text].length,
    width,
    profile,
    {
      text: focused ? theme.roles.text : theme.roles.subtle,
      caret: { ...theme.roles.accent, inverse: focused },
      placeholder: theme.roles.subtle,
    },
    placeholder,
  ))
}

function renderPlanReview(
  view: QuestionDialogPayload,
  width: number,
  profile: TerminalProfile,
  theme: ComponentTheme,
): string[] {
  const progress = view.total > 1 ? ` [${view.position}/${view.total}]` : ''
  const lines = [renderLine(`${view.header ?? 'Plan review'}${progress}`, width, profile, theme.roles.toolName)]
  lines.push(renderLine(view.question, width, profile, theme.roles.text))
  if (view.detail !== undefined && view.detail !== '') {
    lines.push(...renderMarkdownLines(view.detail, { profile, theme }, width))
  }
  if ((view.status ?? 'ready') !== 'ready') {
    lines.push(renderLine(
      view.statusMessage ?? 'Plan review is unavailable; submission is disabled.',
      width,
      profile,
      theme.roles.error,
    ))
  }
  renderOptions(lines, view, width, profile, theme)
  renderDraft(lines, view, width, profile, theme, true)
  if (view.selection.error !== undefined && view.selection.error !== '') {
    lines.push(renderLine(view.selection.error, width, profile, theme.roles.error))
  }
  lines.push(renderLine(
    `↑/↓ select · 1/2 quick-pick · type feedback · Enter submit · Esc dismiss · approve: ${view.intent?.approve ?? ''}`,
    width,
    profile,
    theme.roles.subtle,
  ))
  return lines
}

export function createQuestionDialog(
  view: QuestionDialogPayload,
  options: QuestionDialogOptions,
): Component {
  const { profile, theme } = options
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      if (view.intent?.kind === 'plan-review') return renderPlanReview(view, width, profile, theme)

      const progress = view.total > 1 ? ` [${view.position}/${view.total}]` : ''
      const heading = view.header !== undefined && view.header !== '' ? `${view.header} · ` : ''
      const lines: string[] = [
        renderLine(`${heading}${view.question}${progress}`, width, profile, theme.roles.toolName),
      ]
      for (const summary of view.answeredSummary ?? []) {
        lines.push(renderLine(summary, width, profile, theme.roles.subtle))
      }
      if (view.detail !== undefined && view.detail !== '') {
        lines.push(...renderMarkdownLines(view.detail, { profile, theme }, width))
      }
      if ((view.status ?? 'ready') !== 'ready') {
        lines.push(renderLine(
          view.statusMessage ?? 'Question service unavailable; submission is disabled.',
          width,
          profile,
          theme.roles.error,
        ))
      }

      renderOptions(lines, view, width, profile, theme)
      const customVisible = view.hideCustomInput !== true || view.options.length === 0
      if (customVisible) renderDraft(lines, view, width, profile, theme, false)
      if (view.selection.error !== undefined && view.selection.error !== '') {
        lines.push(renderLine(view.selection.error, width, profile, theme.roles.error))
      }
      lines.push(renderLine(
        view.multiSelect
          ? '↑/↓ choose · Space toggle · Enter answer · Esc cancel'
          : '↑/↓ choose · type custom answer · Enter answer · Esc cancel',
        width,
        profile,
        theme.roles.subtle,
      ))
      return lines
    },
    invalidate() {},
  }
}
