import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { TrajectoryInspectorView, TrajectoryViewModel } from '../../model/surfaces.js'
import { duration, safeLine } from './common.js'

export function createTrajectoryInspector(view: TrajectoryViewModel, profile: TerminalProfile, height = 6): Component {
  return {
    render(width) {
      if (width <= 0 || height <= 0) return []
      const detail: TrajectoryInspectorView = view.inspector
      const lines: string[] = []
      if (detail.status === 'loading') lines.push('Inspector loading…')
      else if (detail.status === 'error') lines.push(`Inspector error: ${detail.error ?? 'unknown'}`)
      else if (detail.status === 'missing' || detail.status === 'hidden') lines.push('Inspector: —')
      else {
        const focused = view.rows[view.cursor - view.windowStart]
        lines.push(`${detail.title || focused?.label || 'Inspector'}${focused?.durationMs === undefined ? '' : ` · ${duration(focused.durationMs)}`}`)
        if (detail.facts.length > 0) lines.push(detail.facts.join(' · '))
        for (const section of detail.sections) {
          if (lines.length >= height) break
          lines.push(`${section.title}: ${section.body}`)
        }
      }
      while (lines.length < height) lines.push('')
      return lines.slice(0, height).map((line) => safeLine(line, width, profile, detail.status === 'error' ? 'red' : 'bright-black'))
    },
    invalidate() {},
  }
}
