/**
 * WP-08e1 business projection boundary.
 *
 * This module is deliberately outside `src/tui-v2/components`: it is the only
 * place that reads Channel fields and the trajectory adapter. Consumers receive
 * serializable surface data or a bounded trajectory window, never Channel or
 * raw session events.
 */
import type { Clock } from '../tui-v2/model/schema.js'
import type {
  ActivityView,
  ContextEntryView,
  ContextFileView,
  ContextSegmentsView,
  ContextSkillView,
  ContextToolView,
  ContextUsageView,
  GoalTodoView,
  GoalView,
  LoadedContextView,
  TodoView,
  TrajectoryHotspotView,
  TrajectoryInspectorSectionView,
  TrajectoryRowSummary,
  TrajectoryTokensView,
  TrajectoryViewModel,
  TrajectoryWaveBucketView,
  UiSurfaceView,
} from '../tui-v2/model/surfaces.js'
import {
  emptySurfaceView,
  SURFACE_MAX_CONTEXT_ENTRIES,
  SURFACE_MAX_CONTEXT_TEXT,
  SURFACE_MAX_TODOS,
  TRAJECTORY_MAX_HOTSPOTS,
  TRAJECTORY_MAX_INSPECT_LINES,
  TRAJECTORY_MAX_INSPECT_SECTIONS,
  TRAJECTORY_MAX_PREVIEW,
  TRAJECTORY_MAX_ROWS,
  TRAJECTORY_MAX_WAVE_BUCKETS,
} from '../tui-v2/model/surfaces.js'
import type { Channel, ChannelGoal, LoadedContext, TodoPanelItem } from './channel.js'
import {
  aggregate,
  buildTrajectory,
  extendTrajectory,
  inspectNode,
  previewText,
  type HotspotSort,
  type TrajBuild,
  type TrajNode,
  type WaveProjection,
} from './trajectory/index.js'
import { projectWave } from './trajectory/wave.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export type SurfaceChannel = Pick<
  Channel,
  | 'agentId'
  | 'activityEnabled'
  | 'activityFrames'
  | 'working'
  | 'contextBarEnabled'
  | 'contextSegments'
  | 'contextWindow'
  | 'lastUsage'
  | 'workingActivity'
  | 'goal'
  | 'todos'
  | 'loadedContext'
  | 'setActivityFrames'
  | 'traceEvents'
  | 'subscribe'
>

const DEFAULT_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface TrajectoryAdapterSnapshot {
  readonly identity: string
  readonly generation: number
  readonly revision: number
  readonly status: 'ready' | 'empty'
  readonly totalRows: number
  readonly windowStart: number
  readonly windowEnd: number
  readonly rows: readonly TrajectoryRowSummary[]
  readonly wave: readonly TrajectoryWaveBucketView[]
  readonly matchedWaveColumns: readonly number[]
  readonly hotspots: readonly TrajectoryHotspotView[]
  readonly hotspotTotal: number
  readonly totals: TrajectoryViewModel['totals']
}

export interface TrajectoryInspectResult {
  readonly identity: string
  readonly generation: number
  readonly seq: number
  readonly detail: {
    readonly title: string
    readonly facts: readonly string[]
    readonly sections: readonly TrajectoryInspectorSectionView[]
  }
}

export interface TrajectorySnapshotOptions {
  readonly sort?: HotspotSort
  readonly projection?: WaveProjection
  readonly query?: string
  readonly cursor?: number
  readonly windowRows?: number
  readonly waveWidth?: number
}

export interface ChannelSurfaceAdapter {
  snapshot(sessionEpoch?: string): UiSurfaceView
  trajectorySnapshot(options?: TrajectorySnapshotOptions): Promise<TrajectoryAdapterSnapshot>
  inspectTrajectory(seq: number, identity: string, generation: number): Promise<TrajectoryInspectResult | null>
  setActivityFrames(name: string): boolean
  subscribe(listener: () => void): () => void
  dispose(): void
}

