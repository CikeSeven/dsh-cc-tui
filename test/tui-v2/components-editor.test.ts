/**
 * tui-v2 WP-04b prompt-editor tests: the vendored-Editor composition behind
 * the v2 Component/Focusable contract — EditorCommand emission (never a
 * Channel), cursor-marker translation, width guarantee and view sync.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPromptEditor, type PromptEditor } from '../../src/tui-v2/components/editor/prompt-editor.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import type { InputCommand } from '../../src/tui-v2/model/schema.js'
import { measureLineWidth, lineToCells } from '../../src/tui-v2/renderer/lines.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'

const PROFILE = getProfile('unicode-ambiguous-narrow')

function visible(line: string): string {
  return lineToCells(line, PROFILE)
    .filter((c) => c.width > 0)
    .map((c) => c.grapheme)
    .join('')
}

function makeEditor(): {
  editor: PromptEditor
  commands: Extract<InputCommand, { type: 'editor' }>[]
} {
  const commands: Extract<InputCommand, { type: 'editor' }>[] = []
  const editor = createPromptEditor({
    profile: PROFILE,
    theme: DEFAULT_COMPONENT_THEME,
    terminalRows: 24,
    onCommand: (command) => commands.push(command),
  })
  editor.focused = true
  return { editor, commands }
}

test('components/editor: typing emits insert commands, not channel calls', () => {
  const { editor, commands } = makeEditor()
  editor.handleInput?.('h')
  editor.handleInput?.('i')
  assert.equal(editor.getText(), 'hi')
  assert.ok(commands.length >= 1)
  assert.ok(commands.every((c) => c.type === 'editor' && (c.command === 'insert' || c.command === 'delete')))
  assert.equal((commands[commands.length - 1] as { text?: string }).text, 'hi')
})

test('components/editor: Enter emits a submit command with the text', () => {
  const { editor, commands } = makeEditor()
  editor.handleInput?.('hello')
  editor.handleInput?.('\r')
  const submits = commands.filter((c) => c.command === 'submit')
  assert.equal(submits.length, 1)
  assert.equal((submits[0] as { text?: string }).text, 'hello')
  assert.equal(editor.getText(), '', 'editor cleared after submit')
})

test('components/editor: render honors the width contract incl. borders', () => {
  const { editor } = makeEditor()
  editor.handleInput?.('some prompt text 你好')
  for (const width of [0, 1, 2, 5, 40]) {
    const lines = editor.render(width)
    if (width === 0) {
      assert.deepEqual(lines, [])
      continue
    }
    assert.ok(lines.length >= 3, 'top border + content + bottom border')
    for (const line of lines) {
      assert.ok(measureLineWidth(line, PROFILE) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`)
    }
  }
})

test('components/editor: focused cursor marker becomes a Focusable cursor position', () => {
  const { editor } = makeEditor()
  editor.handleInput?.('abc')
  const lines = editor.render(40)
  assert.ok(editor.cursor !== undefined && editor.cursor.visible)
  assert.ok(lines.every((line) => !line.includes('_pi:c')), 'marker never leaks into output')
  // paddingX 1 + 3 chars of text -> cursor column 4
  assert.equal(editor.cursor?.x, 4)
  assert.equal(editor.cursor?.y, 1, 'first content line below the top border')
  // Unfocused: no cursor.
  const idle = createPromptEditor({ profile: PROFILE, theme: DEFAULT_COMPONENT_THEME, terminalRows: 24 })
  idle.render(40)
  assert.equal(idle.cursor, undefined)
})

test('components/editor: syncFromView adopts the model text without emitting commands', () => {
  const { editor, commands } = makeEditor()
  editor.syncFromView({
    text: 'from model',
    cursor: 10,
    history: [],
    historyIndex: null,
    focused: true,
  })
  assert.equal(editor.getText(), 'from model')
  assert.equal(commands.length, 0, 'sync is not an editor command')
  const lines = editor.render(30)
  assert.ok(lines.some((line) => visible(line).includes('from model')))
})

test('components/editor: backspace emits delete', () => {
  const { editor, commands } = makeEditor()
  editor.handleInput?.('ab')
  editor.handleInput?.('\x7f')
  assert.equal(editor.getText(), 'a')
  assert.ok(commands.some((c) => c.command === 'delete'))
})

test('components/editor: production undo history retains only the latest bounded snapshots', () => {
  const { editor } = makeEditor()
  const limit = editor.diagnostics().undo.limit
  for (let index = 0; index < limit; index += 1) {
    editor.handleInput?.('x')
    editor.handleInput?.('\x7f')
  }
  assert.deepEqual(editor.diagnostics().undo, { depth: limit, limit })

  editor.handleInput?.('\x1b[45;5u')
  assert.equal(editor.getText(), 'x', 'latest retained snapshot remains undoable')
  assert.deepEqual(editor.diagnostics().undo, { depth: limit - 1, limit })
})
