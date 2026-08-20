/**
 * Controller for WP-08c utility overlays: generic picker, searchable help,
 * prompt-history search and visible-transcript search.
 *
 * Callbacks and source collections remain process-local. Only explicit,
 * serializable payload projections enter AppEvents. A business dialog blocks a
 * new utility overlay; if a dialog arrives later, normal overlay-stack ordering
 * places it above this controller's still-open utility and focus falls back when
 * the dialog closes.
 */
import type {
  HelpDialogPayload,
  HelpShortcutView,
  HistorySearchDialogPayload,
  InteractiveListView,
  InteractiveOptionView,
  InteractiveOverlayPayload,
  PickerDialogPayload,
  TranscriptSearchDialogPayload,
} from '../model/interactive-overlay-payloads.js'
import type { AppEvent } from '../model/events.js'
import type { EventMeta, OverlayState, TranscriptSearchState } from '../model/schema.js'
import type { UiState } from '../model/state.js'
import type { KeyPayload, PastePayload, TerminalInputEvent } from '../terminal/input.js'

export interface InteractiveOverlayItem {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly keywords?: readonly string[]
  readonly disabled?: boolean
  readonly disabledReason?: string
}

interface ListOpenOptions {
  readonly key?: string
  readonly title: string
  readonly items: readonly InteractiveOverlayItem[]
  readonly query?: string
  readonly emptyMessage?: string
  readonly noResultsMessage?: string
  readonly hint?: string
  readonly maxRows?: number
  readonly onSelect: (id: string) => void
  readonly onCancel?: () => void
}

export interface PickerOpenOptions extends ListOpenOptions {
  readonly subtitle?: string
}

export interface HelpOpenOptions extends ListOpenOptions {
  readonly shortcuts?: readonly HelpShortcutView[]
}

export interface HistorySearchOpenOptions extends ListOpenOptions {
  readonly placeholder?: string
}

export interface TranscriptSearchOpenOptions {
  readonly key?: string
  readonly title?: string
  readonly query?: string
  readonly findMatches: (query: string) => readonly string[]
  readonly noResultsMessage?: string
  readonly hint?: string
  readonly onClose?: () => void
}

export interface InteractiveOverlaysControllerOptions {
  readonly dispatch: (event: AppEvent) => void
  readonly nextMeta: (sourceSeq: string) => EventMeta
  readonly getState: () => UiState
  readonly isBusinessDialogActive: () => boolean
  readonly onDiagnostic?: (code: string, message: string) => void
}

export interface InteractiveOverlaysDiagnostics {
  readonly opened: number
  readonly closed: number
  readonly replaced: number
  readonly blocked: number
  readonly revisionBumps: number
  readonly selections: number
  readonly cancels: number
  readonly staleInput: number
  readonly ignoredInput: number
  readonly callbackErrors: number
}

export interface InteractiveOverlaysController {
  readonly openPicker: (options: PickerOpenOptions) => boolean
  readonly openHelp: (options: HelpOpenOptions) => boolean
  readonly openHistory: (options: HistorySearchOpenOptions) => boolean
  readonly openTranscriptSearch: (options: TranscriptSearchOpenOptions) => boolean
  readonly handleInput: (event: TerminalInputEvent) => void
  readonly activeOverlayId: () => string | null
  readonly isManagedOverlay: (overlayId: string) => boolean
  readonly close: () => void
  readonly diagnostics: () => InteractiveOverlaysDiagnostics
  readonly dispose: () => void
}

interface ListActive {
  readonly kind: 'picker' | 'help' | 'history'
  readonly overlayId: string
  readonly key: string
  readonly title: string
  readonly subtitle: string | undefined
  readonly placeholder: string | undefined
  readonly shortcuts: readonly HelpShortcutView[]
  readonly items: readonly InteractiveOverlayItem[]
  readonly emptyMessage: string
  readonly noResultsMessage: string
  readonly hint: string
  readonly maxRows: number
  readonly onSelect: (id: string) => void
  readonly onCancel: (() => void) | undefined
  query: string
  cursor: number
  activeIndex: number
  error: string | undefined
  publishedJson: string
}

interface SearchActive {
  readonly kind: 'search'
  readonly overlayId: string
  readonly key: string
  readonly title: string
  readonly findMatches: (query: string) => readonly string[]
  readonly noResultsMessage: string
  readonly hint: string
  readonly onClose: (() => void) | undefined
  query: string
  cursor: number
  matches: readonly string[]
  current: number
  error: string | undefined
  publishedJson: string
}

