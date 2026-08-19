/**
 * tui-v2 benchmark runner (WP-01): v1 renderer offline baseline fixtures.
 *
 * Entry contract (plan 10.1): must be started as
 *   node --expose-gc --import tsx/esm scripts/bench-tui-v2.ts
 * and asserts typeof global.gc === 'function' before doing anything else.
 *
 * CLI: --fixture <id[,id...]> (required), --iterations <n> (default 200),
 *      --seed <n> (default 1), --output <path>
 *      (default $RUNNER_TEMP/tui-v2/bench.json, else os.tmpdir()).
 *
 * Sampling: 100 warm-up events per fixture, then >= 200 formal samples
 * (an explicit --iterations below 200 is honored for quick smoke but marked
 * formal: false). p50/p95/p99 use nearest-rank on sorted samples. Fixtures
 * never open a real TTY: they drive the headless Chat harness from
 * test/tui-v2/helpers/harness.tsx.
 *
 * Output JSON:
 *   { schemaVersion: 1, kind: 'bench', <identity fields...>,
 *     results: [{ fixture, samples, warmup, formal, p50, p95, p99,
 *                 heapUsedBeforeGc, heapUsedAfterGc, rss, durationMs, notes,
 *                 details? }],
 *     startedAt, durationMs }
 * Identity fields: runnerId, cpuModel, cpuCores, ramBytes, containerImage,
 * os, kernel, node, npmVersion, pnpmVersion, gitDirty, gitHead,
 * lockfileSha256, commandLine, profile, fixture, seed.
 * Unmeasurable metrics are recorded as 'unknown', never fabricated.
 */

if (typeof (globalThis as any).gc !== 'function') {
  console.error(
    'bench-tui-v2 requires --expose-gc (global.gc is not a function). ' +
      'Run: node --expose-gc --import tsx/esm scripts/bench-tui-v2.ts',
  )
  process.exit(1)
}
const gc = (globalThis as any).gc as () => void

// Pin language/color before any src module import resolves startup state.
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = process.env.DSH_TUI_LANG || 'en'

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { createChatHarness, type ChatHarness } from '../test/tui-v2/helpers/harness.js'

const execFileAsync = promisify(execFile)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const lifecycleChildPath = path.join(repoRoot, 'test', 'tui-v2', 'helpers', 'lifecycle-child.tsx')

const WARMUP_EVENTS = 100
const FORMAL_MIN_SAMPLES = 200

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Deterministic PRNG (LCG) so fixture content depends only on --seed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function nearestRank(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))]
}

function percentileStats(samples: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  const round = (v: number) => Math.round(v * 1000) / 1000
  return { p50: round(nearestRank(sorted, 50)), p95: round(nearestRank(sorted, 95)), p99: round(nearestRank(sorted, 99)) }
}

async function waitForFirstFrame(harness: ChatHarness, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (harness.stdout.frames === 0 && performance.now() < deadline) {
    await sleep(10)
  }
}

