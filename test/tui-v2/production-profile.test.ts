import { test } from 'node:test'
import assert from 'node:assert/strict'

import { selectTerminalMode } from '../../src/tui-v2/app/modes.js'
import { resolveProductionTerminalProfile } from '../../src/tui-v2/terminal/production-profile.js'
import { UNKNOWN_CONSERVATIVE_PROFILE_ID } from '../../src/tui-v2/terminal/profile.js'

const resolve = (
  environment: Record<string, string | undefined>,
  options: {
    stdoutTTY?: boolean
    stdinTTY?: boolean
    raw?: boolean
    columns?: number
    rows?: number
    platform?: NodeJS.Platform
  } = {},
) => resolveProductionTerminalProfile({
  stdout: {
    isTTY: options.stdoutTTY ?? true,
    columns: options.columns ?? 132,
    rows: options.rows ?? 48,
  },
  stdin: {
    isTTY: options.stdinTTY ?? true,
    ...(options.raw === false ? {} : { setRawMode() {} }),
  },
  environment,
  platform: options.platform ?? 'linux',
})

test('production profile: recognized xterm TTY has real geometry and may enter fullscreen', () => {
  const result = resolve({ TERM: 'xterm-256color', COLORTERM: 'truecolor' })
  assert.equal(result.profile.id, 'production-xterm')
  assert.equal(result.profile.columns, 132)
  assert.equal(result.profile.rows, 48)
  assert.equal(result.profile.supportsAlternateScreen, 'yes')
  assert.equal(result.profile.supportsTrueColor, 'yes')
  assert.equal(Object.isFrozen(result.profile), true)
  assert.equal(Object.isFrozen(result.capabilities), true)
  assert.deepEqual(selectTerminalMode(result.profile, 'fullscreen'), {
    ok: true,
    mode: 'fullscreen',
    degraded: false,
  })
  assert.equal(result.capabilities.capabilities.rawInput.support, 'yes')
  assert.equal(result.capabilities.capabilities.alternateScreen.support, 'yes')
})

test('production profile: unknown TERM stays conservative and explicit fullscreen is rejected', () => {
  const result = resolve({ TERM: 'mystery-terminal', COLORTERM: 'truecolor' })
  assert.equal(result.profile.id, UNKNOWN_CONSERVATIVE_PROFILE_ID)
  assert.equal(result.profile.term, 'mystery-terminal')
  assert.equal(result.profile.supportsAlternateScreen, 'unknown')
  assert.equal(result.profile.supportsBracketedPaste, 'unknown')
  assert.equal(result.profile.imageProtocol, 'unknown')

  const explicit = selectTerminalMode(result.profile, 'fullscreen')
  assert.equal(explicit.ok, false)
  if (!explicit.ok) assert.equal(explicit.error.code, 'unsupported-alternate-screen')
  assert.deepEqual(selectTerminalMode(result.profile, undefined), {
    ok: true,
    mode: 'inline',
    degraded: true,
  })
})

test('production profile: non-TTY never inherits an xterm fullscreen claim', () => {
  const result = resolve(
    { TERM: 'xterm-256color', WT_SESSION: 'secret-session-id' },
    { stdoutTTY: false },
  )
  assert.equal(result.profile.id, UNKNOWN_CONSERVATIVE_PROFILE_ID)
  assert.equal(result.profile.supportsAlternateScreen, 'unknown')
  assert.equal(result.capabilities.capabilities.rawInput.support, 'yes', 'stdin TTY remains independently observable')
  assert.equal(selectTerminalMode(result.profile, 'fullscreen').ok, false)
})

test('production profile: dumb terminals explicitly deny alternate screen', () => {
  const result = resolve({ TERM: 'dumb' })
  assert.equal(result.profile.id, 'production-limited')
  assert.equal(result.profile.supportsAlternateScreen, 'no')
  assert.equal(result.profile.supportsMouse, 'no')
  assert.equal(result.profile.unicodeLevel, 0)
  assert.equal(selectTerminalMode(result.profile, 'fullscreen').ok, false)
})

test('production profile: direct Kitty is enabled, but tmux strips direct-only protocols', () => {
  const direct = resolve({ TERM: 'xterm-kitty', COLORTERM: 'truecolor' })
  assert.equal(direct.profile.id, 'production-kitty')
  assert.equal(direct.profile.family, 'kitty')
  assert.equal(direct.profile.supportsKittyKeyboard, 'yes')
  assert.equal(direct.profile.imageProtocol, 'kitty')

  const tmux = resolve({ TERM: 'xterm-kitty', COLORTERM: 'truecolor', TMUX: '/tmp/private-tmux-socket' })
  assert.equal(tmux.profile.id, 'production-tmux')
  assert.equal(tmux.profile.multiplexer, 'tmux')
  assert.equal(tmux.profile.supportsKittyKeyboard, 'no')
  assert.equal(tmux.profile.imageProtocol, null)
  assert.equal(tmux.capabilities.host, 'tmux')
  assert.equal(JSON.stringify(tmux).includes('/tmp/private-tmux-socket'), false)
})

test('production profile: SSH evidence is presence-only and remains protocol-conservative', () => {
  const result = resolve({
    TERM: 'xterm-256color',
    SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22',
    COLORTERM: 'truecolor',
  })
  assert.equal(result.profile.id, 'production-ssh-xterm')
  assert.equal(result.profile.supportsAlternateScreen, 'yes')
  assert.equal(result.profile.supportsOsc52, 'unknown')
  assert.equal(result.capabilities.host, 'ssh')
  assert.equal(result.capabilities.capabilities.ssh.support, 'yes')
  assert.equal(JSON.stringify(result).includes('10.0.0.1'), false)
})

test('production profile: Windows Terminal and VS Code use allowlisted presence bits', () => {
  const windows = resolve(
    { TERM: 'xterm-256color', WT_SESSION: 'private-guid' },
    { platform: 'win32' },
  )
  assert.equal(windows.profile.id, 'production-windows-terminal')
  assert.equal(windows.profile.family, 'windows-terminal')
  assert.equal(windows.profile.supportsWindowsDec9001, 'yes')
  assert.equal(windows.profile.supportsAlternateScreen, 'yes')
  assert.equal(windows.capabilities.host, 'windows-terminal')
  assert.equal(JSON.stringify(windows).includes('private-guid'), false)

  const vscode = resolve({ TERM: 'xterm-256color', VSCODE_PID: '123456' })
  assert.equal(vscode.profile.id, 'production-vscode')
  assert.equal(vscode.profile.family, 'vscode')
  assert.equal(vscode.capabilities.host, 'vscode')
  assert.equal(JSON.stringify(vscode).includes('123456'), false)
})

test('production profile: malformed TERM and dimensions cannot escape conservative defaults', () => {
  const result = resolve(
    { TERM: 'xterm-256color\u001b[?1049h', COLORTERM: 'arbitrary-value' },
    { columns: 0, rows: -1 },
  )
  assert.equal(result.profile.id, UNKNOWN_CONSERVATIVE_PROFILE_ID)
  assert.equal(result.profile.term, 'unknown')
  assert.equal(result.profile.columns, 80)
  assert.equal(result.profile.rows, 24)
  assert.equal(result.profile.colorTerm, undefined)
})