type Active = ListActive | SearchActive

const MAX_ITEMS = 512
const MAX_QUERY_POINTS = 256
const DEFAULT_WINDOW_ROWS = 8

function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return segment === '' ? 'picker' : segment.slice(0, 80)
}

function flattenInline(value: string): string {
  // eslint-disable-next-line no-control-regex -- query payloads are single-line
  return value.replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ')
}

function normalizeItems(items: readonly InteractiveOverlayItem[]): readonly InteractiveOverlayItem[] {
  const out: InteractiveOverlayItem[] = []
  const ids = new Set<string>()
  for (const item of items) {
    if (out.length >= MAX_ITEMS || item.id === '' || ids.has(item.id)) continue
    ids.add(item.id)
    out.push({
      id: item.id,
      label: item.label,
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.keywords !== undefined ? { keywords: [...item.keywords] } : {}),
      ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
      ...(item.disabledReason !== undefined ? { disabledReason: item.disabledReason } : {}),
    })
  }
  return out
}

function folded(value: string): string {
  return value.toLocaleLowerCase('en-US')
}

function filteredItems(active: ListActive): readonly InteractiveOverlayItem[] {
  const needle = folded(active.query.trim())
  if (needle === '') return active.items
  return active.items.filter((item) => folded([
    item.label,
    item.description ?? '',
    ...(item.keywords ?? []),
  ].join('\n')).includes(needle))
}

function firstEnabled(items: readonly InteractiveOverlayItem[]): number {
  const index = items.findIndex((item) => item.disabled !== true)
  return index < 0 ? 0 : index
}

function visibleWindow(
  itemHeights: readonly number[],
  activeIndex: number,
  maxRows: number,
): { start: number; end: number } {
  if (itemHeights.length === 0) return { start: 0, end: 0 }
  const focus = Math.max(0, Math.min(activeIndex, itemHeights.length - 1))
  const budget = Math.max(1, maxRows)
  let start = focus
  let end = focus + 1
  let used = Math.max(1, itemHeights[focus] ?? 1)
  for (;;) {
    const up = start > 0 ? Math.max(1, itemHeights[start - 1] ?? 1) : Number.POSITIVE_INFINITY
    const down = end < itemHeights.length
      ? Math.max(1, itemHeights[end] ?? 1)
      : Number.POSITIVE_INFINITY
    if (used + up <= budget && (used + down > budget || focus - start <= end - focus - 1)) {
      start -= 1
      used += up
    } else if (used + down <= budget) {
      end += 1
      used += down
    } else {
      return { start, end }
    }
  }
}

function payloadItem(item: InteractiveOverlayItem): InteractiveOptionView {
  return {
    id: item.id,
    label: item.label,
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.keywords !== undefined ? { keywords: [...item.keywords] } : {}),
    ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
    ...(item.disabledReason !== undefined ? { disabledReason: item.disabledReason } : {}),
  }
}

function uniqueMatches(matches: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const rowId of matches) {
    if (out.length >= MAX_ITEMS || rowId === '' || seen.has(rowId)) continue
    seen.add(rowId)
    out.push(rowId)
  }
  return out
}

