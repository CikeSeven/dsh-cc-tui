/**
 * tui-v2 lifecycle smoke (WP-09b).
 *
 * Repeats the real v2 bootstrap/coordinator against fake stdin/streams and a
 * VirtualTerminal. The deleted React lifecycle child is intentionally not
 * recreated: startup, frame commit, input, stop, and terminal restoration are
 * all exercised through the production v2 seam in-process.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'

import { createTuiV2App } from '../../src/tui-v2/app/bootstrap.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js'
import { createFakeChannel } from './helpers/fake-channel.js'

class FakeStdin extends PassThrough {
  readonly isTTY = true
  readonly rawModes: boolean[] = []

  override setRawMode(raw: boolean): void {
    this.rawModes.push(raw)
  }
}

class VirtualTerminalStream extends Writable {
  readonly isTTY = true

  constructor(readonly virtualTerminal: VirtualTerminal, readonly columns: number, readonly rows: number) {
    super()
  }

  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    try {
      this.virtualTerminal.write(String(chunk))
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

class FakeStderr extends Writable {
  readonly isTTY = true
  writes = 0

  override _write(_chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.writes += 1
    callback()
  }
}

function screenText(virtualTerminal: VirtualTerminal): string {
  return virtualTerminal.snapshot().cells.map((cell) => cell.grapheme).join('')
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 6000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`lifecycle smoke timeout: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function runOnce(run: number): Promise<void> {
  const columns = 80
  const rows = 24
  const profile = { ...getProfile('kitty-sync'), columns, rows }
  const virtualTerminal = new VirtualTerminal(profile)
  const stdin = new FakeStdin()
  const stdout = new VirtualTerminalStream(virtualTerminal, columns, rows)
  const stderr = new FakeStderr()
  const channel = createFakeChannel()
  channel.addUserRow(`v2 lifecycle user ${run}`)
  const app = createTuiV2App({
    channel,
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    profile,
    mode: 'fullscreen',
    language: 'en',
    theme: 'default',
    attachProcessHandlers: false,
    restartRunner: null,
  })

  await app.start()
  await waitFor(() => app.coordinator.diagnostics().framesRendered > 0, `run ${run} first frame`)
  await waitFor(() => screenText(virtualTerminal).includes(`v2 lifecycle user ${run}`), `run ${run} user row`)
  stdin.write('v2 input')
  await waitFor(() => screenText(virtualTerminal).includes('v2 input'), `run ${run} typed input`)

  await app.stop('user-exit')
  await app.awaitStop()
  assert.equal(app.coordinator.phase, 'stopped', `run ${run}: coordinator stopped`)
  assert.equal(stderr.writes, 0, `run ${run}: no injected stderr writes`)
  assert.equal(stdin.rawModes.at(-1), false, `run ${run}: raw mode restored`)
  const modes = virtualTerminal.snapshot().modes
  assert.equal(modes.alternateScreen, false, `run ${run}: alternate screen restored`)
  assert.equal(modes.rawInput, false, `run ${run}: raw input restored`)
}

test('tui-v2 lifecycle: bootstrap renders, accepts input, and stops cleanly across repeated runs', async () => {
  for (let run = 1; run <= 3; run += 1) await runOnce(run)
})
