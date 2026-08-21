/**
 * tui-v2 benchmark runner (WP-09b): coordinator/frame/VirtualTerminal path.
 *
 * The benchmark is live v2 only. It does not import the legacy React harness or
 * the offline baseline tools. Every terminal write is routed to an injected
 * VirtualTerminal-backed stream; process.stdout is never used as the terminal.
 *
 * Entry contract:
 *   node --expose-gc --import tsx/esm scripts/bench-tui-v2.ts
 *
 * CLI: --fixture <id[,id...]> (optional; defaults to all v2 fixtures),
 *      --iterations <n> (default 200), --seed <n> (default 1), --output <path>
 *      (default $RUNNER_TEMP/tui-v2/bench.json, else os.tmpdir()).
 */

if (typeof (globalThis as any).gc !== 'function') {
  console.error(
    'bench-tui-v2 requires --expose-gc (global.gc is not a function). ' +
      'Run: node --expose-gc --import tsx/esm scripts/bench-tui-v2.ts',
  )
  process.exit(1)
}
const gc = (globalThis as any).gc as () => void

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = process.env.DSH_TUI_LANG || 'en'

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

import { createTuiV2App } from '../src/tui-v2/app/bootstrap.js'
import { gridSha256 } from '../src/tui-v2/testkit/canonical.js'
import { getProfile } from '../src/tui-v2/testkit/terminal-profiles.js'
import { VirtualTerminal } from '../src/tui-v2/testkit/virtual-terminal.js'
import { createFakeChannel, type FakeChannel } from '../test/tui-v2/helpers/fake-channel.js'

const execFileAsync = promisify(execFile)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

const WARMUP_EVENTS = 100
const FORMAL_MIN_SAMPLES = 200
const DEFAULT_FIXTURES = ['v2-coordinator-startup', 'v2-stream-200', 'v2-clean-stop'] as const
const WIDTH = 120
const HEIGHT = 40

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeStdin extends PassThrough {
  readonly isTTY = true
  readonly rawModes: boolean[] = []

  override setRawMode(raw: boolean): this {
    this.rawModes.push(raw)
    return this
  }

  override ref(): this { return this }
  override unref(): this { return this }
}

class VirtualTerminalStream extends Writable {
  readonly isTTY = true
  readonly chunks: string[] = []

  constructor(readonly virtualTerminal: VirtualTerminal, readonly columns: number, readonly rows: number) {
    super()
  }

  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    try {
      const text = String(chunk)
      this.chunks.push(text)
      this.virtualTerminal.write(text)
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

class NullStderr extends Writable {
  readonly isTTY = true
  writes = 0

  override _write(_chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.writes += 1
    callback()
  }
}

interface V2Rig {
  readonly app: ReturnType<typeof createTuiV2App>
  readonly channel: FakeChannel
  readonly stdin: FakeStdin
  readonly stdout: VirtualTerminalStream
  readonly stderr: NullStderr
  readonly virtualTerminal: VirtualTerminal
}

function createRig(): V2Rig {
  const profile = { ...getProfile('kitty-sync'), columns: WIDTH, rows: HEIGHT }
  const virtualTerminal = new VirtualTerminal(profile)
  const stdin = new FakeStdin()
  const stdout = new VirtualTerminalStream(virtualTerminal, WIDTH, HEIGHT)
  const stderr = new NullStderr()
  const channel = createFakeChannel()
  const app = createTuiV2App({
    channel,
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    profile,
    mode: 'fullscreen',
    language: 'en',
    theme: 'default',
    welcomeText: 'v2-benchmark',
    attachProcessHandlers: false,
    restartRunner: null,
  })
  return { app, channel, stdin, stdout, stderr, virtualTerminal }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`bench-tui-v2 timeout: ${label}`)
    await sleep(2)
  }
}

async function stopRig(rig: V2Rig): Promise<void> {
  if (rig.app.coordinator.phase !== 'stopped') {
    await rig.app.stop('user-exit').catch(() => undefined)
  }
  await rig.app.awaitStop().catch(() => undefined)
}

function screenText(virtualTerminal: VirtualTerminal): string {
  const snapshot = virtualTerminal.snapshot()
  return snapshot.cells.map((cell) => cell.grapheme).join('')
}

function lcg(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function nearestRank(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return NaN
  const rank = Math.ceil((percentile / 100) * sorted.length)
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))]!
}

function percentileStats(samples: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  const round = (value: number) => Math.round(value * 1000) / 1000
  return {
    p50: round(nearestRank(sorted, 50)),
    p95: round(nearestRank(sorted, 95)),
    p99: round(nearestRank(sorted, 99)),
  }
}

async function measureHeap(): Promise<{ heapUsedBeforeGc: number; heapUsedAfterGc: number; rss: number }> {
  const heapUsedBeforeGc = process.memoryUsage().heapUsed
  gc()
  gc()
  await sleep(0)
  const memory = process.memoryUsage()
  return { heapUsedBeforeGc, heapUsedAfterGc: memory.heapUsed, rss: memory.rss }
}

