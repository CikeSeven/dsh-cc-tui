/**
 * WP-08d1 persisted-session catalog and browser controller.
 *
 * The adapter owns persistence and session switching. This controller owns one
 * process-local catalog, bounded serialized projections and input. Every async
 * completion is guarded by record identity + operation generation; close and
 * dispose abort source reads and make late results inert.
 */
import type { PreviewEntry, SessionSummary } from '../../dsh-adapter/sessions/index.js'
import {
  anchorTop,
  buildView,
  DEFAULT_FILTERS,
  moveSelection,
  seekSelectable,
  sessionAt,
  windowEnd,
  type BrowserFilters,
  type BrowserView,
} from '../../sessions/view.js'
import type {
  CatalogNoticeView,
  SessionBrowserPayload,
  SessionBrowserRowView,
  SessionPreviewView,
} from '../model/catalog-overlay-payloads.js'
import { SESSION_BROWSER_MAX_ROWS, SESSION_PREVIEW_MAX_ENTRIES } from '../model/catalog-overlay-payloads.js'
import type { AppEvent } from '../model/events.js'
import type { EventMeta, OverlayState } from '../model/schema.js'
import type { UiState } from '../model/state.js'
import type { KeyPayload, PastePayload, TerminalInputEvent } from '../terminal/input.js'
import type { ReplayController } from './replay.js'

export interface SessionCatalogCapability {
  list(signal?: AbortSignal): Promise<readonly SessionSummary[]>
  preview(sessionId: string, signal?: AbortSignal): Promise<readonly PreviewEntry[]>
  delete(sessionId: string): Promise<boolean>
  rename(sessionId: string, title: string): Promise<boolean>
}

export interface SessionBrowserContext {
  readonly cwd: string
  readonly branch: string | undefined
  readonly currentSessionId: string
}

export interface SessionCatalogControllerOptions {
  readonly dispatch: (event: AppEvent) => void
  readonly nextMeta: (sourceSeq: string) => EventMeta
  readonly getState: () => UiState
  readonly catalog: SessionCatalogCapability
  readonly replay: Pick<ReplayController, 'resume'>
  readonly context: () => SessionBrowserContext
  readonly sameProject: (left: string, right: string) => boolean
  readonly now: () => number
  readonly isBusinessDialogActive: () => boolean
  readonly onDiagnostic?: (code: string, message: string) => void
}

export interface SessionCatalogDiagnostics {
  readonly opened: number
  readonly closed: number
  readonly loads: number
  readonly previews: number
  readonly resumes: number
  readonly deletes: number
  readonly renames: number
  readonly cancels: number
  readonly lateResults: number
  readonly errors: number
  readonly staleInput: number
}

export interface SessionCatalogController {
  readonly open: () => boolean
  readonly close: () => void
  readonly handleInput: (event: TerminalInputEvent) => void
  readonly activeOverlayId: () => string | null
  readonly isManagedOverlay: (overlayId: string) => boolean
  readonly diagnostics: () => SessionCatalogDiagnostics
  readonly dispose: () => void
}

type BrowserMode = 'list' | 'confirm-delete' | 'rename'
type PreviewPhase = SessionPreviewView['phase']

interface BrowserRecord {
  readonly overlayId: string
  readonly key: string
  revision: number
  phase: SessionBrowserPayload['phase']
  summaries: readonly SessionSummary[]
  filters: BrowserFilters
  filterCursor: number
  focusId: string | undefined
  top: number
  mode: BrowserMode
  draft: string
  draftCursor: number
  previewOpen: boolean
  previewPhase: PreviewPhase
  previewSessionId: string | undefined
  previewEntries: readonly PreviewEntry[]
  previewError: string | undefined
  error: string | undefined
  notice: CatalogNoticeView | undefined
  operationGeneration: number
  listAbort: AbortController | null
  previewAbort: AbortController | null
}

