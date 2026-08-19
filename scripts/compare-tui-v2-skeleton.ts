/**
 * tui-v2 WP-04 skeleton comparison report (intermediate review artifact).
 *
 * NOT the WP-09 V1CaptureRenderer contract: that work package captures v1
 * frames through a real in-process capture renderer on the production event
 * stream. This script only drives ONE scripted conversation scenario through
 * two headless rigs —
 *
 *   (a) v1: the WP-01 harness (mock channel + real Ink <Chat/> + xterm oracle)
 *   (b) v2: the walking skeleton (fake channel → adapter → reducer →
 *       base-renderer → screen planner → writer → VirtualTerminal)
 *
 * — and records frame counts, bytes written, peak heapUsed and the final grid
 * hash for each side. The numbers are a sanity/review signal ("the v2 chain
 * renders the scenario, in the same ballpark"), never a performance gate.
 *
 * Usage:
 *   node --expose-gc --import tsx/esm scripts/compare-tui-v2-skeleton.ts \
 *     -- --output docs/tui-v2/baseline/compare-skeleton.json
 *
 * --expose-gc is mandatory (heap sampling around a forced GC).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

if (typeof global.gc !== 'function') {
  console.error('compare-tui-v2-skeleton: run with --expose-gc (heap sampling requires global.gc)')
  process.exit(2)
}

// The v1 harness requires the language/color pins BEFORE its lazy src imports.
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

// ---------------------------------------------------------------------------
// shared scenario script
// ---------------------------------------------------------------------------

const SCENARIO = {
  welcome: 'welcome-to-skeleton',
  user: 'hello skeleton',
  assistantStart: 'Hello',
  assistantChunks: [', ', 'stream', ' grows', ' here'],
  toolName: 'bash',
  toolArgs: '{"cmd":"ls"}',
  toolResult: 'file-a.txt',
} as const

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (condition()) return
    if (Date.now() - start > timeoutMs) throw new Error(`deadline exceeded waiting for: ${what}`)
    await sleep(10)
  }
}

/** heapUsed sampler: returns stop() → peak. */
function sampleHeap(): () => number {
  let peak = process.memoryUsage().heapUsed
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed)
  }, 20)
  timer.unref()
  return () => {
    clearInterval(timer)
    return Math.max(peak, process.memoryUsage().heapUsed)
  }
}

// ---------------------------------------------------------------------------
// (a) v1: WP-01 harness (mock channel + real Ink Chat + xterm oracle)
// ---------------------------------------------------------------------------

