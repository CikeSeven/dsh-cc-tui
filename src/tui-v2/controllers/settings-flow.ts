/**
 * WP-08d2 settings controller.
 *
 * SettingsForm, plugin section callbacks and credential probes stay process
 * local. The reducer/component boundary receives only the bounded payload in
 * `model/settings-routing-overlay-payloads.ts`.
 */
import { SettingsForm, type SettingsFieldState, type SettingsHost, type SettingsNamespaceView } from '../../dsh-adapter/settingsEditor.js'
import type { TuiSettingsField, TuiSettingsSection } from '../../dsh-adapter/settings-sections.js'
import type { AppEvent } from '../model/events.js'
import {
  SETTINGS_MAX_FIELDS,
  SETTINGS_MAX_SECTIONS,
  SETTINGS_SPLIT_COLUMNS,
  type SettingsDialogPayload,
  type SettingsFieldView,
  type SettingsNoticeView,
  type SettingsSectionView,
  type SettingsRoutingPhase,
} from '../model/settings-routing-overlay-payloads.js'
import type { EventMeta, OverlayState } from '../model/schema.js'
import type { UiState } from '../model/state.js'
import type { KeyPayload, PastePayload, TerminalInputEvent } from '../terminal/input.js'

export const SETTINGS_OVERLAY_ID = 'utility/settings'
const SETTINGS_SECTION_WINDOW = 8
const SETTINGS_FIELD_WINDOW = 10
const MAX_TEXT_POINTS = 1024
const MAX_LABEL_POINTS = 512

type FormLike = Pick<SettingsForm, 'available' | 'namespace' | 'field' | 'shell' | 'isStaged' | 'edit' | 'resetField' | 'discard' | 'save' | 'credentialConfigured' | 'failed'> & {
  readonly lastSaveHadConflict?: boolean
}

export interface SettingsSectionsCapability {
  list(): readonly TuiSettingsSection[]
  subscribe(listener: () => void): () => void
}

export interface SettingsFlowControllerOptions {
  readonly dispatch: (event: AppEvent) => void
  readonly nextMeta: (sourceSeq: string) => EventMeta
  readonly getState: () => UiState
  readonly host?: SettingsHost
  readonly sections: SettingsSectionsCapability
  readonly createForm?: (host: SettingsHost, view: SettingsNamespaceView | undefined, fields: readonly TuiSettingsField[]) => FormLike
  readonly isBusinessDialogActive: () => boolean
  readonly language?: string
  readonly onDiagnostic?: (code: string, message: string) => void
}

export interface SettingsFlowDiagnostics {
  readonly opened: number
  readonly closed: number
  readonly reloads: number
  readonly saves: number
  readonly resets: number
  readonly conflicts: number
  readonly cancels: number
  readonly lateResults: number
  readonly errors: number
  readonly staleInput: number
  readonly callbackErrors: number
}

export interface SettingsFlowController {
  readonly open: () => boolean
  readonly close: () => void
  readonly handleInput: (event: TerminalInputEvent) => void
  readonly activeOverlayId: () => string | null
  readonly isManagedOverlay: (overlayId: string) => boolean
  readonly diagnostics: () => SettingsFlowDiagnostics
  readonly dispose: () => void
}

interface SectionRecord {
  readonly id: string
  readonly ns: string
  readonly title: string
  readonly source: 'section' | 'namespace'
  /** False for read-only namespaces and dirty sections whose plugin unloaded. */
  readonly registered: boolean
  readonly section: TuiSettingsSection | undefined
  readonly namespace: SettingsNamespaceView | undefined
  readonly fields: readonly TuiSettingsField[]
  readonly form: FormLike | undefined
}

interface EditingRecord {
  readonly sectionId: string
  readonly field: TuiSettingsField
  text: string
  cursor: number
}

interface ActiveRecord {
  readonly overlayId: string
  readonly key: string
  revision: number
  phase: SettingsRoutingPhase
  pane: 'sections' | 'fields'
  mode: SettingsDialogPayload['mode']
  sections: readonly SectionRecord[]
  sectionIndex: number
  fieldIndex: number
  editing: EditingRecord | undefined
  notice: SettingsNoticeView | undefined
  error: string | undefined
  operationGeneration: number
  abort: AbortController | null
  unsubscribe: (() => void) | null
  secretConfigured: Map<string, boolean>
  publishedJson: string
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeText(value: unknown, max = MAX_LABEL_POINTS): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : String(value)
  } catch {
    text = '<unavailable>'
  }
  // eslint-disable-next-line no-control-regex -- settings labels are one-line UI text
  return [...text.replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ')].slice(0, max).join('')
}

