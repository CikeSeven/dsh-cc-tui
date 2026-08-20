/** WP-08e1 trajectory controller: bounded projection + async identity guards. */
import type { Clock } from '../model/schema.js'
import type { TerminalInputEvent } from '../terminal/query.js'
import type {
  TrajectoryInspectorView,
  TrajectoryViewModel,
} from '../model/surfaces.js'
import {
  TRAJECTORY_MAX_INSPECT_LINES,
  TRAJECTORY_MAX_INSPECT_SECTIONS,
  TRAJECTORY_MAX_PREVIEW,
  TRAJECTORY_MAX_ROWS,
  TRAJECTORY_MAX_WAVE_BUCKETS,
} from '../model/surfaces.js'
import type {
  ChannelSurfaceAdapter,
  TrajectoryAdapterSnapshot,
  TrajectorySnapshotOptions,
} from '../../dsh-adapter/ui-surfaces.js'
import type { HotspotSort, WaveProjection } from '../../dsh-adapter/trajectory/index.js'

export interface TrajectoryControllerOptions {
  readonly adapter: ChannelSurfaceAdapter
  readonly clock: Clock
  readonly windowRows?: number
  readonly waveWidth?: number
  readonly degradedNotice?: string
  readonly onView?: (view: TrajectoryViewModel) => void
  readonly onDiagnostic?: (code: string, details?: Record<string, unknown>) => void
}

export interface TrajectoryController {
  open(): Promise<void>
  close(): void
  refresh(): Promise<void>
  handleInput(event: string | TerminalInputEvent): void
  invalidate(): void
  view(): TrajectoryViewModel
  bindClose(close: (() => void) | null): void
  dispose(): void
  diagnostics(): { readonly opens: number; readonly closes: number; readonly staleResults: number; readonly errors: number }
}

const EMPTY_INSPECTOR: TrajectoryInspectorView = { status: 'hidden', seq: null, title: '', facts: [], sections: [] }
const ZERO_TOTALS: TrajectoryViewModel['totals'] = {
  turns: 0, steps: 0, rows: 0, calls: 0, errors: 0, retries: 0, spanMs: 0, toolMs: 0,
  decodeMs: 0, ttftMs: 0, ttftSamples: 0, retryMs: 0,
  tokens: { input: 0, output: 0, think: 0, cacheRead: 0, cacheWrite: 0 },
}

