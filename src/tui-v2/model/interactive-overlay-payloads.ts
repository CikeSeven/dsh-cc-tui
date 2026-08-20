/**
 * Serializable payloads for WP-08c utility overlays. Controllers own input,
 * callbacks and filtering; components receive only immutable view data.
 *
 * Dependency rule (§4.3): model imports nothing from other layers.
 */
import { isSerializableValue, type SerializableValue } from './schema.js'

export type InteractiveOptionView = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly keywords?: readonly string[]
  readonly disabled?: boolean
  readonly disabledReason?: string
}

export type InteractiveListView = {
  readonly query: string
  /** Code-point cursor in query. */
  readonly cursor: number
  readonly activeIndex: number
  readonly windowStart: number
  readonly windowEnd: number
  /** Items after filtering, in action order. */
  readonly items: readonly InteractiveOptionView[]
  /** Number of source items before filtering. */
  readonly sourceCount: number
  readonly emptyMessage: string
  readonly noResultsMessage: string
  readonly hint: string
  readonly error?: string
}

export type PickerDialogPayload = {
  readonly kind: 'picker-dialog'
  readonly key: string
  readonly title: string
  readonly subtitle?: string
  readonly list: InteractiveListView
}

export type HelpShortcutView = {
  readonly keys: string
  readonly label: string
}

export type HelpDialogPayload = {
  readonly kind: 'help-dialog'
  readonly key: string
  readonly title: string
  readonly shortcuts: readonly HelpShortcutView[]
  readonly list: InteractiveListView
}

export type HistorySearchDialogPayload = {
  readonly kind: 'history-search-dialog'
  readonly key: string
  readonly title: string
  readonly placeholder: string
  readonly list: InteractiveListView
}

export type TranscriptSearchDialogPayload = {
  readonly kind: 'transcript-search-dialog'
  readonly key: string
  readonly title: string
  readonly query: string
  /** Code-point cursor in query. */
  readonly cursor: number
  readonly current: number
  readonly total: number
  readonly noResultsMessage: string
  readonly hint: string
  readonly error?: string
}

export type InteractiveOverlayPayload =
  | PickerDialogPayload
  | HelpDialogPayload
  | HistorySearchDialogPayload
  | TranscriptSearchDialogPayload

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonNegativeInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined | null {
  const value = record[field]
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

function parseOption(value: unknown): InteractiveOptionView | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '' || typeof value.label !== 'string') {
    return null
  }
  const description = optionalString(value, 'description')
  const disabledReason = optionalString(value, 'disabledReason')
  if (description === null || disabledReason === null) return null
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') return null
  if (
    value.keywords !== undefined &&
    (!Array.isArray(value.keywords) || !value.keywords.every((item) => typeof item === 'string'))
  ) return null
  return {
    id: value.id,
    label: value.label,
    ...(description !== undefined ? { description } : {}),
    ...(value.keywords !== undefined ? { keywords: value.keywords as readonly string[] } : {}),
    ...(value.disabled !== undefined ? { disabled: value.disabled } : {}),
    ...(disabledReason !== undefined ? { disabledReason } : {}),
  }
}

function parseList(value: unknown): InteractiveListView | null {
  if (!isRecord(value)) return null
  if (typeof value.query !== 'string') return null
  if (!nonNegativeInt(value.cursor) || value.cursor > [...value.query].length) return null
  if (!nonNegativeInt(value.activeIndex) || !nonNegativeInt(value.windowStart) || !nonNegativeInt(value.windowEnd)) {
    return null
  }
  if (!Array.isArray(value.items)) return null
  const items: InteractiveOptionView[] = []
  for (const item of value.items) {
    const parsed = parseOption(item)
    if (parsed === null) return null
    items.push(parsed)
  }
  if (!nonNegativeInt(value.sourceCount) || value.sourceCount < items.length) return null
  if (value.windowStart > value.windowEnd || value.windowEnd > items.length) return null
  if (items.length === 0 ? value.activeIndex !== 0 : value.activeIndex >= items.length) return null
  for (const field of ['emptyMessage', 'noResultsMessage', 'hint'] as const) {
    if (typeof value[field] !== 'string') return null
  }
  const error = optionalString(value, 'error')
  if (error === null) return null
  return {
    query: value.query,
    cursor: value.cursor,
    activeIndex: value.activeIndex,
    windowStart: value.windowStart,
    windowEnd: value.windowEnd,
    items,
    sourceCount: value.sourceCount,
    emptyMessage: value.emptyMessage as string,
    noResultsMessage: value.noResultsMessage as string,
    hint: value.hint as string,
    ...(error !== undefined ? { error } : {}),
  }
}

function parseKey(value: Record<string, unknown>): string | null {
  return typeof value.key === 'string' && value.key !== '' ? value.key : null
}

/** Strict component-boundary narrowing; foreign/malformed payloads render nothing. */
export function parseInteractiveOverlayPayload(value: unknown): InteractiveOverlayPayload | null {
  if (!isRecord(value) || !isSerializableValue(value as SerializableValue)) return null
  const key = parseKey(value)
  if (key === null || typeof value.title !== 'string') return null

  switch (value.kind) {
    case 'picker-dialog': {
      const list = parseList(value.list)
      const subtitle = optionalString(value, 'subtitle')
      if (list === null || subtitle === null) return null
      return {
        kind: 'picker-dialog',
        key,
        title: value.title,
        ...(subtitle !== undefined ? { subtitle } : {}),
        list,
      }
    }
    case 'help-dialog': {
      const list = parseList(value.list)
      if (list === null || !Array.isArray(value.shortcuts)) return null
      const shortcuts: HelpShortcutView[] = []
      for (const shortcut of value.shortcuts) {
        if (!isRecord(shortcut) || typeof shortcut.keys !== 'string' || typeof shortcut.label !== 'string') {
          return null
        }
        shortcuts.push({ keys: shortcut.keys, label: shortcut.label })
      }
      return { kind: 'help-dialog', key, title: value.title, shortcuts, list }
    }
    case 'history-search-dialog': {
      const list = parseList(value.list)
      if (list === null || typeof value.placeholder !== 'string') return null
      return { kind: 'history-search-dialog', key, title: value.title, placeholder: value.placeholder, list }
    }
    case 'transcript-search-dialog': {
      if (typeof value.query !== 'string' || !nonNegativeInt(value.cursor) || value.cursor > [...value.query].length) {
        return null
      }
      if (!nonNegativeInt(value.current) || !nonNegativeInt(value.total)) return null
      if (value.total === 0 ? value.current !== 0 : value.current >= value.total) return null
      if (typeof value.noResultsMessage !== 'string' || typeof value.hint !== 'string') return null
      const error = optionalString(value, 'error')
      if (error === null) return null
      return {
        kind: 'transcript-search-dialog',
        key,
        title: value.title,
        query: value.query,
        cursor: value.cursor,
        current: value.current,
        total: value.total,
        noResultsMessage: value.noResultsMessage,
        hint: value.hint,
        ...(error !== undefined ? { error } : {}),
      }
    }
    default:
      return null
  }
}
