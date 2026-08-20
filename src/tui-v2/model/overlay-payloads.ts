/**
 * tui-v2 dialog overlay payload contract (WP-05b; plan §5.2
 * `OverlayState.payload` + §7.3 "approval/question/plugin dialog 优先级 →
 * dialogs.ts + overlay stack").
 *
 * Every dialog overlay the DialogsController publishes carries one of the
 * payload shapes below. Producers (controllers) build them; consumers
 * (components/overlays/*) narrow an opaque `OverlayState.payload` with
 * `parseDialogOverlayPayload`. The contract lives in the model layer so both
 * sides can import it without violating §4.3 (controllers never import
 * components; components never import dsh-adapter).
 *
 * The `selection` view is the controller's ephemeral interaction state,
 * mirrored into the payload via revision-bumped `overlay/open` events so
 * components stay pure renderers and replay sees every user-visible change.
 * Payload shapes are `type` aliases (not interfaces) so they stay assignable
 * to the `SerializableValue` index-signature contract of OverlayState.payload.
 *
 * Dependency rule (§4.3): model imports nothing from other layers.
 */
import { isSerializableValue, type SerializableValue } from './schema.js'

/** One selectable row. Question options use the label as the id (the answer
 * protocol echoes labels); plugin select options carry their opaque id.
 * `disabled` is a backward-compatible host extension: absent means enabled. */
export type DialogOptionView = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly disabled?: boolean
  readonly disabledReason?: string
}

export type DialogPresentationStatus = 'ready' | 'error' | 'unavailable'

/**
 * Serializable mirror of controller-owned interaction state. Fields added by
 * WP-08c are optional so older traces/payload producers remain readable; the
 * full DialogsController always publishes them.
 */
export type DialogSelectionView = {
  readonly focusIndex: number
  readonly checked: readonly number[]
  readonly text: string
  /** Code-point cursor in `text`. */
  readonly cursor?: number
  /** Select-dialog filter and its code-point cursor. */
  readonly filter?: string
  readonly filterCursor?: number
  /** Derived visible item range [start,end). */
  readonly windowStart?: number
  readonly windowEnd?: number
  /** Scroll offset for approval command/reason content. */
  readonly contentOffset?: number
  /** Single-select option attached to custom text typed beside that option. */
  readonly attachedOptionId?: string
  /** User-visible validation/store error. */
  readonly error?: string
}

/** Approval ask (dsh approval seam). Esc/Ctrl+C rejects (fail closed). */
export type ApprovalDialogPayload = {
  readonly kind: 'approval'
  readonly key: string
  readonly toolName: string
  readonly reason?: string
  readonly command?: string
  readonly status?: DialogPresentationStatus
  readonly statusMessage?: string
  /** Maximum wrapped command/reason rows kept above the fixed actions. */
  readonly contentWindowRows?: number
  readonly selection: DialogSelectionView
}

export type QuestionIntentView = {
  readonly kind: 'plan-review'
  readonly approve: string
}

/** ask_user_question item projected field-by-field into serializable view data. */
export type QuestionDialogPayload = {
  readonly kind: 'question'
  readonly key: string
  readonly questionId: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options: readonly DialogOptionView[]
  readonly multiSelect: boolean
  readonly hideCustomInput?: boolean
  readonly intent?: QuestionIntentView
  /** 1-based position within the batch. */
  readonly position: number
  readonly total: number
  /** Questions answered before this one. */
  readonly answered: number
  readonly answeredSummary?: readonly string[]
  readonly optionWindowRows?: number
  readonly status?: DialogPresentationStatus
  readonly statusMessage?: string
  readonly selection: DialogSelectionView
}

/** Managed plugin dialog (ctx.tuiDialogs select/confirm/input). */
export type PluginDialogPayload = {
  readonly kind: 'plugin-dialog'
  readonly dialogKind: 'select' | 'confirm' | 'input'
  readonly key: string
  readonly title: string
  /** confirm only. */
  readonly message?: string
  /** select only (already filtered by the controller). */
  readonly options?: readonly DialogOptionView[]
  /** Number of source options before filtering; distinguishes empty/no-results. */
  readonly totalOptions?: number
  /** confirm only; '' means the host default label. */
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  /** input only. */
  readonly placeholder?: string
  readonly initial: string
  readonly optionWindowRows?: number
  readonly status?: DialogPresentationStatus
  readonly statusMessage?: string
  readonly selection: DialogSelectionView
}

