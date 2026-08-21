import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

import {
  createTuiV2Coordinator,
  type CoordinatorShortcutHost,
  type CoordinatorStatusEntry,
  type CoordinatorStatusHost,
} from '../../src/tui-v2/app/coordinator.js'
import type { Clock } from '../../src/tui-v2/model/schema.js'
import { unknownConservativeDefaults, type TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js'
import { createFakeChannel } from './helpers/fake-channel.js'

class FakeStdin extends PassThrough {
  readonly isTTY = true
  readonly rawModes: boolean[] = []
  override setRawMode(raw: boolean): void { this.rawModes.push(raw) }
}

class VtStream extends Writable {
  constructor(readonly vt: VirtualTerminal) { super() }
  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.vt.write(String(chunk))
    callback()
  }
}

class RecordingStream extends Writable {
  readonly chunks: string[] = []
  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk))
    callback()
  }
}

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function screenText(vt: VirtualTerminal): string {
  const snapshot = vt.snapshot()
  return snapshot.cells.map((cell) => cell.grapheme).join('')
}

function statusHost(): CoordinatorStatusHost & {
  set(entries: readonly CoordinatorStatusEntry[]): void
  readonly unsubscribes: number
} {
  let entries: readonly CoordinatorStatusEntry[] = []
  let unsubscribes = 0
  const listeners = new Set<() => void>()
  return {
    get unsubscribes() { return unsubscribes },
    getSnapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        if (listeners.delete(listener)) unsubscribes += 1
      }
    },
    set(next) {
      entries = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function shortcutHost(): CoordinatorShortcutHost & {
  readonly calls: Array<{ input: string; key: Record<string, boolean | undefined> }>
  fail(combo: string): void
  readonly clears: number
} {
  const calls: Array<{ input: string; key: Record<string, boolean | undefined> }> = []
  let handler: ((combo: string, error: unknown) => void) | undefined
  let clears = 0
  return {
    calls,
    get clears() { return clears },
    dispatch(input, key) {
      calls.push({ input, key: { ...key } })
      return true
    },
    setErrorHandler(next) {
      handler = next
      return () => {
        if (handler === next) {
          handler = undefined
          clears += 1
        }
      }
    },
    fail(combo) { handler?.(combo, new Error('extension failed')) },
  }
}

test('production hosts: status reaches dock, unhandled shortcut dispatches, errors notify, stop releases hosts', async () => {
  const profile: TerminalProfile = { ...getProfile('kitty-sync'), columns: 100, rows: 30 }
  const stdin = new FakeStdin()
  const stdout = { columns: 100, rows: 30, isTTY: true }
  const vt = new VirtualTerminal(profile)
  const statuses = statusHost()
  const shortcuts = shortcutHost()
  const channel = createFakeChannel()
  const coordinator = createTuiV2Coordinator({
    channel,
    stdin,
    stdout,
    stream: new VtStream(vt),
    profile,
    clock,
    processHost: new EventEmitter(),
    attachProcessHandlers: false,
    statusHost: statuses,
    shortcutHost: shortcuts,
  })

  await coordinator.start()
  await waitFor(() => coordinator.diagnostics().framesRendered > 0)
  statuses.set([{ key: 'plugin:ready', text: 'extension ready' }])
  await waitFor(() => screenText(vt).includes('extension ready'))

  stdin.write('\x1bg') // canonical legacy alt+g, not a built-in binding
  await waitFor(() => shortcuts.calls.length === 1)
  assert.deepEqual(shortcuts.calls[0], { input: 'g', key: { meta: true } })

  shortcuts.fail('alt+g')
  await waitFor(() => channel.notifyLog.some((entry) => entry.text.includes('Plugin shortcut failed: alt+g')))

  await coordinator.stop('teardown')
  assert.equal(statuses.unsubscribes, 1)
  assert.equal(shortcuts.clears, 1)
  assert.equal(coordinator.phase, 'stopped')
})

test('failed-before-takeover stop emits no cleanup bytes and settles stopped', async () => {
  const profile: TerminalProfile = { ...unknownConservativeDefaults(), columns: 80, rows: 24 }
  const stdin = new FakeStdin()
  const stream = new RecordingStream()
  const coordinator = createTuiV2Coordinator({
    channel: createFakeChannel(),
    stdin,
    stdout: { columns: 80, rows: 24, isTTY: true },
    stream,
    profile,
    mode: 'fullscreen',
    clock,
    attachProcessHandlers: false,
  })

  await assert.rejects(() => coordinator.start(), (error: unknown) =>
    (error as { code?: string }).code === 'unsupported-alternate-screen')
  assert.equal(stream.chunks.join(''), '')
  assert.deepEqual(stdin.rawModes, [])
  await coordinator.stop('error')
  assert.equal(stream.chunks.join(''), '', 'stop must not invent cleanup bytes before takeover')
  assert.deepEqual(stdin.rawModes, [])
  assert.equal(coordinator.phase, 'stopped')
})
