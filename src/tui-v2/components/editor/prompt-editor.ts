/**
 * tui-v2 prompt editor (WP-04b).
 *
 * Composes the vendored pi `Editor` (which passes the 698 upstream tests)
 * behind the v2 Component/Focusable contract, per the task decision "优先组合
 * vendored Editor，外面包一层 v2 contract":
 *
 *  - No Channel: submit/change surface as schema `InputCommand` editor
 *    commands via `onCommand` (§5.1: PromptEditor only emits EditorCommand).
 *  - The vendored editor wraps with its own width semantics (pi-fork tests
 *    cover that); every emitted line is additionally width-guaranteed through
 *    the §6.1 pipeline (`assertLineWidth`), so a line can never exceed the
 *    viewport even when the two width models disagree.
 *  - The hardware-cursor APC marker (`CURSOR_MARKER`) is consumed here and
 *    re-exposed as a `Focusable.cursor` position; it never reaches output.
 *  - The vendored editor needs a `TUI` host; only `terminal.rows` and
 *    `requestRender()` are exercised, so a minimal stub is injected. This is
 *    the single sanctioned narrowing cast on the facade boundary.
 *
 * Deviation (registered for WP-05): `syncFromView` maps history by identity
 * only and ignores the model's UTF-16 cursor offset (the vendored editor owns
 * its cursor); precise cursor sync lands with the input controller.
 */
import type { EditorView } from '../../model/selectors.js'
import type { InputCommand } from '../../model/schema.js'
import type { Component, Focusable } from '../../renderer/component.js'
import {
  assertLineWidth,
  cellsToString,
  cellsWidth,
  lineToCells,
  sanitizeText,
  truncateCells,
} from '../../renderer/lines.js'
import {
  CURSOR_MARKER,
  Editor,
  type EditorTheme,
  type TUI,
} from '../../terminal/pi.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'

export interface PromptEditorOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
  /** Terminal row count the vendored editor sizes its scroll window against. */
  readonly terminalRows: number
  /** EditorCommand sink (controller). */
  readonly onCommand?: (command: Extract<InputCommand, { type: 'editor' }>) => void
  /** Repaint hint: called whenever the vendored editor asks for a render. */
  readonly onRepaint?: () => void
}

export interface PromptEditor extends Component, Focusable {
  /** Sync the immutable EditorView into the stateful vendored editor. */
  syncFromView(view: EditorView): void
  /** Current plain text. */
  getText(): string
}

const MARKER = CURSOR_MARKER // '\x1b_pi:c\x07' — zero-width APC cursor marker

/**
 * Narrowest width delegated to the vendored editor: with paddingX 1 the
 * vendored layout width is `width - 2`, and its wordWrapLine recurses
 * unboundedly on a wide grapheme when that layout width drops below 2
 * (§6.1 forbids exactly this recursion; the fork is frozen, so the wrapper
 * degrades instead). width < 4 renders a reduced border+text skeleton.
 */
const MIN_VENDORED_WIDTH = 4
const RULE_CHAR = '─'

export function createPromptEditor(options: PromptEditorOptions): PromptEditor {
  const { profile } = options
  // The vendored editor only reads `terminal.rows` and `requestRender()` on
  // its host (verified against vendored editor.ts); the rest of TUI is never
  // touched on this path.
  const tuiStub = {
    terminal: { rows: options.terminalRows },
    requestRender: () => options.onRepaint?.(),
  } as unknown as TUI
  const editorTheme: EditorTheme = {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  }
  const editor = new Editor(tuiStub, editorTheme, { paddingX: 1 })

  let lastEmittedText = ''
  let syncing = false
  const emit = (command: Extract<InputCommand, { type: 'editor' }>): void => {
    options.onCommand?.(command)
  }
  editor.onSubmit = (text) => {
    lastEmittedText = ''
    emit({ type: 'editor', command: 'submit', text })
  }
  editor.onChange = (text) => {
    if (syncing) return
    // Reduced command mapping: full-text sync; insert vs delete by length.
    emit({ type: 'editor', command: text.length < lastEmittedText.length ? 'delete' : 'insert', text })
    lastEmittedText = text
  }

  const component: PromptEditor = {
    get focused() {
      return editor.focused
    },
    set focused(value: boolean) {
      editor.focused = value
    },
    cursor: undefined,

    syncFromView(view) {
      syncing = true
      try {
        if (editor.getText() !== view.text) editor.setText(view.text)
      } finally {
        syncing = false
      }
      // The setter above propagates focus to the vendored editor (it gates
      // the CURSOR_MARKER emission).
      component.focused = view.focused
      lastEmittedText = view.text
    },

    getText() {
      return editor.getText()
    },

    render(width: number): string[] {
      component.cursor = undefined
      if (width <= 0) return []
      if (width < MIN_VENDORED_WIDTH) {
        // Narrow-width degradation (capability-matrix entry): the vendored
        // editor's wordWrapLine recurses on wide graphemes when its layout
        // width drops below 2, so below MIN_VENDORED_WIDTH the skeleton
        // renders border + clipped text through the v2 pipeline directly.
        const rule = cellsToString(truncateCells(lineToCells(RULE_CHAR.repeat(width), profile), width))
        const textCells = truncateCells(lineToCells(sanitizeText(editor.getText()), profile), width)
        if (component.focused) {
          component.cursor = {
            x: Math.min(cellsWidth(textCells), Math.max(0, width - 1)),
            y: 1,
            visible: true,
          }
        }
        return [rule, cellsToString(textCells), rule]
      }
      const rawLines = editor.render(width)
      const out: string[] = []
      for (let y = 0; y < rawLines.length; y++) {
        const raw = rawLines[y] as string
        const markerAt = raw.indexOf(MARKER)
        let line = raw
        if (markerAt !== -1) {
          const before = raw.slice(0, markerAt)
          line = raw.slice(0, markerAt) + raw.slice(markerAt + MARKER.length)
          if (component.focused) {
            const x = lineToCells(before, profile).reduce((sum, cell) => sum + cell.width, 0)
            component.cursor = { x: Math.min(x, Math.max(0, width - 1)), y, visible: true }
          }
        }
        // The vendored editor's width model is not profile-driven; guarantee
        // the §6.1 contract here (clip, never throw).
        out.push(assertLineWidth(line, profile, width))
      }
      return out
    },

    invalidate() {
      // The vendored editor keeps no width-keyed caches of its own.
    },

    handleInput(data) {
      // Raw key data (incl. escape-coded keys) passes through untouched —
      // sanitizeText would destroy arrow/function-key sequences; sanitization
      // is an output-side rule, the vendored editor owns input parsing.
      if (typeof data !== 'string') return // structured events: WP-05 input controller
      if (!component.focused) return
      editor.handleInput(data)
    },
  }
  return component
}