async function measureHeap(): Promise<{ heapUsedBeforeGc: number; heapUsedAfterGc: number; rss: number }> {
  const heapUsedBeforeGc = process.memoryUsage().heapUsed
  gc()
  gc()
  await sleep(0)
  const after = process.memoryUsage()
  return { heapUsedBeforeGc, heapUsedAfterGc: after.heapUsed, rss: after.rss }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

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

async function fixtureChatStartup(ctx: FixtureContext): Promise<FixtureResult> {
  const t0 = performance.now()
  const samples: number[] = []
  const firstFrameMs: number[] = []

  const cycle = async (collect: boolean) => {
    let firstWriteAt: number | null = null
    const harness = await createChatHarness({
      cols: 120,
      rows: 40,
      onWrite: (w) => {
        if (firstWriteAt === null) firstWriteAt = w.at
      },
    })
    const start = performance.now()
    const instance = await harness.render()
    await waitForFirstFrame(harness)
    const firstFrame = firstWriteAt === null ? null : firstWriteAt - start
    await instance.unmount()
    const end = performance.now()
    if (collect) {
      samples.push(Math.round((end - start) * 1000) / 1000)
      if (firstFrame !== null) firstFrameMs.push(Math.round(firstFrame * 1000) / 1000)
    }
  }

  for (let i = 0; i < WARMUP_EVENTS; i++) await cycle(false)
  gc()
  for (let i = 0; i < ctx.iterations; i++) await cycle(true)

  const heap = await measureHeap()
  return {
    fixture: 'v1-chat-startup',
    samples,
    warmup: WARMUP_EVENTS,
    formal: ctx.iterations >= FORMAL_MIN_SAMPLES,
    ...percentileStats(samples),
    ...heap,
    durationMs: Math.round((performance.now() - t0) * 1000) / 1000,
    notes: 'sample = render() -> first frame commit -> unmount() cycle, ms; headless harness 120x40',
    details: {
      firstFrame: firstFrameMs.length > 0 ? percentileStats(firstFrameMs) : 'unknown',
    },
  }
}

async function fixtureStream200(ctx: FixtureContext): Promise<FixtureResult> {
  const t0 = performance.now()
  const rand = lcg(ctx.seed)
  const samples: number[] = []
  const intervals: number[] = []

  let lastWriteAt: number | null = null
  let waiter: ((at: number) => void) | null = null
  const harness = await createChatHarness({
    cols: 120,
    rows: 40,
    onWrite: (w) => {
      if (lastWriteAt !== null) intervals.push(w.at - lastWriteAt)
      lastWriteAt = w.at
      const resolve = waiter
      waiter = null
      resolve?.(w.at)
    },
  })
  harness.channel.rows.push({ id: 0, kind: 'assistant', text: '', streaming: true })
  const instance = await harness.render()
  await waitForFirstFrame(harness)

  const bumpOnce = async (collect: boolean) => {
    const row = harness.channel.rows[0]
    row.text += ` chunk-${Math.floor(rand() * 1e6).toString(36)}`
    harness.channel.responseChars = row.text.length
    const start = performance.now()
    const committed = new Promise<number>((resolve) => {
      waiter = resolve
    })
    harness.bump()
    // A bump that never commits is recorded as a timeout-length sample so a
    // wedged render path shows up in the distribution instead of hanging.
    const commitAt = await Promise.race([committed, sleep(2000).then(() => performance.now())])
    waiter = null
    if (collect) samples.push(Math.round((commitAt - start) * 1000) / 1000)
    // Let any trailing writes of the same frame land before the next bump.
    await sleep(5)
  }

  for (let i = 0; i < WARMUP_EVENTS; i++) await bumpOnce(false)
  gc()
  for (let i = 0; i < ctx.iterations; i++) await bumpOnce(true)

  await instance.unmount()
  const heap = await measureHeap()
  return {
    fixture: 'v1-stream-200',
    samples,
    warmup: WARMUP_EVENTS,
    formal: ctx.iterations >= FORMAL_MIN_SAMPLES,
    ...percentileStats(samples),
    ...heap,
    durationMs: Math.round((performance.now() - t0) * 1000) / 1000,
    notes:
      'sample = one subscribe callback -> first frame commit containing it (input->frame latency), ms; ' +
      'stream bumps are not per-token frames',
    details: {
      framesCommitted: harness.stdout.frames,
      frameIntervals: intervals.length > 0 ? percentileStats(intervals) : 'unknown',
    },
  }
}

async function fixtureCleanStop(ctx: FixtureContext): Promise<FixtureResult> {
  const t0 = performance.now()
  const samples: number[] = []
  const exitCodes: Array<number | null> = []
  const reports: unknown[] = []

  const dir = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-clean-stop-'))
  try {
    for (let run = 1; run <= 3; run++) {
      const reportPath = path.join(dir, `report-${run}.json`)
      const start = performance.now()
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx/esm', lifecycleChildPath, reportPath],
          { stdio: ['ignore', 'inherit', 'inherit'], cwd: repoRoot },
        )
        child.on('error', reject)
        child.on('close', (exitCode) => resolve(exitCode))
      })
      samples.push(Math.round((performance.now() - start) * 1000) / 1000)
      exitCodes.push(code)
      try {
        reports.push(JSON.parse(await readFile(reportPath, 'utf8')))
      } catch (error: any) {
        reports.push({ error: `report unreadable: ${String(error?.message || error)}` })
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const heap = await measureHeap()
  return {
    fixture: 'v1-clean-stop',
    samples,
    warmup: 0,
    formal: true, // fixed 3-run contract, independent of --iterations
    ...percentileStats(samples),
    ...heap,
    durationMs: Math.round((performance.now() - t0) * 1000) / 1000,
    notes: 'sample = full lifecycle-child spawn -> exit duration, ms; 3 runs, all must exit 0',
    details: { exitCodes, reports },
  }
}

const fixtures = new Map<string, (ctx: FixtureContext) => Promise<FixtureResult>>([
  ['v1-chat-startup', fixtureChatStartup],
  ['v1-stream-200', fixtureStream200],
  ['v1-clean-stop', fixtureCleanStop],
])

// ---------------------------------------------------------------------------
// identity + CLI
// ---------------------------------------------------------------------------

async function captureVersion(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd: repoRoot })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function collectIdentity(fixtureIds: string[], seed: number) {
  let gitHead: string | null = null
  let gitDirty: boolean | null = null
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    gitHead = stdout.trim() || null
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
    profile: process.env.TUI_V2_PROFILE ?? 'headless-fake-tty-120x40',
    fixture: fixtureIds.join(','),
    seed,
  }
}

