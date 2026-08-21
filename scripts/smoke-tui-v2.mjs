import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'

import { createTuiV2App } from '../src/tui-v2/app/bootstrap.ts'
import { getProfile } from '../src/tui-v2/testkit/terminal-profiles.ts'
import { VirtualTerminal } from '../src/tui-v2/testkit/virtual-terminal.ts'
import { addUserRows, createControllerRig } from '../test/tui-v2/helpers/controller-rig.ts'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeStdin extends PassThrough {
  isTTY = true
  rawModes = []

  setRawMode(raw) {
    this.rawModes.push(raw)
    return this
  }

  ref() { return this }
  unref() { return this }
}

class FakeTerminalStream extends Writable {
  constructor(vt, columns, rows) {
    super()
    this.vt = vt
    this.columns = columns
    this.rows = rows
    this.isTTY = true
    this.chunks = []
  }

  _write(chunk, _encoding, callback) {
    const text = String(chunk)
    this.chunks.push(text)
    this.vt.write(text)
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true
  writes = 0

  _write(_chunk, _encoding, callback) {
    this.writes += 1
    callback()
  }
}

function screenText(vt) {
  const snapshot = vt.snapshot()
  const lines = []
  for (let row = 0; row < snapshot.height; row += 1) {
    lines.push(snapshot.cells
      .slice(row * snapshot.width, (row + 1) * snapshot.width)
      .map((cell) => cell.grapheme)
      .join(''))
  }
  return lines.join('\n')
}

async function waitFor(predicate, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`tui-v2 smoke timeout: ${label}`)
    await sleep(10)
  }
}

const columns = 80
const rows = 24
const profile = { ...getProfile('kitty-sync'), columns, rows }
const controllerRig = createControllerRig({ width: columns, height: rows })
addUserRows(controllerRig, 1, 'controller-rig')
assert.equal(controllerRig.state().session.rowOrder.length, 1, 'controller rig must accept a v2 row')

const vt = new VirtualTerminal(profile)
const stdin = new FakeStdin()
const stdout = new FakeTerminalStream(vt, columns, rows)
const stderr = new FakeStderr()
const app = createTuiV2App({
  channel: controllerRig.channel,
  stdin,
  stdout,
  stderr,
  profile,
  mode: 'fullscreen',
  language: 'en',
  theme: 'default',
  welcomeText: 'v2-smoke-started',
  attachProcessHandlers: false,
  restartRunner: null,
  historyPersistence: null,
})

try {
  await app.start()
  await waitFor(() => app.coordinator.diagnostics().framesRendered > 0, 'first frame')
  assert.equal(app.coordinator.phase, 'active')
  assert.ok(stdout.chunks.length > 0, 'startup must write a frame to the injected stream')
  assert.equal(vt.snapshot().width, columns)
  assert.equal(vt.snapshot().height, rows)
  assert.ok(screenText(vt).includes('v2-smoke-started'), 'startup frame must reach VirtualTerminal')

  controllerRig.channel.addUserRow('v2-smoke-row')
  await waitFor(() => screenText(vt).includes('v2-smoke-row'), 'channel row frame')

  await app.stop('user-exit')
  await app.awaitStop()
  assert.equal(app.coordinator.phase, 'stopped')
  const modes = vt.snapshot().modes
  assert.equal(modes.alternateScreen, false, 'stop must restore alternate screen')
  assert.equal(modes.rawInput, false, 'stop must restore raw input')
  assert.equal(stdin.rawModes.at(-1), false, 'stop must restore stdin raw mode')
  assert.equal(stderr.writes, 0, 'smoke must not write to the injected stderr')
} finally {
  if (app.coordinator.phase !== 'stopped') {
    await app.stop('error').catch(() => undefined)
    await app.awaitStop().catch(() => undefined)
  }
  controllerRig.adapter.stop()
}

process.exitCode = 0
