/** Pure, bounded session-browser overlay component (WP-08d1). */
import type { SessionBrowserPayload, SessionCatalogRowView, SessionPreviewView } from '../../model/catalog-overlay-payloads.js'
import type { Component } from '../../renderer/component.js'
import { cellsToString, lineToCells, padCells, truncateCells } from '../../renderer/lines.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'
import { renderInputLine, renderLine, renderSegments, renderWrapped } from './overlay-text.js'

export const SESSION_PREVIEW_SPLIT_COLUMNS = 100

export interface SessionBrowserRenderOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

function formatWhen(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days <= 7) return `${days}d ago`
  try {
    return new Date(at).toISOString().slice(0, 10)
  } catch {
    return 'unknown time'
  }
}

function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function kindMark(kind: SessionCatalogRowView['sessionKind']): string {
  if (kind === 'fork') return '⑃ '
  if (kind === 'subagent') return '⑂ '
  return ''
}

function sessionRows(
  view: SessionBrowserPayload,
  width: number,
  options: SessionBrowserRenderOptions,
): string[] {
  const { profile, theme } = options
  if (view.phase === 'loading') return [renderLine('Loading sessions…', width, profile, theme.roles.subtle)]
  if (view.rows.length === 0) {
    return [renderLine(
      view.phase === 'error' ? 'The session catalog is unavailable.' : 'No resumable sessions match this view.',
      width,
      profile,
      view.phase === 'error' ? theme.roles.error : theme.roles.subtle,
    )]
  }
  const lines: string[] = []
  if (view.hasMoreAbove) lines.push(renderLine('↑ more sessions', width, profile, theme.roles.subtle))
  for (const row of view.rows) {
    if (row.kind === 'project') {
      lines.push(renderSegments([
        { text: ` ${row.cwd}`, style: theme.roles.accent },
        { text: ` · ${row.count}`, style: theme.roles.subtle },
      ], width, profile))
      continue
    }
    const selected = row.id === view.selectedId
    const indent = ' '.repeat(Math.min(4, row.depth * 2))
    const displayTitle = row.label ?? row.title
    lines.push(renderSegments([
      { text: `${indent}${selected ? '❯ ' : '  '}`, style: selected ? theme.roles.accent : theme.roles.subtle },
      { text: kindMark(row.sessionKind), style: row.sessionKind === 'subagent' ? theme.roles.success : theme.roles.accent },
      {
        text: displayTitle,
        style: selected
          ? { ...theme.roles.accent, bold: true }
          : row.titleSource === 'fallback' || row.titleSource === 'prompt'
            ? theme.roles.subtle
            : theme.roles.text,
      },
    ], width, profile))
    const facts = [row.cwd || '(cwd unavailable)', formatWhen(row.updatedAt, view.now)]
    if (row.branch !== undefined) facts.push(row.branch)
    const size = formatBytes(row.bytes)
    if (size !== undefined) facts.push(size)
    if (row.model !== undefined) facts.push(row.model)
    if (row.childCount > 0 && row.depth === 0) facts.push(`${row.childCount} runs`)
    lines.push(renderLine(`${indent}  ${facts.join(' · ')}`, width, profile, theme.roles.subtle))
  }
  if (view.hasMoreBelow) lines.push(renderLine('↓ more sessions', width, profile, theme.roles.subtle))
  return lines
}

function previewRows(
  preview: SessionPreviewView,
  width: number,
  options: SessionBrowserRenderOptions,
): string[] {
  const { profile, theme } = options
  if (width <= 0) return []
  const lines: string[] = [renderLine(preview.title ?? 'Session preview', width, profile, theme.roles.toolName)]
  if (preview.cwd !== undefined) lines.push(renderLine(preview.cwd, width, profile, theme.roles.subtle))
  if (preview.phase === 'loading') {
    lines.push(renderLine('Loading preview…', width, profile, theme.roles.subtle))
    return lines
  }
  if (preview.phase === 'error') {
    lines.push(renderLine(preview.error ?? 'Preview is unavailable.', width, profile, theme.roles.error))
    return lines
  }
  if (preview.entries.length === 0) {
    lines.push(renderLine('No message or tool summary is available.', width, profile, theme.roles.subtle))
    return lines
  }
  for (const entry of preview.entries) {
    const role = entry.role === 'user'
      ? { glyph: '❯', style: theme.roles.accent }
      : entry.role === 'tool'
        ? { glyph: '⚙', style: theme.roles.warning }
        : { glyph: '✦', style: theme.roles.subtle }
    const wrapped = renderWrapped(entry.text, Math.max(1, width - 2), profile, role.style, 2)
    wrapped.forEach((line, index) => {
      lines.push(renderSegments([
        { text: index === 0 ? `${role.glyph} ` : '  ', style: role.style },
        { text: line, style: role.style },
      ], width, profile))
    })
  }
  return lines.slice(0, 20)
}

