/**
 * Business-dialog controller (WP-08c).
 *
 * Approval, managed plugin dialogs and user questions remain store-owned. This
 * controller projects the highest-priority snapshot into serializable overlay
 * payloads and owns only ephemeral keyboard state. Every visible mutation is a
 * revision-bumped `overlay/open` AppEvent; settle/cancel calls return to the
 * stores, whose notifications close or replace the overlay.
 *
 * Priority is fixed: approval=300 > plugin-dialog=200 > question=100. The
 * controller owns no timer (plugin timeout remains in TuiDialogStore).
 */
import { INPUT_CELLS, type TuiDialogAnswer, type TuiDialogSnapshot } from '../../dsh-adapter/dialogs.js'
import type { ApprovalSnapshot } from '../../dsh-adapter/approvals.js'
import type { QuestionSelection, QuestionSnapshot } from '../../dsh-adapter/questions.js'
import { capCells, flattenInline } from '../../dsh-adapter/sanitize.js'
import { canonicalJson } from '../model/canonical-json.js'
import type { AppEvent } from '../model/events.js'
import type {
  DialogOptionView,
  DialogOverlayPayload,
  DialogPresentationStatus,
  DialogSelectionView,
} from '../model/overlay-payloads.js'
import type { EventMeta, OverlayState } from '../model/schema.js'
import type { UiState } from '../model/state.js'
import type { KeyPayload, PastePayload, TerminalInputEvent } from '../terminal/input.js'

export interface ApprovalStoreLike {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => ApprovalSnapshot | null
  readonly decide: (outcome: 'allowed-once' | 'rejected') => void
}

export interface QuestionStoreLike {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => QuestionSnapshot | null
  readonly answerCurrent: (selection: QuestionSelection) => void
  readonly cancelCurrent: () => void
  readonly takeSummaries?: () => readonly { readonly title: string; readonly lines: readonly string[] }[]
}

export interface PluginDialogStoreLike {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => TuiDialogSnapshot | null
  readonly decide: (key: string, value: TuiDialogAnswer) => void
  readonly cancel: (key: string) => void
}

export type DialogKind = 'approval' | 'question' | 'plugin-dialog'

export const DIALOG_PRIORITY: Readonly<Record<DialogKind, number>> = Object.freeze({
  approval: 300,
  'plugin-dialog': 200,
  question: 100,
})

export interface DialogsControllerOptions {
  readonly dispatch: (event: AppEvent) => void
  readonly nextMeta: (sourceSeq: string) => EventMeta
  readonly getState: () => UiState
  readonly approvals?: ApprovalStoreLike
  readonly questions?: QuestionStoreLike
  readonly dialogs?: PluginDialogStoreLike
  readonly onQuestionSummary?: (title: string, lines: readonly string[]) => void
  readonly onDiagnostic?: (code: string, message: string) => void
}

export interface DialogsControllerDiagnostics {
  readonly opened: number
  readonly closed: number
  readonly preempted: number
  readonly revisionBumps: number
  readonly decisions: number
  readonly cancels: number
  readonly staleInput: number
  readonly ignoredInput: number
}

export interface DialogsController {
  readonly start: () => void
  readonly handleInput: (event: TerminalInputEvent) => void
  readonly activeOverlayId: () => string | null
  readonly diagnostics: () => DialogsControllerDiagnostics
  readonly dispose: () => void
}

interface InteractionState {
  focusIndex: number
  readonly checked: Set<number>
  text: string
  cursor: number
  filter: string
  filterCursor: number
  contentOffset: number
  attachedOptionId: string | undefined
  error: string | undefined
  storeError: string | undefined
}

interface ActiveDialog {
  readonly overlayId: string
  readonly kind: DialogKind
  readonly key: string
  readonly interaction: InteractionState
  publishedJson: string
}

type QuestionItemView = QuestionSnapshot['question'] & { readonly hideCustomInput?: boolean }
type SelectSnapshot = Extract<TuiDialogSnapshot, { kind: 'select' }>

const OPTION_WINDOW_ROWS = 8
const APPROVAL_CONTENT_ROWS = 6
const FILTER_LIMIT = 256
const QUESTION_TEXT_LIMIT = 4_000