interface FixtureResult {
  fixture: string
  samples: number[]
  warmup: number
  formal: boolean
  p50: number
  p95: number
  p99: number
  heapUsedBeforeGc: number | 'unknown'
  heapUsedAfterGc: number | 'unknown'
  rss: number | 'unknown'
  durationMs: number
  notes: string
  details?: Record<string, unknown>
}

interface FixtureContext {
  iterations: number
  seed: number
}

async function runStartupCycle(): Promise<{
  durationMs: number
  frames: number
  bytes: number
  gridHash: string
  modesRestored: boolean
}> {
  const rig = createRig()
  const started = performance.now()
  try {
    await rig.app.start()
    await waitFor(() => rig.app.coordinator.diagnostics().framesRendered > 0, 'coordinator first frame')
    const diagnostics = rig.app.coordinator.diagnostics()
    const snapshot = rig.virtualTerminal.snapshot()
    const bytes = rig.stdout.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0)
    await stopRig(rig)
    const modes = rig.virtualTerminal.snapshot().modes
    return {
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      frames: diagnostics.framesRendered,
      bytes,
      gridHash: gridSha256(snapshot),
      modesRestored: modes.alternateScreen === false && modes.rawInput === false,
    }
  } finally {
    await stopRig(rig)
  }
}

async function fixtureCoordinatorStartup(ctx: FixtureContext): Promise<FixtureResult> {
  const started = performance.now()
  const samples: number[] = []
  const grids: string[] = []
  let frames = 0
  let bytes = 0
  let restored = true

  for (let index = 0; index < WARMUP_EVENTS; index += 1) await runStartupCycle()
  gc()
  for (let index = 0; index < ctx.iterations; index += 1) {
    const result = await runStartupCycle()
    samples.push(result.durationMs)
    grids.push(result.gridHash)
    frames += result.frames
    bytes += result.bytes
    restored = restored && result.modesRestored
  }

  const heap = await measureHeap()
  return {
    fixture: 'v2-coordinator-startup',
    samples,
    warmup: WARMUP_EVENTS,
    formal: ctx.iterations >= FORMAL_MIN_SAMPLES,
    ...percentileStats(samples),
    ...heap,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    notes: 'sample = createTuiV2App.start() -> first coordinator frame -> stop(), ms; kitty-sync 120x40 VirtualTerminal',
    details: { frames, bytes, uniqueGridHashes: new Set(grids).size, modesRestored: restored },
  }
}

async function fixtureStream200(ctx: FixtureContext): Promise<FixtureResult> {
  const started = performance.now()
  const samples: number[] = []
  const rand = lcg(ctx.seed)
  const intervals: number[] = []
  const rig = createRig()
  let previousFrameAt: number | null = null

  try {
    await rig.app.start()
    await waitFor(() => rig.app.coordinator.diagnostics().framesRendered > 0, 'stream fixture first frame')
    rig.channel.startAssistant('stream')

    const bump = async (collect: boolean): Promise<void> => {
      const beforeFrames = rig.app.coordinator.diagnostics().framesRendered
      const startedAt = performance.now()
      rig.channel.appendAssistant(`-${Math.floor(rand() * 1_000_000).toString(36)}`)
      await waitFor(() => rig.app.coordinator.diagnostics().framesRendered > beforeFrames, 'stream frame')
      const committedAt = performance.now()
      if (previousFrameAt !== null) intervals.push(committedAt - previousFrameAt)
      previousFrameAt = committedAt
      if (collect) samples.push(Math.round((committedAt - startedAt) * 1000) / 1000)
    }

    for (let index = 0; index < WARMUP_EVENTS; index += 1) await bump(false)
    gc()
    for (let index = 0; index < ctx.iterations; index += 1) await bump(true)
    rig.channel.settleAssistant()
    await sleep(20)

    const heap = await measureHeap()
    const diagnostics = rig.app.coordinator.diagnostics()
    return {
      fixture: 'v2-stream-200',
      samples,
      warmup: WARMUP_EVENTS,
      formal: ctx.iterations >= FORMAL_MIN_SAMPLES,
      ...percentileStats(samples),
      ...heap,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      notes: 'sample = v2 channel stream bump -> coordinator frame commit latency, ms; updates are merged by the streaming controller',
      details: {
        framesRendered: diagnostics.framesRendered,
        patchesWritten: diagnostics.patchesWritten,
        bytesWritten: rig.stdout.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0),
        frameIntervals: intervals.length > 0 ? percentileStats(intervals) : 'unknown',
        finalScreenHash: gridSha256(rig.virtualTerminal.snapshot()),
        streamVisible: screenText(rig.virtualTerminal).includes('stream'),
      },
    }
  } finally {
    await stopRig(rig)
  }
}

async function fixtureCleanStop(ctx: FixtureContext): Promise<FixtureResult> {
  const started = performance.now()
  const samples: number[] = []
  const reports: Array<Record<string, unknown>> = []

  for (let run = 1; run <= 3; run += 1) {
    const cycle = await runStartupCycle()
    samples.push(cycle.durationMs)
    reports.push({ run, frames: cycle.frames, bytes: cycle.bytes, gridHash: cycle.gridHash, modesRestored: cycle.modesRestored })
  }
  const heap = await measureHeap()
  return {
    fixture: 'v2-clean-stop',
    samples,
    warmup: 0,
    formal: true,
    ...percentileStats(samples),
    ...heap,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    notes: 'sample = v2 coordinator start -> first frame -> stop lifecycle duration, ms; three in-process runs',
    details: { runs: reports, requestedIterations: ctx.iterations },
  }
}

