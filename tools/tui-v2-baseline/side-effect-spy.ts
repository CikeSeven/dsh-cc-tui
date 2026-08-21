/**
 * Side-effect ledger for the offline baseline boundary.
 *
 * The spy is scoped: every patched process/global function is restored in a
 * finally block by `scope.close()`. It never forwards intercepted output to a
 * real stream and never records payloads.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

import type { Clock, SerializableValue } from '../../src/tui-v2/model/schema.js'
import type { SideEffectKind } from './contract.js'

export interface SideEffectLedger {
  stdoutWrites: number
  stderrWrites: number
  subscriptions: number
  timersCreated: number
  timersCleared: number
  commands: number
  sessionWrites: number
  fakeWriterWrites: number
  fakeWriterControls: number
  resets: number
  violations: string[]
}

export interface SideEffectSnapshot {
  readonly stdoutWrites: number
  readonly stderrWrites: number
  readonly subscriptions: number
  readonly timersCreated: number
  readonly timersCleared: number
  readonly commands: number
  readonly sessionWrites: number
  readonly fakeWriterWrites: number
  readonly fakeWriterControls: number
  readonly resets: number
  readonly violations: readonly string[]
}

export interface SideEffectSpy {
  readonly ledger: SideEffectLedger
  readonly snapshot: () => SideEffectSnapshot
  readonly recordSubscription: () => () => void
  readonly recordCommand: () => void
  readonly recordSessionWrite: () => void
  readonly recordFakeWriterWrite: () => void
  readonly recordFakeWriterControl: () => void
  readonly recordReset: () => void
  readonly install: () => SideEffectScope
  readonly assertNoForbiddenSideEffects: () => void
}

export interface SideEffectScope {
  readonly close: () => void
}

const FORBIDDEN: readonly SideEffectKind[] = ['stdout', 'stderr', 'subscription', 'timer', 'command', 'session-write']

function freshLedger(): SideEffectLedger {
  return {
    stdoutWrites: 0,
    stderrWrites: 0,
    subscriptions: 0,
    timersCreated: 0,
    timersCleared: 0,
    commands: 0,
    sessionWrites: 0,
    fakeWriterWrites: 0,
    fakeWriterControls: 0,
    resets: 0,
    violations: [],
  }
}

function recordViolation(ledger: SideEffectLedger, kind: SideEffectKind): void {
  if (!ledger.violations.includes(kind)) ledger.violations.push(kind)
}

function countFor(ledger: SideEffectLedger, kind: SideEffectKind): number {
  switch (kind) {
    case 'stdout': return ledger.stdoutWrites
    case 'stderr': return ledger.stderrWrites
    case 'subscription': return ledger.subscriptions
    case 'timer': return ledger.timersCreated
    case 'command': return ledger.commands
    case 'session-write': return ledger.sessionWrites
  }
}

function snapshotOf(ledger: SideEffectLedger): SideEffectSnapshot {
  return {
    stdoutWrites: ledger.stdoutWrites,
    stderrWrites: ledger.stderrWrites,
    subscriptions: ledger.subscriptions,
    timersCreated: ledger.timersCreated,
    timersCleared: ledger.timersCleared,
    commands: ledger.commands,
    sessionWrites: ledger.sessionWrites,
    fakeWriterWrites: ledger.fakeWriterWrites,
    fakeWriterControls: ledger.fakeWriterControls,
    resets: ledger.resets,
    violations: [...ledger.violations],
  }
}

/** Create a fresh, payload-free side-effect ledger. */
export function createSideEffectSpy(): SideEffectSpy {
  const ledger = freshLedger()
  let active = false

  const spy: SideEffectSpy = {
    ledger,
    snapshot: () => snapshotOf(ledger),
    recordSubscription: () => {
      ledger.subscriptions += 1
      recordViolation(ledger, 'subscription')
      return () => undefined
    },
    recordCommand: () => {
      ledger.commands += 1
      recordViolation(ledger, 'command')
    },
    recordSessionWrite: () => {
      ledger.sessionWrites += 1
      recordViolation(ledger, 'session-write')
    },
    recordFakeWriterWrite: () => { ledger.fakeWriterWrites += 1 },
    recordFakeWriterControl: () => { ledger.fakeWriterControls += 1 },
    recordReset: () => { ledger.resets += 1 },
    install: () => {
      if (active) throw new Error('side-effect spy scope is already active')
      active = true

      const stdout = process.stdout as NodeJS.WriteStream & { write: (...args: any[]) => any }
      const stderr = process.stderr as NodeJS.WriteStream & { write: (...args: any[]) => any }
      const originalStdoutWrite = stdout.write
      const originalStderrWrite = stderr.write
      const originalWriteSync = fs.writeSync
      const originalSetTimeout = globalThis.setTimeout
      const originalSetInterval = globalThis.setInterval
      const originalClearTimeout = globalThis.clearTimeout
      const originalClearInterval = globalThis.clearInterval

      stdout.write = ((..._args: any[]) => {
        ledger.stdoutWrites += 1
        recordViolation(ledger, 'stdout')
        return true
      }) as typeof stdout.write
      stderr.write = ((..._args: any[]) => {
        ledger.stderrWrites += 1
        recordViolation(ledger, 'stderr')
        return true
      }) as typeof stderr.write
      fs.writeSync = ((fd: number, data: string | NodeJS.ArrayBufferView, ...args: any[]) => {
        if (fd === 1 || fd === 2) {
          const kind: SideEffectKind = fd === 1 ? 'stdout' : 'stderr'
          if (kind === 'stdout') ledger.stdoutWrites += 1
          else ledger.stderrWrites += 1
          recordViolation(ledger, kind)
          return typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength
        }
        return (originalWriteSync as any)(fd, data, ...args)
      }) as typeof fs.writeSync
      syncBuiltinESMExports()

      // Timers are observed but never scheduled. Returning an opaque token is
      // enough for code under capture; no callback can become live work.
      globalThis.setTimeout = ((..._args: any[]) => {
        ledger.timersCreated += 1
        recordViolation(ledger, 'timer')
        return { __offlineBaselineTimer: true }
      }) as unknown as typeof setTimeout
      globalThis.setInterval = ((..._args: any[]) => {
        ledger.timersCreated += 1
        recordViolation(ledger, 'timer')
        return { __offlineBaselineTimer: true }
      }) as unknown as typeof setInterval
      globalThis.clearTimeout = ((..._args: any[]) => {
        ledger.timersCleared += 1
      }) as unknown as typeof clearTimeout
      globalThis.clearInterval = ((..._args: any[]) => {
        ledger.timersCleared += 1
      }) as unknown as typeof clearInterval

      let scopeClosed = false
      return {
        close: () => {
          if (scopeClosed) return
          scopeClosed = true
          stdout.write = originalStdoutWrite
          stderr.write = originalStderrWrite
          fs.writeSync = originalWriteSync
          syncBuiltinESMExports()
          globalThis.setTimeout = originalSetTimeout
          globalThis.setInterval = originalSetInterval
          globalThis.clearTimeout = originalClearTimeout
          globalThis.clearInterval = originalClearInterval
          active = false
        },
      }
    },
    assertNoForbiddenSideEffects: () => {
      const failures = FORBIDDEN.filter((kind) => countFor(ledger, kind) !== 0)
      if (failures.length > 0 || ledger.violations.length > 0) {
        throw new Error(`offline baseline side effects: ${[...new Set([...failures, ...ledger.violations])].join(', ')}`)
      }
    },
  }
  return spy
}

