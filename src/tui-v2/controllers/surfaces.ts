/** WP-08e1 surface/controller clock ownership. */
import type { Clock, RandomSource } from '../model/schema.js'
import type { ActivityView, UiSurfaceView } from '../model/surfaces.js'
import type { ChannelSurfaceAdapter } from '../../dsh-adapter/ui-surfaces.js'
import { FRAME_PRESETS, isPresetName } from '../../utils/activityFrames.js'

/** Shared neutral preset table: v2 accepts every preset the production Channel persists. */
const PRESETS = FRAME_PRESETS

export interface ActivityControllerOptions {
  readonly clock: Clock
  readonly random?: RandomSource
  readonly stallMs?: number
  readonly onFrame?: () => void
  readonly onDiagnostic?: (code: string, details?: Record<string, unknown>) => void
}

export interface ActivityController {
  update(surface: UiSurfaceView): void
  view(activity: ActivityView | null): ActivityView | null
  setPreset(name: string): boolean
  start(): void
  stop(): void
  dispose(): void
  diagnostics(): { readonly ticks: number; readonly stalls: number; readonly invalidPresets: number }
}

export function createActivityController(options: ActivityControllerOptions): ActivityController {
  const stallMs = Math.max(250, options.stallMs ?? 4_000)
  let timer: unknown = null
  let running = false
  let frameIndex = 0
  let requestedPresetName = 'claude'
  let presetName = 'claude'
  let current: UiSurfaceView | null = null
  let ticks = 0
  let stalls = 0
  let invalidPresets = 0

  const pickRandomPreset = (): string => {
    const names = Object.keys(PRESETS)
    const random = options.random?.next() ?? 0
    return names[Math.min(names.length - 1, Math.max(0, Math.floor(random * names.length)))] ?? 'claude'
  }
  const selectPreset = (name: string): void => {
    requestedPresetName = name
    presetName = name === 'random' ? pickRandomPreset() : name
    frameIndex = 0
  }
  const preset = (): { readonly frames: readonly string[]; readonly intervalMs: number } => PRESETS[presetName] ?? PRESETS.claude!
  const nextDelay = (): number => Math.max(16, preset().intervalMs)
  const clear = (): void => {
    if (timer !== null) options.clock.clearTimeout(timer)
    timer = null
  }
  const schedule = (): void => {
    clear()
    if (!running) return
    timer = options.clock.setTimeout(() => {
      if (!running) return
      frameIndex = (frameIndex + 1) % Math.max(1, preset().frames.length)
      ticks += 1
      options.onFrame?.()
      schedule()
    }, nextDelay())
  }
  const controller: ActivityController = {
    update(surface) {
      current = surface
      const activity = surface.activity
      if (
        activity !== null
        && activity.preset !== ''
        && isPresetName(activity.preset)
        && activity.preset !== requestedPresetName
      ) {
        selectPreset(activity.preset)
      }
      if (activity === null || activity.phase === 'idle' || !surface.activityEnabled) {
        running = false
        clear()
      } else if (!running) {
        running = true
        schedule()
      }
    },
    view(activity) {
      if (activity === null || activity.phase === 'idle' || current?.activityEnabled === false) return null
      const selected = preset()
      const now = options.clock.now()
      const stale = activity.updatedAt !== undefined && now - activity.updatedAt >= stallMs && activity.phase !== 'done' && activity.phase !== 'stalled'
      if (stale) stalls += 1
      const phase = stale ? 'stalled' : activity.phase
      const frames = selected.frames.length === 0 ? ['·'] : selected.frames
      return {
        ...activity,
        phase,
        preset: presetName,
        frameIndex: frameIndex % frames.length,
        frame: frames[frameIndex % frames.length] ?? '·',
        intervalMs: selected.intervalMs,
      }
    },
    setPreset(name) {
      const normalized = name.trim().toLowerCase()
      if (!isPresetName(normalized)) {
        invalidPresets += 1
        options.onDiagnostic?.('activity/invalid-preset', { name: normalized })
        return false
      }
      selectPreset(normalized)
      schedule()
      options.onFrame?.()
      return true
    },
    start() {
      if (running) return
      running = true
      schedule()
    },
    stop() {
      running = false
      clear()
    },
    dispose() {
      running = false
      clear()
      current = null
    },
    diagnostics: () => ({ ticks, stalls, invalidPresets }),
  }
  return controller
}

export interface SurfaceController {
  readonly activity: ActivityController
  refresh(surface: UiSurfaceView): void
  setActivityPreset(name: string): boolean
  toggleActivity(): boolean
  activityEnabled(): boolean
  dispose(): void
}

export function createSurfaceController(options: {
  readonly adapter: ChannelSurfaceAdapter
  readonly clock: Clock
  readonly onRender?: () => void
  readonly onDiagnostic?: (code: string, details?: Record<string, unknown>) => void
}): SurfaceController {
  const activity = createActivityController({
    clock: options.clock,
    onFrame: options.onRender,
    onDiagnostic: options.onDiagnostic,
  })
  let disposed = false
  let lastSurface: UiSurfaceView | null = null
  let enabledOverride: boolean | null = null
  const effective = (surface: UiSurfaceView): UiSurfaceView => ({
    ...surface,
    activityEnabled: enabledOverride ?? surface.activityEnabled,
  })
  return {
    activity,
    refresh(surface) {
      if (disposed) return
      lastSurface = surface
      activity.update(effective(surface))
    },
    setActivityPreset(name) {
      if (disposed) return false
      const ok = activity.setPreset(name)
      if (ok) options.adapter.setActivityFrames(name)
      return ok
    },
    toggleActivity() {
      if (disposed) return false
      enabledOverride = !(enabledOverride ?? lastSurface?.activityEnabled ?? true)
      if (lastSurface !== null) activity.update(effective(lastSurface))
      options.onRender?.()
      return enabledOverride
    },
    activityEnabled() {
      return enabledOverride ?? lastSurface?.activityEnabled ?? true
    },
    dispose() {
      if (disposed) return
      disposed = true
      activity.dispose()
    },
  }
}

export { PRESETS as ACTIVITY_PRESETS }