function previewValue(value: unknown): string {
  try {
    return safeText(JSON.stringify(value) ?? String(value), 1024)
  } catch {
    return '<unavailable>'
  }
}

function points(value: string): string[] {
  return [...value]
}

function boundedInput(value: string): string {
  return points(value.replace(/[\r\n\u0000-\u001f\u007f-\u009f]/gu, ' ')).slice(0, MAX_TEXT_POINTS).join('')
}

function localized(text: string, descriptions: Record<string, string> | undefined, language: string): string {
  return safeText(descriptions?.[language] ?? descriptions?.en ?? text)
}

function fieldId(field: TuiSettingsField): string {
  return field.path.join('.') || '<root>'
}

function sectionId(source: 'section' | 'namespace', ns: string): string {
  return `${source}:${ns}`
}

function windowFor(length: number, index: number, budget: number): { start: number; end: number } {
  if (length <= 0) return { start: 0, end: 0 }
  const size = Math.max(1, Math.min(length, budget))
  const focus = Math.max(0, Math.min(index, length - 1))
  const start = Math.max(0, Math.min(focus - Math.floor(size / 2), length - size))
  return { start, end: start + size }
}

function editText(text: string, cursor: number, payload: KeyPayload): { text: string; cursor: number } | null {
  const value = points(text)
  const at = Math.max(0, Math.min(cursor, value.length))
  if (payload.key === 'backspace') {
    if (at > 0) value.splice(at - 1, 1)
    return { text: value.join(''), cursor: Math.max(0, at - 1) }
  }
  if (payload.key === 'delete') {
    if (at < value.length) value.splice(at, 1)
    return { text: value.join(''), cursor: at }
  }
  if (payload.key === 'left') return { text, cursor: Math.max(0, at - 1) }
  if (payload.key === 'right') return { text, cursor: Math.min(value.length, at + 1) }
  if (payload.key === 'home') return { text, cursor: 0 }
  if (payload.key === 'end') return { text, cursor: value.length }
  const inserted = payload.text ?? (payload.key === 'space' ? ' ' : null)
  if (inserted === null) return null
  const incoming = points(boundedInput(inserted))
  const next = [...value.slice(0, at), ...incoming, ...value.slice(at)].slice(0, MAX_TEXT_POINTS)
  return { text: next.join(''), cursor: Math.min(next.length, at + incoming.length) }
}

function formShell(record: SectionRecord): ReturnType<FormLike['shell']> {
  if (record.form === undefined) {
    return { available: false, dirty: false, invalid: false, saving: false, failed: false }
  }
  try {
    return record.form.shell()
  } catch {
    return { available: false, dirty: false, invalid: true, saving: false, failed: true }
  }
}

function safeFieldState(record: SectionRecord, field: TuiSettingsField): SettingsFieldState {
  try {
    return record.form?.field(field) ?? { text: '', overridden: false, invalid: false }
  } catch {
    return { text: '', overridden: false, invalid: true }
  }
}

