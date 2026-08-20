/**
 * Serializable view models for the WP-08d1 session/workspace utility overlays.
 * Controllers retain sources, callbacks and async handles; components receive
 * only these bounded immutable projections.
 *
 * Dependency rule (§4.3): model imports nothing from controllers/components.
 */
import { isSerializableValue, type SerializableValue } from './schema.js'

export const SESSION_BROWSER_MAX_ROWS = 16
export const SESSION_PREVIEW_MAX_ENTRIES = 8
export const WORKSPACE_WINDOW_ITEMS = 8

export type CatalogPhase = 'loading' | 'ready' | 'pending' | 'error'
export type CatalogNoticeView = {
  readonly text: string
  readonly tone: 'info' | 'success' | 'warning' | 'error'
}

export type SessionBrowserFilterView = {
  readonly query: string
  /** Code-point cursor in query. */
  readonly cursor: number
  readonly allProjects: boolean
  readonly branchOnly: boolean
  readonly showSubagents: boolean
}

export type SessionProjectRowView = {
  readonly kind: 'project'
  readonly key: string
  readonly cwd: string
  readonly count: number
}

export type SessionCatalogRowView = {
  readonly kind: 'session'
  readonly id: string
  readonly sessionKind: 'root' | 'fork' | 'subagent'
  readonly title: string
  readonly titleSource: 'renamed' | 'auto' | 'prompt' | 'fallback'
  readonly cwd: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly depth: number
  readonly bytes?: number
  readonly model?: string
  readonly branch?: string
  readonly label?: string
  readonly childCount: number
}

export type SessionBrowserRowView = SessionProjectRowView | SessionCatalogRowView

export type SessionPreviewEntryView = {
  readonly role: 'user' | 'assistant' | 'tool'
  readonly text: string
  readonly at?: number
}

export type SessionPreviewView = {
  readonly open: boolean
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly sessionId?: string
  readonly title?: string
  readonly cwd?: string
  readonly entries: readonly SessionPreviewEntryView[]
  readonly error?: string
}

export type SessionBrowserPayload = {
  readonly kind: 'session-browser-dialog'
  readonly key: string
  readonly title: string
  readonly phase: CatalogPhase
  /** One clock sample shared by every relative time in this projection. */
  readonly now: number
  readonly filter: SessionBrowserFilterView
  readonly rows: readonly SessionBrowserRowView[]
  readonly selectedId?: string
  readonly hasMoreAbove: boolean
  readonly hasMoreBelow: boolean
  readonly sourceCount: number
  readonly shownCount: number
  readonly hiddenSubagents: number
  readonly emptyCount: number
  readonly current: { readonly id: string; readonly title?: string }
  readonly mode: 'list' | 'confirm-delete' | 'rename'
  readonly draft?: { readonly text: string; readonly cursor: number }
  readonly preview: SessionPreviewView
  readonly error?: string
  readonly notice?: CatalogNoticeView
  readonly hint: string
}

export type WorkspaceItemView = {
  readonly kind: 'target' | 'choice'
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly badge?: string
  readonly current?: boolean
  readonly hasInput?: boolean
}

export type WorkspaceInputView = {
  readonly choiceId: string
  readonly value: string
  /** Code-point cursor in value. */
  readonly cursor: number
  readonly placeholder?: string
}

export type WorkspaceDialogPayload = {
  readonly kind: 'workspace-dialog'
  readonly key: string
  readonly title: string
  readonly phase: CatalogPhase
  readonly view: 'targets' | 'choices'
  readonly query: string
  /** Code-point cursor in query. */
  readonly cursor: number
  readonly items: readonly WorkspaceItemView[]
  readonly selectedId?: string
  readonly hasMoreAbove: boolean
  readonly hasMoreBelow: boolean
  readonly sourceCount: number
  readonly filteredCount: number
  readonly input?: WorkspaceInputView
  readonly degraded: boolean
  readonly error?: string
  readonly notice?: CatalogNoticeView
  readonly hint: string
}

export type CatalogOverlayPayload = SessionBrowserPayload | WorkspaceDialogPayload

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonNegativeInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function optionalString(record: Record<string, unknown>, field: string): boolean {
  return record[field] === undefined || typeof record[field] === 'string'
}

function validCursor(text: unknown, cursor: unknown): text is string {
  return typeof text === 'string' && nonNegativeInt(cursor) && cursor <= [...text].length
}

function validPhase(value: unknown): value is CatalogPhase {
  return value === 'loading' || value === 'ready' || value === 'pending' || value === 'error'
}

function validNotice(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || typeof value.text !== 'string') return false
  return value.tone === 'info' || value.tone === 'success' || value.tone === 'warning' || value.tone === 'error'
}

function validSessionRow(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.kind === 'project') {
    return typeof value.key === 'string' && value.key !== '' && typeof value.cwd === 'string' && nonNegativeInt(value.count)
  }
  if (value.kind !== 'session') return false
  if (typeof value.id !== 'string' || value.id === '' || typeof value.title !== 'string' || typeof value.cwd !== 'string') {
    return false
  }
  if (value.sessionKind !== 'root' && value.sessionKind !== 'fork' && value.sessionKind !== 'subagent') return false
  if (value.titleSource !== 'renamed' && value.titleSource !== 'auto' && value.titleSource !== 'prompt' && value.titleSource !== 'fallback') {
    return false
  }
  if (!finiteNonNegative(value.createdAt) || !finiteNonNegative(value.updatedAt)) return false
  if (!nonNegativeInt(value.depth) || !nonNegativeInt(value.childCount)) return false
  if (value.bytes !== undefined && !finiteNonNegative(value.bytes)) return false
  return optionalString(value, 'model') && optionalString(value, 'branch') && optionalString(value, 'label')
}

