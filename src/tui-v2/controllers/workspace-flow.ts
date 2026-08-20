/**
 * WP-08d1 workspace target/provider flow controller.
 *
 * Provider objects and callbacks remain process-local. The reducer sees only a
 * bounded `workspace-dialog` projection; switching/creation/attachment remain
 * in the injected adapter callbacks.
 */
import type {
  TuiWorkspaceChoice,
  TuiWorkspaceCommand,
  TuiWorkspaceCommandResult,
  TuiWorkspaceHost,
  TuiWorkspaceTarget,
} from '../../dsh-adapter/workspaces.js'
import { WORKSPACE_WINDOW_ITEMS, type CatalogNoticeView, type WorkspaceDialogPayload, type WorkspaceItemView } from '../model/catalog-overlay-payloads.js'
import type { AppEvent } from '../model/events.js'
import type { EventMeta, OverlayState } from '../model/schema.js'
import type { UiState } from '../model/state.js'
import type { KeyPayload, PastePayload, TerminalInputEvent } from '../terminal/input.js'

export type WorkspaceHostCapability = Pick<TuiWorkspaceHost, 'list' | 'resolve' | 'commands' | 'runCommand'>

export interface WorkspaceFlowActions {
  readonly currentCwd: () => string
  readonly switchTarget: (target: TuiWorkspaceTarget) => Promise<boolean>
  readonly renameCurrent: (title: string) => Promise<boolean>
}

export interface WorkspaceFlowControllerOptions {
  readonly dispatch: (event: AppEvent) => void
  readonly nextMeta: (sourceSeq: string) => EventMeta
  readonly getState: () => UiState
  /** Provider-aware host. Undefined means the optional service is absent. */
  readonly host?: WorkspaceHostCapability
  /** Existing local-only adapter fallback; never synthesized in this controller. */
  readonly fallback: WorkspaceHostCapability
  readonly actions: WorkspaceFlowActions
  readonly isBusinessDialogActive: () => boolean
  readonly notify: (text: string, options?: { color?: 'error' | 'warning' | 'success' }) => void
  readonly onDiagnostic?: (code: string, message: string) => void
}

export interface WorkspaceFlowDiagnostics {
  readonly opened: number
  readonly closed: number
  readonly targetLoads: number
  readonly providerCommands: number
  readonly choices: number
  readonly switches: number
  readonly renames: number
  readonly cancels: number
  readonly degraded: number
  readonly errors: number
  readonly lateResults: number
  readonly staleInput: number
}

export interface WorkspaceFlowController {
  readonly handleCommand: (rawInput: string) => boolean
  readonly close: () => void
  readonly handleInput: (event: TerminalInputEvent) => void
  readonly activeOverlayId: () => string | null
  readonly isManagedOverlay: (overlayId: string) => boolean
  readonly diagnostics: () => WorkspaceFlowDiagnostics
  readonly dispose: () => void
}

type Source =
  | { readonly kind: 'targets'; readonly values: readonly TuiWorkspaceTarget[] }
  | { readonly kind: 'choices'; readonly values: readonly TuiWorkspaceChoice[] }

interface InputDraft {
  readonly choiceId: string
  value: string
  cursor: number
  readonly placeholder: string | undefined
}

interface WorkspaceRecord {
  readonly overlayId: string
  readonly key: string
  revision: number
  title: string
  phase: WorkspaceDialogPayload['phase']
  source: Source
  query: string
  queryCursor: number
  focusId: string | undefined
  top: number
  input: InputDraft | undefined
  degraded: boolean
  error: string | undefined
  notice: CatalogNoticeView | undefined
  operationGeneration: number
  abort: AbortController | null
}