export type DialogOverlayPayload =
  | ApprovalDialogPayload
  | QuestionDialogPayload
  | PluginDialogPayload

// ---------------------------------------------------------------------------
// Runtime narrowing (component boundary; the model store validated already)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseOption(value: unknown): DialogOptionView | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || typeof value.label !== 'string') return null
  if (value.description !== undefined && typeof value.description !== 'string') return null
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') return null
  if (value.disabledReason !== undefined && typeof value.disabledReason !== 'string') return null
  return {
    id: value.id,
    label: value.label,
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(value.disabled !== undefined ? { disabled: value.disabled } : {}),
    ...(value.disabledReason !== undefined ? { disabledReason: value.disabledReason } : {}),
  }
}

function parseOptions(value: unknown): readonly DialogOptionView[] | null {
  if (!Array.isArray(value)) return null
  const out: DialogOptionView[] = []
  for (const item of value) {
    const parsed = parseOption(item)
    if (parsed === null) return null
    out.push(parsed)
  }
  return out
}

function optString(record: Record<string, unknown>, field: string): string | undefined | null {
  const value = record[field]
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

function optNonNegativeInt(record: Record<string, unknown>, field: string): number | undefined | null {
  const value = record[field]
  if (value === undefined) return undefined
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null
}

function optBoolean(record: Record<string, unknown>, field: string): boolean | undefined | null {
  const value = record[field]
  if (value === undefined) return undefined
  return typeof value === 'boolean' ? value : null
}

function parseSelection(value: unknown): DialogSelectionView | null {
  if (!isRecord(value)) return null
  if (!Number.isInteger(value.focusIndex) || (value.focusIndex as number) < 0) return null
  if (typeof value.text !== 'string') return null
  if (!Array.isArray(value.checked)) return null
  if (!value.checked.every((item) => Number.isInteger(item) && (item as number) >= 0)) return null
  const cursor = optNonNegativeInt(value, 'cursor')
  const filterCursor = optNonNegativeInt(value, 'filterCursor')
  const windowStart = optNonNegativeInt(value, 'windowStart')
  const windowEnd = optNonNegativeInt(value, 'windowEnd')
  const contentOffset = optNonNegativeInt(value, 'contentOffset')
  const filter = optString(value, 'filter')
  const attachedOptionId = optString(value, 'attachedOptionId')
  const error = optString(value, 'error')
  if (
    cursor === null || filterCursor === null || windowStart === null || windowEnd === null ||
    contentOffset === null || filter === null || attachedOptionId === null || error === null
  ) return null
  if (cursor !== undefined && cursor > [...value.text].length) return null
  if (filterCursor !== undefined && filterCursor > [...(filter ?? '')].length) return null
  if (windowStart !== undefined && windowEnd !== undefined && windowEnd < windowStart) return null
  return {
    focusIndex: value.focusIndex as number,
    checked: value.checked as readonly number[],
    text: value.text,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(filter !== undefined ? { filter } : {}),
    ...(filterCursor !== undefined ? { filterCursor } : {}),
    ...(windowStart !== undefined ? { windowStart } : {}),
    ...(windowEnd !== undefined ? { windowEnd } : {}),
    ...(contentOffset !== undefined ? { contentOffset } : {}),
    ...(attachedOptionId !== undefined ? { attachedOptionId } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

function parseStatus(value: unknown): DialogPresentationStatus | undefined | null {
  if (value === undefined) return undefined
  return value === 'ready' || value === 'error' || value === 'unavailable' ? value : null
}

function parseStringArray(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null
  return value as readonly string[]
}

/**
 * Narrow an opaque `OverlayState.payload` to a dialog payload. Returns null
 * for foreign payloads (WP-06+ overlays) or shape violations — components
 * render nothing for payloads they do not recognize rather than guessing.
 */
export function parseDialogOverlayPayload(value: unknown): DialogOverlayPayload | null {
  if (!isRecord(value) || !isSerializableValue(value as SerializableValue)) return null
  const selection = parseSelection(value.selection)
  const key = typeof value.key === 'string' && value.key !== '' ? value.key : null
  if (selection === null || key === null) return null

  switch (value.kind) {
    case 'approval': {
      if (typeof value.toolName !== 'string') return null
      const reason = optString(value, 'reason')
      const command = optString(value, 'command')
      const status = parseStatus(value.status)
      const statusMessage = optString(value, 'statusMessage')
      const contentWindowRows = optNonNegativeInt(value, 'contentWindowRows')
      if (
        reason === null || command === null || status === null ||
        statusMessage === null || contentWindowRows === null
      ) return null
      return {
        kind: 'approval',
        key,
        toolName: value.toolName,
        ...(reason !== undefined ? { reason } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(statusMessage !== undefined ? { statusMessage } : {}),
        ...(contentWindowRows !== undefined ? { contentWindowRows } : {}),
        selection,
      }
    }
    case 'question': {
      if (typeof value.questionId !== 'string') return null
      if (typeof value.question !== 'string') return null
      const header = optString(value, 'header')
      const detail = optString(value, 'detail')
      const hideCustomInput = optBoolean(value, 'hideCustomInput')
      const answeredSummary = parseStringArray(value.answeredSummary)
      const optionWindowRows = optNonNegativeInt(value, 'optionWindowRows')
      const status = parseStatus(value.status)
      const statusMessage = optString(value, 'statusMessage')
      if (
        header === null || detail === null || hideCustomInput === null || answeredSummary === null ||
        optionWindowRows === null || status === null || statusMessage === null
      ) return null
      const options = parseOptions(value.options)
      if (options === null) return null
      if (typeof value.multiSelect !== 'boolean') return null
      if (!Number.isInteger(value.position) || (value.position as number) < 1) return null
      if (!Number.isInteger(value.total) || (value.total as number) < 1) return null
      if ((value.position as number) > (value.total as number)) return null
      if (!Number.isInteger(value.answered) || (value.answered as number) < 0) return null
      let intent: QuestionIntentView | undefined
      if (value.intent !== undefined) {
        if (!isRecord(value.intent) || value.intent.kind !== 'plan-review' || typeof value.intent.approve !== 'string') {
          return null
        }
        intent = { kind: 'plan-review', approve: value.intent.approve }
      }
      return {
        kind: 'question',
        key,
        questionId: value.questionId,
        question: value.question,
        ...(header !== undefined ? { header } : {}),
        ...(detail !== undefined ? { detail } : {}),
        options,
        multiSelect: value.multiSelect,
        ...(hideCustomInput !== undefined ? { hideCustomInput } : {}),
        ...(intent !== undefined ? { intent } : {}),
        position: value.position as number,
        total: value.total as number,
        answered: value.answered as number,
        ...(answeredSummary !== undefined ? { answeredSummary } : {}),
        ...(optionWindowRows !== undefined ? { optionWindowRows } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(statusMessage !== undefined ? { statusMessage } : {}),
        selection,
      }
    }
    case 'plugin-dialog': {
      if (value.dialogKind !== 'select' && value.dialogKind !== 'confirm' && value.dialogKind !== 'input') {
        return null
      }
      if (typeof value.title !== 'string') return null
      if (typeof value.initial !== 'string') return null
      const message = optString(value, 'message')
      const confirmLabel = optString(value, 'confirmLabel')
      const cancelLabel = optString(value, 'cancelLabel')
      const placeholder = optString(value, 'placeholder')
      const totalOptions = optNonNegativeInt(value, 'totalOptions')
      const optionWindowRows = optNonNegativeInt(value, 'optionWindowRows')
      const status = parseStatus(value.status)
      const statusMessage = optString(value, 'statusMessage')
      if (
        message === null || confirmLabel === null || cancelLabel === null || placeholder === null ||
        totalOptions === null || optionWindowRows === null || status === null || statusMessage === null
      ) return null
      let options: readonly DialogOptionView[] | undefined
      if (value.options !== undefined) {
        const parsed = parseOptions(value.options)
        if (parsed === null) return null
        options = parsed
      }
      if (value.dialogKind === 'select' && options === undefined) return null
      return {
        kind: 'plugin-dialog',
        dialogKind: value.dialogKind,
        key,
        title: value.title,
        ...(message !== undefined ? { message } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(totalOptions !== undefined ? { totalOptions } : {}),
        ...(confirmLabel !== undefined ? { confirmLabel } : {}),
        ...(cancelLabel !== undefined ? { cancelLabel } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
        initial: value.initial,
        ...(optionWindowRows !== undefined ? { optionWindowRows } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(statusMessage !== undefined ? { statusMessage } : {}),
        selection,
      }
    }
    default:
      return null
  }
}
