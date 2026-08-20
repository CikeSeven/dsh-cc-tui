/**
 * WP-08d2 model/preset/effort picker controller.
 *
 * This owner projects Channel capabilities into bounded picker/slider payloads.
 * It never forks, recomposes, writes preferences or mutates tool state itself.
 */
import type { EffortOption, PresetOption } from '../../dsh-adapter/channel.js'
import type { LlmModelInfo } from '../../dsh-adapter/types.js'
import type { AppEvent } from '../model/events.js'
import {
  ROUTING_MAX_OPTIONS,
  type EffortDialogPayload,
  type EffortOptionView,
  type RoutingListView,
  type RoutingOptionView,
  type RoutingPickerPayload,
  type SettingsNoticeView,
  type SettingsRoutingPhase,
} from '../model/settings-routing-overlay-payloads.js'
import type { EventMeta, OverlayState } from '../model/schema.js'
import type { UiState } from '../model/state.js'
import type { KeyPayload, PastePayload, TerminalInputEvent } from '../terminal/input.js'

export type ChannelOptionsKind = 'model' | 'preset' | 'effort'

export interface ChannelOptionsCapability {
  listModels(signal?: AbortSignal): Promise<readonly LlmModelInfo[]>
  switchModel(provider: string, model: string): Promise<boolean>
  listPresets(signal?: AbortSignal): Promise<readonly PresetOption[]>
  switchPreset(id: string): Promise<boolean>
  listEfforts(signal?: AbortSignal): Promise<{ efforts: readonly EffortOption[]; defaultEffort: string | undefined }>
  setEffort(id: string): Promise<boolean>
  currentModel(): { readonly provider: string; readonly model: string }
  currentPreset(): string | undefined
  currentEffort(): string | undefined
  working(): boolean
  subscribe(listener: () => void): () => void
}

export interface ChannelOptionsControllerOptions {
  readonly dispatch: (event: AppEvent) => void
  readonly nextMeta: (sourceSeq: string) => EventMeta
  readonly getState: () => UiState
  readonly capability: ChannelOptionsCapability
  readonly isBusinessDialogActive: () => boolean
  readonly onDiagnostic?: (code: string, message: string) => void
}

export interface ChannelOptionsDiagnostics {
  readonly opened: number
  readonly closed: number
  readonly loads: number
  readonly selections: number
  readonly liveEffortChanges: number
  readonly cancels: number
  readonly lateResults: number
  readonly errors: number
  readonly staleInput: number
  readonly callbackErrors: number
}

export interface ChannelOptionsController {
  readonly openModel: (query?: string) => boolean
  readonly openPreset: (query?: string) => boolean
  readonly openEffort: () => boolean
  readonly close: () => void
  readonly handleInput: (event: TerminalInputEvent) => void
  readonly activeOverlayId: () => string | null
  readonly isManagedOverlay: (overlayId: string) => boolean
  readonly diagnostics: () => ChannelOptionsDiagnostics
  readonly dispose: () => void
}

const OVERLAY_IDS: Record<ChannelOptionsKind, string> = {
  model: 'utility/model',
  preset: 'utility/preset',
  effort: 'utility/effort',
}
const MAX_QUERY_POINTS = 256
const LIST_WINDOW = 9

interface ModelSource {
  readonly kind: 'model'
  /** Bounded process-local picker identity; never sent to the Channel. */
  readonly id: string
  /** Exact provider/model values for the existing atomic route API. */
  readonly provider: string
  readonly model: string
  readonly displayProvider: string
  readonly displayModel: string
  readonly label: string
  readonly description: string | undefined
  readonly metadata: readonly { label: string; value: string }[]
}
interface PresetSource {
  readonly kind: 'preset'
  readonly id: string
  /** Exact roster id for switchPreset; never projected without sanitizing. */
  readonly presetId: string
  readonly displayId: string
  readonly label: string
  readonly description: string | undefined
  readonly badges: readonly string[]
  readonly disabled: boolean
  readonly disabledReason: string | undefined
}
interface EffortSource {
  readonly id: string
  /** Exact adapter-owned id for setEffort. */
  readonly effortId: string
  readonly name: string
  readonly description: string | undefined
}