const OVERLAY_ID = 'utility/workspace'
const MAX_SOURCE_ITEMS = 512
const MAX_INPUT_POINTS = 256

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function aborted(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function flattenInline(value: string): string {
  // eslint-disable-next-line no-control-regex -- workspace filters/editors are one line
  return value.replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ')
}

function points(value: string): string[] {
  return [...value]
}

function bounded(value: string): string {
  return points(flattenInline(value)).slice(0, MAX_INPUT_POINTS).join('')
}

function normalizeTargets(values: readonly TuiWorkspaceTarget[]): readonly TuiWorkspaceTarget[] {
  const seen = new Set<string>()
  const out: TuiWorkspaceTarget[] = []
  for (const value of values) {
    if (out.length >= MAX_SOURCE_ITEMS || value.uri === '' || seen.has(value.uri)) continue
    seen.add(value.uri)
    out.push(value)
  }
  return out
}

function normalizeChoices(values: readonly TuiWorkspaceChoice[]): readonly TuiWorkspaceChoice[] {
  const seen = new Set<string>()
  const out: TuiWorkspaceChoice[] = []
  for (const value of values) {
    if (out.length >= MAX_SOURCE_ITEMS || value.id === '' || seen.has(value.id)) continue
    seen.add(value.id)
    out.push(value)
  }
  return out
}

function folded(value: string): string {
  return value.toLocaleLowerCase('en-US')
}

function sourceValues(record: WorkspaceRecord): readonly (TuiWorkspaceTarget | TuiWorkspaceChoice)[] {
  return record.source.values
}

function itemId(record: WorkspaceRecord, item: TuiWorkspaceTarget | TuiWorkspaceChoice): string {
  return record.source.kind === 'targets'
    ? (item as TuiWorkspaceTarget).uri
    : (item as TuiWorkspaceChoice).id
}

function filtered(record: WorkspaceRecord): readonly (TuiWorkspaceTarget | TuiWorkspaceChoice)[] {
  const needle = folded(record.query.trim())
  if (needle === '') return sourceValues(record)
  return sourceValues(record).filter((item) => folded([
    item.label,
    item.description ?? '',
    record.source.kind === 'targets' ? (item as TuiWorkspaceTarget).badge : (item as TuiWorkspaceChoice).badge ?? '',
    record.source.kind === 'targets' ? (item as TuiWorkspaceTarget).uri : '',
  ].join('\n')).includes(needle))
}

function selectedIndex(record: WorkspaceRecord, values: readonly (TuiWorkspaceTarget | TuiWorkspaceChoice)[]): number {
  if (values.length === 0) return 0
  const byId = record.focusId === undefined ? -1 : values.findIndex((item) => itemId(record, item) === record.focusId)
  return byId >= 0 ? byId : 0
}

function centeredTop(index: number, length: number): number {
  return Math.max(0, Math.min(index - Math.floor(WORKSPACE_WINDOW_ITEMS / 2), Math.max(0, length - WORKSPACE_WINDOW_ITEMS)))
}

function editText(text: string, cursor: number, payload: KeyPayload): { text: string; cursor: number } | null {
  const value = points(text)
  if (payload.key === 'backspace') {
    if (cursor > 0) value.splice(cursor - 1, 1)
    return { text: value.join(''), cursor: Math.max(0, cursor - 1) }
  }
  if (payload.key === 'delete') {
    if (cursor < value.length) value.splice(cursor, 1)
    return { text: value.join(''), cursor }
  }
  if (payload.key === 'left') return { text, cursor: Math.max(0, cursor - 1) }
  if (payload.key === 'right') return { text, cursor: Math.min(value.length, cursor + 1) }
  if (payload.key === 'home') return { text, cursor: 0 }
  if (payload.key === 'end') return { text, cursor: value.length }
  const inserted = payload.text ?? (payload.key === 'space' ? ' ' : null)
  if (inserted === null) return null
  const incoming = points(flattenInline(inserted))
  const next = [...value.slice(0, cursor), ...incoming, ...value.slice(cursor)].slice(0, MAX_INPUT_POINTS)
  return { text: next.join(''), cursor: Math.min(next.length, cursor + incoming.length) }
}

export function createWorkspaceFlowController(options: WorkspaceFlowControllerOptions): WorkspaceFlowController {
  let disposed = false
  let active: WorkspaceRecord | null = null
  let instanceSeq = 0
  let journalSeq = 0
  const counts = {
    opened: 0,
    closed: 0,
    targetLoads: 0,
    providerCommands: 0,
    choices: 0,
    switches: 0,
    renames: 0,
    cancels: 0,
    degraded: 0,
    errors: 0,
    lateResults: 0,
    staleInput: 0,
  }

  const diagnostic = (code: string, detail: string): void => {
    try {
      options.onDiagnostic?.(code, detail)
    } catch {
      // Diagnostics cannot break provider control.
    }
  }

  const live = (record: WorkspaceRecord, generation?: number): boolean => {
    const result = !disposed && active === record && (generation === undefined || generation === record.operationGeneration)
    if (!result) counts.lateResults += 1
    return result
  }

  const payloadFor = (record: WorkspaceRecord): WorkspaceDialogPayload => {
    const values = filtered(record)
    const index = selectedIndex(record, values)
    const selected = values[index]
    record.focusId = selected === undefined ? undefined : itemId(record, selected)
    record.top = centeredTop(index, values.length)
    const visible = values.slice(record.top, record.top + WORKSPACE_WINDOW_ITEMS)
    const currentCwd = options.actions.currentCwd()
    const items: WorkspaceItemView[] = visible.map((item) => record.source.kind === 'targets'
      ? {
          kind: 'target',
          id: (item as TuiWorkspaceTarget).uri,
          label: item.label,
          ...(item.description !== undefined ? { description: item.description } : {}),
          badge: (item as TuiWorkspaceTarget).badge,
          current: (item as TuiWorkspaceTarget).cwd === currentCwd,
        }
      : {
          kind: 'choice',
          id: (item as TuiWorkspaceChoice).id,
          label: item.label,
          ...(item.description !== undefined ? { description: item.description } : {}),
          ...((item as TuiWorkspaceChoice).badge !== undefined ? { badge: (item as TuiWorkspaceChoice).badge } : {}),
          hasInput: (item as TuiWorkspaceChoice).input !== undefined,
        })
    const selectedVisible = record.focusId !== undefined && items.some((item) => item.id === record.focusId)
      ? record.focusId
      : undefined
    const hint = record.phase === 'pending'
      ? 'Working… · Esc cancels provider work'
      : record.input !== undefined
        ? 'Type a value · Enter submit · Esc back'
        : record.source.kind === 'choices'
          ? 'Type filter · ↑/↓/PgUp/PgDn · Enter choose · Tab edit · Esc close'
          : 'Type filter · ↑/↓/PgUp/PgDn · Enter switch · Esc close'
    return {
      kind: 'workspace-dialog',
      key: record.key,
      title: record.title,
      phase: record.phase,
      view: record.source.kind,
      query: record.query,
      cursor: record.queryCursor,
      items,
      ...(selectedVisible !== undefined ? { selectedId: selectedVisible } : {}),
      hasMoreAbove: record.top > 0,
      hasMoreBelow: record.top + visible.length < values.length,
      sourceCount: sourceValues(record).length,
      filteredCount: values.length,
      ...(record.input !== undefined
        ? {
            input: {
              choiceId: record.input.choiceId,
              value: record.input.value,
              cursor: record.input.cursor,
              ...(record.input.placeholder !== undefined ? { placeholder: record.input.placeholder } : {}),
            },
          }
        : {}),
      degraded: record.degraded,
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.notice !== undefined ? { notice: record.notice } : {}),
      hint,
    }
  }

  const publish = (record: WorkspaceRecord): void => {
    if (!live(record)) return
    record.revision += 1
    journalSeq += 1
    const overlay: OverlayState = {
      overlayId: record.overlayId,
      revision: record.revision,
      anchor: 'center',
      width: '80%',
      maxHeight: '80%',
      margin: 1,
      visible: true,
      captureInput: true,
      nonCapturing: false,
      payload: payloadFor(record),
    }
    options.dispatch({ ...options.nextMeta(`workspace-flow-${journalSeq}`), type: 'overlay/open', overlay })
  }

  const closeRecord = (record: WorkspaceRecord, cancelled: boolean): void => {
    if (active !== record) return
    active = null
    record.abort?.abort()
    record.abort = null
    record.operationGeneration += 1
    journalSeq += 1
    options.dispatch({
      ...options.nextMeta(`workspace-flow-${journalSeq}`),
      type: 'overlay/close',
      overlayId: record.overlayId,
    })
    counts.closed += 1
    if (cancelled) counts.cancels += 1
  }

  const createRecord = (title: string, phase: WorkspaceRecord['phase']): WorkspaceRecord | null => {
    if (disposed || options.isBusinessDialogActive()) return null
    if (active !== null) closeRecord(active, false)
    const degraded = options.host === undefined
    const record: WorkspaceRecord = {
      overlayId: OVERLAY_ID,
      key: `workspace-${++instanceSeq}`,
      revision: 0,
      title,
      phase,
      source: { kind: 'targets', values: [] },
      query: '',
      queryCursor: 0,
      focusId: undefined,
      top: 0,
      input: undefined,
      degraded,
      error: undefined,
      notice: degraded
        ? { text: 'Workspace provider host is unavailable; using the local-only fallback.', tone: 'warning' }
        : undefined,
      operationGeneration: 0,
      abort: null,
    }
    if (degraded) counts.degraded += 1
    active = record
    counts.opened += 1
    publish(record)
    return record
  }

  const hostFor = (record: WorkspaceRecord): WorkspaceHostCapability => record.degraded ? options.fallback : options.host as WorkspaceHostCapability

  const switchTarget = (record: WorkspaceRecord, target: TuiWorkspaceTarget): void => {
    const generation = ++record.operationGeneration
    record.abort?.abort()
    record.abort = null
    record.phase = 'pending'
    record.error = undefined
    record.notice = { text: `Switching to ${target.label}…`, tone: 'info' }
    counts.switches += 1
    publish(record)
    void options.actions.switchTarget(target).then((ok) => {
      if (!live(record, generation)) return
      if (ok) {
        closeRecord(record, false)
        return
      }
      record.phase = 'ready'
      record.notice = undefined
      record.error = `Could not switch to ${target.label}.`
      counts.errors += 1
      publish(record)
    }).catch((error: unknown) => {
      if (!live(record, generation)) return
      record.phase = 'ready'
      record.notice = undefined
      record.error = `Workspace switch failed: ${message(error)}`
      counts.errors += 1
      diagnostic('switch-failed', message(error))
      publish(record)
    })
  }

  const applyResult = (record: WorkspaceRecord, result: TuiWorkspaceCommandResult): void => {
    record.abort = null
    record.input = undefined
    record.query = ''
    record.queryCursor = 0
    record.focusId = undefined
    record.top = 0
    record.error = undefined
    if (result.kind === 'target') {
      switchTarget(record, result.target)
      return
    }
    const choices = normalizeChoices(result.choices)
    if (choices.length === 0) {
      record.phase = 'error'
      record.source = { kind: 'choices', values: [] }
      record.title = result.title
      record.error = 'The workspace provider returned no choices.'
      counts.errors += 1
      publish(record)
      return
    }
    record.phase = 'ready'
    record.title = result.title
    record.source = { kind: 'choices', values: choices }
    counts.choices += 1
    publish(record)
  }

  const runProviderAction = (
    record: WorkspaceRecord,
    action: (signal: AbortSignal) => Promise<TuiWorkspaceCommandResult> | TuiWorkspaceCommandResult,
  ): void => {
    record.abort?.abort()
    const controller = new AbortController()
    record.abort = controller
    const generation = ++record.operationGeneration
    record.phase = 'pending'
    record.error = undefined
    publish(record)
    void Promise.resolve().then(() => action(controller.signal)).then((result) => {
      if (!live(record, generation) || controller.signal.aborted) return
      applyResult(record, result)
    }).catch((error: unknown) => {
      if (controller.signal.aborted || aborted(error)) return
      if (!live(record, generation)) return
      record.abort = null
      record.phase = 'error'
      record.error = `Workspace provider failed: ${message(error)}`
      counts.errors += 1
      diagnostic('provider-failed', message(error))
      publish(record)
    })
  }

  const openTargets = (): boolean => {
    const record = createRecord('Switch workspace', 'loading')
    if (record === null) return false
    const controller = new AbortController()
    record.abort = controller
    const generation = ++record.operationGeneration
    counts.targetLoads += 1
    void hostFor(record).list(options.actions.currentCwd(), controller.signal).then((values) => {
      if (!live(record, generation) || controller.signal.aborted) return
      record.abort = null
      record.source = { kind: 'targets', values: normalizeTargets(values) }
      record.phase = 'ready'
      const current = record.source.values.find((target) => target.cwd === options.actions.currentCwd())
      record.focusId = current?.uri ?? record.source.values[0]?.uri
      record.error = undefined
      publish(record)
    }).catch((error: unknown) => {
      if (controller.signal.aborted || aborted(error)) return
      if (!live(record, generation)) return
      record.abort = null
      record.phase = 'error'
      record.error = `Workspace list failed: ${message(error)}`
      counts.errors += 1
      diagnostic('list-failed', message(error))
      publish(record)
    })
    return true
  }

  const openReference = (reference: string): boolean => {
    const record = createRecord('Open workspace', 'pending')
    if (record === null) return false
    const controller = new AbortController()
    record.abort = controller
    const generation = ++record.operationGeneration
    record.notice = { text: `Resolving ${reference}…`, tone: 'info' }
    publish(record)
    void hostFor(record).resolve(reference, options.actions.currentCwd(), controller.signal).then((target) => {
      if (!live(record, generation) || controller.signal.aborted) return
      if (target === undefined) {
        record.abort = null
        record.phase = 'error'
        record.notice = undefined
        record.error = `Workspace target is unavailable: ${reference}`
        counts.errors += 1
        publish(record)
        return
      }
      switchTarget(record, target)
    }).catch((error: unknown) => {
      if (controller.signal.aborted || aborted(error)) return
      if (!live(record, generation)) return
      record.abort = null
      record.phase = 'error'
      record.notice = undefined
      record.error = `Workspace resolve failed: ${message(error)}`
      counts.errors += 1
      publish(record)
    })
    return true
  }

  const renameCurrent = (title: string): boolean => {
    const record = createRecord('Rename workspace', 'pending')
    if (record === null) return false
    const generation = ++record.operationGeneration
    record.notice = { text: `Renaming workspace to ${title}…`, tone: 'info' }
    counts.renames += 1
    publish(record)
    void options.actions.renameCurrent(title).then((ok) => {
      if (!live(record, generation)) return
      if (ok) {
        options.notify(`Workspace renamed to ${title}`, { color: 'success' })
        closeRecord(record, false)
        return
      }
      record.phase = 'error'
      record.notice = undefined
      record.error = 'Workspace rename failed.'
      counts.errors += 1
      publish(record)
    }).catch((error: unknown) => {
      if (!live(record, generation)) return
      record.phase = 'error'
      record.notice = undefined
      record.error = `Workspace rename failed: ${message(error)}`
      counts.errors += 1
      publish(record)
    })
    return true
  }

  const runCommand = (name: string, input: string): boolean => {
    const degraded = options.host === undefined
    const host = degraded ? options.fallback : options.host as WorkspaceHostCapability
    let commands: readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[]
    try {
      commands = host.commands()
    } catch (error) {
      options.notify(`Workspace provider commands are unavailable: ${message(error)}`, { color: 'error' })
      counts.errors += 1
      return true
    }
    const normalized = name.toLocaleLowerCase('en-US')
    const command = commands.find((candidate) =>
      candidate.name.toLocaleLowerCase('en-US') === normalized
      || candidate.aliases?.some((alias) => alias.toLocaleLowerCase('en-US') === normalized))
    if (command === undefined) {
      options.notify(`Unknown workspace command: ${name}`, { color: 'error' })
      return true
    }
    const record = createRecord(`Workspace: ${command.name}`, 'pending')
    if (record === null) return false
    counts.providerCommands += 1
    runProviderAction(record, async (signal) => {
      const result = await host.runCommand(command.name, input, options.actions.currentCwd(), signal)
      if (result === undefined) throw new Error(`provider command disappeared: ${command.name}`)
      return result
    })
    return true
  }

  const move = (record: WorkspaceRecord, delta: number): void => {
    const values = filtered(record)
    if (values.length === 0) return
    const index = selectedIndex(record, values)
    const next = (index + delta % values.length + values.length) % values.length
    record.focusId = itemId(record, values[next] as TuiWorkspaceTarget | TuiWorkspaceChoice)
    record.top = centeredTop(next, values.length)
    record.error = undefined
    record.notice = record.degraded ? record.notice : undefined
    publish(record)
  }

  const applyQuery = (record: WorkspaceRecord, text: string, cursor: number): void => {
    const query = bounded(text)
    record.query = query
    record.queryCursor = Math.max(0, Math.min(cursor, points(query).length))
    record.focusId = undefined
    record.top = 0
    record.error = undefined
    publish(record)
  }

  const select = (record: WorkspaceRecord): void => {
    const values = filtered(record)
    const selected = values[selectedIndex(record, values)]
    if (selected === undefined) {
      record.error = sourceValues(record).length === 0 ? 'No workspaces are available.' : 'No workspaces match this filter.'
      publish(record)
      return
    }
    if (record.source.kind === 'targets') {
      switchTarget(record, selected as TuiWorkspaceTarget)
    } else {
      runProviderAction(record, (signal) => (selected as TuiWorkspaceChoice).choose(signal))
    }
  }

  const handleKey = (record: WorkspaceRecord, payload: KeyPayload): void => {
    if (payload.eventType === 'release') return
    if (payload.key === 'escape' || payload.key === 'ctrl+g') {
      if (record.phase === 'pending' && record.abort !== null) {
        record.abort.abort()
        record.abort = null
        record.operationGeneration += 1
        record.phase = sourceValues(record).length === 0 ? 'error' : 'ready'
        record.error = sourceValues(record).length === 0 ? 'Workspace operation cancelled.' : undefined
        record.notice = record.degraded
          ? { text: 'Workspace provider host is unavailable; using the local-only fallback.', tone: 'warning' }
          : undefined
        counts.cancels += 1
        publish(record)
      } else if (record.input !== undefined) {
        record.input = undefined
        record.error = undefined
        publish(record)
      } else {
        closeRecord(record, true)
      }
      return
    }
    if (record.phase === 'loading' || record.phase === 'pending') return
    if (record.input !== undefined) {
      if (payload.key === 'enter') {
        const draft = record.input
        const value = draft.value.trim()
        const choice = record.source.kind === 'choices'
          ? record.source.values.find((candidate) => candidate.id === draft.choiceId)
          : undefined
        if (value === '') {
          record.error = 'Workspace input must not be empty.'
          publish(record)
        } else if (choice?.input !== undefined) {
          runProviderAction(record, (signal) => choice.input!.submit(value, signal))
        }
        return
      }
      const edited = editText(record.input.value, record.input.cursor, payload)
      if (edited !== null) {
        record.input.value = edited.text
        record.input.cursor = edited.cursor
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
      move(record, payload.key === 'pageUp' ? -WORKSPACE_WINDOW_ITEMS : WORKSPACE_WINDOW_ITEMS)
      return
    }
    if (payload.key === 'tab' && record.source.kind === 'choices') {
      const values = filtered(record)
      const choice = values[selectedIndex(record, values)] as TuiWorkspaceChoice | undefined
      if (choice?.input !== undefined) {
        const value = bounded(choice.input.initialValue ?? '')
        record.input = {
          choiceId: choice.id,
          value,
          cursor: points(value).length,
          placeholder: choice.input.placeholder,
        }
        record.error = undefined
        publish(record)
      }
      return
    }
    if (payload.key === 'enter') {
      select(record)
      return
    }
    const edited = editText(record.query, record.queryCursor, payload)
    if (edited !== null) applyQuery(record, edited.text, edited.cursor)
  }

  return {
    handleCommand(rawInput) {
      const trimmed = rawInput.trim()
      const separator = trimmed.search(/\s/u)
      const subcommand = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLocaleLowerCase('en-US')
      const input = separator < 0 ? '' : trimmed.slice(separator + 1).trim()
      if (subcommand === '' || subcommand === 'resume') return openTargets()
      if (subcommand === 'open') {
        if (input === '') {
          options.notify('Usage: /workspace open <path-or-uri>', { color: 'warning' })
          return true
        }
        return openReference(input)
      }
      if (subcommand === 'rename') {
        if (input === '') {
          options.notify('Usage: /workspace rename <title>', { color: 'warning' })
          return true
        }
        return renameCurrent(input)
      }
      return runCommand(subcommand, input)
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
      } else if (event.kind === 'paste' && record.phase === 'ready') {
        const value = bounded((event.payload as PastePayload).text)
        if (record.input !== undefined) {
          const current = points(record.input.value)
          const inserted = points(value)
          const next = [...current.slice(0, record.input.cursor), ...inserted, ...current.slice(record.input.cursor)]
            .slice(0, MAX_INPUT_POINTS)
          record.input.value = next.join('')
          record.input.cursor = Math.min(next.length, record.input.cursor + inserted.length)
          record.error = undefined
          publish(record)
        } else {
          const current = points(record.query)
          const inserted = points(value)
          const next = [...current.slice(0, record.queryCursor), ...inserted, ...current.slice(record.queryCursor)]
          applyQuery(record, next.join(''), record.queryCursor + inserted.length)
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
