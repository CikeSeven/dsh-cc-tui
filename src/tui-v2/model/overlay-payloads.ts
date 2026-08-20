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
 *  protocol echoes labels); plugin select options carry their opaque id. */
export type DialogOptionView = {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/**
 * Interaction state mirror: `focusIndex` is the highlighted row, `checked`
 * the toggled option indices (multi-select questions, ascending), `text` the
 * single-line draft (plugin input dialogs and optionless questions).
 */
export type DialogSelectionView = {
  readonly focusIndex: number
  readonly checked: readonly number[]
  readonly text: string
}

/** Approval ask (dsh approval seam). Esc/Ctrl+C rejects (fail closed). */
export type ApprovalDialogPayload = {
  readonly kind: 'approval'
  readonly key: string
  readonly toolName: string
  readonly reason?: string
  readonly command?: string
  readonly selection: DialogSelectionView
}

/**
 * ask_user_question ask. The item is projected field-by-field (never embedded
 * raw) so the payload stays a plain SerializableValue; the presentation
 * `intent` tag (e.g. plan-review) is a WP-08 rendering concern and is not
 * mirrored here.
 */
export type QuestionDialogPayload = {
  readonly kind: 'question'
  readonly key: string
  readonly questionId: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options: readonly DialogOptionView[]
  readonly multiSelect: boolean
  /** 1-based position within the batch. */
  readonly position: number
  readonly total: number
  /** Questions answered before this one. */
  readonly answered: number
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
  /** select only. */
  readonly options?: readonly DialogOptionView[]
  /** confirm only; '' means the host default label. */
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  /** input only. */
  readonly placeholder?: string
  readonly initial: string
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
  return {
    id: value.id,
    label: value.label,
    ...(value.description !== undefined ? { description: value.description } : {}),
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

function parseSelection(value: unknown): DialogSelectionView | null {
  if (!isRecord(value)) return null
  if (!Number.isInteger(value.focusIndex) || (value.focusIndex as number) < 0) return null
  if (typeof value.text !== 'string') return null
  if (!Array.isArray(value.checked)) return null
  if (!value.checked.every((item) => Number.isInteger(item) && (item as number) >= 0)) return null
  return {
    focusIndex: value.focusIndex as number,
    checked: value.checked as readonly number[],
    text: value.text,
  }
}

function optString(record: Record<string, unknown>, field: string): string | undefined | null {
  const value = record[field]
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
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
      if (reason === null || command === null) return null
      return {
        kind: 'approval',
        key,
        toolName: value.toolName,
        ...(reason !== undefined ? { reason } : {}),
        ...(command !== undefined ? { command } : {}),
        selection,
      }
    }
    case 'question': {
      if (typeof value.questionId !== 'string') return null
      if (typeof value.question !== 'string') return null
      const header = optString(value, 'header')
      const detail = optString(value, 'detail')
      if (header === null || detail === null) return null
      const options = parseOptions(value.options)
      if (options === null) return null
      if (typeof value.multiSelect !== 'boolean') return null
      if (!Number.isInteger(value.position) || (value.position as number) < 1) return null
      if (!Number.isInteger(value.total) || (value.total as number) < 1) return null
      if (!Number.isInteger(value.answered) || (value.answered as number) < 0) return null
      return {
        kind: 'question',
        key,
        questionId: value.questionId,
        question: value.question,
        ...(header !== undefined ? { header } : {}),
        ...(detail !== undefined ? { detail } : {}),
        options,
        multiSelect: value.multiSelect,
        position: value.position as number,
        total: value.total as number,
        answered: value.answered as number,
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
      if (message === null || confirmLabel === null || cancelLabel === null || placeholder === null) {
        return null
      }
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
        ...(confirmLabel !== undefined ? { confirmLabel } : {}),
        ...(cancelLabel !== undefined ? { cancelLabel } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
        initial: value.initial,
        selection,
      }
    }
    default:
      return null
  }
}