export function createInteractiveOverlaysController(
  options: InteractiveOverlaysControllerOptions,
): InteractiveOverlaysController {
  let disposed = false
  let active: Active | null = null
  let instanceSeq = 0
  let journalSeq = 0
  const revisions = new Map<string, number>()
  const counts = {
    opened: 0,
    closed: 0,
    replaced: 0,
    blocked: 0,
    revisionBumps: 0,
    selections: 0,
    cancels: 0,
    staleInput: 0,
    ignoredInput: 0,
    callbackErrors: 0,
  }

  const diagnostic = (code: string, message: string): void => {
    try {
      options.onDiagnostic?.(code, message)
    } catch {
      // Diagnostics cannot break overlay control.
    }
  }

  const nextKey = (prefix: string, requested?: string): string =>
    requested !== undefined && requested !== '' ? requested : `${prefix}-${++instanceSeq}`

  const listView = (record: ListActive): InteractiveListView => {
    const filtered = filteredItems(record)
    const index = filtered.length === 0 ? 0 : Math.max(0, Math.min(record.activeIndex, filtered.length - 1))
    const items = filtered.map(payloadItem)
    const window = visibleWindow(items.map((item) =>
      1
      + (item.description !== undefined ? 1 : 0)
      + (item.disabledReason !== undefined ? 1 : 0)), index, record.maxRows)
    return {
      query: record.query,
      cursor: record.cursor,
      activeIndex: index,
      windowStart: window.start,
      windowEnd: window.end,
      items,
      sourceCount: record.items.length,
      emptyMessage: record.emptyMessage,
      noResultsMessage: record.noResultsMessage,
      hint: record.hint,
      ...(record.error !== undefined ? { error: record.error } : {}),
    }
  }

  const payloadFor = (record: Active): InteractiveOverlayPayload => {
    if (record.kind === 'search') {
      const payload: TranscriptSearchDialogPayload = {
        kind: 'transcript-search-dialog',
        key: record.key,
        title: record.title,
        query: record.query,
        cursor: record.cursor,
        current: record.matches.length === 0 ? 0 : record.current,
        total: record.matches.length,
        noResultsMessage: record.noResultsMessage,
        hint: record.hint,
        ...(record.error !== undefined ? { error: record.error } : {}),
      }
      return payload
    }
    const list = listView(record)
    if (record.kind === 'picker') {
      const payload: PickerDialogPayload = {
        kind: 'picker-dialog',
        key: record.key,
        title: record.title,
        ...(record.subtitle !== undefined ? { subtitle: record.subtitle } : {}),
        list,
      }
      return payload
    }
    if (record.kind === 'help') {
      const payload: HelpDialogPayload = {
        kind: 'help-dialog',
        key: record.key,
        title: record.title,
        shortcuts: record.shortcuts,
        list,
      }
      return payload
    }
    const payload: HistorySearchDialogPayload = {
      kind: 'history-search-dialog',
      key: record.key,
      title: record.title,
      placeholder: record.placeholder ?? 'type to search history',
      list,
    }
    return payload
  }

  const journalOpen = (record: Active, revisionBump: boolean): void => {
    const payload = payloadFor(record)
    const revision = (revisions.get(record.overlayId) ?? 0) + 1
    revisions.set(record.overlayId, revision)
    record.publishedJson = JSON.stringify(payload)
    journalSeq += 1
    const overlay: OverlayState = {
      overlayId: record.overlayId,
      revision,
      anchor: 'center',
      width: '80%',
      maxHeight: '80%',
      visible: true,
      captureInput: true,
      nonCapturing: false,
      payload,
    }
    options.dispatch({ ...options.nextMeta(`utility-${journalSeq}`), type: 'overlay/open', overlay })
    if (revisionBump) counts.revisionBumps += 1
  }

  const journalClose = (overlayId: string): void => {
    journalSeq += 1
    options.dispatch({
      ...options.nextMeta(`utility-${journalSeq}`),
      type: 'overlay/close',
      overlayId,
    })
  }

  const journalSearch = (search: TranscriptSearchState): void => {
    journalSeq += 1
    options.dispatch({ ...options.nextMeta(`utility-${journalSeq}`), type: 'search/update', search })
  }

  const publishSearchState = (record: SearchActive, activeSearch: boolean): void => {
    journalSearch({
      query: record.query,
      active: activeSearch,
      current: record.matches.length === 0 ? 0 : record.current,
      matches: record.matches,
    })
  }

  const callback = (code: string, fn: (() => void) | undefined): void => {
    if (fn === undefined) return
    try {
      fn()
    } catch (error) {
      counts.callbackErrors += 1
      diagnostic(code, error instanceof Error ? error.message : String(error))
    }
  }

  const closeActive = (reason: 'cancel' | 'select' | 'replace' | 'dispose', invokeCancel: boolean): Active | null => {
    const record = active
    if (record === null) return null
    active = null
    journalClose(record.overlayId)
    if (record.kind === 'search') publishSearchState(record, false)
    counts.closed += 1
    if (reason === 'cancel') counts.cancels += 1
    if (reason === 'replace') counts.replaced += 1
    if (invokeCancel) {
      callback(
        `utility/${record.kind}-cancel-callback`,
        record.kind === 'search' ? record.onClose : record.onCancel,
      )
    }
    return record
  }

  const openRecord = (record: Active): boolean => {
    if (disposed) return false
    if (options.isBusinessDialogActive()) {
      counts.blocked += 1
      diagnostic('utility/blocked-by-dialog', `${record.overlayId}: a business dialog owns input`)
      return false
    }
    if (active !== null) closeActive('replace', true)
    active = record
    counts.opened += 1
    journalOpen(record, false)
    if (record.kind === 'search') publishSearchState(record, true)
    return true
  }

  const makeListRecord = (
    kind: ListActive['kind'],
    open: ListOpenOptions,
    additions: {
      readonly subtitle?: string
      readonly placeholder?: string
      readonly shortcuts?: readonly HelpShortcutView[]
    },
  ): ListActive => {
    const key = nextKey(kind, open.key)
    const overlayId = kind === 'picker' ? `utility/picker/${safeSegment(key)}` : `utility/${kind}`
    const items = normalizeItems(open.items)
    const query = [...flattenInline(open.query ?? '')].slice(0, MAX_QUERY_POINTS).join('')
    const record: ListActive = {
      kind,
      overlayId,
      key,
      title: open.title,
      subtitle: additions.subtitle,
      placeholder: additions.placeholder,
      shortcuts: additions.shortcuts?.slice(0, 64).map((shortcut) => ({
        keys: shortcut.keys,
        label: shortcut.label,
      })) ?? [],
      items,
      emptyMessage: open.emptyMessage ?? 'Nothing is available yet.',
      noResultsMessage: open.noResultsMessage ?? 'No matching results.',
      hint: open.hint ?? 'Type to filter · ↑/↓ choose · Enter select · Esc close',
      maxRows: Math.max(1, Math.min(open.maxRows ?? DEFAULT_WINDOW_ROWS, 32)),
      onSelect: open.onSelect,
      onCancel: open.onCancel,
      query,
      cursor: [...query].length,
      activeIndex: 0,
      error: undefined,
      publishedJson: '',
    }
    record.activeIndex = firstEnabled(filteredItems(record))
    return record
  }

  const refreshMatches = (record: SearchActive): void => {
    try {
      record.matches = record.query === '' ? [] : uniqueMatches(record.findMatches(record.query))
      record.current = 0
      record.error = undefined
    } catch (error) {
      record.matches = []
      record.current = 0
      record.error = 'Transcript search failed.'
      diagnostic('utility/search-matches', error instanceof Error ? error.message : String(error))
    }
  }

  const publish = (record: Active): void => {
    if (active !== record || disposed) return
    if (record.kind === 'search') publishSearchState(record, true)
    journalOpen(record, true)
  }

  const moveList = (record: ListActive, delta: number): void => {
    const items = filteredItems(record)
    if (items.length === 0) return
    for (let step = 1; step <= items.length; step++) {
      const candidate = ((record.activeIndex + delta * step) % items.length + items.length) % items.length
      if (items[candidate]?.disabled === true) continue
      record.activeIndex = candidate
      record.error = undefined
      publish(record)
      return
    }
    if (record.error !== 'No selectable results.') {
      record.error = 'No selectable results.'
      publish(record)
    }
  }

  const applyQuery = (record: Active, next: string, cursor: number): void => {
    const points = [...next].slice(0, MAX_QUERY_POINTS)
    record.query = points.join('')
    record.cursor = Math.max(0, Math.min(cursor, points.length))
    record.error = undefined
    if (record.kind === 'search') {
      refreshMatches(record)
    } else {
      record.activeIndex = firstEnabled(filteredItems(record))
    }
    publish(record)
  }

  const insertQuery = (record: Active, chunk: string): void => {
    const current = [...record.query]
    const inserted = [...flattenInline(chunk)]
    const candidate = [...current.slice(0, record.cursor), ...inserted, ...current.slice(record.cursor)].join('')
    applyQuery(record, candidate, record.cursor + inserted.length)
  }

  const editQueryKey = (record: Active, payload: KeyPayload): boolean => {
    const points = [...record.query]
    if (payload.key === 'backspace') {
      if (record.cursor > 0) {
        points.splice(record.cursor - 1, 1)
        applyQuery(record, points.join(''), record.cursor - 1)
      }
      return true
    }
    if (payload.key === 'delete') {
      if (record.cursor < points.length) {
        points.splice(record.cursor, 1)
        applyQuery(record, points.join(''), record.cursor)
      }
      return true
    }
    if (payload.key === 'left') {
      if (record.cursor > 0) applyQuery(record, record.query, record.cursor - 1)
      return true
    }
    if (payload.key === 'right') {
      if (record.cursor < points.length) applyQuery(record, record.query, record.cursor + 1)
      return true
    }
    if (payload.key === 'home') {
      if (record.cursor !== 0) applyQuery(record, record.query, 0)
      return true
    }
    if (payload.key === 'end') {
      if (record.cursor !== points.length) applyQuery(record, record.query, points.length)
      return true
    }
    const text = payload.text ?? (payload.key === 'space' ? ' ' : null)
    if (text === null) return false
    insertQuery(record, text)
    return true
  }

  const selectList = (record: ListActive): void => {
    const item = filteredItems(record)[record.activeIndex]
    if (item === undefined) {
      record.error = record.items.length === 0 ? record.emptyMessage : record.noResultsMessage
      publish(record)
      return
    }
    if (item.disabled === true) {
      record.error = item.disabledReason ?? 'That result is unavailable.'
      publish(record)
      return
    }
    const id = item.id
    closeActive('select', false)
    counts.selections += 1
    callback(`utility/${record.kind}-select-callback`, () => record.onSelect(id))
  }

  const moveSearch = (record: SearchActive, delta: number): void => {
    if (record.matches.length === 0) {
      if (record.query !== '' && record.error === undefined) {
        record.error = record.noResultsMessage
        publish(record)
      }
      return
    }
    record.current = (record.current + delta + record.matches.length) % record.matches.length
    record.error = undefined
    publish(record)
  }

  const handleKey = (record: Active, payload: KeyPayload): void => {
    if (payload.key === 'escape' || payload.key === 'ctrl+g') {
      closeActive('cancel', true)
      return
    }
    if (record.kind === 'search') {
      if (payload.key === 'up' || payload.key === 'shift+enter') {
        moveSearch(record, -1)
        return
      }
      if (payload.key === 'down' || payload.key === 'enter') {
        moveSearch(record, 1)
        return
      }
      if (!editQueryKey(record, payload)) counts.ignoredInput += 1
      return
    }

    if (payload.key === 'up' || payload.key === 'down') {
      moveList(record, payload.key === 'up' ? -1 : 1)
      return
    }
    if (payload.key === 'pageUp' || payload.key === 'pageDown') {
      moveList(record, payload.key === 'pageUp' ? -record.maxRows : record.maxRows)
      return
    }
    if (payload.key === 'enter') {
      selectList(record)
      return
    }
    if (!editQueryKey(record, payload)) counts.ignoredInput += 1
  }

  const handleInput = (event: TerminalInputEvent): void => {
    if (disposed) return
    const record = active
    if (record === null) {
      counts.ignoredInput += 1
      return
    }
    const focus = options.getState().focus
    if (focus.target !== 'overlay' || focus.overlayId !== record.overlayId) {
      counts.staleInput += 1
      return
    }
    if (event.kind === 'key') {
      const payload = event.payload as KeyPayload
      if (payload.eventType === 'release') {
        counts.ignoredInput += 1
        return
      }
      handleKey(record, payload)
    } else if (event.kind === 'paste') {
      insertQuery(record, (event.payload as PastePayload).text)
    } else {
      counts.ignoredInput += 1
    }
  }

  return {
    openPicker(open) {
      return openRecord(makeListRecord('picker', open, { subtitle: open.subtitle }))
    },
    openHelp(open) {
      return openRecord(makeListRecord('help', open, { shortcuts: open.shortcuts }))
    },
    openHistory(open) {
      return openRecord(makeListRecord('history', open, { placeholder: open.placeholder }))
    },
    openTranscriptSearch(open) {
      const key = nextKey('search', open.key)
      const record: SearchActive = {
        kind: 'search',
        overlayId: 'utility/search',
        key,
        title: open.title ?? 'Search transcript',
        findMatches: open.findMatches,
        noResultsMessage: open.noResultsMessage ?? 'No visible transcript matches.',
        hint: open.hint ?? 'Type to search · ↑/↓ or Enter move · Esc close',
        onClose: open.onClose,
        query: flattenInline(open.query ?? ''),
        cursor: [...flattenInline(open.query ?? '')].length,
        matches: [],
        current: 0,
        error: undefined,
        publishedJson: '',
      }
      refreshMatches(record)
      return openRecord(record)
    },
    handleInput,
    activeOverlayId: () => active?.overlayId ?? null,
    isManagedOverlay: (overlayId) => active?.overlayId === overlayId,
    close() {
      if (!disposed) closeActive('cancel', true)
    },
    diagnostics: () => ({ ...counts }),
    dispose() {
      if (disposed) return
      if (active !== null) closeActive('dispose', false)
      disposed = true
    },
  }
}
