/** WP-08e1 loaded-context startup panel. */
import type { Component } from '../../renderer/component.js'
import { cellsToString, lineStyle, styledCells, truncateCells } from '../../renderer/lines.js'
import type { LoadedContextView } from '../../model/surfaces.js'
import type { TerminalProfile } from '../../terminal/profile.js'

export const CONTEXT_PANEL_MAX_LINES = 96

function makeLine(text: string, width: number, profile: TerminalProfile, foreground: string | null = null): string {
  if (width <= 0) return ''
  return cellsToString(truncateCells(styledCells(text, lineStyle({ foreground }), profile), width))
}

export function contextSummary(view: LoadedContextView): string {
  if (view.summary !== '') return view.summary
  if (view.loading) return 'loading context…'
  if (!view.available) return 'context unavailable'
  return 'no loaded context'
}

export function createContextPanel(view: LoadedContextView, profile: TerminalProfile, expanded = false): Component {
  return {
    render(width) {
      if (width <= 0) return []
      const lines: string[] = [makeLine(`${expanded ? '▼' : '▶'} context · ${contextSummary(view)}`, width, profile)]
      if (!expanded) return lines
      if (view.degradedNotice !== undefined) lines.push(makeLine(`! ${view.degradedNotice}`, width, profile, 'yellow'))
      const group = (title: string, entries: readonly { name: string; text: string }[]): void => {
        if (entries.length === 0 || lines.length >= CONTEXT_PANEL_MAX_LINES) return
        lines.push(makeLine(`${title} (${entries.length})`, width, profile, 'cyan'))
        for (const item of entries) {
          if (lines.length >= CONTEXT_PANEL_MAX_LINES) break
          lines.push(makeLine(`  ${item.name}`, width, profile))
          lines.push(makeLine(`    ${item.text}`, width, profile, 'bright-black'))
        }
      }
      group('sections', view.sections)
      group('runtime', view.contexts)
      if (view.files.length > 0 && lines.length < CONTEXT_PANEL_MAX_LINES) {
        lines.push(makeLine(`files (${view.files.length})`, width, profile, 'cyan'))
        for (const item of view.files) {
          if (lines.length >= CONTEXT_PANEL_MAX_LINES) break
          lines.push(makeLine(`  ${item.displayPath}`, width, profile, 'bright-black'))
        }
      }
      group('skills', view.skills.map((item) => ({ name: item.name, text: item.description })))
      group('tools', view.tools.map((item) => ({ name: item.name, text: item.description })))
      return lines.slice(0, CONTEXT_PANEL_MAX_LINES)
    },
    invalidate() {},
  }
}