export function createSettingsFlowController(options: SettingsFlowControllerOptions): SettingsFlowController {
  let disposed = false
  let active: ActiveRecord | null = null
  let instanceSeq = 0
  let journalSeq = 0
  const counts = {
    opened: 0,
    closed: 0,
    reloads: 0,
    saves: 0,
    resets: 0,
    conflicts: 0,
    cancels: 0,
    lateResults: 0,
    errors: 0,
    staleInput: 0,
    callbackErrors: 0,
  }

  const diagnostic = (code: string, detail: string): void => {
    try {
      options.onDiagnostic?.(code, detail)
    } catch {
      counts.callbackErrors += 1
    }
  }

  const live = (record: ActiveRecord, generation?: number): boolean => {
    const ok = !disposed && active === record && (generation === undefined || record.operationGeneration === generation)
    if (!ok) counts.lateResults += 1
    return ok
  }

  const currentSection = (record: ActiveRecord): SectionRecord | undefined => record.sections[record.sectionIndex]

  const normalizeIndices = (record: ActiveRecord): void => {
    if (record.sections.length === 0) {
      record.sectionIndex = 0
      record.fieldIndex = 0
      return
    }
    record.sectionIndex = Math.max(0, Math.min(record.sectionIndex, record.sections.length - 1))
    const fields = currentSection(record)?.fields ?? []
    record.fieldIndex = fields.length === 0 ? 0 : Math.max(0, Math.min(record.fieldIndex, fields.length - 1))
  }

  const makeSectionRecords = (
    namespaces: readonly SettingsNamespaceView[],
    sections: readonly TuiSettingsSection[],
    previous: readonly SectionRecord[],
  ): readonly SectionRecord[] => {
    const namespaceByName = new Map<string, SettingsNamespaceView>()
    for (const view of namespaces.slice(0, SETTINGS_MAX_SECTIONS * 2)) {
      if (typeof view.ns !== 'string' || namespaceByName.has(view.ns)) continue
      namespaceByName.set(view.ns, view)
    }
    const previousByNs = new Map(previous.map((record) => [record.ns, record]))
    const out: SectionRecord[] = []
    const seen = new Set<string>()
    for (const section of sections.slice(0, SETTINGS_MAX_SECTIONS)) {
      const ns = safeText(section.ns, 256).trim()
      if (ns === '' || seen.has(ns)) continue
      seen.add(ns)
      const view = namespaceByName.get(ns)
      const old = previousByNs.get(ns)
      let form = old?.form
      try {
        const dirty = form !== undefined && formShell(old as SectionRecord).dirty
        if (options.host !== undefined && (form === undefined || !dirty)) {
          form = (options.createForm ?? ((host, namespace, fields) => new SettingsForm(host, namespace, fields)))(options.host, view, section.fields)
        }
      } catch (error) {
        form = undefined
        counts.errors += 1
        diagnostic('form-create-failed', message(error))
      }
      out.push({
        id: sectionId('section', ns),
        ns,
        title: localized(section.title, section.descriptions as Record<string, string> | undefined, options.language ?? 'en'),
        source: 'section',
        registered: true,
        section,
        namespace: view,
        fields: section.fields.slice(0, SETTINGS_MAX_FIELDS),
        form,
      })
    }
    // A plugin may unload while its form is dirty. Keep that process-local
    // draft visible but fail closed for further edits/saves until the section
    // registers again; silently dropping it would violate the staged contract.
    for (const old of previous) {
      if (out.length >= SETTINGS_MAX_SECTIONS || old.source !== 'section' || seen.has(old.ns) || !formShell(old).dirty) continue
      seen.add(old.ns)
      out.push({ ...old, registered: false, namespace: namespaceByName.get(old.ns) })
    }
    for (const view of namespaces) {
      if (out.length >= SETTINGS_MAX_SECTIONS || seen.has(view.ns)) continue
      const ns = safeText(view.ns, 256).trim()
      if (ns === '') continue
      seen.add(ns)
      const old = previousByNs.get(ns)
      const preserveDirtySection = old?.source === 'section' && formShell(old).dirty
      out.push(preserveDirtySection
        ? {
            ...old,
            registered: false,
            namespace: view,
          }
        : {
            id: sectionId('namespace', ns),
            ns,
            title: ns,
            source: 'namespace',
            registered: false,
            section: undefined,
            namespace: view,
            fields: [],
            form: undefined,
          })
    }
    return out
  }

  const fieldView = (record: SectionRecord, field: TuiSettingsField, secretConfigured: Map<string, boolean>): SettingsFieldView => {
    const state = safeFieldState(record, field)
    const secret = field.secret !== undefined
    const rawText = safeText(state.text, MAX_TEXT_POINTS)
    const configuredKey = `${record.ns}:${fieldId(field)}`
    const text = secret ? '•'.repeat(Math.min(128, [...rawText].length)) : rawText
    const fieldOptions = field.options?.slice(0, 64).map((option) => ({
      value: safeText(option.value, 512),
      label: localized(option.label, option.descriptions as Record<string, string> | undefined, options.language ?? 'en'),
    }))
    return {
      id: fieldId(field),
      label: localized(field.label, field.descriptions as Record<string, string> | undefined, options.language ?? 'en'),
      ...(field.hint === undefined ? {} : { hint: localized(field.hint, field.hintDescriptions as Record<string, string> | undefined, options.language ?? 'en') }),
      kind: field.kind,
      ...(fieldOptions === undefined ? {} : { options: fieldOptions }),
      text,
      staged: record.form?.isStaged(field) === true,
      overridden: state.overridden,
      invalid: state.invalid,
      secret,
      ...(secret ? { configured: secretConfigured.get(configuredKey) === true } : {}),
    }
  }

  const payloadFor = (record: ActiveRecord): SettingsDialogPayload => {
    normalizeIndices(record)
    const sectionWindow = windowFor(record.sections.length, record.sectionIndex, SETTINGS_SECTION_WINDOW)
    const selected = currentSection(record)
    const fieldsSource = selected?.fields ?? []
    const fieldWindow = windowFor(fieldsSource.length, record.fieldIndex, SETTINGS_FIELD_WINDOW)
    const sections: SettingsSectionView[] = record.sections.map((entry) => {
      const shell = formShell(entry)
      return {
        id: entry.id,
        ns: entry.ns,
        title: entry.title,
        source: entry.source,
        available: entry.registered && entry.form?.available === true,
        applies: entry.namespace?.applies ?? 'live',
        dirty: shell.dirty,
        invalid: shell.invalid,
        saving: shell.saving,
        failed: shell.failed,
        conflicted: entry.form?.lastSaveHadConflict === true,
        fieldsCount: entry.fields.length,
        ...(entry.source === 'namespace' || !entry.registered ? { preview: previewValue(entry.namespace?.value ?? null) } : {}),
      }
    })
    const fields = selected === undefined ? [] : fieldsSource.map((field) => fieldView(selected, field, record.secretConfigured))
    const editing = record.editing === undefined
      ? undefined
      : (() => {
          const text = record.editing.field.secret === undefined
            ? boundedInput(record.editing.text)
            : '•'.repeat(Math.min(128, points(record.editing.text).length))
          return {
            fieldId: fieldId(record.editing.field),
            text,
            cursor: Math.min(points(text).length, record.editing.cursor),
          }
        })()
    return {
      kind: 'settings-dialog',
      key: record.key,
      title: 'Settings',
      phase: record.phase,
      pane: record.pane,
      mode: record.mode,
      sections,
      sectionWindowStart: sectionWindow.start,
      sectionWindowEnd: sectionWindow.end,
      ...(selected === undefined ? {} : { selectedSectionId: selected.id }),
      fields,
      fieldWindowStart: fieldWindow.start,
      fieldWindowEnd: fieldWindow.end,
      ...(selected?.fields[record.fieldIndex] === undefined ? {} : { selectedFieldId: fieldId(selected.fields[record.fieldIndex] as TuiSettingsField) }),
      ...(editing === undefined ? {} : { editing }),
      ...(record.error === undefined ? {} : { error: safeText(record.error, 1024) }),
      ...(record.notice === undefined ? {} : { notice: { ...record.notice, text: safeText(record.notice.text, 1024) } }),
      hint: record.mode === 'edit'
        ? 'Type value · Enter stage · Esc cancel'
        : record.mode === 'confirm-close'
          ? 'Enter discard edits and close · Esc keep editing'
          : record.mode === 'confirm-reload'
            ? 'Enter discard edits and reload · Esc keep edits'
            : '↑/↓ navigate · ←/→ pane · Tab/Backtab cycle · Enter edit · s save · r reload · d reset · Esc back',
    }
  }

  const publish = (record: ActiveRecord): void => {
    if (!live(record)) return
    const payload = payloadFor(record)
    const json = JSON.stringify(payload)
    // Host wakeups and credential probes can be noisy; do not create a new
    // overlay revision when the visible projection did not change.
    if (json === record.publishedJson) return
    record.publishedJson = json
    record.revision += 1
    journalSeq += 1
    const overlay: OverlayState = {
      overlayId: record.overlayId,
      revision: record.revision,
      anchor: 'center',
      width: '96%',
      maxHeight: '94%',
      margin: 1,
      visible: true,
      captureInput: true,
      nonCapturing: false,
      payload,
    }
    options.dispatch({ ...options.nextMeta(`settings-flow-${journalSeq}`), type: 'overlay/open', overlay })
  }

  const closeRecord = (record: ActiveRecord, cancelled: boolean): void => {
    if (active !== record) return
    active = null
    record.abort?.abort()
    record.abort = null
    record.operationGeneration += 1
    record.unsubscribe?.()
    record.unsubscribe = null
    journalSeq += 1
    options.dispatch({ ...options.nextMeta(`settings-flow-${journalSeq}`), type: 'overlay/close', overlayId: record.overlayId })
    counts.closed += 1
    if (cancelled) counts.cancels += 1
  }

  const probeSecrets = (record: ActiveRecord, generation: number): void => {
    const pending: Promise<void>[] = []
    for (const section of record.sections) {
      if (section.form === undefined) continue
      for (const field of section.fields) {
        if (field.secret === undefined) continue
        const key = `${section.ns}:${fieldId(field)}`
        pending.push(Promise.resolve().then(() => section.form?.credentialConfigured(field)).then((configured) => {
          if (!live(record, generation) || record.abort?.signal.aborted) return
          record.secretConfigured.set(key, configured === true)
          publish(record)
        }).catch((error: unknown) => {
          if (!live(record, generation)) return
          diagnostic('credential-probe-failed', message(error))
        }))
      }
    }
    void Promise.all(pending).catch(() => {})
  }

  const rebuild = (record: ActiveRecord, namespaces: readonly SettingsNamespaceView[], sections: readonly TuiSettingsSection[]): void => {
    const before = record.sections
    const oldId = currentSection(record)?.id
    record.sections = makeSectionRecords(namespaces, sections, before)
    const index = record.sections.findIndex((entry) => entry.id === oldId)
    record.sectionIndex = index >= 0 ? index : Math.min(record.sectionIndex, Math.max(0, record.sections.length - 1))
    normalizeIndices(record)
  }

  const reload = (record: ActiveRecord, preserveNotice: boolean): void => {
    record.abort?.abort()
    const controller = new AbortController()
    record.abort = controller
    const generation = ++record.operationGeneration
    counts.reloads += 1
    record.phase = 'loading'
    record.mode = 'list'
    record.editing = undefined
    record.error = undefined
    if (!preserveNotice) record.notice = undefined
    publish(record)
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return
      const namespaces = options.host?.listNamespaces() ?? []
      const sections = options.sections.list()
      if (!live(record, generation)) return
      rebuild(record, namespaces, sections)
      record.phase = 'ready'
      record.abort = null
      publish(record)
      probeSecrets(record, generation)
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !live(record, generation)) return
      record.abort = null
      record.phase = 'error'
      record.error = `Settings reload failed: ${message(error)}`
      counts.errors += 1
      diagnostic('reload-failed', message(error))
      publish(record)
    })
  }

  const subscribe = (record: ActiveRecord): void => {
    try {
      record.unsubscribe = options.sections.subscribe(() => {
        if (!live(record) || record.phase === 'pending') return
        reload(record, true)
      })
    } catch (error) {
      counts.errors += 1
      diagnostic('sections-subscribe-failed', message(error))
    }
  }

  const moveSection = (record: ActiveRecord, delta: number): void => {
    if (record.sections.length === 0) return
    record.sectionIndex = (record.sectionIndex + delta + record.sections.length) % record.sections.length
    record.fieldIndex = 0
    record.editing = undefined
    record.error = undefined
    publish(record)
  }

  const moveField = (record: ActiveRecord, delta: number): void => {
    const fields = currentSection(record)?.fields ?? []
    if (fields.length === 0) return
    const next = record.fieldIndex + delta
    if (next < 0) {
      record.sectionIndex = (record.sectionIndex - 1 + record.sections.length) % record.sections.length
      record.fieldIndex = Math.max(0, (currentSection(record)?.fields.length ?? 1) - 1)
    } else if (next >= fields.length) {
      record.sectionIndex = (record.sectionIndex + 1) % record.sections.length
      record.fieldIndex = 0
    } else {
      record.fieldIndex = next
    }
    record.error = undefined
    publish(record)
  }

  const selectedField = (record: ActiveRecord): { section: SectionRecord; field: TuiSettingsField } | undefined => {
    const section = currentSection(record)
    const field = section?.fields[record.fieldIndex]
    return section === undefined || field === undefined ? undefined : { section, field }
  }

  const beginEdit = (record: ActiveRecord): void => {
    const selected = selectedField(record)
    if (selected === undefined || !selected.section.registered || selected.section.form === undefined || !selected.section.form.available || formShell(selected.section).saving) return
    if (selected.field.kind === 'boolean' || selected.field.kind === 'select') {
      const state = safeFieldState(selected.section, selected.field)
      if (selected.field.kind === 'boolean') {
        selected.section.form.edit(selected.field, state.text === 'true' ? 'false' : 'true')
      } else {
        const choices = selected.field.options ?? []
        if (choices.length === 0) return
        const index = choices.findIndex((choice) => choice.value === state.text)
        selected.section.form.edit(selected.field, choices[(index + 1) % choices.length]?.value ?? choices[0]?.value ?? '')
      }
      record.error = undefined
      publish(record)
      return
    }
    const state = safeFieldState(selected.section, selected.field)
    record.editing = { sectionId: selected.section.id, field: selected.field, text: state.text, cursor: points(state.text).length }
    record.mode = 'edit'
    record.error = undefined
    publish(record)
  }

  const commitEdit = (record: ActiveRecord): void => {
    const editing = record.editing
    if (editing === undefined) return
    const section = record.sections.find((entry) => entry.id === editing.sectionId)
    if (section?.form === undefined) return
    try {
      section.form.edit(editing.field, boundedInput(editing.text))
      record.editing = undefined
      record.mode = 'list'
      record.error = undefined
      publish(record)
    } catch (error) {
      record.error = `Field edit failed: ${message(error)}`
      counts.errors += 1
      diagnostic('field-edit-failed', message(error))
      publish(record)
    }
  }

  const discardAll = (record: ActiveRecord): void => {
    for (const section of record.sections) {
      try { section.form?.discard() } catch (error) { diagnostic('discard-failed', message(error)) }
    }
  }

  const saveSelected = (record: ActiveRecord): void => {
    const section = currentSection(record)
    if (section?.form === undefined || !section.registered) return
    const shell = formShell(section)
    if (!shell.available || !shell.dirty || shell.saving) return
    if (shell.invalid) {
      record.error = 'Fix invalid fields before saving.'
      publish(record)
      return
    }
    const generation = ++record.operationGeneration
    record.abort?.abort()
    record.abort = new AbortController()
    record.phase = 'pending'
    record.error = undefined
    record.notice = undefined
    counts.saves += 1
    publish(record)
    void section.form.save().then((ok) => {
      if (!live(record, generation) || record.abort?.signal.aborted) return
      record.abort = null
      if (!ok) {
        record.phase = 'ready'
        record.error = section.form?.failed === true ? 'Settings save failed.' : 'Nothing was saved.'
        counts.errors += 1
        publish(record)
        return
      }
      if (section.form?.lastSaveHadConflict === true) {
        counts.conflicts += 1
        record.notice = { text: `Concurrent revision detected for ${section.ns}; saved against the latest revision.`, tone: 'warning' }
      } else {
        record.notice = { text: `Saved ${section.ns}.`, tone: 'success' }
      }
      record.phase = 'ready'
      publish(record)
      // Re-seed clean forms from the host while preserving any newer edit made
      // while the write was in flight (SettingsForm owns that identity fence).
      reload(record, true)
    }).catch((error: unknown) => {
      if (!live(record, generation)) return
      record.abort = null
      record.phase = 'ready'
      record.error = `Settings save failed: ${message(error)}`
      counts.errors += 1
      diagnostic('save-failed', message(error))
      publish(record)
    })
  }

  const requestReload = (record: ActiveRecord): void => {
    const dirty = record.sections.some((section) => formShell(section).dirty)
    if (dirty) {
      record.mode = 'confirm-reload'
      record.error = undefined
      publish(record)
      return
    }
    reload(record, false)
  }

  const closeFromInput = (record: ActiveRecord): void => {
    if (record.mode === 'confirm-close') {
      discardAll(record)
      closeRecord(record, true)
      return
    }
    if (record.mode === 'confirm-reload') {
      discardAll(record)
      record.mode = 'list'
      reload(record, false)
      return
    }
    if (record.mode === 'edit') {
      record.editing = undefined
      record.mode = 'list'
      record.error = undefined
      publish(record)
      return
    }
    if (record.pane === 'fields') {
      record.pane = 'sections'
      record.error = undefined
      publish(record)
      return
    }
    if (record.sections.some((section) => formShell(section).dirty)) {
      record.mode = 'confirm-close'
      record.error = undefined
      publish(record)
      return
    }
    closeRecord(record, true)
  }

  const handleKey = (record: ActiveRecord, payload: KeyPayload): void => {
    if (payload.eventType === 'release') return
    if (record.mode === 'confirm-close' || record.mode === 'confirm-reload') {
      if (payload.key === 'enter') closeFromInput(record)
      else if (payload.key === 'escape' || payload.key === 'ctrl+g') {
        record.mode = 'list'
        record.error = undefined
        publish(record)
      }
      return
    }
    if (payload.key === 'escape' || payload.key === 'ctrl+g') {
      closeFromInput(record)
      return
    }
    if (record.phase === 'loading' || record.phase === 'pending') return
    if (record.mode === 'edit') {
      if (payload.key === 'enter') commitEdit(record)
      else {
        const edited = editText(record.editing?.text ?? '', record.editing?.cursor ?? 0, payload)
        if (edited !== null && record.editing !== undefined) {
          record.editing.text = edited.text
          record.editing.cursor = edited.cursor
          record.error = undefined
          publish(record)
        }
      }
      return
    }
    if (payload.key === 'up' || payload.key === 'down') {
      if (record.pane === 'sections') moveSection(record, payload.key === 'up' ? -1 : 1)
      else moveField(record, payload.key === 'up' ? -1 : 1)
      return
    }
    if (payload.key === 'left') {
      record.pane = 'sections'
      record.error = undefined
      publish(record)
      return
    }
    if (payload.key === 'right') {
      if ((currentSection(record)?.fields.length ?? 0) > 0) record.pane = 'fields'
      record.error = undefined
      publish(record)
      return
    }
    if (payload.key === 'tab' || payload.key === 'shift+tab') {
      record.pane = record.pane === 'sections' && (currentSection(record)?.fields.length ?? 0) > 0
        ? 'fields'
        : 'sections'
      record.error = undefined
      publish(record)
      return
    }
    if (payload.key === 'enter') {
      if (record.pane === 'sections') {
        if ((currentSection(record)?.fields.length ?? 0) > 0) record.pane = 'fields'
        publish(record)
      } else beginEdit(record)
      return
    }
    if (payload.key === 'd' || payload.key === 'delete' || payload.key === 'ctrl+d') {
      const selected = selectedField(record)
      if (selected?.section.registered === true && selected.section.form !== undefined && !formShell(selected.section).saving) {
        selected.section.form.resetField(selected.field)
        counts.resets += 1
        record.error = undefined
        publish(record)
      }
      return
    }
    if (payload.key === 's' || payload.key === 'ctrl+s') {
      saveSelected(record)
      return
    }
    if (payload.key === 'r' || payload.key === 'ctrl+r') {
      requestReload(record)
      return
    }
  }

  const handleInput = (event: TerminalInputEvent): void => {
    const record = active
    if (disposed || record === null) return
    const focus = options.getState().focus
    if (focus.target !== 'overlay' || focus.overlayId !== record.overlayId) {
      counts.staleInput += 1
      return
    }
    if (event.kind === 'key') handleKey(record, event.payload as KeyPayload)
    else if (event.kind === 'paste' && record.mode === 'edit' && record.editing !== undefined) {
      const edited = editText(record.editing.text, record.editing.cursor, { key: null, raw: '', text: (event.payload as PastePayload).text, eventType: 'press' })
      if (edited !== null) {
        record.editing.text = edited.text
        record.editing.cursor = edited.cursor
        record.error = undefined
        publish(record)
      }
    }
  }

  return {
    open() {
      if (disposed || options.isBusinessDialogActive()) return false
      if (active !== null) closeRecord(active, false)
      const record: ActiveRecord = {
        overlayId: SETTINGS_OVERLAY_ID,
        key: `settings-${++instanceSeq}`,
        revision: 0,
        phase: 'loading',
        pane: 'sections',
        mode: 'list',
        sections: [],
        sectionIndex: 0,
        fieldIndex: 0,
        editing: undefined,
        notice: undefined,
        error: undefined,
        operationGeneration: 0,
        abort: null,
        unsubscribe: null,
        secretConfigured: new Map(),
        publishedJson: '',
      }
      active = record
      counts.opened += 1
      publish(record)
      subscribe(record)
      reload(record, false)
      return true
    },
    close() {
      if (active !== null) closeRecord(active, true)
    },
    handleInput,
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

/** Exported for component/verify documentation without making components import adapter code. */
export const SETTINGS_DUAL_COLUMN_THRESHOLD = SETTINGS_SPLIT_COLUMNS
