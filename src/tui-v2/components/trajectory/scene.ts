import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { TrajectoryViewModel } from '../../model/surfaces.js'
import { safeLine, tokenCount } from './common.js'
import { createTrajectoryHotspot } from './hotspot.js'
import { createTrajectoryInspector } from './inspector.js'
import { createTrajectoryLedger } from './ledger.js'
import { createTrajectoryWave } from './wave-band.js'

export function createTrajectoryScene(view: TrajectoryViewModel, profile: TerminalProfile): Component {
  return {
    render(width) {
      if (width <= 0) return []
      const header = safeLine(
        `✦ Trajectory · ${view.totalRows} rows · ${view.totals.errors ? `!${view.totals.errors} errors · ` : ''}${tokenCount(view.totals.tokens.output)} out`,
        width,
        profile,
        view.totals.errors > 0 ? 'red' : 'cyan',
      )
      const degraded = view.degradedNotice === undefined ? [] : [safeLine(`! ${view.degradedNotice}`, width, profile, 'yellow')]
      const tabs = safeLine(
        `${view.view === 'timeline' ? '●' : '○'} timeline  ${view.view === 'hotspot' ? '●' : '○'} hotspots  · ${view.query ? `/ ${view.query}` : 'm projection / t sort'}`,
        width,
        profile,
        'bright-black',
      )
      const wave = createTrajectoryWave(view, profile).render(width)
      const body = view.view === 'timeline'
        ? createTrajectoryLedger(view, profile).render(width)
        : createTrajectoryHotspot(view, profile).render(width)
      const inspectorHeight = Math.max(1, Math.min(6, view.view === 'timeline' ? 6 : 3))
      const inspector = createTrajectoryInspector(view, profile, inspectorHeight).render(width)
      const hints = safeLine('↑↓ move · PgUp/PgDn page · / filter · m projection · t sort · Enter inspect · q/Esc close', width, profile, 'bright-black')
      return [header, ...degraded, tabs, ...wave, ...body, ...inspector, hints]
    },
    invalidate() {},
  }
}
