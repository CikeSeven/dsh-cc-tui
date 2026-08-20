/**
 * WP-08d2 serializable projections for settings and route pickers.
 *
 * Controllers retain SettingsForm/Channel callbacks and async records. Only
 * these bounded plain-data projections cross the reducer/component boundary.
 * Components must be able to render a malformed/foreign payload as nothing.
 */
import { isSerializableValue, type SerializableValue } from './schema.js'

export const SETTINGS_SPLIT_COLUMNS = 100
export const SETTINGS_MAX_SECTIONS = 64
export const SETTINGS_MAX_FIELDS = 64
export const ROUTING_MAX_OPTIONS = 256
export const ROUTING_MAX_METADATA = 8

export type SettingsRoutingPhase = 'loading' | 'ready' | 'pending' | 'error'
export type SettingsPane = 'sections' | 'fields'
export type SettingsInteractionMode = 'list' | 'edit' | 'confirm-close' | 'confirm-reload'
export type SettingsFieldKind = 'text' | 'number' | 'boolean' | 'select'

export type SettingsNoticeView = {
  readonly text: string
  readonly tone: 'info' | 'success' | 'warning' | 'error'
}

export type SettingsOptionView = {
  readonly value: string
  readonly label: string
}

export type SettingsFieldView = {
  readonly id: string
  readonly label: string
  readonly hint?: string
  readonly kind: SettingsFieldKind
  readonly options?: readonly SettingsOptionView[]
  /** Non-secret effective/staged text; secret fields contain only bullets. */
  readonly text: string
  readonly staged: boolean
  readonly overridden: boolean
  readonly invalid: boolean
  readonly secret: boolean
  readonly configured?: boolean
}

export type SettingsSectionView = {
  readonly id: string
  readonly ns: string
  readonly title: string
  readonly source: 'section' | 'namespace'
  readonly available: boolean
  readonly applies: 'live' | 'restart'
  readonly dirty: boolean
  readonly invalid: boolean
  readonly saving: boolean
  readonly failed: boolean
  readonly conflicted: boolean
  readonly fieldsCount: number
  readonly preview?: string
}

export type SettingsEditingView = {
  readonly fieldId: string
  /** Secret drafts are always masked. */
  readonly text: string
  readonly cursor: number
}

export type SettingsDialogPayload = {
  readonly kind: 'settings-dialog'
  readonly key: string
  readonly title: string
  readonly phase: SettingsRoutingPhase
  readonly pane: SettingsPane
  readonly mode: SettingsInteractionMode
  readonly sections: readonly SettingsSectionView[]
  readonly sectionWindowStart: number
  readonly sectionWindowEnd: number
  readonly selectedSectionId?: string
  readonly fields: readonly SettingsFieldView[]
  readonly fieldWindowStart: number
  readonly fieldWindowEnd: number
  readonly selectedFieldId?: string
  readonly editing?: SettingsEditingView
  readonly error?: string
  readonly notice?: SettingsNoticeView
  readonly hint: string
}

export type RoutingOptionView = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly provider?: string
  readonly metadata?: readonly { readonly label: string; readonly value: string }[]
  readonly badges?: readonly string[]
  readonly current?: boolean
  readonly disabled?: boolean
  readonly disabledReason?: string
}

export type RoutingListView = {
  readonly query: string
  readonly cursor: number
  readonly activeIndex: number
  readonly windowStart: number
  readonly windowEnd: number
  readonly items: readonly RoutingOptionView[]
  readonly sourceCount: number
  readonly emptyMessage: string
  readonly noResultsMessage: string
}

export type RoutingPickerPayload = {
  readonly kind: 'routing-picker-dialog'
  readonly key: string
  readonly title: string
  readonly route: 'model' | 'preset'
  readonly phase: SettingsRoutingPhase
  readonly list: RoutingListView
  readonly pendingId?: string
  readonly error?: string
  readonly notice?: SettingsNoticeView
  readonly hint: string
}

export type EffortOptionView = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly current?: boolean
  readonly default?: boolean
  readonly disabled?: boolean
}

