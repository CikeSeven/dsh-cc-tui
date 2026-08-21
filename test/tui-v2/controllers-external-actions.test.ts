import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createExternalActionTraceRecorder, parseLocalCommand, sanitizeChildText } from '../../src/tui-v2/capabilities/external-actions.js'
import { createNotificationController } from '../../src/tui-v2/controllers/notifications.js'
import { createShellController } from '../../src/tui-v2/controllers/shell.js'
import { createClipboardController } from '../../src/tui-v2/controllers/clipboard.js'
import { createExternalEditorController } from '../../src/tui-v2/controllers/external-editor.js'
import { createUpdateController } from '../../src/tui-v2/controllers/update.js'
import { createPreferencesController } from '../../src/tui-v2/controllers/preferences.js'
import { createThemeRegistry } from '../../src/tui-v2/theme/registry.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import { createNotificationDock } from '../../src/tui-v2/components/chrome/notification-dock.js'
import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js'
import { createScreenTakeover } from '../../src/tui-v2/terminal/takeover.js'

class Clock {
  nowValue = 0
  timers: Array<{ at: number; callback: () => void }> = []
  now(): number { return this.nowValue }
  setTimeout(callback: () => void, delayMs: number): number {
    this.timers.push({ at: this.nowValue + delayMs, callback })
    return this.timers.length
  }
  clearTimeout(_handle: unknown): void {}
  advance(ms: number): void {
    this.nowValue += ms
    for (const timer of this.timers.filter((candidate) => candidate.at <= this.nowValue)) timer.callback()
    this.timers = this.timers.filter((candidate) => candidate.at > this.nowValue)
  }
}

test('external actions: local prefix and child output are bounded/sanitized', () => {
  assert.deepEqual(parseLocalCommand('!printf hi'), { commandLine: 'printf hi', includeInContext: false })
  assert.deepEqual(parseLocalCommand('!!printf hi'), { commandLine: 'printf hi', includeInContext: true })
  assert.equal(parseLocalCommand('hello'), undefined)
  const output = sanitizeChildText('\x1b[31mred\x1b[0m\n\x1b]52;c;secret\x07', { maxChars: 20, maxLines: 2 })
  assert.equal(output.text, 'red\n')
  assert.equal(output.truncated, false)
})

test('external actions: child takeover holds one lease and restores via opaque token', async () => {
  const modes = {
    alternateScreen: true, rawInput: true, mouse: 'sgr-1006' as const, bracketedPaste: true,
    syncOutput: true, autowrap: true, wrapPending: false, scrollRegion: { top: 0, bottom: 23 },
    cursorStyle: 'block' as const, cursorVisible: false, kittyKeyboard: true,
    modifyOtherKeys: false, focusReporting: true, windowsDec9001: false, osc133: false,
    title: null, progress: { state: 'none' as const },
  }
  let suspended = 0
  let resumed = 0
  const lifecycle = {
    generation: () => 2,
    setGeneration: () => {},
    currentModeSnapshot: () => modes,
    suspendForTakeover: async () => ({ modeSnapshot: modes, generation: 2, barrier: { generation: 2, committedPatchSeq: 4 } }),
    resumeFromTakeover: async () => { resumed += 1 },
  }
  const writer = {
    quiesce: async () => { suspended += 1; return { generation: 2, committedPatchSeq: 4 } },
    resume: () => {},
  }
  const takeover = createScreenTakeover({ lifecycle, writer })
  const lease = await takeover.request('external-editor', 'test child')
  await assert.rejects(() => takeover.request('update', 'busy'))
  await takeover.restore(lease.token, { reason: 'completed' })
  await takeover.restore(lease.token, { reason: 'completed' })
  assert.equal(suspended, 0, 'child lifecycle suspension owns the writer barrier')
  assert.equal(resumed, 1)
})

test('external actions: shell controller lifecycle, cancel, and late result', async () => {
  const trace = createExternalActionTraceRecorder()
  const notices: string[] = []
  let resolve!: (result: any) => void
  const shell = createShellController({
    capability: {
      run: async (_request, sink, signal) => {
        sink.stdout('out\x1b[2K')
        if (signal.aborted) return { phase: 'cancelled', exitCode: null, signal: 'SIGINT', stdoutChars: 3, stderrChars: 0, stdoutLines: 1, stderrLines: 0, truncated: false }
        return await new Promise((done) => { resolve = done })
      },
    },
    cwd: () => '/safe/workspace',
    notify: (text) => notices.push(text),
    trace,
  })
  assert.equal(shell.run('!echo hello'), true)
  assert.equal(shell.phase(), 'working')
  assert.equal(shell.run('!second'), true)
  assert.equal(shell.diagnostics().ignored, 1)
  shell.cancel()
  resolve({ phase: 'completed', exitCode: 0, signal: null, stdoutChars: 3, stderrChars: 0, stdoutLines: 1, stderrLines: 0, truncated: false })
  await new Promise((done) => setImmediate(done))
  assert.equal(shell.diagnostics().completed, 1)
  assert.ok(notices.some((text) => text.includes('already running')))
  assert.ok(trace.entries().every((entry) => !JSON.stringify(entry).includes('echo hello')))
})

