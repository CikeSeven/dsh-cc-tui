/**
 * WP-08e1 serialized surface contracts.
 *
 * These are the only values that cross the Channel -> v2 model boundary for
 * goal/todo, working activity and loaded context.  They intentionally contain
 * bounded display projections rather than Channel objects or session events.
 * Trajectory uses the same rule: the scene receives a finite index window and
 * asks the adapter for focused detail on demand.
 */
import type { SerializableValue } from './schema.js'

export const SURFACE_MAX_TODOS = 64
export const SURFACE_MAX_CONTEXT_ENTRIES = 64
export const SURFACE_MAX_CONTEXT_TEXT = 800
export const TRAJECTORY_MAX_ROWS = 128
export const TRAJECTORY_MAX_HOTSPOTS = 96
export const TRAJECTORY_MAX_PREVIEW = 160
export const TRAJECTORY_MAX_WAVE_BUCKETS = 160
export const TRAJECTORY_MAX_INSPECT_SECTIONS = 16
export const TRAJECTORY_MAX_INSPECT_LINES = 96

export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface GoalView {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly phase: GoalPhase
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly blockedReason?: { readonly code: string; readonly message: string }
}

export interface TodoView {
  readonly content: string
  readonly status: TodoStatus
}

export interface GoalTodoView {
  readonly goal: GoalView | null
  readonly todos: readonly TodoView[]
  readonly hiddenTodos: number
}

export type ActivityPhase = 'idle' | 'thinking' | 'tool' | 'done' | 'stalled'

export interface ActivityView {
  readonly phase: ActivityPhase
  readonly line: string
  readonly detail?: string
  readonly preset: string
  readonly frame: string
  readonly frameIndex: number
  readonly intervalMs: number
  readonly startedAt?: number
  readonly updatedAt?: number
  readonly contextPct?: number
}

export interface ContextEntryView {
  readonly name: string
  readonly text: string
}

export interface ContextFileView {
  readonly displayPath: string
}

export interface ContextSkillView {
  readonly name: string
  readonly description: string
}

export interface ContextToolView {
  readonly name: string
  readonly description: string
}

export interface LoadedContextView {
  readonly available: boolean
  readonly loading: boolean
  readonly sections: readonly ContextEntryView[]
  readonly contexts: readonly ContextEntryView[]
  readonly files: readonly ContextFileView[]
  readonly skills: readonly ContextSkillView[]
  readonly tools: readonly ContextToolView[]
  readonly summary: string
  readonly degradedNotice?: string
}

export interface ContextSegmentsView {
  readonly system: number
  readonly prompt: number
  readonly assistant: number
  readonly thinking: number
  readonly tools: number
}

export interface ContextUsageView {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface ContextBarView {
  readonly contextSegments: ContextSegmentsView
  readonly contextWindow: number | null
  readonly usage: ContextUsageView | null
}

export interface TrajectoryTokensView {
  readonly input: number
  readonly output: number
  readonly think: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface TrajectoryRowSummary {
  readonly seq: number
  readonly time: number
  readonly kind: string
  readonly turn: number
  readonly step?: number
  readonly label: string
  readonly detail?: string
  readonly outcome?: string
  readonly durationMs?: number
  readonly status?: 'running' | 'ok' | 'error'
  readonly tokens?: TrajectoryTokensView
  readonly errorCode?: string
  readonly attempts?: number
  readonly burstCount?: number
  readonly seed?: boolean
}

export interface TrajectoryWaveBucketView {
  readonly weight: number
  readonly count: number
  readonly input: number
  readonly model: number
  readonly tool: number
  readonly error: boolean
  readonly retry: boolean
  readonly running: boolean
  readonly firstIndex: number
}

export interface TrajectoryHotspotView {
  readonly label: string
  readonly totalMs: number
  readonly count: number
  readonly tokens: number
  readonly error?: boolean
  readonly firstIndex: number
}

export interface TrajectoryInspectorSectionView {
  readonly title: string
  readonly body: string
  readonly tone?: 'error' | 'dim'
}

export interface TrajectoryInspectorView {
  readonly status: 'hidden' | 'loading' | 'ready' | 'missing' | 'error'
  readonly seq: number | null
  readonly title: string
  readonly facts: readonly string[]
  readonly sections: readonly TrajectoryInspectorSectionView[]
  readonly error?: string
}

export interface TrajectoryViewModel {
  readonly sceneId: 'trajectory'
  readonly revision: number
  readonly sessionEpoch: string
  readonly status: 'loading' | 'ready' | 'empty' | 'error' | 'cancelled'
  readonly view: 'timeline' | 'hotspot'
  readonly projection: 'sequence' | 'time' | 'compressed'
  readonly sort: 'duration' | 'count' | 'tokens'
  readonly query: string
  readonly totalRows: number
  readonly cursor: number
  readonly windowStart: number
  readonly windowEnd: number
  readonly rows: readonly TrajectoryRowSummary[]
  readonly wave: readonly TrajectoryWaveBucketView[]
  readonly matchedWaveColumns: readonly number[]
  readonly hotspots: readonly TrajectoryHotspotView[]
  readonly hotspotTotal: number
  readonly inspector: TrajectoryInspectorView
  readonly totals: {
    readonly turns: number
    readonly steps: number
    readonly rows: number
    readonly calls: number
    readonly errors: number
    readonly retries: number
    readonly spanMs: number
    readonly toolMs: number
    readonly decodeMs: number
    readonly ttftMs: number
    readonly ttftSamples: number
    readonly retryMs: number
    readonly tokens: TrajectoryTokensView
  }
  readonly degradedNotice?: string
  readonly error?: string
}

export interface UiSurfaceView {
  readonly revision: number
  readonly sessionEpoch: string
  readonly activityEnabled: boolean
  readonly contextBarEnabled: boolean
  readonly goalTodo: GoalTodoView
  readonly activity: ActivityView | null
  readonly context: LoadedContextView
  readonly contextSegments: ContextSegmentsView
  readonly contextWindow: number | null
  readonly usage: ContextUsageView | null
}

/** The payload of `surface/update`; kept separate for future surface events. */
export interface SurfaceUpdatePayload {
  readonly surface: UiSurfaceView
}

/** A serializable helper used by adapters when creating default surface data. */
export function emptySurfaceView(sessionEpoch = ''): UiSurfaceView {
  return {
    revision: 0,
    sessionEpoch,
    activityEnabled: true,
    contextBarEnabled: true,
    goalTodo: { goal: null, todos: [], hiddenTodos: 0 },
    activity: null,
    context: {
      available: false,
      loading: true,
      sections: [],
      contexts: [],
      files: [],
      skills: [],
      tools: [],
      summary: '',
    },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    contextWindow: null,
    usage: null,
  }
}

/**
 * Keep a value compatible with the model schema at the explicit boundary.
 * TypeScript's structural typing cannot prove this for nested view models.
 */
export function asSerializableSurface(value: UiSurfaceView): SerializableValue {
  return value as unknown as SerializableValue
}