function boundedText(value: unknown, max = SURFACE_MAX_CONTEXT_TEXT): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function entry(name: unknown, text: unknown): ContextEntryView {
  return { name: boundedText(name, 160), text: boundedText(text) }
}

function loadedContextView(context: LoadedContext | undefined): LoadedContextView {
  if (context === undefined) {
    return { available: false, loading: true, sections: [], contexts: [], files: [], skills: [], tools: [], summary: '' }
  }
  const sections: ContextEntryView[] = context.sections.slice(0, SURFACE_MAX_CONTEXT_ENTRIES).map((item) => entry(item.name, item.text))
  const contexts: ContextEntryView[] = context.contexts.slice(0, SURFACE_MAX_CONTEXT_ENTRIES).map((item) => entry(item.name, item.text))
  const files: ContextFileView[] = context.files.slice(0, SURFACE_MAX_CONTEXT_ENTRIES).map((item) => ({ displayPath: boundedText(item.displayPath, 240) }))
  const skills: ContextSkillView[] = context.skills.slice(0, SURFACE_MAX_CONTEXT_ENTRIES).map((item) => ({ name: boundedText(item.name, 160), description: boundedText(item.description) }))
  const tools: ContextToolView[] = context.tools.slice(0, SURFACE_MAX_CONTEXT_ENTRIES).map((item) => ({ name: boundedText(item.name, 160), description: boundedText(item.description, 320) }))
  const summary = [
    sections.length > 0 ? `sections ${sections.length}` : '',
    contexts.length > 0 ? `runtime ${contexts.length}` : '',
    files.length > 0 ? `files ${files.length}` : '',
    skills.length > 0 ? `skills ${skills.length}` : '',
    tools.length > 0 ? `tools ${tools.length}` : '',
  ].filter(Boolean).join(' · ')
  return { available: true, loading: false, sections, contexts, files, skills, tools, summary }
}

function goalView(goal: ChannelGoal | undefined): GoalView | null {
  if (goal === undefined) return null
  return {
    id: boundedText(goal.id, 120), revision: Math.max(0, goal.revision), objective: boundedText(goal.objective), phase: goal.phase,
    maxGoalRounds: Math.max(0, goal.maxGoalRounds), roundsStarted: Math.max(0, goal.roundsStarted),
    ...(goal.blockedReason === undefined ? {} : { blockedReason: { code: boundedText(goal.blockedReason.code, 120), message: boundedText(goal.blockedReason.message) } }),
  }
}

function todoView(todo: TodoPanelItem): TodoView { return { content: boundedText(todo.content), status: todo.status } }

function goalTodoView(channel: SurfaceChannel): GoalTodoView {
  const all = channel.todos ?? []
  const todos = channel.working ? all : all.filter((todo) => todo.status !== 'completed')
  return {
    goal: goalView(channel.goal),
    todos: todos.slice(0, SURFACE_MAX_TODOS).map(todoView),
    hiddenTodos: Math.max(0, todos.length - SURFACE_MAX_TODOS),
  }
}

function contextUsage(channel: SurfaceChannel): ContextUsageView | null {
  const usage = channel.lastUsage
  return usage === undefined ? null : { input: Math.max(0, usage.input), cacheRead: Math.max(0, usage.cacheRead), cacheWrite: Math.max(0, usage.cacheWrite) }
}

function activityView(channel: SurfaceChannel): ActivityView | null {
  const activity = channel.workingActivity
  if (activity === undefined) return null
  const phase = activity.phase === 'waiting' ? 'thinking' : activity.phase
  return {
    phase, line: boundedText(activity.line), ...(activity.detail === undefined ? {} : { detail: boundedText(activity.detail, 240) }),
    preset: boundedText(channel.activityFrames ?? 'claude', 80), frame: '·', frameIndex: 0, intervalMs: 150,
    startedAt: activity.phaseStartedAt, updatedAt: activity.phaseStartedAt,
  }
}

function surfaceSignature(view: UiSurfaceView): string { return JSON.stringify({ ...view, revision: undefined }) }