const OVERLAY_ID = 'utility/session-browser'
const MAX_QUERY_POINTS = 256

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function aborted(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function flattenInline(value: string): string {
  // eslint-disable-next-line no-control-regex -- catalog inputs are single-line
  return value.replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ')
}

function codePoints(value: string): string[] {
  return [...value]
}

function boundedText(value: string): string {
  return codePoints(flattenInline(value)).slice(0, MAX_QUERY_POINTS).join('')
}

function viewFor(record: BrowserRecord, context: SessionBrowserContext, sameProject: SessionCatalogControllerOptions['sameProject']): BrowserView {
  return buildView(record.summaries, record.filters, {
    cwd: context.cwd,
    branch: context.branch,
    currentId: context.currentSessionId,
    sameProject,
  })
}

function selectedIndex(record: BrowserRecord, view: BrowserView): number {
  const identity = record.focusId === undefined
    ? -1
    : view.rows.findIndex((row) => row.kind === 'session' && row.session.id === record.focusId)
  if (identity >= 0) return identity
  return Math.max(0, seekSelectable(view.rows, 0, 1))
}

function sessionRow(summary: SessionSummary, depth: number): SessionBrowserRowView {
  return {
    kind: 'session',
    id: summary.id,
    sessionKind: summary.kind.kind,
    title: summary.title.text,
    titleSource: summary.title.source,
    cwd: summary.cwd,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    depth,
    ...(summary.bytes !== undefined ? { bytes: summary.bytes } : {}),
    ...(summary.model !== undefined ? { model: summary.model } : {}),
    ...(summary.branch !== undefined ? { branch: summary.branch } : {}),
    ...(summary.label !== undefined ? { label: summary.label } : {}),
    childCount: summary.childCount,
  }
}

function editText(
  text: string,
  cursor: number,
  payload: KeyPayload,
): { text: string; cursor: number } | null {
  const points = codePoints(text)
  if (payload.key === 'backspace') {
    if (cursor > 0) points.splice(cursor - 1, 1)
    return { text: points.join(''), cursor: Math.max(0, cursor - 1) }
  }
  if (payload.key === 'delete') {
    if (cursor < points.length) points.splice(cursor, 1)
    return { text: points.join(''), cursor }
  }
  if (payload.key === 'left') return { text, cursor: Math.max(0, cursor - 1) }
  if (payload.key === 'right') return { text, cursor: Math.min(points.length, cursor + 1) }
  if (payload.key === 'home') return { text, cursor: 0 }
  if (payload.key === 'end') return { text, cursor: points.length }
  const inserted = payload.text ?? (payload.key === 'space' ? ' ' : null)
  if (inserted === null) return null
  const incoming = codePoints(flattenInline(inserted))
  const next = [...points.slice(0, cursor), ...incoming, ...points.slice(cursor)].slice(0, MAX_QUERY_POINTS)
  return { text: next.join(''), cursor: Math.min(next.length, cursor + incoming.length) }
}

export function createSessionCatalogController(options: SessionCatalogControllerOptions): SessionCatalogController {
  let disposed = false
  let active: BrowserRecord | null = null
  let instanceSeq = 0
  let journalSeq = 0
  const counts = {
    opened: 0,
    closed: 0,
    loads: 0,
    previews: 0,
    resumes: 0,
    deletes: 0,
    renames: 0,
    cancels: 0,
    lateResults: 0,
    errors: 0,
    staleInput: 0,
  }

  const diagnostic = (code: string, detail: string): void => {
    try {
      options.onDiagnostic?.(code, detail)
    } catch {
      // Diagnostics cannot own the browser lifecycle.
    }
  }

  const journalOpen = (record: BrowserRecord): void => {
    const payload = payloadFor(record)
    record.revision += 1
    journalSeq += 1
    const overlay: OverlayState = {
      overlayId: record.overlayId,
      revision: record.revision,
      anchor: 'center',
      width: '96%',
      maxHeight: '90%',
      margin: 1,
      visible: true,
      captureInput: true,
      nonCapturing: false,
      payload,
    }
    options.dispatch({ ...options.nextMeta(`session-catalog-${journalSeq}`), type: 'overlay/open', overlay })
  }

  const journalClose = (overlayId: string): void => {
    journalSeq += 1
    options.dispatch({
      ...options.nextMeta(`session-catalog-${journalSeq}`),
      type: 'overlay/close',
      overlayId,
    })
  }

  const recordIsLive = (record: BrowserRecord, generation?: number): boolean => {
    const live = !disposed && active === record && (generation === undefined || generation === record.operationGeneration)
    if (!live) counts.lateResults += 1
    return live
  }

  const normalizeFocus = (record: BrowserRecord): { view: BrowserView; index: number } => {
    const view = viewFor(record, options.context(), options.sameProject)
    const index = selectedIndex(record, view)
    const selected = sessionAt(view.rows, index)
    record.focusId = selected?.id
    record.top = anchorTop(view.rows, index, SESSION_BROWSER_MAX_ROWS, record.top)
    return { view, index }
  }

  const payloadFor = (record: BrowserRecord): SessionBrowserPayload => {
    const context = options.context()
    const { view, index } = normalizeFocus(record)
    const end = windowEnd(view.rows, record.top, SESSION_BROWSER_MAX_ROWS)
    const rows = view.rows.slice(record.top, end).map((row, offset): SessionBrowserRowView =>
      row.kind === 'project'
        ? { kind: 'project', key: `project:${record.top + offset}:${row.project}`, cwd: row.project, count: row.count }
        : sessionRow(row.session, row.depth))
    const selected = sessionAt(view.rows, index)
    const current = record.summaries.find((summary) => summary.id === context.currentSessionId)
    const preview: SessionPreviewView = {
      open: record.previewOpen,
      phase: record.previewOpen ? record.previewPhase : 'idle',
      ...(record.previewSessionId !== undefined ? { sessionId: record.previewSessionId } : {}),
      ...(record.previewSessionId !== undefined
        ? (() => {
            const summary = record.summaries.find((candidate) => candidate.id === record.previewSessionId)
            return summary === undefined ? {} : { title: summary.title.text, cwd: summary.cwd }
          })()
        : {}),
      entries: record.previewEntries.slice(-SESSION_PREVIEW_MAX_ENTRIES).map((entry) => ({
        role: entry.role,
        text: entry.text,
        ...(entry.at !== undefined ? { at: entry.at } : {}),
      })),
      ...(record.previewError !== undefined ? { error: record.previewError } : {}),
    }
    const hint = record.mode === 'confirm-delete'
      ? 'Enter delete permanently · Esc cancel'
      : record.mode === 'rename'
        ? 'Enter rename · Esc cancel'
        : 'Type filter · ↑/↓/PgUp/PgDn · Tab preview · Enter resume · Ctrl+D delete · Ctrl+R rename · Esc close'
    return {
      kind: 'session-browser-dialog',
      key: record.key,
      title: 'Resume session',
      phase: record.phase,
      now: options.now(),
      filter: {
        query: record.filters.query,
        cursor: record.filterCursor,
        allProjects: record.filters.allProjects,
        branchOnly: record.filters.branchOnly,
        showSubagents: record.filters.showSubagents,
      },
      rows,
      ...(selected !== undefined ? { selectedId: selected.id } : {}),
      hasMoreAbove: record.top > 0,
      hasMoreBelow: end < view.rows.length,
      sourceCount: record.summaries.length,
      shownCount: view.shown,
      hiddenSubagents: view.hiddenSubagents,
      emptyCount: view.emptyCount,
      current: {
        id: context.currentSessionId,
        ...(current !== undefined ? { title: current.title.text } : {}),
      },
      mode: record.mode,
      ...(record.mode === 'rename' ? { draft: { text: record.draft, cursor: record.draftCursor } } : {}),
      preview,
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.notice !== undefined ? { notice: record.notice } : {}),
      hint,
    }
  }

  const publish = (record: BrowserRecord): void => {
    if (!recordIsLive(record)) return
    journalOpen(record)
  }

  const abortReads = (record: BrowserRecord): void => {
    record.listAbort?.abort()
    record.previewAbort?.abort()
    record.listAbort = null
    record.previewAbort = null
    record.operationGeneration += 1
  }

  const closeRecord = (record: BrowserRecord, cancelled: boolean): void => {
    if (active !== record) return
    active = null
    abortReads(record)
    journalClose(record.overlayId)
    counts.closed += 1
    if (cancelled) counts.cancels += 1
  }

  const loadCatalog = async (record: BrowserRecord, preserveFocus: boolean): Promise<void> => {
    record.listAbort?.abort()
    const controller = new AbortController()
    record.listAbort = controller
    const generation = ++record.operationGeneration
    counts.loads += 1
    try {
      const summaries = await options.catalog.list(controller.signal)
      if (!recordIsLive(record, generation)) return
      record.listAbort = null
      record.summaries = [...summaries]
      if (!preserveFocus) record.focusId = undefined
      record.phase = 'ready'
      record.error = undefined
      normalizeFocus(record)
      publish(record)
      if (record.previewOpen) requestPreview(record)
    } catch (error) {
      if (controller.signal.aborted || aborted(error)) return
      if (!recordIsLive(record, generation)) return
      record.listAbort = null
      record.phase = 'error'
      record.error = `Session catalog failed: ${message(error)}`
      counts.errors += 1
      diagnostic('list-failed', message(error))
      publish(record)
    }
  }

  const requestPreview = (record: BrowserRecord): void => {
    const { view, index } = normalizeFocus(record)
    const selected = sessionAt(view.rows, index)
    record.previewAbort?.abort()
    record.previewAbort = null
    record.previewEntries = []
    record.previewError = undefined
    if (!record.previewOpen || selected === undefined) {
      record.previewSessionId = undefined
      record.previewPhase = 'idle'
      publish(record)
      return
    }
    const controller = new AbortController()
    record.previewAbort = controller
    const generation = ++record.operationGeneration
    const sessionId = selected.id
    record.previewSessionId = sessionId
    record.previewPhase = 'loading'
    counts.previews += 1
    publish(record)
    void options.catalog.preview(sessionId, controller.signal).then((entries) => {
      if (!recordIsLive(record, generation) || controller.signal.aborted) return
      if (!record.previewOpen || record.focusId !== sessionId) return
      record.previewAbort = null
      record.previewEntries = entries.slice(-SESSION_PREVIEW_MAX_ENTRIES)
      record.previewPhase = 'ready'
      publish(record)
    }).catch((error: unknown) => {
      if (controller.signal.aborted || aborted(error)) return
      if (!recordIsLive(record, generation)) return
      record.previewAbort = null
      record.previewEntries = []
      record.previewPhase = 'error'
      record.previewError = `Preview failed: ${message(error)}`
      counts.errors += 1
      diagnostic('preview-failed', message(error))
      publish(record)
    })
  }

  const move = (record: BrowserRecord, delta: 1 | -1, times = 1): void => {
    const { view, index } = normalizeFocus(record)
    if (view.rows.length === 0) return
    let next = index
    for (let step = 0; step < times; step += 1) next = moveSelection(view.rows, next, delta)
    record.focusId = sessionAt(view.rows, next)?.id
    record.top = anchorTop(view.rows, next, SESSION_BROWSER_MAX_ROWS, record.top)
    record.mode = 'list'
    record.error = undefined
    record.notice = undefined
    if (record.previewOpen) requestPreview(record)
    else publish(record)
  }

  const applyFilter = (record: BrowserRecord, next: string, cursor: number): void => {
    const query = boundedText(next)
    record.filters = { ...record.filters, query }
    record.filterCursor = Math.max(0, Math.min(cursor, codePoints(query).length))
    record.top = 0
    record.mode = 'list'
    record.error = undefined
    record.notice = undefined
    normalizeFocus(record)
    if (record.previewOpen) requestPreview(record)
    else publish(record)
  }

  const runResume = (record: BrowserRecord): void => {
    const { view, index } = normalizeFocus(record)
    const selected = sessionAt(view.rows, index)
    if (selected === undefined) return
    const generation = ++record.operationGeneration
    record.phase = 'pending'
    record.error = undefined
    record.notice = { text: `Resuming ${selected.title.text}…`, tone: 'info' }
    counts.resumes += 1
    publish(record)
    void options.replay.resume(selected.id).then((result) => {
      if (!recordIsLive(record, generation)) return
      if (result.ok) {
        closeRecord(record, false)
        return
      }
      record.phase = 'ready'
      record.notice = undefined
      record.error = result.reason === 'working'
        ? 'Cannot resume while the model is working.'
        : result.reason === 'unavailable'
          ? 'This session is unavailable and cannot be resumed.'
          : result.reason === 'cancelled'
            ? 'Resume was cancelled.'
            : `Resume failed: ${result.error}`
      counts.errors += result.reason === 'cancelled' ? 0 : 1
      publish(record)
    }).catch((error: unknown) => {
      if (!recordIsLive(record, generation)) return
      record.phase = 'ready'
      record.notice = undefined
      record.error = `Resume failed: ${message(error)}`
      counts.errors += 1
      publish(record)
    })
  }

  const runDelete = (record: BrowserRecord): void => {
    const { view, index } = normalizeFocus(record)
    const selected = sessionAt(view.rows, index)
    if (selected === undefined) return
    const generation = ++record.operationGeneration
    record.mode = 'list'
    record.phase = 'pending'
    record.error = undefined
    record.notice = { text: `Deleting ${selected.title.text}…`, tone: 'warning' }
    counts.deletes += 1
    publish(record)
    void options.catalog.delete(selected.id).then(async (ok) => {
      if (!recordIsLive(record, generation)) return
      if (!ok) {
        record.phase = 'ready'
        record.notice = undefined
        record.error = `Could not delete ${selected.title.text}.`
        counts.errors += 1
        publish(record)
        return
      }
      record.notice = { text: `Deleted session ${selected.title.text}.`, tone: 'success' }
      record.focusId = undefined
      await loadCatalog(record, true)
    }).catch((error: unknown) => {
      if (!recordIsLive(record, generation)) return
      record.phase = 'ready'
      record.notice = undefined
      record.error = `Delete failed: ${message(error)}`
      counts.errors += 1
      publish(record)
    })
  }

  const runRename = (record: BrowserRecord): void => {
    const { view, index } = normalizeFocus(record)
    const selected = sessionAt(view.rows, index)
    const title = record.draft.trim()
    if (selected === undefined || title === '') {
      record.error = 'Session title must not be empty.'
      publish(record)
      return
    }
    const generation = ++record.operationGeneration
    record.mode = 'list'
    record.phase = 'pending'
    record.error = undefined
    record.notice = { text: `Renaming ${selected.title.text}…`, tone: 'info' }
    counts.renames += 1
    publish(record)
    void options.catalog.rename(selected.id, title).then(async (ok) => {
      if (!recordIsLive(record, generation)) return
      if (!ok) {
        record.phase = 'ready'
        record.notice = undefined
        record.error = `Could not rename ${selected.title.text}.`
        counts.errors += 1
        publish(record)
        return
      }
      record.focusId = selected.id
      record.notice = { text: `Renamed session to ${title}.`, tone: 'success' }
      await loadCatalog(record, true)
    }).catch((error: unknown) => {
      if (!recordIsLive(record, generation)) return
      record.phase = 'ready'
      record.notice = undefined
      record.error = `Rename failed: ${message(error)}`
      counts.errors += 1
      publish(record)
    })
  }

  const handleKey = (record: BrowserRecord, payload: KeyPayload): void => {
    if (payload.eventType === 'release') return
    if (payload.key === 'escape' || payload.key === 'ctrl+g') {
      if (record.mode !== 'list') {
        record.mode = 'list'
        record.error = undefined
        publish(record)
      } else if (record.filters.query !== '') {
        applyFilter(record, '', 0)
      } else {
        closeRecord(record, true)
      }
      return
    }
    if (record.phase === 'loading' || record.phase === 'pending') return

    if (record.mode === 'confirm-delete') {
      if (payload.key === 'enter') runDelete(record)
      return
    }
    if (record.mode === 'rename') {
      if (payload.key === 'enter') {
        runRename(record)
        return
      }
      const edited = editText(record.draft, record.draftCursor, payload)
      if (edited !== null) {
        record.draft = edited.text
        record.draftCursor = edited.cursor
        record.error = undefined
        publish(record)
      }
      return
    }

    if (payload.key === 'up' || payload.key === 'down') {
      move(record, payload.key === 'up' ? -1 : 1)
      return
    }
    if (payload.key === 'pageUp' || payload.key === 'pageDown') {
      move(record, payload.key === 'pageUp' ? -1 : 1, Math.max(1, Math.floor(SESSION_BROWSER_MAX_ROWS / 2)))
      return
    }
    if (payload.key === 'tab') {
      record.previewOpen = !record.previewOpen
      if (record.previewOpen) requestPreview(record)
      else {
        record.previewAbort?.abort()
        record.previewAbort = null
        record.previewPhase = 'idle'
        record.previewSessionId = undefined
        record.previewEntries = []
        record.previewError = undefined
        publish(record)
      }
      return
    }
    if (payload.key === 'ctrl+a' || payload.key === 'ctrl+b' || payload.key === 'ctrl+s') {
      record.filters = {
        ...record.filters,
        ...(payload.key === 'ctrl+a' ? { allProjects: !record.filters.allProjects } : {}),
        ...(payload.key === 'ctrl+b' ? { branchOnly: !record.filters.branchOnly } : {}),
        ...(payload.key === 'ctrl+s' ? { showSubagents: !record.filters.showSubagents } : {}),
      }
      record.top = 0
      normalizeFocus(record)
      if (record.previewOpen) requestPreview(record)
      else publish(record)
      return
    }
    if (payload.key === 'ctrl+d') {
      const { view, index } = normalizeFocus(record)
      if (sessionAt(view.rows, index) !== undefined) {
        record.mode = 'confirm-delete'
        record.error = undefined
        publish(record)
      }
      return
    }
    if (payload.key === 'ctrl+r') {
      const { view, index } = normalizeFocus(record)
      const selected = sessionAt(view.rows, index)
      if (selected !== undefined) {
        record.mode = 'rename'
        record.draft = selected.title.text
        record.draftCursor = codePoints(record.draft).length
        record.error = undefined
        publish(record)
      }
      return
    }
    if (payload.key === 'enter') {
      runResume(record)
      return
    }
    const edited = editText(record.filters.query, record.filterCursor, payload)
    if (edited !== null) applyFilter(record, edited.text, edited.cursor)
  }

  return {
    open() {
      if (disposed || options.isBusinessDialogActive()) return false
      if (active !== null) closeRecord(active, false)
      const record: BrowserRecord = {
        overlayId: OVERLAY_ID,
        key: `session-browser-${++instanceSeq}`,
        revision: 0,
        phase: 'loading',
        summaries: [],
        filters: { ...DEFAULT_FILTERS },
        filterCursor: 0,
        focusId: undefined,
        top: 0,
        mode: 'list',
        draft: '',
        draftCursor: 0,
        previewOpen: false,
        previewPhase: 'idle',
        previewSessionId: undefined,
        previewEntries: [],
        previewError: undefined,
        error: undefined,
        notice: undefined,
        operationGeneration: 0,
        listAbort: null,
        previewAbort: null,
      }
      active = record
      counts.opened += 1
      journalOpen(record)
      void loadCatalog(record, false)
      return true
    },
    close() {
      if (active !== null) closeRecord(active, true)
    },
    handleInput(event) {
      const record = active
      if (disposed || record === null) return
      const focus = options.getState().focus
      if (focus.target !== 'overlay' || focus.overlayId !== record.overlayId) {
        counts.staleInput += 1
        return
      }
      if (event.kind === 'key') {
        handleKey(record, event.payload as KeyPayload)
      } else if (event.kind === 'paste') {
        const text = boundedText((event.payload as PastePayload).text)
        if (record.mode === 'rename') {
          const points = codePoints(record.draft)
          const inserted = codePoints(text)
          const next = [...points.slice(0, record.draftCursor), ...inserted, ...points.slice(record.draftCursor)]
            .slice(0, MAX_QUERY_POINTS)
          record.draft = next.join('')
          record.draftCursor = Math.min(next.length, record.draftCursor + inserted.length)
          record.error = undefined
          publish(record)
        } else if (record.phase === 'ready') {
          const points = codePoints(record.filters.query)
          const inserted = codePoints(text)
          const next = [...points.slice(0, record.filterCursor), ...inserted, ...points.slice(record.filterCursor)]
          applyFilter(record, next.join(''), record.filterCursor + inserted.length)
        }
      }
    },
    activeOverlayId: () => active?.overlayId ?? null,
    isManagedOverlay: (overlayId) => active?.overlayId === overlayId,
    diagnostics: () => ({ ...counts }),
    dispose() {
      if (disposed) return
      if (active !== null) closeRecord(active, false)
      disposed = true
    },
  }
}