export type EffortDialogPayload = {
  readonly kind: 'effort-dialog'
  readonly key: string
  readonly title: string
  readonly phase: SettingsRoutingPhase
  readonly options: readonly EffortOptionView[]
  readonly activeIndex: number
  readonly currentId?: string
  readonly defaultId?: string
  readonly pendingId?: string
  readonly error?: string
  readonly notice?: SettingsNoticeView
  readonly hint: string
}

export type SettingsRoutingOverlayPayload =
  | SettingsDialogPayload
  | RoutingPickerPayload
  | EffortDialogPayload

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonNegativeInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function boundedString(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && [...value].length <= max
}

function optionalBoundedString(record: Record<string, unknown>, key: string, max = 2048): boolean {
  return record[key] === undefined || boundedString(record[key], max)
}

function validPhase(value: unknown): value is SettingsRoutingPhase {
  return value === 'loading' || value === 'ready' || value === 'pending' || value === 'error'
}

function validNotice(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || !boundedString(value.text, 1024)) return false
  return value.tone === 'info' || value.tone === 'success' || value.tone === 'warning' || value.tone === 'error'
}

function validCursor(text: unknown, cursor: unknown): boolean {
  return boundedString(text, 2048) && nonNegativeInt(cursor) && cursor <= [...text].length
}

function validSettingsOption(value: unknown): boolean {
  return isRecord(value) && boundedString(value.value, 512) && boundedString(value.label, 512)
}

function validSettingsField(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!boundedString(value.id, 512) || !boundedString(value.label, 512)) return false
  if (value.hint !== undefined && !boundedString(value.hint, 1024)) return false
  if (value.kind !== 'text' && value.kind !== 'number' && value.kind !== 'boolean' && value.kind !== 'select') return false
  if (!boundedString(value.text, 1024)) return false
  for (const key of ['staged', 'overridden', 'invalid', 'secret'] as const) {
    if (typeof value[key] !== 'boolean') return false
  }
  if (value.configured !== undefined && typeof value.configured !== 'boolean') return false
  if (value.options !== undefined && (!Array.isArray(value.options) || value.options.length > 64 || !value.options.every(validSettingsOption))) return false
  return true
}

function validSettingsSection(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!boundedString(value.id, 512) || !boundedString(value.ns, 256) || !boundedString(value.title, 512)) return false
  if (value.source !== 'section' && value.source !== 'namespace') return false
  if (typeof value.available !== 'boolean' || (value.applies !== 'live' && value.applies !== 'restart')) return false
  for (const key of ['dirty', 'invalid', 'saving', 'failed', 'conflicted'] as const) {
    if (typeof value[key] !== 'boolean') return false
  }
  if (!nonNegativeInt(value.fieldsCount)) return false
  return value.preview === undefined || boundedString(value.preview, 1024)
}

function validSettingsPayload(value: Record<string, unknown>): value is SettingsDialogPayload {
  if (!boundedString(value.key, 256) || !boundedString(value.title, 512) || !validPhase(value.phase)) return false
  if (value.pane !== 'sections' && value.pane !== 'fields') return false
  if (value.mode !== 'list' && value.mode !== 'edit' && value.mode !== 'confirm-close' && value.mode !== 'confirm-reload') return false
  if (!Array.isArray(value.sections) || value.sections.length > SETTINGS_MAX_SECTIONS || !value.sections.every(validSettingsSection)) return false
  if (!nonNegativeInt(value.sectionWindowStart) || !nonNegativeInt(value.sectionWindowEnd) || value.sectionWindowStart > value.sectionWindowEnd || value.sectionWindowEnd > value.sections.length) return false
  if (value.selectedSectionId !== undefined && (!boundedString(value.selectedSectionId, 512) || !value.sections.some((section) => section.id === value.selectedSectionId))) return false
  if (!Array.isArray(value.fields) || value.fields.length > SETTINGS_MAX_FIELDS || !value.fields.every(validSettingsField)) return false
  if (!nonNegativeInt(value.fieldWindowStart) || !nonNegativeInt(value.fieldWindowEnd) || value.fieldWindowStart > value.fieldWindowEnd || value.fieldWindowEnd > value.fields.length) return false
  if (value.selectedFieldId !== undefined && (!boundedString(value.selectedFieldId, 512) || !value.fields.some((field) => field.id === value.selectedFieldId))) return false
  if (value.editing !== undefined) {
    const editing = value.editing
    if (!isRecord(editing) || !boundedString(editing.fieldId, 512) || !validCursor(editing.text, editing.cursor)) return false
    if (!value.fields.some((field) => field.id === editing.fieldId)) return false
  }
  if (!optionalBoundedString(value, 'error') || !validNotice(value.notice) || typeof value.hint !== 'string') return false
  return true
}