type RecordSource = ModelSource | PresetSource

interface ActiveRecord {
  readonly kind: ChannelOptionsKind
  readonly overlayId: string
  readonly key: string
  revision: number
  phase: SettingsRoutingPhase
  query: string
  cursor: number
  sources: readonly RecordSource[]
  efforts: readonly EffortSource[]
  activeIndex: number
  defaultId: string | undefined
  pendingId: string | undefined
  error: string | undefined
  notice: SettingsNoticeView | undefined
  operationGeneration: number
  abort: AbortController | null
  unsubscribe: (() => void) | null
  publishedJson: string
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safe(value: unknown, max = 1024): string {
  let text: string
  try { text = typeof value === 'string' ? value : String(value) } catch { text = '<unavailable>' }
  // eslint-disable-next-line no-control-regex -- picker text is displayed on one line
  return [...text.replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ')].slice(0, max).join('')
}

function boundedQuery(value: string): string {
  return [...safe(value, MAX_QUERY_POINTS)].slice(0, MAX_QUERY_POINTS).join('')
}

function folded(value: string): string {
  return value.toLocaleLowerCase('en-US')
}

function windowFor(length: number, index: number): { start: number; end: number } {
  if (length === 0) return { start: 0, end: 0 }
  const size = Math.min(LIST_WINDOW, length)
  const focus = Math.max(0, Math.min(index, length - 1))
  const start = Math.max(0, Math.min(focus - Math.floor(size / 2), length - size))
  return { start, end: start + size }
}

function editQuery(text: string, cursor: number, payload: KeyPayload): { text: string; cursor: number } | null {
  const chars = [...text]
  const at = Math.max(0, Math.min(cursor, chars.length))
  if (payload.key === 'backspace') {
    if (at > 0) chars.splice(at - 1, 1)
    return { text: chars.join(''), cursor: Math.max(0, at - 1) }
  }
  if (payload.key === 'delete') {
    if (at < chars.length) chars.splice(at, 1)
    return { text: chars.join(''), cursor: at }
  }
  if (payload.key === 'left') return { text, cursor: Math.max(0, at - 1) }
  if (payload.key === 'right') return { text, cursor: Math.min(chars.length, at + 1) }
  if (payload.key === 'home') return { text, cursor: 0 }
  if (payload.key === 'end') return { text, cursor: chars.length }
  const inserted = payload.text ?? (payload.key === 'space' ? ' ' : null)
  if (inserted === null) return null
  const incoming = [...safe(inserted, MAX_QUERY_POINTS)]
  const next = [...chars.slice(0, at), ...incoming, ...chars.slice(at)].slice(0, MAX_QUERY_POINTS)
  return { text: next.join(''), cursor: Math.min(next.length, at + incoming.length) }
}

export function createChannelOptionsController(options: ChannelOptionsControllerOptions): ChannelOptionsController {
  let disposed = false
  let active: ActiveRecord | null = null
  let instanceSeq = 0
  let journalSeq = 0
  const counts = {
    opened: 0,
    closed: 0,
    loads: 0,
    selections: 0,
    liveEffortChanges: 0,
    cancels: 0,
    lateResults: 0,
    errors: 0,
    staleInput: 0,
    callbackErrors: 0,
  }

  const diagnostic = (code: string, detail: string): void => {
    try { options.onDiagnostic?.(code, detail) } catch { counts.callbackErrors += 1 }
  }

  const live = (record: ActiveRecord, generation?: number): boolean => {
    const ok = !disposed && active === record && (generation === undefined || generation === record.operationGeneration)
    if (!ok) counts.lateResults += 1
    return ok
  }

  const filtered = (record: ActiveRecord): readonly RecordSource[] => {
    const needle = folded(record.query.trim())
    if (needle === '') return record.sources
    return record.sources.filter((source) => {
      const text = source.kind === 'model'
        ? [source.displayProvider, source.displayModel, source.label, source.description ?? '', ...source.metadata.map((entry) => `${entry.label} ${entry.value}`)].join('\n')
        : [source.displayId, source.label, source.description ?? '', ...source.badges].join('\n')
      return folded(text).includes(needle)
    })
  }

  const modelIsCurrent = (source: ModelSource): boolean => {
    const current = options.capability.currentModel()
    return source.provider === current.provider && source.model === current.model
  }

  const routingOption = (record: ActiveRecord, source: RecordSource): RoutingOptionView => {
    if (source.kind === 'model') {
      const current = modelIsCurrent(source)
      const blocked = options.capability.working() && !current
      return {
        id: source.id,
        label: `${source.displayProvider} / ${source.label}`,
        ...(source.description === undefined ? {} : { description: source.description }),
        provider: source.displayProvider,
        ...(source.metadata.length === 0 ? {} : { metadata: source.metadata }),
        ...(current ? { current: true } : {}),
        ...(blocked ? { disabled: true, disabledReason: 'Model switching is unavailable while a turn is running.' } : {}),
      }
    }
    const current = options.capability.currentPreset() === source.presetId
    return {
      id: source.id,
      label: source.label,
      ...(source.description === undefined ? {} : { description: source.description }),
      ...(source.badges.length === 0 ? {} : { badges: source.badges }),
      ...(current ? { current: true } : {}),
      ...(source.disabled ? { disabled: true, ...(source.disabledReason === undefined ? {} : { disabledReason: source.disabledReason }) } : {}),
    }
  }

  const routingPayload = (record: ActiveRecord): RoutingPickerPayload => {
    const values = filtered(record)
    const index = values.length === 0 ? 0 : Math.max(0, Math.min(record.activeIndex, values.length - 1))
    const window = windowFor(values.length, index)
    const items = values.map((source) => routingOption(record, source))
    return {
      kind: 'routing-picker-dialog',
      key: record.key,
      title: record.kind === 'model' ? 'Choose model' : 'Choose preset',
      route: record.kind === 'preset' ? 'preset' : 'model',
      phase: record.phase,
      list: {
        query: record.query,
        cursor: record.cursor,
        activeIndex: index,
        windowStart: window.start,
        windowEnd: window.end,
        items,
        sourceCount: record.sources.length,
        emptyMessage: record.kind === 'model' ? 'No models are advertised by the active providers.' : 'No preset roster is available.',
        noResultsMessage: record.kind === 'model' ? 'No models match this filter.' : 'No presets match this filter.',
      },
      ...(record.pendingId === undefined ? {} : { pendingId: record.pendingId }),
      ...(record.error === undefined ? {} : { error: safe(record.error, 1024) }),
      ...(record.notice === undefined ? {} : { notice: { ...record.notice, text: safe(record.notice.text, 1024) } }),
      hint: record.phase === 'pending'
        ? 'Working… · Esc closes and ignores any late result'
        : 'Type to filter · ↑/↓/PgUp/PgDn · Enter select · Esc close',
    }
  }

  const effortPayload = (record: ActiveRecord): EffortDialogPayload => {
    const current = options.capability.currentEffort()
    const optionsView: EffortOptionView[] = record.efforts.map((effort) => ({
      id: effort.id,
      name: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
      ...(current === effort.effortId ? { current: true } : {}),
      ...(record.defaultId === effort.effortId ? { default: true } : {}),
      ...(record.pendingId !== undefined && record.pendingId !== effort.id ? { disabled: true } : {}),
    }))
    return {
      kind: 'effort-dialog',
      key: record.key,
      title: 'Reasoning effort',
      phase: record.phase,
      options: optionsView,
      activeIndex: record.efforts.length === 0 ? 0 : Math.max(0, Math.min(record.activeIndex, record.efforts.length - 1)),
      ...(current === undefined ? {} : { currentId: safe(current, 256) }),
      ...(record.defaultId === undefined ? {} : { defaultId: safe(record.defaultId, 256) }),
      ...(record.pendingId === undefined ? {} : { pendingId: record.pendingId }),
      ...(record.error === undefined ? {} : { error: safe(record.error, 1024) }),
      ...(record.notice === undefined ? {} : { notice: { ...record.notice, text: safe(record.notice.text, 1024) } }),
      hint: record.phase === 'pending'
        ? 'Applying… · Left/Right or Tab is temporarily locked'
        : '←/→ adjust · Tab/Backtab cycle · 1–9 choose · Enter/Esc close',
    }
  }

  const publish = (record: ActiveRecord): void => {
    if (!live(record)) return
    const payload = record.kind === 'effort' ? effortPayload(record) : routingPayload(record)
    const json = JSON.stringify(payload)
    if (json === record.publishedJson) return
    record.publishedJson = json
    record.revision += 1
    journalSeq += 1
    const overlay: OverlayState = {
      overlayId: record.overlayId,
      revision: record.revision,
      anchor: 'center',
      width: record.kind === 'effort' ? '90%' : '92%',
      maxHeight: '86%',
      margin: 1,
      visible: true,
      captureInput: true,
      nonCapturing: false,
      payload,
    }
    options.dispatch({ ...options.nextMeta(`channel-options-${journalSeq}`), type: 'overlay/open', overlay })
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
    options.dispatch({ ...options.nextMeta(`channel-options-${journalSeq}`), type: 'overlay/close', overlayId: record.overlayId })
    counts.closed += 1
    if (cancelled) counts.cancels += 1
  }

  const makeRecord = (kind: ChannelOptionsKind, query = ''): ActiveRecord => ({
    kind,
    overlayId: OVERLAY_IDS[kind],
    key: `${kind}-${++instanceSeq}`,
    revision: 0,
    phase: 'loading',
    query: boundedQuery(query),
    cursor: [...boundedQuery(query)].length,
    sources: [],
    efforts: [],
    activeIndex: 0,
    defaultId: undefined,
    pendingId: undefined,
    error: undefined,
    notice: undefined,
    operationGeneration: 0,
    abort: null,
    unsubscribe: null,
    publishedJson: '',
  })

  const load = (record: ActiveRecord): void => {
    record.abort?.abort()
    const controller = new AbortController()
    record.abort = controller
    const generation = ++record.operationGeneration
    counts.loads += 1
    record.phase = 'loading'
    record.error = undefined
    record.notice = undefined
    publish(record)
    const operation = record.kind === 'model'
      ? options.capability.listModels(controller.signal).then((models) => {
          const seen = new Set<string>()
          const sources: ModelSource[] = []
          for (const model of models.slice(0, ROUTING_MAX_OPTIONS)) {
            if (typeof model.provider !== 'string' || typeof model.id !== 'string' || seen.has(`${model.provider}\0${model.id}`)) continue
            seen.add(`${model.provider}\0${model.id}`)
            const metadata = [
              { label: 'id', value: safe(model.id, 512) },
              ...(model.inputModalities ?? []).slice(0, 4).map((modality) => ({ label: 'input', value: safe(modality, 64) })),
            ]
            sources.push({
              kind: 'model',
              id: `model:${sources.length}`,
              provider: model.provider,
              model: model.id,
              displayProvider: safe(model.provider, 256),
              displayModel: safe(model.id, 512),
              label: safe(model.name || model.id, 512),
              description: model.description === undefined ? undefined : safe(model.description, 1024),
              metadata,
            })
          }
          return { sources, efforts: [] as readonly EffortSource[], defaultId: undefined }
        })
      : record.kind === 'preset'
        ? options.capability.listPresets(controller.signal).then((presets) => {
            const seen = new Set<string>()
            const sources: PresetSource[] = []
            for (const preset of presets.slice(0, ROUTING_MAX_OPTIONS)) {
              if (typeof preset.id !== 'string' || preset.id === '' || seen.has(preset.id)) continue
              seen.add(preset.id)
              const broken = preset.broken === undefined ? undefined : safe(preset.broken, 1024)
              sources.push({
                kind: 'preset',
                id: `preset:${sources.length}`,
                presetId: preset.id,
                displayId: safe(preset.id, 256),
                label: safe(preset.name ?? preset.id, 512),
                description: broken ?? (preset.description === undefined ? undefined : safe(preset.description, 1024)),
                badges: [preset.isDefault ? 'default' : '', preset.id === 'minimal' ? 'minimal' : '', broken === undefined ? '' : 'unavailable'].filter(Boolean),
                disabled: broken !== undefined,
                disabledReason: broken,
              })
            }
            return { sources, efforts: [] as readonly EffortSource[], defaultId: undefined }
          })
        : options.capability.listEfforts(controller.signal).then((result) => ({
            sources: [] as readonly RecordSource[],
            efforts: result.efforts.slice(0, ROUTING_MAX_OPTIONS).filter((effort) => typeof effort.id === 'string' && effort.id !== '').map((effort, index) => ({
              id: `effort:${index}`,
              effortId: effort.id,
              name: safe(effort.name || effort.id, 512),
              description: effort.description === undefined ? undefined : safe(effort.description, 1024),
            })),
            defaultId: result.defaultEffort,
          }))
    void operation.then((result) => {
      if (!live(record, generation) || controller.signal.aborted) return
      record.abort = null
      record.sources = result.sources
      record.efforts = result.efforts
      record.defaultId = result.defaultId
      record.phase = 'ready'
      const preferredIndex = record.kind === 'effort'
        ? record.efforts.findIndex((effort) => effort.effortId === (options.capability.currentEffort() ?? record.defaultId))
        : filtered(record).findIndex((source) => source.kind === 'model'
          ? modelIsCurrent(source)
          : source.presetId === options.capability.currentPreset())
      record.activeIndex = preferredIndex >= 0 ? preferredIndex : 0
      publish(record)
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !live(record, generation)) return
      record.abort = null
      record.phase = 'error'
      record.error = `${record.kind === 'model' ? 'Model' : record.kind === 'preset' ? 'Preset' : 'Effort'} list failed: ${message(error)}`
      counts.errors += 1
      diagnostic('list-failed', message(error))
      publish(record)
    })
  }

  const subscribe = (record: ActiveRecord): void => {
    try {
      record.unsubscribe = options.capability.subscribe(() => {
        if (!live(record)) return
        // Current markers and the actual effort/status may change while the
        // overlay is open. Projection dedup prevents a noisy channel wakeup.
        publish(record)
      })
    } catch (error) {
      diagnostic('subscribe-failed', message(error))
    }
  }

  const selectRoute = (record: ActiveRecord): void => {
    const values = filtered(record)
    const source = values[record.activeIndex]
    if (source === undefined) {
      record.error = values.length === 0 ? 'No selectable entries are available.' : 'No entries match this filter.'
      publish(record)
      return
    }
    const current = source.kind === 'model'
      ? modelIsCurrent(source)
      : source.presetId === options.capability.currentPreset()
    if (current) {
      record.notice = { text: 'That entry is already current.', tone: 'success' }
      publish(record)
      return
    }
    if (source.kind === 'preset' && source.disabled) {
      record.error = source.disabledReason ?? 'This preset is unavailable.'
      publish(record)
      return
    }
    if (source.kind === 'model' && options.capability.working()) {
      record.error = 'Model switching is unavailable while a turn is running.'
      publish(record)
      return
    }
    const generation = ++record.operationGeneration
    record.abort?.abort()
    record.abort = new AbortController()
    record.phase = 'pending'
    record.pendingId = source.id
    record.error = undefined
    record.notice = undefined
    counts.selections += 1
    publish(record)
    const operation = source.kind === 'model'
      ? options.capability.switchModel(source.provider, source.model)
      : options.capability.switchPreset(source.presetId)
    void operation.then((ok) => {
      if (!live(record, generation) || record.abort?.signal.aborted) return
      record.abort = null
      record.pendingId = undefined
      if (ok) {
        closeRecord(record, false)
        return
      }
      record.phase = 'ready'
      record.error = `${record.kind === 'model' ? 'Model' : 'Preset'} switch was not applied.`
      counts.errors += 1
      publish(record)
    }).catch((error: unknown) => {
      if (!live(record, generation)) return
      record.abort = null
      record.pendingId = undefined
      record.phase = 'ready'
      record.error = `${record.kind === 'model' ? 'Model' : 'Preset'} switch failed: ${message(error)}`
      counts.errors += 1
      diagnostic('switch-failed', message(error))
      publish(record)
    })
  }

  const selectEffort = (record: ActiveRecord, index: number): void => {
    const effort = record.efforts[index]
    if (effort === undefined || record.phase === 'pending') return
    record.activeIndex = index
    const current = options.capability.currentEffort()
    if (effort.effortId === current) {
      publish(record)
      return
    }
    const generation = ++record.operationGeneration
    record.abort?.abort()
    record.abort = new AbortController()
    record.phase = 'pending'
    record.pendingId = effort.id
    record.error = undefined
    record.notice = undefined
    counts.liveEffortChanges += 1
    publish(record)
    void options.capability.setEffort(effort.effortId).then((ok) => {
      if (!live(record, generation) || record.abort?.signal.aborted) return
      record.abort = null
      record.pendingId = undefined
      record.phase = 'ready'
      if (!ok) {
        record.error = `Effort “${effort.name}” was not accepted by the active route.`
        counts.errors += 1
      } else {
        record.notice = { text: `Effort set to ${safe(options.capability.currentEffort() ?? effort.effortId, 256)}.`, tone: 'success' }
      }
      publish(record)
    }).catch((error: unknown) => {
      if (!live(record, generation)) return
      record.abort = null
      record.pendingId = undefined
      record.phase = 'ready'
      record.error = `Effort switch failed: ${message(error)}`
      counts.errors += 1
      diagnostic('effort-failed', message(error))
      publish(record)
    })
  }

  const handleKey = (record: ActiveRecord, payload: KeyPayload): void => {
    if (payload.eventType === 'release') return
    if (payload.key === 'escape' || payload.key === 'ctrl+g') {
      closeRecord(record, true)
      return
    }
    if (record.phase === 'loading') return
    if (record.kind === 'effort') {
      if (record.phase === 'pending') return
      const count = record.efforts.length
      if (count === 0) {
        record.error = 'No effort levels are available for the active route.'
        publish(record)
        return
      }
      if (payload.key === 'left' || payload.key === 'right' || payload.key === 'tab' || payload.key === 'shift+tab') {
        const delta = payload.key === 'left' || payload.key === 'shift+tab' ? -1 : 1
        selectEffort(record, (record.activeIndex + delta + count) % count)
        return
      }
      const digit = payload.key !== null && /^[1-9]$/u.test(payload.key) ? Number(payload.key) : null
      if (digit !== null) {
        if (digit <= count) selectEffort(record, digit - 1)
        return
      }
      if (payload.key === 'enter') {
        closeRecord(record, false)
        return
      }
      return
    }
    if (record.phase === 'pending') return
    const values = filtered(record)
    if (payload.key === 'up' || payload.key === 'down') {
      if (values.length > 0) record.activeIndex = (record.activeIndex + (payload.key === 'up' ? -1 : 1) + values.length) % values.length
      record.error = undefined
      publish(record)
      return
    }
    if (payload.key === 'pageUp' || payload.key === 'pageDown') {
      if (values.length > 0) record.activeIndex = (record.activeIndex + (payload.key === 'pageUp' ? -LIST_WINDOW : LIST_WINDOW) + values.length * 4) % values.length
      publish(record)
      return
    }
    if (payload.key === 'enter') {
      selectRoute(record)
      return
    }
    const edited = editQuery(record.query, record.cursor, payload)
    if (edited !== null) {
      record.query = edited.text
      record.cursor = edited.cursor
      record.activeIndex = 0
      record.error = undefined
      publish(record)
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
    else if (event.kind === 'paste' && record.kind !== 'effort' && record.phase !== 'pending') {
      const payload = event.payload as PastePayload
      const edited = editQuery(record.query, record.cursor, { key: null, raw: '', text: payload.text, eventType: 'press' })
      if (edited !== null) {
        record.query = edited.text
        record.cursor = edited.cursor
        record.activeIndex = 0
        publish(record)
      }
    }
  }

  const open = (kind: ChannelOptionsKind, query = ''): boolean => {
    if (disposed || options.isBusinessDialogActive()) return false
    if (active !== null) closeRecord(active, false)
    const record = makeRecord(kind, query)
    active = record
    counts.opened += 1
    publish(record)
    try { subscribe(record) } catch { /* subscribe handles its own errors */ }
    load(record)
    return true
  }

  return {
    openModel: (query = '') => open('model', query),
    openPreset: (query = '') => open('preset', query),
    openEffort: () => open('effort'),
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
