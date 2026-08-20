import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { TrajectoryViewModel } from '../../model/surfaces.js'
import { duration, safeLine, tokenCount } from './common.js'

export function createTrajectoryLedger(view: TrajectoryViewModel, profile: TerminalProfile): Component {
  return {
    render(width) {
      if (width <= 0) return []
      if (view.status === 'loading') return [safeLine('Loading trajectory…', width, profile, 'bright-black')]
      if (view.status === 'error') return [safeLine(`Trajectory error: ${view.error ?? 'unknown error'}`, width, profile, 'red')]
      if (view.status === 'cancelled') return [safeLine('Trajectory cancelled', width, profile, 'yellow')]
      if (view.status === 'empty' || view.rows.length === 0) return [safeLine('No trajectory events', width, profile, 'bright-black')]
      const lines: string[] = []
      for (let i = 0; i < view.rows.length; i += 1) {
        const row = view.rows[i]!
        const absolute = view.windowStart + i
        const focused = absolute === view.cursor
        const marker = focused ? '▸' : ' '
        const status = row.status === 'error' ? '!' : row.status === 'running' ? '…' : ' '
        const detail = row.detail === undefined ? '' : ` ${row.detail}`
        const outcome = row.outcome === undefined ? '' : ` → ${row.outcome}`
        const tokens = row.tokens === undefined ? '' : ` · ${tokenCount(row.tokens.output)}t`
        const burst = row.burstCount === undefined ? '' : ` ×${row.burstCount}`
        const text = `${marker}${status} ${row.label}${burst}${detail}${outcome}  ${duration(row.durationMs)}${tokens}`
        lines.push(safeLine(text, width, profile, row.status === 'error' ? 'red' : focused ? 'cyan' : row.seed ? 'bright-black' : null))
      }
      return lines
    },
    invalidate() {},
  }
}
