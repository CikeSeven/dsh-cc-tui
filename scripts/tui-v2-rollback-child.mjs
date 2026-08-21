#!/usr/bin/env node
/**
 * Deterministic failed-renderer child used only by the rollback drill.
 * It models cleanup ownership; it never starts a renderer fallback and never
 * contacts a registry.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [scenario = '', reportPath = ''] = process.argv.slice(2)
if (!reportPath || !['failed-before-takeover', 'failed-after-takeover', 'cleanup-timeout', 'stdin-close'].includes(scenario)) {
  console.error('rollback child: invalid scenario/report path')
  process.exit(2)
}

const evidence = {
  schemaVersion: 1,
  scenario,
  phase: 'starting',
  fallbackSwitchCount: 0,
  stdoutWrites: 0,
  stderrWrites: 0,
  cleanupCount: 0,
  repeatedSignals: 0,
  cleanupStarted: false,
  cleanupCompleted: false,
  cleanupDeadlineHit: false,
  modesBeforeCleanup: {
    rawInput: false,
    alternateScreen: false,
    mouse: false,
    bracketedPaste: false,
    cursorVisible: true,
  },
  modesAfterCleanup: null,
  exitCode: null,
}
let settled = false
let cleanupPromise = null
const keepAlive = setInterval(() => {}, 1000)

function writeStderr(message) {
  process.stderr.write(`${message}\n`)
  evidence.stderrWrites += 1
}

async function persist(exitCode) {
  evidence.exitCode = exitCode
  await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
}

async function cleanup(reason, deadline = false) {
  if (cleanupPromise !== null) {
    evidence.repeatedSignals += 1
    return cleanupPromise
  }
  evidence.cleanupStarted = true
  evidence.cleanupCount += 1
  evidence.phase = `cleaning:${reason}`
  evidence.cleanupDeadlineHit = deadline
  cleanupPromise = (async () => {
    // A real failed renderer would await its bounded writer/terminal barrier.
    // The fixture deliberately does not sleep beyond the process deadline.
    await new Promise(resolve => setTimeout(resolve, deadline ? 30 : 20))
    evidence.modesAfterCleanup = {
      rawInput: false,
      alternateScreen: false,
      mouse: false,
      bracketedPaste: false,
      cursorVisible: true,
    }
    evidence.cleanupCompleted = true
    evidence.phase = deadline ? 'cleanup-timeout' : 'stopped'
    const code = deadline ? 74 : 73
    await persist(code)
    settled = true
    clearInterval(keepAlive)
    process.exit(code)
  })()
  return cleanupPromise
}

function onSignal(signal) {
  if (settled) return
  void cleanup(`signal:${signal}`)
}
process.on('SIGTERM', () => onSignal('SIGTERM'))
process.on('SIGINT', () => onSignal('SIGINT'))
process.stdin.once('end', () => {
  if (!settled) void cleanup('stdin-close')
})
process.stdin.resume()

if (scenario === 'failed-after-takeover') {
  evidence.modesBeforeCleanup = {
    rawInput: true,
    alternateScreen: true,
    mouse: true,
    bracketedPaste: true,
    cursorVisible: false,
  }
  evidence.phase = 'failed-after-takeover'
  writeStderr('READY')
} else if (scenario === 'failed-before-takeover') {
  evidence.phase = 'failed-before-takeover'
  writeStderr('READY')
} else if (scenario === 'cleanup-timeout') {
  evidence.modesBeforeCleanup = {
    rawInput: true,
    alternateScreen: true,
    mouse: true,
    bracketedPaste: true,
    cursorVisible: false,
  }
  evidence.phase = 'cleanup-timeout-requested'
  writeStderr('READY')
  setTimeout(() => void cleanup('cleanup-deadline', true), 15)
} else {
  evidence.phase = 'active'
  writeStderr('READY')
  // Parent closes stdin to exercise the independent close path.
}