export function createTrajectoryController(options: TrajectoryControllerOptions): TrajectoryController {
  const windowRows = Math.max(1, Math.min(TRAJECTORY_MAX_ROWS, options.windowRows ?? 24))
  const waveWidth = Math.max(1, Math.min(TRAJECTORY_MAX_WAVE_BUCKETS, options.waveWidth ?? 120))
  let snapshot: TrajectoryAdapterSnapshot | null = null
  let viewName: 'timeline' | 'hotspot' = 'timeline'
  let projection: WaveProjection = 'compressed'
  let sort: HotspotSort = 'duration'
  let query = ''
  let queryOpen = false
  let cursor = 0
  let inspector: TrajectoryInspectorView = EMPTY_INSPECTOR
  let loadStatus: 'loading' | 'error' | 'cancelled' = 'loading'
  let errorMessage: string | undefined
  let revision = 0
  let operation = 0
  let disposed = false
  let onClose: (() => void) | null = null
  let opens = 0
  let closes = 0
  let staleResults = 0
  let errors = 0

  const currentView = (): TrajectoryViewModel => {
    const current = snapshot
    const status: TrajectoryViewModel['status'] = current === null
      ? loadStatus
      : current.status === 'empty' ? 'empty' : 'ready'
    const maxCursor = viewName === 'hotspot'
      ? Math.max(0, (current?.hotspots.length ?? 0) - 1)
      : Math.max(0, (current?.totalRows ?? 0) - 1)
    const boundedCursor = Math.min(Math.max(0, cursor), maxCursor)
    cursor = boundedCursor
    return {
      sceneId: 'trajectory', revision, sessionEpoch: current?.identity ?? '', status,
      view: viewName, projection, sort, query, totalRows: current?.totalRows ?? 0,
      cursor: boundedCursor, windowStart: current?.windowStart ?? 0, windowEnd: current?.windowEnd ?? 0,
      rows: current?.rows ?? [], wave: current?.wave ?? [], matchedWaveColumns: current?.matchedWaveColumns ?? [],
      hotspots: current?.hotspots ?? [], hotspotTotal: current?.hotspotTotal ?? 0, inspector,
      totals: current?.totals ?? ZERO_TOTALS,
      ...(options.degradedNotice === undefined ? {} : { degradedNotice: options.degradedNotice }),
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
    }
  }

  const publish = (): void => {
    revision += 1
    options.onView?.(currentView())
  }

  const focusedSeq = (): number | null => {
    if (snapshot === null || viewName !== 'timeline') return null
    const offset = cursor - snapshot.windowStart
    return snapshot.rows[offset]?.seq ?? null
  }

  const inspect = (): void => {
    const seq = focusedSeq()
    if (seq === null || snapshot === null) {
      inspector = EMPTY_INSPECTOR
      publish()
      return
    }
    const token = ++operation
    const identity = snapshot.identity
    const generation = snapshot.generation
    inspector = { status: 'loading', seq, title: snapshot.rows[cursor - snapshot.windowStart]?.label ?? '', facts: [], sections: [] }
    publish()
    void options.adapter.inspectTrajectory(seq, identity, generation).then((result) => {
      if (disposed || token !== operation || result === null || snapshot === null || result.identity !== identity || result.generation !== generation) {
        staleResults += 1
        return
      }
      inspector = {
        status: 'ready', seq: result.seq, title: result.detail.title,
        facts: result.detail.facts.slice(0, TRAJECTORY_MAX_INSPECT_SECTIONS),
        sections: result.detail.sections.slice(0, TRAJECTORY_MAX_INSPECT_SECTIONS).map((section) => ({
          title: section.title,
          body: section.body.split('\n').slice(0, TRAJECTORY_MAX_INSPECT_LINES).join('\n').slice(0, TRAJECTORY_MAX_INSPECT_LINES * TRAJECTORY_MAX_PREVIEW),
          ...(section.tone === undefined ? {} : { tone: section.tone }),
        })),
      }
      publish()
    }).catch((error: unknown) => {
      if (disposed || token !== operation) return
      errors += 1
      inspector = { status: 'error', seq, title: '', facts: [], sections: [], error: String(error) }
      publish()
    })
  }

  const refresh = async (): Promise<void> => {
    if (disposed) return
    const token = ++operation
    loadStatus = 'loading'
    errorMessage = undefined
    inspector = EMPTY_INSPECTOR
    publish()
    const request: TrajectorySnapshotOptions = { sort, projection, query, cursor, windowRows, waveWidth }
    try {
      const next = await options.adapter.trajectorySnapshot(request)
      if (disposed || token !== operation) { staleResults += 1; return }
      snapshot = next
      loadStatus = 'loading'
      cursor = viewName === 'hotspot' ? Math.min(cursor, Math.max(0, next.hotspots.length - 1)) : Math.min(cursor, Math.max(0, next.totalRows - 1))
      publish()
      inspect()
    } catch (error) {
      if (disposed || token !== operation) return
      errors += 1
      loadStatus = 'error'
      errorMessage = String(error)
      options.onDiagnostic?.('trajectory/load-error', { message: errorMessage })
      publish()
    }
  }

  const keyOf = (event: string | TerminalInputEvent): string => {
    if (typeof event === 'string') return event
    if (event.kind !== 'key') return event.kind
    const payload = event.payload as { readonly key?: string | null; readonly text?: string | null }
    return payload.key ?? payload.text ?? ''
  }

  const move = (delta: number): void => {
    cursor = Math.max(0, cursor + delta)
    void refresh()
  }

  const controller: TrajectoryController = {
    async open() {
      if (disposed) return
      opens += 1
      await refresh()
    },
    close() {
      if (disposed) return
      closes += 1
      ++operation
      loadStatus = 'cancelled'
      onClose?.()
    },
    refresh,
    handleInput(event) {
      if (disposed) return
      const key = keyOf(event)
      if (queryOpen) {
        if (key === 'escape' || key === 'esc') { queryOpen = false; query = ''; void refresh(); return }
        if (key === 'return' || key === 'enter') { queryOpen = false; void refresh(); return }
        if (key === 'backspace' || key === 'backspace2') { query = query.slice(0, -1); cursor = 0; void refresh(); return }
        if (key.length === 1) { query += key; cursor = 0; void refresh(); return }
        return
      }
      if (key === 'q' || key === 'escape' || key === 'esc') { controller.close(); return }
      if (key === 'left' || key === 'leftArrow') { viewName = 'timeline'; cursor = 0; void refresh(); return }
      if (key === 'right' || key === 'rightArrow' || key === 'h') { viewName = 'hotspot'; cursor = 0; void refresh(); return }
      if (key === 'up' || key === 'upArrow' || key === 'k') { move(-1); return }
      if (key === 'down' || key === 'downArrow' || key === 'j') { move(1); return }
      if (key === 'pageup' || key === 'pageUp') { move(-windowRows); return }
      if (key === 'pagedown' || key === 'pageDown') { move(windowRows); return }
      if (key === 'g') { cursor = 0; void refresh(); return }
      if (key === 'G') { cursor = Number.MAX_SAFE_INTEGER; void refresh(); return }
      if (key === 'm') { projection = projection === 'sequence' ? 'time' : projection === 'time' ? 'compressed' : 'sequence'; void refresh(); return }
      if (key === 't') { sort = sort === 'duration' ? 'count' : sort === 'count' ? 'tokens' : 'duration'; void refresh(); return }
      if (key === '/') { queryOpen = true; query = ''; publish(); return }
      if (key === 'return' || key === 'enter') { inspect(); return }
    },
    invalidate() { if (!disposed) publish() },
    view: currentView,
    bindClose(close) { onClose = close },
    dispose() { if (disposed) return; disposed = true; ++operation; onClose = null; snapshot = null; options.onDiagnostic?.('trajectory/dispose') },
    diagnostics: () => ({ opens, closes, staleResults, errors }),
  }
  return controller
}