const fixtures = new Map<string, (ctx: FixtureContext) => Promise<FixtureResult>>([
  ['v2-coordinator-startup', fixtureCoordinatorStartup],
  ['v2-stream-200', fixtureStream200],
  ['v2-clean-stop', fixtureCleanStop],
])

async function captureVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd: repoRoot })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function collectIdentity(fixtureIds: string[], seed: number): Promise<Record<string, unknown>> {
  let gitHead: string | null = null
  let gitDirty: boolean | null = null
  try {
    const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    gitHead = head.stdout.trim() || null
    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot })
    gitDirty = status.stdout.trim().length > 0
  } catch {
    gitDirty = null
  }
  let lockfileSha256: string | null = null
  try {
    lockfileSha256 = createHash('sha256')
      .update(await readFile(path.join(repoRoot, 'pnpm-lock.yaml')))
      .digest('hex')
  } catch {
    lockfileSha256 = null
  }
  const cpus = os.cpus()
  return {
    runnerId: process.env.TUI_V2_RUNNER_ID || os.hostname(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCores: cpus.length,
    ramBytes: os.totalmem(),
    containerImage: process.env.TUI_V2_CONTAINER_IMAGE ?? null,
    os: `${os.platform()} ${os.arch()}`,
    kernel: os.release(),
    node: process.version,
    npmVersion: await captureVersion('npm', ['--version']),
    pnpmVersion: await captureVersion('pnpm', ['--version']),
    gitDirty,
    gitHead,
    lockfileSha256,
    commandLine: process.argv,
    profile: 'kitty-sync-120x40-virtual-terminal',
    fixture: fixtureIds.join(','),
    seed,
    runtime: 'tui-v2-coordinator',
  }
}

function parseArgs(argv: string[]): { fixtures: string[]; iterations: number; seed: number; output: string | null } {
  const out = {
    fixtures: [...DEFAULT_FIXTURES],
    iterations: FORMAL_MIN_SAMPLES,
    seed: 1,
    output: null as string | null,
  }
  let fixtureSpecified = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--fixture') {
      const value = argv[++index]
      if (!value) throw new Error('--fixture requires an id')
      out.fixtures = value.split(',').map((item) => item.trim()).filter(Boolean)
      fixtureSpecified = true
    } else if (arg === '--iterations') {
      const value = Number(argv[++index])
      if (!Number.isInteger(value) || value <= 0) throw new Error('--iterations requires a positive integer')
      out.iterations = value
    } else if (arg === '--seed') {
      const value = Number(argv[++index])
      if (!Number.isInteger(value)) throw new Error('--seed requires an integer')
      out.seed = value
    } else if (arg === '--output') {
      out.output = argv[++index] ?? null
      if (!out.output) throw new Error('--output requires a path')
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (fixtureSpecified && out.fixtures.length === 0) throw new Error('--fixture requires at least one id')
  for (const id of out.fixtures) {
    if (!fixtures.has(id)) throw new Error(`unknown fixture: ${id} (available: ${[...fixtures.keys()].join(', ')})`)
  }
  return out
}

async function writeArtifactAtomic(outputPath: string, artifact: unknown): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const temp = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temp, JSON.stringify(artifact, null, 2) + '\n', 'utf8')
  await rename(temp, outputPath)
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  let outputPath = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', 'bench.json')
  const rawArgs = process.argv.slice(2)
  const outputIndex = rawArgs.indexOf('--output')
  if (outputIndex >= 0 && rawArgs[outputIndex + 1]) outputPath = path.resolve(rawArgs[outputIndex + 1]!)

  let exitCode = 1
  let artifact: Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'bench',
    runtime: 'tui-v2-coordinator',
    results: [],
    startedAt,
    durationMs: 0,
  }
  try {
    const args = parseArgs(rawArgs)
    if (args.output !== null) outputPath = path.resolve(args.output)
    artifact = { ...artifact, ...(await collectIdentity(args.fixtures, args.seed)) }
    const results: FixtureResult[] = []
    for (const id of args.fixtures) results.push(await fixtures.get(id)!({ iterations: args.iterations, seed: args.seed }))
    artifact.results = results
    exitCode = 0
  } catch (error: any) {
    artifact.error = String(error?.message || error)
    console.error(`bench-tui-v2: ${artifact.error}`)
  } finally {
    artifact.durationMs = Math.round((performance.now() - started) * 1000) / 1000
    try {
      await writeArtifactAtomic(outputPath, artifact)
      console.log(`tui-v2 bench artifact written to ${outputPath}`)
    } catch (error: any) {
      console.error(`failed to write artifact to ${outputPath}: ${String(error?.message || error)}`)
      exitCode = 1
    }
    process.exitCode = exitCode
  }
}

await main()