function nodeMatches(node: TrajNode, query: string): boolean {
  if (query === '') return true
  return `${node.kind} ${node.label} ${node.detail ?? ''} ${node.outcome ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
}

function tokenView(node: TrajNode): TrajectoryTokensView | undefined {
  return node.tokens === undefined ? undefined : { ...node.tokens }
}

function rowSummary(node: TrajNode): TrajectoryRowSummary {
  return {
    seq: node.seq, time: node.time, kind: node.kind, turn: node.turn,
    ...(node.step === undefined ? {} : { step: node.step }), label: previewText(node.label, TRAJECTORY_MAX_PREVIEW),
    ...(node.detail === undefined ? {} : { detail: previewText(node.detail, TRAJECTORY_MAX_PREVIEW) }),
    ...(node.outcome === undefined ? {} : { outcome: previewText(node.outcome, TRAJECTORY_MAX_PREVIEW) }),
    ...(node.durationMs === undefined ? {} : { durationMs: node.durationMs }),
    ...(node.status === undefined ? {} : { status: node.status }), ...(tokenView(node) === undefined ? {} : { tokens: tokenView(node) }),
    ...(node.errorCode === undefined ? {} : { errorCode: previewText(node.errorCode, 80) }),
    ...(node.attempts === undefined ? {} : { attempts: node.attempts }), ...(node.burst === undefined ? {} : { burstCount: node.burst.members.length }),
    ...(node.seed === undefined ? {} : { seed: node.seed }),
  }
}

export function createChannelSurfaceAdapter(channel: SurfaceChannel, _clock: Clock = DEFAULT_CLOCK): ChannelSurfaceAdapter {
  let revision = 0
  let lastSignature = ''
  let lastView = emptySurfaceView()
  const listeners = new Set<() => void>()
  let trajectoryBuild: TrajBuild | null = null
  let trajectoryEvents: readonly SessionEvent[] = []
  let trajectoryIdentity = channel.agentId
  let trajectoryGeneration = 1
  let trajectoryRevision = 0
  let disposed = false
  const unsubscribeChannel = channel.subscribe(() => {
    if (disposed) return
    for (const listener of [...listeners]) listener()
  })

  const snapshot = (sessionEpoch = `${channel.agentId}`): UiSurfaceView => {
    const segments = channel.contextSegments ?? { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }
    const view: UiSurfaceView = {
      ...emptySurfaceView(sessionEpoch), revision, sessionEpoch,
      activityEnabled: channel.activityEnabled !== false, contextBarEnabled: channel.contextBarEnabled !== false,
      goalTodo: goalTodoView(channel), activity: activityView(channel), context: loadedContextView(channel.loadedContext),
      contextSegments: { system: Math.max(0, segments.system), prompt: Math.max(0, segments.prompt), assistant: Math.max(0, segments.assistant), thinking: Math.max(0, segments.thinking), tools: Math.max(0, segments.tools) },
      contextWindow: channel.contextWindow === undefined ? null : Math.max(0, channel.contextWindow), usage: contextUsage(channel),
    }
    const signature = surfaceSignature(view)
    if (signature !== lastSignature) { lastSignature = signature; revision += 1; lastView = Object.freeze({ ...view, revision }) as UiSurfaceView }
    return lastView
  }

  const updateTrajectory = (): { events: readonly SessionEvent[]; build: TrajBuild } => {
    const events = channel.traceEvents?.() ?? []
    if (channel.agentId !== trajectoryIdentity) { trajectoryIdentity = channel.agentId; trajectoryGeneration += 1; trajectoryBuild = null; trajectoryEvents = [] }
    if (events !== trajectoryEvents) { trajectoryBuild = extendTrajectory(trajectoryBuild, events); trajectoryEvents = events; trajectoryRevision += 1 }
    if (trajectoryBuild === null) { trajectoryBuild = buildTrajectory(events); trajectoryEvents = events; trajectoryRevision += 1 }
    return { events, build: trajectoryBuild }
  }

  const trajectorySnapshot = async (options: TrajectorySnapshotOptions = {}): Promise<TrajectoryAdapterSnapshot> => {
    if (disposed) throw new Error('surface adapter disposed')
    const current = updateTrajectory()
    await Promise.resolve()
    const query = options.query ?? ''
    const filtered = current.build.nodes.filter((node) => nodeMatches(node, query))
    const totalRows = filtered.length
    const windowRows = Math.max(1, Math.min(TRAJECTORY_MAX_ROWS, options.windowRows ?? 24))
    const cursor = Math.max(0, Math.min(Math.max(0, totalRows - 1), options.cursor ?? 0))
    const windowStart = totalRows === 0 ? 0 : Math.max(0, Math.min(cursor - Math.floor(windowRows / 2), Math.max(0, totalRows - windowRows)))
    const projection = options.projection ?? 'compressed'
    const waveWidth = Math.max(1, Math.min(TRAJECTORY_MAX_WAVE_BUCKETS, options.waveWidth ?? 120))
    const band = projectWave(current.build.nodes, waveWidth, projection)
    const matched = new Set(filtered.map((node) => current.build.nodes.indexOf(node)))
    const matchedWaveColumns = band.buckets.map((bucket, index) => matched.has(bucket.firstIndex) ? index : -1).filter((index) => index >= 0)
    const agg = aggregate(current.build, options.sort ?? 'duration')
    const totals = { ...agg.totals, tokens: { ...agg.totals.tokens } }
    return {
      identity: trajectoryIdentity, generation: trajectoryGeneration, revision: trajectoryRevision,
      status: totalRows === 0 ? 'empty' : 'ready', totalRows, windowStart, windowEnd: windowStart + Math.min(windowRows, totalRows),
      rows: filtered.slice(windowStart, windowStart + windowRows).map(rowSummary),
      wave: band.buckets.map((bucket) => ({ weight: bucket.weight, count: bucket.count, input: bucket.channels.input, model: bucket.channels.model, tool: bucket.channels.tool, error: bucket.error, retry: bucket.retry, running: bucket.running, firstIndex: bucket.firstIndex })),
      matchedWaveColumns, hotspots: [...agg.tools, ...agg.model, ...agg.turns].slice(0, TRAJECTORY_MAX_HOTSPOTS).map((row) => ({ ...row })),
      hotspotTotal: agg.tools.length + agg.model.length + agg.turns.length, totals,
    }
  }

  return {
    snapshot,
    trajectorySnapshot,
    async inspectTrajectory(seq, identity, generation) {
      if (disposed) return null
      const current = updateTrajectory()
      await Promise.resolve()
      if (identity !== trajectoryIdentity || generation !== trajectoryGeneration) return null
      const node = current.build.nodes.find((candidate) => candidate.seq === seq)
      if (node === undefined) return null
      const detail = inspectNode(node, current.events)
      return {
        identity, generation, seq,
        detail: {
          title: boundedText(detail.title, TRAJECTORY_MAX_PREVIEW),
          facts: detail.facts.slice(0, TRAJECTORY_MAX_INSPECT_SECTIONS).map((fact) => boundedText(fact, TRAJECTORY_MAX_PREVIEW)),
          sections: detail.sections.slice(0, TRAJECTORY_MAX_INSPECT_SECTIONS).map((section) => ({
            title: boundedText(section.title, 80), body: boundedText(section.body.split('\n').slice(0, TRAJECTORY_MAX_INSPECT_LINES).join('\n'), TRAJECTORY_MAX_INSPECT_LINES * TRAJECTORY_MAX_PREVIEW),
            ...(section.tone === undefined ? {} : { tone: section.tone }),
          })),
        },
      }
    },
    setActivityFrames(name) {
      if (typeof channel.setActivityFrames !== 'function') return false
      const ok = channel.setActivityFrames(name)
      if (ok) { revision += 1; for (const listener of [...listeners]) listener() }
      return ok
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    dispose() { if (disposed) return; disposed = true; unsubscribeChannel(); listeners.clear(); trajectoryBuild = null; trajectoryEvents = [] },
  }
}