function visibleWindow(
  itemHeights: readonly number[],
  focusIndex: number,
  maxRows = OPTION_WINDOW_ROWS,
): { start: number; end: number } {
  if (itemHeights.length === 0) return { start: 0, end: 0 }
  const focus = Math.max(0, Math.min(focusIndex, itemHeights.length - 1))
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

function folded(value: string): string {
  return value.toLocaleLowerCase('en-US')
}

function filteredSelectOptions(snapshot: SelectSnapshot, query: string): readonly SelectSnapshot['options'][number][] {
  const needle = folded(query.trim())
  if (needle === '') return snapshot.options
  return snapshot.options.filter((option) => folded([
    option.label,
    option.description ?? '',
  ].join('\n')).includes(needle))
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createDialogsController(options: DialogsControllerOptions): DialogsController {
  let started = false
  let disposed = false
  let active: ActiveDialog | null = null
  let journalSeq = 0
  const revisions = new Map<string, number>()
  const unsubscribes: (() => void)[] = []
  const counts = {
    opened: 0,
    closed: 0,
    preempted: 0,
    revisionBumps: 0,
    decisions: 0,
    cancels: 0,
    staleInput: 0,
    ignoredInput: 0,
  }

  const diagnostic = (code: string, message: string): void => {
    try {
      options.onDiagnostic?.(code, message)
    } catch {
      // Diagnostic callbacks never break interaction state.
    }
  }

  const overlayIdFor = (kind: DialogKind, key: string): string => `dialog/${kind}/${key}`

  const snapshotFor = (
    kind: DialogKind,
    key: string,
  ): ApprovalSnapshot | QuestionSnapshot | TuiDialogSnapshot | null => {
    const snapshot = kind === 'approval'
      ? (options.approvals?.getSnapshot() ?? null)
      : kind === 'question'
        ? (options.questions?.getSnapshot() ?? null)
        : (options.dialogs?.getSnapshot() ?? null)
    return snapshot !== null && snapshot.key === key ? snapshot : null
  }

  const currentWinner = (): { kind: DialogKind; key: string; priority: number } | null => {
    let winner: { kind: DialogKind; key: string; priority: number } | null = null
    const consider = (kind: DialogKind, key: string): void => {
      const priority = DIALOG_PRIORITY[kind]
      if (winner === null || priority > winner.priority) winner = { kind, key, priority }
    }
    const question = options.questions?.getSnapshot() ?? null
    const plugin = options.dialogs?.getSnapshot() ?? null
    const approval = options.approvals?.getSnapshot() ?? null
    if (question !== null) consider('question', question.key)
    if (plugin !== null) consider('plugin-dialog', plugin.key)
    if (approval !== null) consider('approval', approval.key)
    return winner
  }

  const questionView = (dialog: ActiveDialog): { snapshot: QuestionSnapshot; item: QuestionItemView } | null => {
    const snapshot = snapshotFor('question', dialog.key) as QuestionSnapshot | null
    return snapshot === null ? null : { snapshot, item: snapshot.question as QuestionItemView }
  }

  const questionCustomVisible = (item: QuestionItemView): boolean =>
    item.intent?.kind === 'plan-review' || item.hideCustomInput !== true || (item.options ?? []).length === 0

  const pluginOptions = (dialog: ActiveDialog): readonly SelectSnapshot['options'][number][] => {
    const snapshot = snapshotFor('plugin-dialog', dialog.key) as TuiDialogSnapshot | null
    return snapshot?.kind === 'select' ? filteredSelectOptions(snapshot, dialog.interaction.filter) : []
  }

  const selectionView = (dialog: ActiveDialog, itemHeights: readonly number[]): DialogSelectionView => {
    const interaction = dialog.interaction
    const focusForWindow = Math.min(interaction.focusIndex, Math.max(0, itemHeights.length - 1))
    const window = visibleWindow(itemHeights, focusForWindow)
    return {
      focusIndex: interaction.focusIndex,
      checked: [...interaction.checked].sort((a, b) => a - b),
      text: interaction.text,
      cursor: interaction.cursor,
      filter: interaction.filter,
      filterCursor: interaction.filterCursor,
      windowStart: window.start,
      windowEnd: window.end,
      contentOffset: interaction.contentOffset,
      ...(interaction.attachedOptionId !== undefined
        ? { attachedOptionId: interaction.attachedOptionId }
        : {}),
      ...(interaction.error !== undefined ? { error: interaction.error } : {}),
    }
  }

  const presentation = (dialog: ActiveDialog): {
    status: DialogPresentationStatus
    statusMessage?: string
  } => dialog.interaction.storeError === undefined
    ? { status: 'ready' }
    : { status: 'error', statusMessage: dialog.interaction.storeError }

  const buildPayload = (dialog: ActiveDialog): DialogOverlayPayload | null => {
    const snapshot = snapshotFor(dialog.kind, dialog.key)
    if (snapshot === null) return null
    const status = presentation(dialog)
    switch (dialog.kind) {
      case 'approval': {
        const approval = snapshot as ApprovalSnapshot
        return {
          kind: 'approval',
          key: dialog.key,
          toolName: approval.toolName,
          ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
          ...(approval.command !== undefined ? { command: approval.command } : {}),
          ...status,
          contentWindowRows: APPROVAL_CONTENT_ROWS,
          selection: selectionView(dialog, []),
        }
      }
      case 'question': {
        const question = snapshot as QuestionSnapshot
        const item = question.question as QuestionItemView
        const optionViews: DialogOptionView[] = (item.options ?? []).map((option) => ({
          id: option.label,
          label: option.label,
          ...(option.description !== undefined ? { description: option.description } : {}),
        }))
        return {
          kind: 'question',
          key: dialog.key,
          questionId: item.id,
          question: item.question,
          ...(item.header !== undefined ? { header: item.header } : {}),
          ...(item.detail !== undefined ? { detail: item.detail } : {}),
          options: optionViews,
          multiSelect: item.multiSelect === true,
          ...(item.hideCustomInput !== undefined ? { hideCustomInput: item.hideCustomInput } : {}),
          ...(item.intent !== undefined ? { intent: item.intent } : {}),
          position: question.position,
          total: question.total,
          answered: question.answered,
          answeredSummary: question.answeredSummary,
          optionWindowRows: OPTION_WINDOW_ROWS,
          ...status,
          selection: selectionView(dialog, optionViews.map((option) =>
            1
            + (option.description !== undefined ? 1 : 0)
            + (option.disabledReason !== undefined ? 1 : 0))),
        }
      }
      case 'plugin-dialog': {
        const plugin = snapshot as TuiDialogSnapshot
        const base = {
          kind: 'plugin-dialog' as const,
          dialogKind: plugin.kind,
          key: dialog.key,
          title: plugin.title,
          optionWindowRows: OPTION_WINDOW_ROWS,
          ...status,
        }
        switch (plugin.kind) {
          case 'select': {
            const filtered = filteredSelectOptions(plugin, dialog.interaction.filter)
            const optionViews: DialogOptionView[] = filtered.map((option) => ({
              id: option.id,
              label: option.label,
              ...(option.description !== undefined ? { description: option.description } : {}),
              ...(option.disabled !== undefined ? { disabled: option.disabled } : {}),
              ...(option.disabledReason !== undefined ? { disabledReason: option.disabledReason } : {}),
            }))
            return {
              ...base,
              options: optionViews,
              totalOptions: plugin.options.length,
              initial: '',
              selection: selectionView(dialog, optionViews.map((option) =>
                1
                + (option.description !== undefined ? 1 : 0)
                + (option.disabledReason !== undefined ? 1 : 0))),
            }
          }
          case 'confirm':
            return {
              ...base,
              ...(plugin.message !== undefined ? { message: plugin.message } : {}),
              confirmLabel: plugin.confirmLabel,
              cancelLabel: plugin.cancelLabel,
              initial: '',
              selection: selectionView(dialog, [1, 1]),
            }
          case 'input':
            return {
              ...base,
              ...(plugin.placeholder !== undefined ? { placeholder: plugin.placeholder } : {}),
              initial: plugin.initial,
              selection: selectionView(dialog, []),
            }
        }
      }
    }
  }

  const publishOpen = (): void => {
    const dialog = active
    if (dialog === null) return
    const payload = buildPayload(dialog)
    if (payload === null) {
      diagnostic('dialog/stale-snapshot', `${dialog.overlayId}: snapshot gone before open`)
      return
    }
    const revision = (revisions.get(dialog.overlayId) ?? 0) + 1
    revisions.set(dialog.overlayId, revision)
    dialog.publishedJson = canonicalJson(payload)
    journalSeq += 1
    const overlay: OverlayState = {
      overlayId: dialog.overlayId,
      revision,
      anchor: 'bottom-center',
      width: '100%',
      visible: true,
      captureInput: true,
      nonCapturing: false,
      payload,
    }
    options.dispatch({ ...options.nextMeta(`dialog-${journalSeq}`), type: 'overlay/open', overlay })
  }

  const publishInteraction = (dialog: ActiveDialog): void => {
    if (active !== dialog || disposed) return
    counts.revisionBumps += 1
    publishOpen()
  }

  const closeActive = (preempted: boolean): void => {
    const dialog = active
    if (dialog === null) return
    active = null
    counts.closed += 1
    if (preempted) counts.preempted += 1
    journalSeq += 1
    options.dispatch({
      ...options.nextMeta(`dialog-${journalSeq}`),
      type: 'overlay/close',
      overlayId: dialog.overlayId,
    })
  }

  const firstEnabledPluginIndex = (snapshot: SelectSnapshot, query: string): number => {
    const filtered = filteredSelectOptions(snapshot, query)
    const index = filtered.findIndex((option) => option.disabled !== true)
    return index < 0 ? 0 : index
  }

  const freshInteraction = (kind: DialogKind, key: string): InteractionState => {
    const interaction: InteractionState = {
      focusIndex: 0,
      checked: new Set<number>(),
      text: '',
      cursor: 0,
      filter: '',
      filterCursor: 0,
      contentOffset: 0,
      attachedOptionId: undefined,
      error: undefined,
      storeError: undefined,
    }
    if (kind === 'plugin-dialog') {
      const snapshot = snapshotFor(kind, key) as TuiDialogSnapshot | null
      if (snapshot?.kind === 'input') {
        interaction.text = snapshot.initial
        interaction.cursor = [...snapshot.initial].length
      } else if (snapshot?.kind === 'select') {
        interaction.focusIndex = firstEnabledPluginIndex(snapshot, '')
      }
    }
    return interaction
  }

  const drainQuestionSummaries = (): void => {
    if (options.onQuestionSummary === undefined || options.questions?.takeSummaries === undefined) return
    for (const summary of options.questions.takeSummaries()) {
      try {
        options.onQuestionSummary(summary.title, summary.lines)
      } catch (error) {
        diagnostic('dialog/question-summary', errorDetail(error))
      }
    }
  }

  const syncFromStores = (): void => {
    if (!started || disposed) return
    drainQuestionSummaries()
    const winner = currentWinner()
    if (winner === null) {
      closeActive(false)
      return
    }
    const overlayId = overlayIdFor(winner.kind, winner.key)
    if (active !== null && active.overlayId !== overlayId) {
      closeActive(snapshotFor(active.kind, active.key) !== null)
    }
    if (active === null) {
      active = {
        overlayId,
        kind: winner.kind,
        key: winner.key,
        interaction: freshInteraction(winner.kind, winner.key),
        publishedJson: '',
      }
      counts.opened += 1
      publishOpen()
      return
    }
    const payload = buildPayload(active)
    if (payload !== null && canonicalJson(payload) !== active.publishedJson) {
      counts.revisionBumps += 1
      publishOpen()
    }
  }

  const clearValidationError = (dialog: ActiveDialog): void => {
    dialog.interaction.error = dialog.interaction.storeError
  }

  const setValidationError = (dialog: ActiveDialog, message: string): void => {
    if (dialog.interaction.error === message) return
    dialog.interaction.error = message
    publishInteraction(dialog)
  }

  const setStoreError = (dialog: ActiveDialog, code: string, message: string, error: unknown): void => {
    diagnostic(code, `${message}: ${errorDetail(error)}`)
    dialog.interaction.storeError = message
    dialog.interaction.error = message
    publishInteraction(dialog)
  }

  const moveFocus = (
    dialog: ActiveDialog,
    delta: number,
    rowCount: number,
    enabled: (index: number) => boolean = () => true,
  ): void => {
    if (rowCount <= 0) return
    for (let step = 1; step <= rowCount; step++) {
      const candidate = (dialog.interaction.focusIndex + delta * step + rowCount * step) % rowCount
      if (!enabled(candidate)) continue
      if (candidate === dialog.interaction.focusIndex && dialog.interaction.error === dialog.interaction.storeError) return
      dialog.interaction.focusIndex = candidate
      clearValidationError(dialog)
      publishInteraction(dialog)
      return
    }
  }

  const normalizePluginFocus = (dialog: ActiveDialog): void => {
    const snapshot = snapshotFor('plugin-dialog', dialog.key) as TuiDialogSnapshot | null
    if (snapshot?.kind !== 'select') return
    dialog.interaction.focusIndex = firstEnabledPluginIndex(snapshot, dialog.interaction.filter)
  }

  const applyField = (
    dialog: ActiveDialog,
    field: 'text' | 'filter',
    next: string,
    nextCursor: number,
  ): void => {
    if (field === 'text') {
      dialog.interaction.text = next
      dialog.interaction.cursor = Math.max(0, Math.min(nextCursor, [...next].length))
      if (next === '') dialog.interaction.attachedOptionId = undefined
    } else {
      dialog.interaction.filter = next
      dialog.interaction.filterCursor = Math.max(0, Math.min(nextCursor, [...next].length))
      normalizePluginFocus(dialog)
    }
    clearValidationError(dialog)
    publishInteraction(dialog)
  }

  const insertField = (
    dialog: ActiveDialog,
    field: 'text' | 'filter',
    chunk: string,
    pasted: boolean,
  ): boolean => {
    if (chunk === '') return true
    const current = field === 'text' ? dialog.interaction.text : dialog.interaction.filter
    const at = field === 'text' ? dialog.interaction.cursor : dialog.interaction.filterCursor
    const points = [...current]
    const inserted = [...flattenInline(chunk)]
    let candidate = [...points.slice(0, at), ...inserted, ...points.slice(at)].join('')
    let cursor = at + inserted.length

    const plugin = dialog.kind === 'plugin-dialog'
      ? snapshotFor('plugin-dialog', dialog.key) as TuiDialogSnapshot | null
      : null
    if (field === 'text' && plugin?.kind === 'input') {
      const capped = capCells(candidate, INPUT_CELLS)
      if (!pasted && capped !== candidate) return true
      candidate = capped
      cursor = Math.min(cursor, [...candidate].length)
    } else {
      const limit = field === 'filter' ? FILTER_LIMIT : QUESTION_TEXT_LIMIT
      if ([...candidate].length > limit) {
        if (!pasted) return true
        candidate = [...candidate].slice(0, limit).join('')
        cursor = Math.min(cursor, [...candidate].length)
      }
    }
    applyField(dialog, field, candidate, cursor)
    return true
  }

  const editFieldKey = (dialog: ActiveDialog, field: 'text' | 'filter', payload: KeyPayload): boolean => {
    const value = field === 'text' ? dialog.interaction.text : dialog.interaction.filter
    const cursor = field === 'text' ? dialog.interaction.cursor : dialog.interaction.filterCursor
    const points = [...value]
    if (payload.key === 'backspace') {
      if (cursor > 0) {
        points.splice(cursor - 1, 1)
        applyField(dialog, field, points.join(''), cursor - 1)
      }
      return true
    }
    if (payload.key === 'delete') {
      if (cursor < points.length) {
        points.splice(cursor, 1)
        applyField(dialog, field, points.join(''), cursor)
      }
      return true
    }
    if (payload.key === 'left') {
      if (cursor > 0) applyField(dialog, field, value, cursor - 1)
      return true
    }
    if (payload.key === 'right') {
      if (cursor < points.length) applyField(dialog, field, value, cursor + 1)
      return true
    }
    if (payload.key === 'home') {
      if (cursor !== 0) applyField(dialog, field, value, 0)
      return true
    }
    if (payload.key === 'end') {
      if (cursor !== points.length) applyField(dialog, field, value, points.length)
      return true
    }
    const text = payload.text ?? (payload.key === 'space' ? ' ' : null)
    return text === null ? false : insertField(dialog, field, text, false)
  }

  const decideApproval = (dialog: ActiveDialog, outcome: 'allowed-once' | 'rejected'): void => {
    if (outcome === 'allowed-once' && dialog.interaction.storeError !== undefined) {
      setValidationError(dialog, 'Approval failed; proceeding remains disabled.')
      return
    }
    counts.decisions += 1
    try {
      options.approvals?.decide(outcome)
    } catch (error) {
      setStoreError(dialog, 'dialog/approval-decide', 'Approval service failed; proceeding is disabled.', error)
    }
  }

  const answerQuestion = (dialog: ActiveDialog, selection: QuestionSelection): void => {
    if (dialog.interaction.storeError !== undefined) return
    counts.decisions += 1
    try {
      options.questions?.answerCurrent(selection)
    } catch (error) {
      setStoreError(dialog, 'dialog/question-answer', 'Question service failed; answer was not submitted.', error)
    }
  }

  const decidePlugin = (dialog: ActiveDialog, value: TuiDialogAnswer): void => {
    if (dialog.interaction.storeError !== undefined) return
    counts.decisions += 1
    try {
      options.dialogs?.decide(dialog.key, value)
    } catch (error) {
      setStoreError(dialog, 'dialog/plugin-decide', 'Plugin dialog failed; value was not submitted.', error)
    }
  }

  const cancelActive = (dialog: ActiveDialog): void => {
    counts.cancels += 1
    try {
      if (dialog.kind === 'approval') options.approvals?.decide('rejected')
      else if (dialog.kind === 'question') options.questions?.cancelCurrent()
      else options.dialogs?.cancel(dialog.key)
    } catch (error) {
      setStoreError(dialog, `dialog/${dialog.kind}-cancel`, 'Dialog cancellation failed; retry or interrupt safely.', error)
    }
  }

  const handleApprovalKey = (dialog: ActiveDialog, payload: KeyPayload): void => {
    if (payload.key === 'up' || payload.key === 'left') {
      moveFocus(dialog, -1, 2)
      return
    }
    if (payload.key === 'down' || payload.key === 'right') {
      moveFocus(dialog, 1, 2)
      return
    }
    if (payload.key === 'pageUp' || payload.key === 'pageDown') {
      dialog.interaction.contentOffset = Math.max(
        0,
        dialog.interaction.contentOffset + (payload.key === 'pageUp' ? -APPROVAL_CONTENT_ROWS : APPROVAL_CONTENT_ROWS),
      )
      clearValidationError(dialog)
      publishInteraction(dialog)
      return
    }
    if (payload.text === '1') {
      decideApproval(dialog, 'allowed-once')
      return
    }
    if (payload.text === '2') {
      decideApproval(dialog, 'rejected')
      return
    }
    if (payload.key === 'enter') {
      decideApproval(dialog, dialog.interaction.focusIndex === 0 ? 'allowed-once' : 'rejected')
      return
    }
    counts.ignoredInput += 1
  }

  const checkedLabels = (dialog: ActiveDialog, options_: readonly DialogOptionView[]): string[] =>
    [...dialog.interaction.checked]
      .sort((a, b) => a - b)
      .map((index) => options_[index]?.label)
      .filter((label): label is string => label !== undefined)

  const submitQuestion = (
    dialog: ActiveDialog,
    item: QuestionItemView,
    optionViews: readonly DialogOptionView[],
  ): void => {
    const interaction = dialog.interaction
    const text = interaction.text.trim()
    const inputFocused = interaction.focusIndex === optionViews.length
    if (item.intent?.kind === 'plan-review') {
      const approve = item.intent.approve
      const decline = optionViews.find((option) => option.label !== approve)?.label
      if (inputFocused) {
        answerQuestion(dialog, {
          selected: decline === undefined ? [] : [decline],
          ...(text !== '' ? { custom: text } : {}),
        })
        return
      }
      const label = optionViews[interaction.focusIndex]?.label
      if (label === undefined) {
        setValidationError(dialog, 'Choose an option or enter feedback.')
      } else if (label === approve && text !== '') {
        setValidationError(dialog, 'Clear feedback before approving, or submit it from the feedback row.')
      } else {
        answerQuestion(dialog, {
          selected: [label],
          ...(label !== approve && text !== '' ? { custom: text } : {}),
        })
      }
      return
    }

    if (item.multiSelect === true) {
      const selected = checkedLabels(dialog, optionViews)
      if (selected.length === 0 && text === '') {
        setValidationError(dialog, 'Select at least one option, or type an answer on the last line.')
        return
      }
      answerQuestion(dialog, { selected, ...(text !== '' ? { custom: text } : {}) })
      return
    }

    if (inputFocused) {
      if (text === '') {
        setValidationError(dialog, 'Type your answer before submitting.')
        return
      }
      answerQuestion(dialog, {
        selected: interaction.attachedOptionId === undefined ? [] : [interaction.attachedOptionId],
        custom: text,
      })
      return
    }

    const option = optionViews[interaction.focusIndex]
    if (option === undefined || option.disabled === true) {
      setValidationError(dialog, option?.disabledReason ?? 'Choose an available option.')
      return
    }
    answerQuestion(dialog, { selected: [option.label], ...(text !== '' ? { custom: text } : {}) })
  }

  const handleQuestionKey = (dialog: ActiveDialog, payload: KeyPayload): void => {
    const view = questionView(dialog)
    if (view === null) {
      counts.staleInput += 1
      return
    }
    const item = view.item
    const optionViews: DialogOptionView[] = (item.options ?? []).map((option) => ({
      id: option.label,
      label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}),
    }))
    const customVisible = questionCustomVisible(item)
    const rowCount = optionViews.length + (customVisible ? 1 : 0)
    const inputFocused = customVisible && dialog.interaction.focusIndex === optionViews.length

    if (payload.key === 'up' || payload.key === 'down') {
      moveFocus(
        dialog,
        payload.key === 'up' ? -1 : 1,
        rowCount,
        (index) => index === optionViews.length || optionViews[index]?.disabled !== true,
      )
      return
    }
    if (payload.key === 'tab' && customVisible) {
      dialog.interaction.focusIndex = optionViews.length
      clearValidationError(dialog)
      publishInteraction(dialog)
      return
    }
    if (item.intent?.kind === 'plan-review' && dialog.interaction.text === '' && /^[1-9]$/u.test(payload.text ?? '')) {
      const index = Number(payload.text) - 1
      if (index < optionViews.length) {
        dialog.interaction.focusIndex = index
        submitQuestion(dialog, item, optionViews)
        return
      }
    }
    if (item.multiSelect === true && !inputFocused && (payload.text === ' ' || payload.key === 'space')) {
      const focus = dialog.interaction.focusIndex
      if (optionViews[focus]?.disabled === true) {
        setValidationError(dialog, optionViews[focus]?.disabledReason ?? 'That option is unavailable.')
        return
      }
      if (dialog.interaction.checked.has(focus)) dialog.interaction.checked.delete(focus)
      else dialog.interaction.checked.add(focus)
      clearValidationError(dialog)
      publishInteraction(dialog)
      return
    }
    if (payload.key === 'enter') {
      submitQuestion(dialog, item, optionViews)
      return
    }

    if (inputFocused) {
      if (editFieldKey(dialog, 'text', payload)) return
      counts.ignoredInput += 1
      return
    }
    if (payload.key === 'backspace' && customVisible) {
      editFieldKey(dialog, 'text', payload)
      return
    }
    const text = payload.text ?? (payload.key === 'space' ? ' ' : null)
    if (text !== null && customVisible) {
      if (item.intent?.kind === 'plan-review') {
        dialog.interaction.focusIndex = optionViews.length
        dialog.interaction.attachedOptionId = undefined
      } else if (item.multiSelect !== true) {
        dialog.interaction.attachedOptionId = optionViews[dialog.interaction.focusIndex]?.label
      }
      insertField(dialog, 'text', text, false)
      return
    }
    counts.ignoredInput += 1
  }

  const handlePluginKey = (dialog: ActiveDialog, payload: KeyPayload): void => {
    const snapshot = snapshotFor('plugin-dialog', dialog.key) as TuiDialogSnapshot | null
    if (snapshot === null) {
      counts.staleInput += 1
      return
    }
    switch (snapshot.kind) {
      case 'select': {
        const filtered = filteredSelectOptions(snapshot, dialog.interaction.filter)
        if (payload.key === 'up' || payload.key === 'down') {
          moveFocus(
            dialog,
            payload.key === 'up' ? -1 : 1,
            filtered.length,
            (index) => filtered[index]?.disabled !== true,
          )
          return
        }
        if (payload.key === 'enter') {
          const option = filtered[dialog.interaction.focusIndex]
          if (option === undefined) {
            setValidationError(dialog, snapshot.options.length === 0
              ? 'No options are available.'
              : 'No options match the current filter.')
          } else if (option.disabled === true) {
            setValidationError(dialog, option.disabledReason ?? 'That option is unavailable.')
          } else {
            decidePlugin(dialog, option.id)
          }
          return
        }
        if (editFieldKey(dialog, 'filter', payload)) return
        counts.ignoredInput += 1
        return
      }
      case 'confirm':
        if (payload.key === 'up' || payload.key === 'left') {
          moveFocus(dialog, -1, 2)
          return
        }
        if (payload.key === 'down' || payload.key === 'right') {
          moveFocus(dialog, 1, 2)
          return
        }
        if (payload.text === '1' || payload.text === '2') {
          decidePlugin(dialog, payload.text === '1')
          return
        }
        if (payload.key === 'enter') {
          decidePlugin(dialog, dialog.interaction.focusIndex === 0)
          return
        }
        counts.ignoredInput += 1
        return
      case 'input':
        if (payload.key === 'enter') {
          decidePlugin(dialog, dialog.interaction.text)
          return
        }
        if (editFieldKey(dialog, 'text', payload)) return
        counts.ignoredInput += 1
    }
  }

  const handleKey = (dialog: ActiveDialog, payload: KeyPayload): void => {
    if (payload.key === 'escape' || payload.key === 'ctrl+c') {
      cancelActive(dialog)
      return
    }
    if (dialog.kind === 'approval') handleApprovalKey(dialog, payload)
    else if (dialog.kind === 'question') handleQuestionKey(dialog, payload)
    else handlePluginKey(dialog, payload)
  }

  const handlePaste = (dialog: ActiveDialog, text: string): void => {
    if (dialog.kind === 'approval') {
      counts.ignoredInput += 1
      return
    }
    if (dialog.kind === 'plugin-dialog') {
      const snapshot = snapshotFor('plugin-dialog', dialog.key) as TuiDialogSnapshot | null
      if (snapshot?.kind === 'select') insertField(dialog, 'filter', text, true)
      else if (snapshot?.kind === 'input') insertField(dialog, 'text', text, true)
      else counts.ignoredInput += 1
      return
    }
    const view = questionView(dialog)
    if (view === null || !questionCustomVisible(view.item)) {
      counts.ignoredInput += 1
      return
    }
    const optionCount = (view.item.options ?? []).length
    if (view.item.intent?.kind === 'plan-review') {
      dialog.interaction.focusIndex = optionCount
      dialog.interaction.attachedOptionId = undefined
    } else if (view.item.multiSelect !== true && dialog.interaction.focusIndex < optionCount) {
      dialog.interaction.attachedOptionId = view.item.options?.[dialog.interaction.focusIndex]?.label
    }
    insertField(dialog, 'text', text, true)
  }

  const handleInput = (event: TerminalInputEvent): void => {
    if (!started || disposed) return
    const dialog = active
    if (dialog === null) {
      counts.ignoredInput += 1
      return
    }
    const focus = options.getState().focus
    if (focus.target !== 'overlay' || focus.overlayId !== dialog.overlayId) {
      counts.staleInput += 1
      return
    }
    if (event.kind === 'key') {
      const payload = event.payload as KeyPayload
      if (payload.eventType === 'release') {
        counts.ignoredInput += 1
        return
      }
      handleKey(dialog, payload)
    } else if (event.kind === 'paste') {
      handlePaste(dialog, (event.payload as PastePayload).text)
    } else {
      counts.ignoredInput += 1
    }
  }

  return {
    start() {
      if (started || disposed) return
      started = true
      for (const store of [options.approvals, options.questions, options.dialogs]) {
        if (store !== undefined) unsubscribes.push(store.subscribe(syncFromStores))
      }
      syncFromStores()
    },
    handleInput,
    activeOverlayId: () => active?.overlayId ?? null,
    diagnostics: () => ({ ...counts }),
    dispose() {
      if (disposed) return
      disposed = true
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
    },
  }
}
