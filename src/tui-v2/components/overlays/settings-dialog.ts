/** Pure line component for the WP-08d2 settings overlay. */
import type { Component } from '../../renderer/component.js'
import { cellsToString, lineToCells, padCells, truncateCells } from '../../renderer/lines.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type {
  SettingsDialogPayload,
  SettingsFieldView,
  SettingsSectionView,
} from '../../model/settings-routing-overlay-payloads.js'
import { SETTINGS_SPLIT_COLUMNS } from '../../model/settings-routing-overlay-payloads.js'
import type { ComponentTheme } from '../theme.js'
import { renderInputLine, renderLine, renderSegments } from './overlay-text.js'

export interface SettingsDialogRenderOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

function statusStyle(section: SettingsSectionView, theme: ComponentTheme) {
  if (!section.available || section.failed || section.invalid) return theme.roles.error
  if (section.conflicted || section.dirty || section.saving) return theme.roles.warning
  return theme.roles.subtle
}

function sectionLines(
  view: SettingsDialogPayload,
  width: number,
  options: SettingsDialogRenderOptions,
): string[] {
  const { profile, theme } = options
  if (view.sections.length === 0) return [renderLine('No settings sections are available.', width, profile, theme.roles.subtle)]
  const lines: string[] = []
  if (view.sectionWindowStart > 0) lines.push(renderLine('↑ more sections', width, profile, theme.roles.subtle))
  for (const section of view.sections.slice(view.sectionWindowStart, view.sectionWindowEnd)) {
    const selected = section.id === view.selectedSectionId
    const badges = [
      section.source === 'namespace' ? 'read-only' : '',
      !section.available ? 'unavailable' : '',
      section.applies === 'restart' ? 'restart' : '',
      section.dirty ? 'dirty' : '',
      section.saving ? 'saving' : '',
      section.invalid ? 'invalid' : '',
      section.conflicted ? 'revision conflict' : '',
    ].filter(Boolean)
    lines.push(renderSegments([
      { text: selected ? '❯ ' : '  ', style: selected ? theme.roles.accent : theme.roles.subtle },
      { text: section.title, style: selected ? { ...theme.roles.accent, bold: true } : theme.roles.text },
      { text: ` (${section.ns})`, style: theme.roles.subtle },
      ...(badges.length === 0 ? [] : [{ text: ` [${badges.join(' · ')}]`, style: statusStyle(section, theme) }]),
    ], width, profile))
    if (section.source === 'namespace' && section.preview !== undefined) {
      lines.push(renderLine(`    ${section.preview}`, width, profile, theme.roles.subtle))
    }
  }
  if (view.sectionWindowEnd < view.sections.length) lines.push(renderLine('↓ more sections', width, profile, theme.roles.subtle))
  return lines
}

function fieldValue(field: SettingsFieldView): string {
  if (field.secret) {
    if (field.text !== '') return `${field.text} ${field.staged ? '(staged)' : ''}`.trim()
    return field.configured === true ? 'configured' : 'not configured'
  }
  if (field.text === '') return '(empty)'
  if (field.kind === 'boolean') return field.text === 'true' ? 'true' : field.text
  const choice = field.options?.find((option) => option.value === field.text)
  return choice?.label ?? field.text
}