async function runV1() {
  const { createChatHarness } = await import('../test/tui-v2/helpers/harness.js')
  const harness = await createChatHarness({ cols: 120, rows: 40 })
  const channel = harness.channel
  const instance = await harness.render()
  // Chat subscribes on mount; let the first frame land before mutating rows,
  // or the bumps race the subscription and the rows are never picked up.
  await waitFor(() => harness.stdout.frames > 0, 'v1 first frame')

  let rowId = 1
  let seq = 1
  /** Append a row; returns the STORED row object (with its assigned id). */
  const pushRow = (row: any): any => {
    const stored = { id: rowId++, ...row }
    channel.rows = [...channel.rows, stored]
    harness.bump()
    return stored
  }

  global.gc!()
  const heapBefore = process.memoryUsage().heapUsed
  const stopSampling = sampleHeap()
  const t0 = performance.now()

  pushRow({ kind: 'local', text: SCENARIO.welcome })
  await waitFor(() => harness.screenHas(SCENARIO.welcome), 'v1 welcome')
  pushRow({ kind: 'user', text: SCENARIO.user, seq: seq++ })
  await waitFor(() => harness.screenHas(SCENARIO.user), 'v1 user row')
  const assistant: any = pushRow({ kind: 'assistant', text: SCENARIO.assistantStart, streaming: true, seq: seq++ })
  channel.working = true
  harness.bump()
  await waitFor(() => harness.screenHas(SCENARIO.assistantStart), 'v1 assistant start')
  for (const chunk of SCENARIO.assistantChunks) {
    // Immutable row replacement: in-place text mutation races ink's
    // memoized row rendering (the old renderer's contract allows either,
    // but the harness mock is not the real channel's mutation scheduler).
    const grown = { ...assistant, text: assistant.text + chunk }
    channel.rows = channel.rows.map((row: any) => (row.id === assistant.id ? grown : row))
    Object.assign(assistant, grown)
    harness.bump()
    // translateToString(true) trims trailing blanks: match the trimmed form.
    await waitFor(() => harness.screenHas(grown.text.trimEnd()), `v1 stream ${JSON.stringify(grown.text)}`)
  }
  const settledAssistant = { ...assistant, streaming: false }
  channel.rows = channel.rows.map((row: any) => (row.id === assistant.id ? settledAssistant : row))
  channel.working = false
  harness.bump()
  const toolRow: any = pushRow({
    kind: 'tool',
    text: `Bash(ls)`,
    seq: seq++,
    tool: { callId: 'call-1', name: SCENARIO.toolName, argsText: SCENARIO.toolArgs, status: 'running', startedAt: Date.now() },
  })
  await waitFor(() => harness.screenHas('Bash'), 'v1 tool running')
  const settledTool = {
    ...toolRow,
    tool: { ...toolRow.tool, status: 'ok', resultText: SCENARIO.toolResult, durationMs: 1 },
  }
  channel.rows = channel.rows.map((row: any) => (row.id === toolRow.id ? settledTool : row))
  harness.bump()
  await waitFor(() => harness.screenHas(SCENARIO.toolResult), 'v1 tool result')

  const durationMs = performance.now() - t0
  const heapPeak = stopSampling()
  global.gc!()
  const heapAfterGc = process.memoryUsage().heapUsed

  // Grid hash from the xterm oracle's active buffer.
  const gridHash = createHash('sha256').update(harness.gridText()).digest('hex')

  const bytesWritten = harness.stdout.writes.reduce((sum, write) => sum + write.bytes, 0)
  const frames = harness.stdout.frames
  await instance.unmount()
  return { frames, bytesWritten, heapBefore, heapPeak, heapAfterGc, gridHash, durationMs }
}

// ---------------------------------------------------------------------------
// (b) v2: walking skeleton (fake channel → coordinator → VirtualTerminal)
// ---------------------------------------------------------------------------

