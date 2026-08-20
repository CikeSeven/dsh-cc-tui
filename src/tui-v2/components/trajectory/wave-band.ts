import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { TrajectoryViewModel } from '../../model/surfaces.js'
import { safeLine } from './common.js'

const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

export function createTrajectoryWave(view: TrajectoryViewModel, profile: TerminalProfile): Component {
  return {
    render(width) {
      if (width <= 0) return []
      const buckets = view.wave.slice(0, width)
      if (buckets.length === 0) return [safeLine('·', width, profile, 'bright-black')]
      const weights = buckets.map((bucket) => bucket.weight).filter((weight) => weight > 0)
      const floor = Math.min(...weights, 0)
      const peak = Math.max(...weights, 1)
      const span = Math.max(1, Math.log1p(peak) - Math.log1p(floor))
      const matched = new Set(view.matchedWaveColumns)
      const glyphs = buckets.map((bucket, index) => {
        if (bucket.count === 0) return '·'
        if (bucket.running) return '▶'
        const level = Math.max(1, Math.min(LEVELS.length, Math.round(((Math.log1p(bucket.weight) - Math.log1p(floor)) / span) * (LEVELS.length - 1)) + 1))
        return matched.size > 0 && !matched.has(index) ? '░' : LEVELS[level - 1]
      }).join('')
      return [safeLine(glyphs, width, profile, view.status === 'error' ? 'red' : 'cyan')]
    },
    invalidate() {},
  }
}