function joinColumns(
  left: readonly string[],
  right: readonly string[],
  leftWidth: number,
  rightWidth: number,
  profile: TerminalProfile,
  dividerStyle: ComponentTheme['roles']['subtle'],
): string[] {
  const height = Math.max(left.length, right.length)
  const out: string[] = []
  for (let row = 0; row < height; row += 1) {
    const leftCells = padCells(truncateCells(lineToCells(left[row] ?? '', profile), leftWidth), leftWidth)
    const divider = lineToCells('│', profile).map((cell) => ({ ...cell, style: dividerStyle }))
    const rightCells = truncateCells(lineToCells(right[row] ?? '', profile), rightWidth)
    out.push(cellsToString([...leftCells, ...divider, ...rightCells]))
  }
  return out
}

export function createSessionBrowserDialog(
  view: SessionBrowserPayload,
  options: SessionBrowserRenderOptions,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const { profile, theme } = options
      const counts = [
        `${view.shownCount} shown`,
        view.hiddenSubagents > 0 ? `${view.hiddenSubagents} runs folded` : '',
        view.emptyCount > 0 ? `${view.emptyCount} empty/unrecoverable` : '',
      ].filter(Boolean).join(' · ')
      const current = view.current.title === undefined
        ? `Current: ${view.current.id}`
        : `Current: ${view.current.title}`
      const lines = [
        renderSegments([
          { text: view.title, style: theme.roles.toolName },
          { text: counts === '' ? '' : ` · ${counts}`, style: theme.roles.subtle },
        ], width, profile),
        renderLine(current, width, profile, theme.roles.subtle),
        renderInputLine(
          'Filter: ',
          view.filter.query,
          view.filter.cursor,
          width,
          profile,
          { text: theme.roles.text, caret: { ...theme.roles.accent, inverse: true }, placeholder: theme.roles.subtle },
          view.filter.allProjects ? 'all projects' : 'current project',
        ),
      ]

      const list = sessionRows(view, width, options)
      if (view.preview.open && width >= SESSION_PREVIEW_SPLIT_COLUMNS) {
        const leftWidth = Math.max(1, Math.floor((width - 1) * 0.56))
        const rightWidth = Math.max(0, width - leftWidth - 1)
        lines.push(...joinColumns(
          sessionRows(view, leftWidth, options),
          previewRows(view.preview, rightWidth, options),
          leftWidth,
          rightWidth,
          profile,
          theme.roles.subtle,
        ))
      } else if (view.preview.open) {
        lines.push(...previewRows(view.preview, width, options))
      } else {
        lines.push(...list)
      }

      if (view.mode === 'confirm-delete' && view.selectedId !== undefined) {
        const selected = view.rows.find((row) => row.kind === 'session' && row.id === view.selectedId)
        lines.push(renderLine(
          selected?.kind === 'session' ? `Delete “${selected.title}” permanently?` : 'Delete this session permanently?',
          width,
          profile,
          theme.roles.error,
        ))
      } else if (view.mode === 'rename' && view.draft !== undefined) {
        lines.push(renderInputLine(
          'Rename: ',
          view.draft.text,
          view.draft.cursor,
          width,
          profile,
          { text: theme.roles.text, caret: { ...theme.roles.accent, inverse: true }, placeholder: theme.roles.subtle },
          'session title',
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
      if (view.error !== undefined) lines.push(renderLine(view.error, width, profile, theme.roles.error))
      lines.push(renderLine(view.hint, width, profile, theme.roles.subtle))
      return lines
    },
    invalidate() {},
  }
}