/** Deterministic clock: callbacks are recorded as forbidden, never run. */
export function createFakeClock(spy?: SideEffectSpy): Clock {
  return {
    now: () => 0,
    setTimeout: (_callback, _delayMs) => {
      spy?.ledger && (spy.ledger.timersCreated += 1)
      if (spy !== undefined) recordViolation(spy.ledger, 'timer')
      return { __offlineBaselineTimer: true }
    },
    clearTimeout: (_handle) => {
      if (spy !== undefined) spy.ledger.timersCleared += 1
    },
  }
}

/** No-op stdin object; it intentionally has no listener or raw-mode behavior. */
export function createFakeStdin(): { readonly isTTY: true; setRawMode: (_raw: boolean) => void } {
  return { isTTY: true, setRawMode: () => undefined }
}

/** Minimal adapter seam used by capture tests; every effect records in ledger. */
export function createNoopChannelAdapter(spy: SideEffectSpy): {
  subscribe: (_listener: () => void) => () => void
  command: (..._args: readonly SerializableValue[]) => void
  writeSession: (..._args: readonly SerializableValue[]) => void
} {
  return {
    subscribe: (_listener) => spy.recordSubscription(),
    command: (..._args) => spy.recordCommand(),
    writeSession: (..._args) => spy.recordSessionWrite(),
  }
}

/** Assert the explicit zero policy while allowing fake writer activity. */
export function assertZeroForbiddenSideEffects(spy: SideEffectSpy): void {
  spy.assertNoForbiddenSideEffects()
}