test('external actions: notification queue dedupe, timeout, sticky and bounded rows', () => {
  const clock = new Clock()
  const controller = createNotificationController({ clock, maxEntries: 2 })
  const first = controller.enqueue({ text: 'hello', dedupeKey: 'same', timeoutMs: 100 })
  controller.enqueue({ text: 'hello again', dedupeKey: 'same', timeoutMs: 100 })
  assert.equal(controller.view()[0]?.count, 2)
  assert.equal(controller.dismiss(first), true)
  controller.enqueue({ text: 'sticky', sticky: true })
  controller.enqueue({ text: 'bounded' })
  controller.enqueue({ text: 'newest' })
  assert.equal(controller.view().length, 2)
  clock.advance(200)
  controller.advance()
  assert.equal(controller.view().some((item) => item.text === 'sticky'), true)
})

test('external actions: clipboard text/image routing and unsupported OSC52', async () => {
  const inserted: string[] = []
  const notices: string[] = []
  let value: any = { kind: 'text', text: '你好\ntext' }
  const clipboard = createClipboardController({
    capability: {
      read: async () => value,
      copy: async () => ({ status: 'unsupported', reason: 'host' as const }),
    },
    generation: () => 0,
    profileSupportsOsc52: () => false,
    insertText: (text) => inserted.push(text),
    notify: (text) => notices.push(text),
  })
  assert.deepEqual(await clipboard.paste(), { status: 'inserted-text', chars: 7 })
  value = { kind: 'image', data: new Uint8Array([1, 2]), mediaType: 'image/png' }
  assert.equal((await clipboard.paste()).status, 'unsupported')
  assert.equal((await clipboard.copy('copy me')).status, 'unsupported')
  assert.ok(notices.length >= 1)
})

test('external actions: editor and update controllers suppress late results', async () => {
  const notices: string[] = []
  const editor = createExternalEditorController({
    runner: { run: async () => ({ phase: 'completed' as const, exitCode: 0, signal: null }) },
    cwd: () => '/safe',
    draft: () => 'draft',
    setDraft: () => {},
    resolveArgv: () => ['fake-editor'],
    notify: (text) => notices.push(text),
  })
  assert.equal(editor.open(), true)
  assert.equal(editor.open(), true)
  for (let i = 0; i < 20 && editor.diagnostics().unchanged === 0 && editor.diagnostics().completed === 0 && editor.diagnostics().failed === 0; i += 1) {
    await new Promise((done) => setTimeout(done, 10))
  }
  assert.equal(editor.diagnostics().unchanged + editor.diagnostics().completed, 1)
  assert.equal(editor.diagnostics().busy, 1)

  let restartResolve!: (result: any) => void
  const update = createUpdateController({
    runner: { run: async () => await new Promise((resolve) => { restartResolve = resolve }) },
    confirm: () => true,
    notify: (text) => notices.push(text),
  })
  const request = update.request({ sessionId: 's', profile: 'p' })
  for (let i = 0; i < 10 && restartResolve === undefined; i += 1) await new Promise((done) => setTimeout(done, 0))
  update.cancel()
  restartResolve({ phase: 'success', updateCode: 0, restartCode: 0 })
  assert.equal(await request, false)
  assert.equal(update.phase(), 'cancelled')
})

test('external actions: notification dock component is bounded at narrow widths', () => {
  const component = createNotificationDock([{
    notificationId: 'dock-1', text: '危险 你好 👩‍💻', severity: 'warning', sticky: true,
    createdAt: 0, expiresAt: null, dedupeKey: null, count: 2,
  }], { profile: unknownConservativeDefaults(), theme: DEFAULT_COMPONENT_THEME })
  assert.deepEqual(component.render(0), [])
  for (const width of [1, 2, 8, 40]) assert.equal(component.render(width).length, 1)
})

test('external actions: safe theme fallback and language persistence seam', async () => {
  const themes = createThemeRegistry({ initial: [{ id: 'safe', displayName: 'Safe', base: 'default', roles: DEFAULT_COMPONENT_THEME.roles }] })
  const notices: string[] = []
  let language = 'en'
  const preferences = createPreferencesController({
    themes,
    languages: { supported: ['zh', 'en'], set: async (next) => { language = next; return { status: 'changed' as const } } },
    notify: (text) => notices.push(text),
  })
  assert.equal(await preferences.setTheme('../escape'), false)
  assert.equal(await preferences.setTheme('safe'), true)
  assert.equal(await preferences.setLanguage('zh'), true)
  assert.equal(language, 'zh')
  assert.ok(notices.length >= 2)
})