function parseArgs(argv: string[]) {
  const out: { fixtures: string[]; iterations: number; seed: number; output: string | null } = {
    fixtures: [],
    iterations: FORMAL_MIN_SAMPLES,
    seed: 1,
    output: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // pnpm forwards a literal `--` separator; skip it.
    if (arg === '--') continue
    if (arg === '--fixture') {
      const value = argv[++i]
      if (!value) throw new Error('--fixture requires an id')
      out.fixtures = value.split(',').map((s) => s.trim()).filter(Boolean)
    } else if (arg === '--iterations') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value <= 0) throw new Error('--iterations requires a positive integer')
      out.iterations = value
    } else if (arg === '--seed') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value)) throw new Error('--seed requires an integer')
      out.seed = value
    } else if (arg === '--output') {
      out.output = argv[++i] ?? null
      if (!out.output) throw new Error('--output requires a path')
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (out.fixtures.length === 0) throw new Error('--fixture <id> is required')
  for (const id of out.fixtures) {
    if (!fixtures.has(id)) {
      throw new Error(`unknown fixture: ${id} (available: ${[...fixtures.keys()].join(', ')})`)
    }
  }
  return out
}

async function writeArtifactAtomic(outputPath: string, artifact: unknown): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const tmp = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  )
  await writeFile(tmp, JSON.stringify(artifact, null, 2) + '\n', 'utf8')
  await rename(tmp, outputPath)
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  const t0 = performance.now()

  let outputPath = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', 'bench.json')
  // Best-effort: honor --output even if a later unknown argument fails parsing.
  const rawArgs = process.argv.slice(2)
  const outputIndex = rawArgs.indexOf('--output')
  if (outputIndex >= 0 && rawArgs[outputIndex + 1]) {
    outputPath = path.resolve(rawArgs[outputIndex + 1])
  }
  let exitCode = 1
  let artifact: Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'bench',
    results: [],
    startedAt,
    durationMs: 0,
  }
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.output) outputPath = path.resolve(args.output)
    artifact = { ...artifact, ...(await collectIdentity(args.fixtures, args.seed)) }

    const results: FixtureResult[] = []
    for (const id of args.fixtures) {
      const run = fixtures.get(id)!
      results.push(await run({ iterations: args.iterations, seed: args.seed }))
    }
    artifact.results = results
    exitCode = 0
  } catch (error: any) {
    artifact.error = String(error?.message || error)
    console.error(`bench-tui-v2: ${artifact.error}`)
  } finally {
    artifact.durationMs = Math.round((performance.now() - t0) * 1000) / 1000
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