function validRoutingOption(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!boundedString(value.id, 512) || !boundedString(value.label, 1024)) return false
  if (!optionalBoundedString(value, 'description', 1024) || !optionalBoundedString(value, 'provider', 256)) return false
  if (value.metadata !== undefined) {
    if (!Array.isArray(value.metadata) || value.metadata.length > ROUTING_MAX_METADATA) return false
    if (!value.metadata.every((entry) => isRecord(entry) && boundedString(entry.label, 256) && boundedString(entry.value, 512))) return false
  }
  if (value.badges !== undefined && (!Array.isArray(value.badges) || value.badges.length > 8 || !value.badges.every((entry) => boundedString(entry, 128)))) return false
  for (const key of ['current', 'disabled'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return false
  }
  return value.disabledReason === undefined || boundedString(value.disabledReason, 512)
}

function validRoutingList(value: unknown): boolean {
  if (!isRecord(value) || !validCursor(value.query, value.cursor)) return false
  if (!nonNegativeInt(value.activeIndex) || !nonNegativeInt(value.windowStart) || !nonNegativeInt(value.windowEnd)) return false
  if (!Array.isArray(value.items) || value.items.length > ROUTING_MAX_OPTIONS || !value.items.every(validRoutingOption)) return false
  if (value.windowStart > value.windowEnd || value.windowEnd > value.items.length) return false
  if (value.items.length === 0 ? value.activeIndex !== 0 : value.activeIndex >= value.items.length) return false
  return nonNegativeInt(value.sourceCount) && value.sourceCount >= value.items.length
    && boundedString(value.emptyMessage, 512) && boundedString(value.noResultsMessage, 512)
}

function validRoutingPayload(value: Record<string, unknown>): value is RoutingPickerPayload {
  return boundedString(value.key, 256)
    && boundedString(value.title, 512)
    && (value.route === 'model' || value.route === 'preset')
    && validPhase(value.phase)
    && validRoutingList(value.list)
    && optionalBoundedString(value, 'pendingId', 512)
    && optionalBoundedString(value, 'error', 1024)
    && validNotice(value.notice)
    && boundedString(value.hint, 1024)
}

function validEffortOption(value: unknown): boolean {
  if (!isRecord(value) || !boundedString(value.id, 256) || !boundedString(value.name, 512)) return false
  if (!optionalBoundedString(value, 'description', 1024)) return false
  if (value.current !== undefined && typeof value.current !== 'boolean') return false
  if (value.default !== undefined && typeof value.default !== 'boolean') return false
  return value.disabled === undefined || typeof value.disabled === 'boolean'
}

function validEffortPayload(value: Record<string, unknown>): value is EffortDialogPayload {
  if (!boundedString(value.key, 256) || !boundedString(value.title, 512) || !validPhase(value.phase)) return false
  if (!Array.isArray(value.options) || value.options.length > ROUTING_MAX_OPTIONS || !value.options.every(validEffortOption)) return false
  if (!nonNegativeInt(value.activeIndex) || (value.options.length === 0 ? value.activeIndex !== 0 : value.activeIndex >= value.options.length)) return false
  return optionalBoundedString(value, 'currentId', 256)
    && optionalBoundedString(value, 'defaultId', 256)
    && optionalBoundedString(value, 'pendingId', 256)
    && optionalBoundedString(value, 'error', 1024)
    && validNotice(value.notice)
    && boundedString(value.hint, 1024)
}

/** Strict boundary parser used by the compositor bridge and component tests. */
export function parseSettingsRoutingOverlayPayload(value: unknown): SettingsRoutingOverlayPayload | null {
  if (!isRecord(value) || !isSerializableValue(value as SerializableValue)) return null
  switch (value.kind) {
    case 'settings-dialog': return validSettingsPayload(value) ? value : null
    case 'routing-picker-dialog': return validRoutingPayload(value) ? value : null
    case 'effort-dialog': return validEffortPayload(value) ? value : null
    default: return null
  }
}
