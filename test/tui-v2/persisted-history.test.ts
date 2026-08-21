/** Persisted prompt-history integration for the v2 input controller. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendHistory, loadHistory } from '../../src/history.js'
import { createInputController, type InputEditorBinding } from '../../src/tui-v2/controllers/input.js'
import type { EventMeta } from '../../src/tui-v2/model/schema.js'

const meta: EventMeta = {
  schemaVersion: 1,
  adapterInstanceId: 'history-test',
  durableSessionId: 'history-session',
  uiSessionGeneration: 'history-generation',
  resetEpoch: 0,
  sessionEpoch: 'history-generation:0',
  source: 'input',
  sourceSeq: 'history-input',
  seq: 1,
  at: 0,
}

test('persisted history: malformed lines degrade and append dedups newest entry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-tui-history-'))
  await writeFile(path.join(dir, 'history.jsonl'), '{bad json}\n{"text":"first","ts":1}\n', 'utf8')

  appendHistory(' second ', dir)
  appendHistory('second', dir)
  const entries = loadHistory(dir)
  assert.deepEqual(entries.map(entry => entry.text), ['second', 'first'])
  assert.equal(entries.length, 2, 'consecutive duplicate updates rather than appends')
  assert.ok(entries[0]!.ts > 0)

  const raw = await readFile(path.join(dir, 'history.jsonl'), 'utf8')
  assert.equal(raw.endsWith('\n'), true)
  assert.equal(raw.includes('{bad json}'), false, 'next append compacts malformed input away')
})

test('persisted history: controller seeds editor/search and appends submissions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-tui-history-controller-'))
  appendHistory('older', dir)
  appendHistory('newer', dir)

  const editorHistory: string[] = []
  const submitted: string[] = []
  const editor: InputEditorBinding = {
    handleRawInput() {},
    getText: () => '',
    clearText() {},
    addToHistory: text => editorHistory.unshift(text),
  }
  const controller = createInputController({
    clock: { now: () => 0, setTimeout: () => 0, clearTimeout() {} },
    dispatch() {},
    nextMeta: () => meta,
    editor,
    commands: { submit: text => submitted.push(text), cancel() {} },
    isWorking: () => false,
    onExitRequest() {},
    initialHistory: loadHistory(dir).map(entry => entry.text),
    onHistoryAppend: text => appendHistory(text, dir),
  })

  assert.deepEqual(editorHistory, ['newer', 'older'], 'editor receives persisted entries newest first')
  assert.deepEqual(controller.history(), ['newer', 'older'], 'search mirror starts from persisted history')

  controller.handleEditorCommand({ type: 'editor', command: 'submit', text: '  newest  ' })
  assert.deepEqual(submitted, ['  newest  '], 'command dispatch keeps submitted text unchanged')
  assert.deepEqual(controller.history(), ['newest', 'newer', 'older'])
  assert.deepEqual(loadHistory(dir).map(entry => entry.text), ['newest', 'newer', 'older'])
})
