#!/usr/bin/env node
/**
 * External-editor regression: pure argv/path helpers plus the v2
 * EditorRunner/ScreenTakeover controller seam.
 *
 * The retired renderer handoff reproduction is intentionally gone. Terminal
 * ownership is asserted by the v2 controller tests; this gate uses only pure
 * helpers and the v2 controller seam and never treats a skipped check as success.
 *
 * Run against compiled output: `node scripts/verify-external-editor.mjs`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildCmdExeSpawn,
  resolveEditorCommand,
  resolveWindowsShim,
  splitEditorCommand,
} from '../lib/types/utils/externalEditor.js'
import { cmdEscapeArgument, cmdEscapeCommand } from '../lib/types/utils/shellQuote.js'

let checks = 0
let failed = 0
function check(name, ok, detail = '') {
  checks += 1
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? `  (${detail})` : ''}`)
}
const eq = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

// ── splitEditorCommand ────────────────────────────────────────────────────
check('split: whitespace splits command and arguments', eq(splitEditorCommand('code --wait'), ['code', '--wait']))
check('split: double-quoted editor path keeps spaces', eq(splitEditorCommand('"/opt/my editor/nvim" -f'), ['/opt/my editor/nvim', '-f']))
check('split: single-quoted argument', eq(splitEditorCommand("nano '--restricted'"), ['nano', '--restricted']))
check('split: blank command becomes an empty argv', eq(splitEditorCommand('   '), []))
check('split: empty quotes preserve an empty argument', eq(splitEditorCommand('""'), ['']))

// ── resolveEditorCommand ──────────────────────────────────────────────────
check('resolve: VISUAL takes precedence', eq(resolveEditorCommand({ VISUAL: 'vim', EDITOR: 'nano' }), ['vim']))
check('resolve: blank VISUAL falls back to EDITOR', eq(resolveEditorCommand({ VISUAL: '  ', EDITOR: 'nano' }), ['nano']))
check('resolve: parses a command with arguments', eq(resolveEditorCommand({ EDITOR: 'code --wait' }), ['code', '--wait']))
check('resolve: Windows without an editor is unsupported', resolveEditorCommand({}, 'win32') === undefined)
if (process.platform !== 'win32') check('resolve: POSIX fallback is vi', eq(resolveEditorCommand({}), ['vi']))

// ── cross-spawn quoting helpers ───────────────────────────────────────────
check(
  'cmd-escape: command path with spaces uses caret escaping',
  cmdEscapeCommand('C:\\VS Code\\bin\\code.cmd') === 'C:\\VS^ Code\\bin\\code.cmd',
  cmdEscapeCommand('C:\\VS Code\\bin\\code.cmd'),
)
check('cmd-escape: plain argument uses outer quoting', cmdEscapeArgument('--wait') === '^"--wait^"', cmdEscapeArgument('--wait'))
check(
  'cmd-escape: embedded quotes are escaped',
  cmdEscapeArgument('say "hi"') === '^"say^ \\^"hi\\^"^"',
  cmdEscapeArgument('say "hi"'),
)
check('cmd-escape: trailing backslash is doubled', cmdEscapeArgument('C:\\') === '^"C:\\\\^"', cmdEscapeArgument('C:\\'))
check('cmd-escape: .bin shim arguments are double escaped', cmdEscapeArgument('--wait', true) === '^^^"--wait^^^"', cmdEscapeArgument('--wait', true))
{
  const spawnDesc = buildCmdExeSpawn('C:\\VS Code\\bin\\code.cmd', ['--wait', 'C:\\T m p\\f.md'], {})
  check(
    'cmd-spawn: default comspec, /d /s /c, verbatim arguments',
    spawnDesc.file === 'cmd.exe' &&
      eq(spawnDesc.args, ['/d', '/s', '/c', '"C:\\VS^ Code\\bin\\code.cmd ^"--wait^" ^"C:\\T^ m^ p\\f.md^""']) &&
      spawnDesc.verbatim === true,
    JSON.stringify(spawnDesc),
  )
}
{
  const shimDesc = buildCmdExeSpawn('proj\\node_modules\\.bin\\tsc.cmd', ['--watch'], { comspec: 'C:\\Windows\\System32\\cmd.exe' })
  check(
    'cmd-spawn: .bin shim uses the supplied comspec',
    shimDesc.file === 'C:\\Windows\\System32\\cmd.exe' &&
      eq(shimDesc.args, ['/d', '/s', '/c', '"proj\\node_modules\\.bin\\tsc.cmd ^^^"--watch^^^""']),
    JSON.stringify(shimDesc),
  )
}
{
  const fwd = buildCmdExeSpawn('C:/Program Files/Microsoft VS Code/bin/code.cmd', ['--wait'], {})
  check(
    'cmd-spawn: forward-slash Windows paths normalize before escaping',
    eq(fwd.args, ['/d', '/s', '/c', '"C:\\Program^ Files\\Microsoft^ VS^ Code\\bin\\code.cmd ^"--wait^""']),
    JSON.stringify(fwd),
  )
}
{
  const emptyComspec = buildCmdExeSpawn('x.cmd', [], { comspec: '' })
  check('cmd-spawn: blank ComSpec falls back to cmd.exe', emptyComspec.file === 'cmd.exe' && eq(emptyComspec.args, ['/d', '/s', '/c', '"x.cmd"']), JSON.stringify(emptyComspec))
}

// ── resolveWindowsShim ────────────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-verify-editor-'))
const shimDir = join(scratch, 'shim-bin')
mkdirSync(shimDir)
writeFileSync(join(shimDir, 'code.cmd'), '@echo off\r\n')
writeFileSync(join(shimDir, 'gvim.exe'), 'MZ')
const shimEnv = { PATH: shimDir, PATHEXT: '.EXE;.CMD' }
try {
  const cmd = resolveWindowsShim('code', shimEnv)
  check('shim: code resolves to code.cmd through cmd.exe', cmd.viaCmd && /code\.cmd$/i.test(cmd.command), JSON.stringify(cmd))
  const exe = resolveWindowsShim('gvim', shimEnv)
  check('shim: gvim.exe spawns directly', !exe.viaCmd && /gvim\.exe$/i.test(exe.command), JSON.stringify(exe))
  const explicit = resolveWindowsShim('nvim.cmd', shimEnv)
  check('shim: explicit .cmd extension passes through', explicit.viaCmd && explicit.command === 'nvim.cmd')
  const missing = resolveWindowsShim('not-on-path', shimEnv)
  check('shim: missing command remains a bare command', !missing.viaCmd && missing.command === 'not-on-path')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ── v2 controller seam ────────────────────────────────────────────────────
const controllerSource = readFileSync(new URL('../src/tui-v2/controllers/external-editor.ts', import.meta.url), 'utf8')
check('v2 controller owns the external-editor takeover', controllerSource.includes("request('external-editor'"))
check('v2 controller restores the takeover after the runner settles', controllerSource.includes('options.takeover.restore'))
check('v2 controller has no legacy Ink handoff symbols', !/editInExternalEditor|instances|src\/ink|waitUntilExit/u.test(controllerSource))

const { createExternalEditorController } = await import('../lib/types/tui-v2/controllers/external-editor.js')
const notices = []
let draft = 'draft'
const controller = createExternalEditorController({
  runner: {
    async run(request) {
      writeFileSync(request.filePath, 'edited by v2\n', 'utf8')
      return { phase: 'completed', exitCode: 0, signal: null }
    },
  },
  cwd: () => process.cwd(),
  draft: () => draft,
  setDraft: (next) => { draft = next },
  resolveArgv: () => ['fake-editor'],
  notify: (text) => { notices.push(text) },
})
assert.equal(controller.open(), true)
const deadline = Date.now() + 3000
while (controller.phase() === 'preparing' || controller.phase() === 'running' || controller.phase() === 'reading') {
  if (Date.now() >= deadline) throw new Error('v2 external-editor controller did not settle')
  await new Promise((resolve) => setTimeout(resolve, 5))
}
check('v2 controller runs an injected EditorRunner without Ink handoff', controller.phase() === 'completed' && draft === 'edited by v2\n', JSON.stringify(controller.diagnostics()))
check('v2 controller records a completed operation', controller.diagnostics().started === 1 && controller.diagnostics().completed === 1, JSON.stringify(controller.diagnostics()))
check('v2 controller emits a bounded success notice', notices.some((text) => text.includes('Draft updated')), JSON.stringify(notices))

if (failed > 0) {
  console.error(`verify-external-editor: FAILED (${failed}/${checks})`)
  process.exitCode = 1
} else {
  console.log(`verify-external-editor: OK (${checks} checks)`)
  process.exitCode = 0
}
