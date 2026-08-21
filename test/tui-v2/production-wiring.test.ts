import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { projectShortcutKey } from '../../src/tui-v2/app/coordinator.js'

const root = resolve(import.meta.dirname, '../..')
const read = (relative: string): string => readFileSync(resolve(root, relative), 'utf8')

test('production wiring: plugin bootstrap is v2-only and has no retired UI imports', () => {
  const plugin = read('src/dsh-adapter/plugin.ts')
  const forbiddenImport = /^\s*import\s+(?:[^;]*?\s+from\s+)?["'][^"']*(?:react|screens\/|(?:^|\/)ui|(?:^|\/)ink)(?:["'][^;]*)/imu
  assert.equal(forbiddenImport.test(plugin), false)
  assert.equal(plugin.includes('createTuiV2App'), true)
  assert.equal(plugin.includes('await app.start()'), true)
  assert.equal(plugin.includes(['Re', 'act', '.createElement'].join('')), false)
  assert.equal(plugin.includes('waitUntilExit'), false)
  assert.equal(plugin.includes('finishExit'), false)
})

test('production wiring: stores, scenes, status/shortcuts and lifecycle reasons cross the factory seam', () => {
  const plugin = read('src/dsh-adapter/plugin.ts')
  const bootstrap = read('src/tui-v2/app/bootstrap.ts')
  const coordinator = read('src/tui-v2/app/coordinator.ts')

  for (const token of [
    'approvalStore',
    'questionStore',
    'pluginDialogStore',
    'statusHost',
    'shortcutHost',
    'scenes',
    "await app?.stop('teardown')",
    'channel.releaseContributions()',
  ]) {
    assert.equal(plugin.includes(token), true, `plugin must wire ${token}`)
  }
  for (const token of [
    'approvalStore?: ApprovalStoreLike',
    'questionStore?: QuestionStoreLike',
    'pluginDialogStore?: PluginDialogStoreLike',
    'statusHost?: CoordinatorStatusHost',
    'shortcutHost?: CoordinatorShortcutHost',
    'processHost?: ProcessSignalHost',
    'onStopRequest?',
    'stop(reason?: LifecycleStopReason)',
  ]) {
    assert.equal(`${bootstrap}\n${coordinator}`.includes(token), true, `factory/coordinator must expose ${token}`)
  }
  assert.equal(plugin.includes("mode: config.fullscreen === true ? 'fullscreen' : 'inline'"), true)
  assert.equal(plugin.includes("onExitRequest: () => handleExit('user-exit')"), true)
})

test('shortcut host seam projects canonical key ids without importing adapter services', () => {
  assert.deepEqual(projectShortcutKey({ key: 'ctrl+shift+p', raw: '', text: null, eventType: 'press' }), {
    input: 'p',
    key: { ctrl: true, shift: true },
  })
  assert.deepEqual(projectShortcutKey({ key: 'ctrl+space', raw: '\\0', text: null, eventType: 'press' }), {
    input: ' ',
    key: { ctrl: true },
  })
  assert.deepEqual(projectShortcutKey({ key: 'alt+enter', raw: '', text: null, eventType: 'press' }), {
    input: '',
    key: { meta: true, return: true },
  })
})

test('neutral helper boundary: sanitize and external-editor helpers do not import Ink', () => {
  const sanitize = read('src/dsh-adapter/sanitize.ts')
  const editor = read('src/utils/externalEditor.ts')
  assert.equal(/(?:^|["'])[^\n]*ink\//iu.test(sanitize), false)
  assert.equal(/(?:^|["'])[^\n]*ink\//iu.test(editor), false)
  assert.equal(editor.includes('editInExternalEditor'), false)
  assert.equal(editor.includes('buildCmdExeSpawn'), true)
  assert.equal(read('src/utils/activityFrames.ts').includes('FRAME_PRESETS'), true)
  assert.equal(read('src/utils/spinnerMode.ts').includes('SpinnerMode'), true)
})

test('production profile resolver is not sourced from testkit profiles', () => {
  const resolver = read('src/tui-v2/terminal/production-profile.ts')
  assert.equal(resolver.includes("from '../testkit/terminal-profiles.js'"), false)
  assert.equal(resolver.includes('resolveProductionTerminalProfile'), true)
  assert.equal(resolver.includes('WT_SESSION'), true)
  assert.equal(resolver.includes('VSCODE_PID'), true)
  assert.equal(resolver.includes('TMUX'), true)
  assert.equal(resolver.includes('SSH_CONNECTION'), true)
})
