/**
 * Production-safe pi editor facade.
 *
 * Unlike the broad test/fork facade in `pi.ts`, this module does not re-export
 * `ProcessTerminal` or either pi screen backend. Importing the v2 prompt editor
 * therefore cannot make a second process.stdout writer reachable from the
 * production dependency graph.
 *
 * The vendored editor's undo stack is intentionally replaced at this facade:
 * upstream keeps every deep-cloned snapshot forever, while a long-lived TUI
 * must retain only a bounded recent undo history. The fork itself stays frozen.
 */
import type { TUI } from '../vendor/pi-tui/src/tui.js'
import {
  Editor as VendoredEditor,
  type EditorOptions,
  type EditorTheme,
} from '../vendor/pi-tui/src/components/editor.js'

export { CURSOR_MARKER } from '../vendor/pi-tui/src/tui.js'
export type { EditorTheme, TUI }

export const PI_EDITOR_UNDO_LIMIT = 256

interface UndoStackLike<S> {
  push(state: S): void
  pop(): S | undefined
  clear(): void
  readonly length: number
}

class BoundedUndoStack<S> implements UndoStackLike<S> {
  private readonly stack: S[] = []

  push(state: S): void {
    this.stack.push(structuredClone(state))
    if (this.stack.length > PI_EDITOR_UNDO_LIMIT) this.stack.shift()
  }

  pop(): S | undefined {
    return this.stack.pop()
  }

  clear(): void {
    this.stack.length = 0
  }

  get length(): number {
    return this.stack.length
  }
}

interface EditorUndoSlot {
  undoStack: UndoStackLike<unknown>
}

export class Editor extends VendoredEditor {
  constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
    super(tui, theme, options)
    ;(this as unknown as EditorUndoSlot).undoStack = new BoundedUndoStack()
  }
}

export function editorUndoDiagnostics(editor: Editor): { readonly depth: number; readonly limit: number } {
  return {
    depth: (editor as unknown as EditorUndoSlot).undoStack.length,
    limit: PI_EDITOR_UNDO_LIMIT,
  }
}