function fieldLines(
  view: SettingsDialogPayload,
  width: number,
  options: SettingsDialogRenderOptions,
): string[] {
  const { profile, theme } = options
  if (view.fields.length === 0) {
    return [renderLine('This namespace has no editable fields.', width, profile, theme.roles.subtle)]
  }
  const lines: string[] = []
  if (view.fieldWindowStart > 0) lines.push(renderLine('↑ more fields', width, profile, theme.roles.subtle))
  for (const field of view.fields.slice(view.fieldWindowStart, view.fieldWindowEnd)) {
    const selected = field.id === view.selectedFieldId
    const editing = view.editing?.fieldId === field.id
    const flags = [
      field.invalid ? 'invalid' : '',
      field.overridden ? 'override' : '',
      field.staged ? 'staged' : '',
    ].filter(Boolean)
    const prefix = selected ? '❯ ' : '  '
    const style = field.invalid ? theme.roles.error : selected ? theme.roles.accent : theme.roles.text
    if (editing && view.editing !== undefined) {
      lines.push(renderInputLine(
        `${prefix}${field.label}: `,
        view.editing.text,
        view.editing.cursor,
        width,
        profile,
        { text: style, caret: { ...theme.roles.accent, inverse: true }, placeholder: theme.roles.subtle },
        field.secret ? 'secret value' : field.kind,
      ))
    } else {
      lines.push(renderSegments([
        { text: prefix, style: selected ? theme.roles.accent : theme.roles.subtle },
        { text: `${field.label}: `, style },
        { text: fieldValue(field), style: field.text === '' ? theme.roles.subtle : style },
        ...(flags.length === 0 ? [] : [{ text: ` [${flags.join(' · ')}]`, style: field.invalid ? theme.roles.error : theme.roles.warning }]),
      ], width, profile))
    }
    if (field.hint !== undefined && selected) lines.push(renderLine(`    ${field.hint}`, width, profile, theme.roles.subtle))
  }
  if (view.fieldWindowEnd < view.fields.length) lines.push(renderLine('↓ more fields', width, profile, theme.roles.subtle))
  return lines
}

function joinColumns(
  left: readonly string[],
  right: readonly string[],
  leftWidth: number,
  rightWidth: number,
  profile: TerminalProfile,
  dividerStyle: SettingsDialogRenderOptions['theme']['roles']['subtle'],
): string[] {
  const height = Math.max(left.length, right.length)
  const out: string[] = []
  for (let index = 0; index < height; index += 1) {
    const leftCells = padCells(truncateCells(lineToCells(left[index] ?? '', profile), leftWidth), leftWidth)
    const divider = lineToCells('│', profile).map((cell) => ({ ...cell, style: dividerStyle }))
    const rightCells = truncateCells(lineToCells(right[index] ?? '', profile), rightWidth)
    out.push(cellsToString([...leftCells, ...divider, ...rightCells]))
  }
  return out
}

export function createSettingsDialog(
  view: SettingsDialogPayload,
  options: SettingsDialogRenderOptions,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const { profile, theme } = options
      const lines: string[] = [renderSegments([
        { text: view.title, style: theme.roles.toolName },
        { text: view.phase === 'loading' ? ' · loading' : view.phase === 'pending' ? ' · saving' : '', style: theme.roles.subtle },
      ], width, profile)]
      if (view.error !== undefined) lines.push(renderLine(view.error, width, profile, theme.roles.error))
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

      if (view.phase === 'loading' && view.sections.length === 0) {
        lines.push(renderLine('Loading settings…', width, profile, theme.roles.subtle))
      } else if (width >= SETTINGS_SPLIT_COLUMNS) {
        const leftWidth = Math.max(24, Math.floor((width - 1) * 0.36))
        const rightWidth = Math.max(1, width - leftWidth - 1)
        lines.push(...joinColumns(
          sectionLines(view, leftWidth, options),
          fieldLines(view, rightWidth, options),
          leftWidth,
          rightWidth,
          profile,
          theme.roles.subtle,
        ))
      } else if (view.pane === 'sections') {
        lines.push(...sectionLines(view, width, options))
      } else {
        lines.push(...fieldLines(view, width, options))
      }
      lines.push(renderLine(view.mode === 'confirm-close'
        ? 'Discard all unsaved edits and close? Press Enter to confirm.'
        : view.mode === 'confirm-reload'
          ? 'Discard all unsaved edits and reload? Press Enter to confirm.'
          : view.hint, width, profile, view.mode === 'list' ? theme.roles.subtle : theme.roles.warning))
      return lines
    },
    invalidate() {},
  }
}
