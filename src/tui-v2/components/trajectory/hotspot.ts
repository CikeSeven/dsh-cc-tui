import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { TrajectoryViewModel, TrajectoryHotspotView } from '../../model/surfaces.js'
import { duration, safeLine, tokenCount } from './common.js'

function value(row: TrajectoryHotspotView, sort: TrajectoryViewModel['sort']): number {
  return sort === 'count' ? row.count : sort === 'tokens' ? row.tokens : row.totalMs
}

export function createTrajectoryHotspot(view: TrajectoryViewModel, profile: TerminalProfile): Component {
  return {
    render(width) {
      if (width <= 0) return []
      if (view.status === 'loading') return [safeLine('Loading hotspots…', width, profile, 'bright-black')]
      const rows = view.hotspots
      if (rows.length === 0) return [safeLine('No hotspot data', width, profile, 'bright-black')]
      const max = Math.max(...rows.map((row) => value(row, view.sort)), 1)
      return rows.map((row, index) => {
        const focused = index === view.cursor
        const barWidth = Math.max(4, Math.min(28, Math.floor(width * 0.32)))
        const n = Math.max(0, Math.min(barWidth, Math.round((value(row, view.sort) / max) * barWidth)))
        const stats = `${row.count}× · ${duration(row.totalMs)}${row.tokens > 0 ? ` · ${tokenCount(row.tokens)}` : ''}`
        return safeLine(`${focused ? '▸' : ' '} ${row.label} ${'█'.repeat(n)} ${stats}`, width, profile, row.error ? 'red' : focused ? 'cyan' : null)
      })
    },
    invalidate() {},
  }
}