function validPreview(value: unknown): boolean {
  if (!isRecord(value) || typeof value.open !== 'boolean') return false
  if (value.phase !== 'idle' && value.phase !== 'loading' && value.phase !== 'ready' && value.phase !== 'error') return false
  if (!optionalString(value, 'sessionId') || !optionalString(value, 'title') || !optionalString(value, 'cwd') || !optionalString(value, 'error')) {
    return false
  }
  if (!Array.isArray(value.entries) || value.entries.length > SESSION_PREVIEW_MAX_ENTRIES) return false
  for (const entry of value.entries) {
    if (!isRecord(entry)) return false
    if (entry.role !== 'user' && entry.role !== 'assistant' && entry.role !== 'tool') return false
    if (typeof entry.text !== 'string') return false
    if (entry.at !== undefined && !finiteNonNegative(entry.at)) return false
  }
  return true
}

function validSessionPayload(value: Record<string, unknown>): value is SessionBrowserPayload {
  if (typeof value.key !== 'string' || value.key === '' || typeof value.title !== 'string' || !validPhase(value.phase)) return false
  if (!finiteNonNegative(value.now)) return false
  if (!isRecord(value.filter) || !validCursor(value.filter.query, value.filter.cursor)) return false
  if (typeof value.filter.allProjects !== 'boolean' || typeof value.filter.branchOnly !== 'boolean' || typeof value.filter.showSubagents !== 'boolean') {
    return false
  }
  if (!Array.isArray(value.rows) || value.rows.length > SESSION_BROWSER_MAX_ROWS || !value.rows.every(validSessionRow)) return false
  const ids = value.rows.filter((row) => isRecord(row) && row.kind === 'session').map((row) => (row as Record<string, unknown>).id)
  if (new Set(ids).size !== ids.length) return false
  if (!optionalString(value, 'selectedId')) return false
  if (value.selectedId !== undefined && !ids.includes(value.selectedId)) return false
  if (typeof value.hasMoreAbove !== 'boolean' || typeof value.hasMoreBelow !== 'boolean') return false
  for (const field of ['sourceCount', 'shownCount', 'hiddenSubagents', 'emptyCount'] as const) {
    if (!nonNegativeInt(value[field])) return false
  }
  if (!isRecord(value.current) || typeof value.current.id !== 'string' || value.current.id === '' || !optionalString(value.current, 'title')) {
    return false
  }
  if (value.mode !== 'list' && value.mode !== 'confirm-delete' && value.mode !== 'rename') return false
  if (value.draft !== undefined) {
    if (!isRecord(value.draft) || !validCursor(value.draft.text, value.draft.cursor)) return false
  }
  if (value.mode === 'rename' && value.draft === undefined) return false
  if (!validPreview(value.preview) || !optionalString(value, 'error') || !validNotice(value.notice) || typeof value.hint !== 'string') {
    return false
  }
  return true
}

function validWorkspaceItem(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.kind !== 'target' && value.kind !== 'choice') return false
  if (typeof value.id !== 'string' || value.id === '' || typeof value.label !== 'string') return false
  if (!optionalString(value, 'description') || !optionalString(value, 'badge')) return false
  if (value.current !== undefined && typeof value.current !== 'boolean') return false
  return value.hasInput === undefined || typeof value.hasInput === 'boolean'
}

function validWorkspacePayload(value: Record<string, unknown>): value is WorkspaceDialogPayload {
  if (typeof value.key !== 'string' || value.key === '' || typeof value.title !== 'string' || !validPhase(value.phase)) return false
  if (value.view !== 'targets' && value.view !== 'choices') return false
  if (!validCursor(value.query, value.cursor)) return false
  if (!Array.isArray(value.items) || value.items.length > WORKSPACE_WINDOW_ITEMS || !value.items.every(validWorkspaceItem)) return false
  const ids = value.items.map((item) => (item as Record<string, unknown>).id)
  if (new Set(ids).size !== ids.length) return false
  if (!optionalString(value, 'selectedId')) return false
  if (value.selectedId !== undefined && !ids.includes(value.selectedId)) return false
  if (typeof value.hasMoreAbove !== 'boolean' || typeof value.hasMoreBelow !== 'boolean') return false
  if (!nonNegativeInt(value.sourceCount) || !nonNegativeInt(value.filteredCount) || value.filteredCount > value.sourceCount) return false
  if (value.input !== undefined) {
    if (!isRecord(value.input) || typeof value.input.choiceId !== 'string' || value.input.choiceId === '') return false
    if (!validCursor(value.input.value, value.input.cursor) || !optionalString(value.input, 'placeholder')) return false
  }
  if (typeof value.degraded !== 'boolean' || !optionalString(value, 'error') || !validNotice(value.notice) || typeof value.hint !== 'string') {
    return false
  }
  return true
}

/** Strict component-boundary narrowing; malformed/foreign payloads render nothing. */
export function parseCatalogOverlayPayload(value: unknown): CatalogOverlayPayload | null {
  if (!isRecord(value) || !isSerializableValue(value as SerializableValue)) return null
  if (value.kind === 'session-browser-dialog') return validSessionPayload(value) ? value : null
  if (value.kind === 'workspace-dialog') return validWorkspacePayload(value) ? value : null
  return null
}