async function runV2() {
  const { PassThrough, Writable } = await import('node:stream')
  const { createFakeChannel } = await import('../test/tui-v2/helpers/fake-channel.js')
  const { createTuiV2Coordinator } = await import('../src/tui-v2/app/coordinator.js')
  const { getProfile } = await import('../src/tui-v2/testkit/terminal-profiles.js')
  const { VirtualTerminal } = await import('../src/tui-v2/testkit/virtual-terminal.js')
  const { gridSha256 } = await import('../src/tui-v2/testkit/canonical.js')

  const profile = { ...getProfile('kitty-sync'), columns: 120, rows: 40 }
  class FakeStdin extends PassThrough {
    readonly isTTY = true
    readonly rawModes: boolean[] = []
    override setRawMode(raw: boolean): void {
      this.rawModes.push(raw)
    }
  }
  const stdin = new FakeStdin()
  const vt = new VirtualTerminal(profile)
  let bytesWritten = 0
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = String(chunk)
      bytesWritten += text.length
      vt.write(text)
      cb()
    },
  })
  const channel = createFakeChannel()
  const coordinator = createTuiV2Coordinator({
    channel,
    stdin,
    stdout: { columns: 120, rows: 40, isTTY: true },
    stream,
    profile,
    clock: { now: () => Date.now(), setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (h) => clearTimeout(h as any) },
    welcomeText: SCENARIO.welcome,
    attachProcessHandlers: false,
  })

  global.gc!()
  const heapBefore = process.memoryUsage().heapUsed
  const stopSampling = sampleHeap()
  const t0 = performance.now()

  await coordinator.start()
  const text = () => {
    const snap = vt.snapshot()
    const lines: string[] = []
    for (let y = 0; y < snap.height; y++) {
      lines.push(snap.cells.slice(y * snap.width, (y + 1) * snap.width).map((cell) => cell.grapheme).join(''))
    }
    return lines.join('\n')
  }
  await waitFor(() => text().includes(SCENARIO.welcome), 'v2 welcome')
  channel.addUserRow(SCENARIO.user)
  channel.startAssistant(SCENARIO.assistantStart)
  for (const chunk of SCENARIO.assistantChunks) {
    channel.appendAssistant(chunk)
    await sleep(40)
  }
  channel.settleAssistant()
  await waitFor(() => text().includes('stream grows here'), 'v2 stream')
  const tool = channel.addToolRow(SCENARIO.toolName, SCENARIO.toolArgs)
  await waitFor(() => text().includes(SCENARIO.toolName), 'v2 tool running')
  channel.settleTool(tool, SCENARIO.toolResult)
  await waitFor(() => text().includes(SCENARIO.toolResult), 'v2 tool result')

  const durationMs = performance.now() - t0
  const heapPeak = stopSampling()
  const gridHash = gridSha256(vt.snapshot())
  const diagnostics = coordinator.diagnostics()
  global.gc!()
  const heapAfterGc = process.memoryUsage().heapUsed

  await coordinator.stop('user-exit')
  await coordinator.awaitStop()
  return {
    frames: diagnostics.patchesWritten,
    renders: diagnostics.framesRendered,
    bytesWritten,
    heapBefore,
    heapPeak,
    heapAfterGc,
    gridHash,
    durationMs,
  }
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

async function gitHead(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function lockfileHash(): Promise<string | null> {
  try {
    const content = await readFile(path.join(repoRoot, 'pnpm-lock.yaml'))
    return createHash('sha256').update(content).digest('hex')
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  let output = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', 'compare-skeleton.json')
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (arg === '--') continue
    if (arg === '--output') {
      output = path.resolve(rawArgs[++i] ?? '')
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  const startedAt = new Date().toISOString()
  const t0 = performance.now()
  const v1 = await runV1()
  const v2 = await runV2()

  for (const [side, result] of [['v1', v1], ['v2', v2]] as const) {
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error(`${side}.${key} is not a finite number`)
      }
      if (value === '' || value === null || value === undefined) {
        throw new Error(`${side}.${key} is empty`)
      }
    }
  }

  const artifact = {
    schemaVersion: 1,
    kind: 'compare-skeleton',
    note: 'WP-04 intermediate review artifact: scripted scenario through the WP-01 v1 harness and the v2 walking skeleton. NOT the WP-09 V1CaptureRenderer contract; numbers are a sanity signal, never a gate.',
    scenario: SCENARIO,
    profile: 'headless-120x40 (v1: xterm oracle + Ink Chat; v2: kitty-sync profile + VirtualTerminal)',
    results: { v1, v2 },
    startedAt,
    durationMs: Math.round((performance.now() - t0) * 1000) / 1000,
    node: process.version,
    os: `${os.platform()} ${os.arch()}`,
    kernel: os.release(),
    gitHead: await gitHead(),
    lockfileSha256: await lockfileHash(),
  }
  await mkdir(path.dirname(output), { recursive: true })
  const tmp = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, JSON.stringify(artifact, null, 2) + '\n', 'utf8')
  await rename(tmp, output)
  console.log(`compare-skeleton artifact written to ${output}`)
  console.log(`v1: frames=${v1.frames} bytes=${v1.bytesWritten} heapPeak=${v1.heapPeak}`)
  console.log(`v2: frames=${v2.frames} bytes=${v2.bytesWritten} heapPeak=${v2.heapPeak}`)
}

const invokedAsMain =
  typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsMain) {
  await main()
}
