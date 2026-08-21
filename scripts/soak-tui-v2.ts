import { execFile } from 'node:child_process'
import { createHash, randomUUID, type Hash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createTuiV2App, type TuiV2App } from '../src/tui-v2/app/bootstrap.js'
import { gridSha256 } from '../src/tui-v2/testkit/canonical.js'
import { getProfile } from '../src/tui-v2/testkit/terminal-profiles.js'
import { VirtualTerminal } from '../src/tui-v2/testkit/virtual-terminal.js'
import { WRITER_MAX_PENDING_BYTES } from '../src/tui-v2/terminal/writer.js'
import { createFakeChannel } from '../test/tui-v2/helpers/fake-channel.js'
import {
  evaluateMemoryGate,
  percentileSummary,
  SOAK_FULL_SETTLED_EVENTS,
  SOAK_REQUIRED_WINDOWS,
  SOAK_WINDOW_SETTLED_EVENTS,
  type SoakMemoryWindow,
} from './tui-v2-soak-stats.js'

const execFileAsync = promisify(execFile)
const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = path.dirname(scriptPath)
const repoRoot = path.resolve(scriptDir, '..')

const WIDTH = 120
const HEIGHT = 40
const DEFAULT_MINUTES = 10
const DEFAULT_PROFILE = 'unknown-conservative'
const DEFAULT_SEED = 1
const FIXTURE = 'bounded-mixed-settled-v1'
const SAMPLE_LIMIT = 2_048
const WINDOW_LIMIT = 2_048
const DURATION_SETTLED_PER_SECOND = 200
const MEMORY_SETTLING_PROTOCOL = 'idle-input-turn-gc-turn-gc-v1'
// Four complete unmeasured, workload-identical windows let V8/JIT/native
// stream pages reach their steady allocation shape before the first formal
// 20k baseline window. Formal eligibility still requires a separate 100k,
// and the warm-up count is explicit in the artifact rather than hidden.
const WARMUP_SETTLED = SOAK_WINDOW_SETTLED_EVENTS * 4

interface SoakArgs {
  readonly minutes: number | null
  readonly events: number | null
  readonly profile: string
  readonly output: string
  readonly seed: number
  readonly requirePty: boolean
  readonly internalPtyChild: boolean
}

interface ResourceSnapshot {
  readonly timers: number
  readonly listeners: number
  readonly activeResources: Readonly<Record<string, number>>
  readonly frameQueue: number
  readonly pendingBytes: number
}

interface TerminalSummary {
  readonly bytes: number
  readonly writes: number
  readonly sha256: string
  readonly gridSha256: string | null
  readonly backpressureDelays: number
}

interface InputLatencyState {
  readonly samples: number[]
  total: number
  busy: number
  pending: boolean
  readonly pendingTasks: Set<Promise<void>>
}

interface RunContext {
  readonly app: TuiV2App
  readonly channel: ReturnType<typeof createFakeChannel>
  readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean }
  readonly output: FakeDuplexTerminal | ForwardingTtyStream
  readonly terminalType: 'fake-duplex' | 'real-pty'
  readonly seed: number
}

class FakeDuplexInput extends PassThrough {
  readonly isTTY = true
  readonly rawModes: boolean[] = []

  setRawMode(raw: boolean): this {
    this.rawModes.push(raw)
    return this
  }

  ref(): this { return this }
  unref(): this { return this }
}

class FakeDuplexTerminal extends Writable {
  readonly isTTY = true
  columns = WIDTH
  rows = HEIGHT
  private readonly hash: Hash = createHash('sha256')
  private digested = false
  private digest = ''
  private bytes = 0
  private writes = 0
  private delayed = 0

  constructor(readonly virtualTerminal: VirtualTerminal) {
    super({ highWaterMark: 128 })
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      this.bytes += buffer.byteLength
      this.writes += 1
      this.hash.update(buffer)
      this.virtualTerminal.write(buffer.toString('utf8'))
      if (this.writes % 19 === 0) {
        this.delayed += 1
        setTimeout(callback, 2)
      } else {
        queueMicrotask(callback)
      }
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.virtualTerminal.resize(columns, rows)
  }

  summary(): TerminalSummary {
    if (!this.digested) {
      this.digest = this.hash.digest('hex')
      this.digested = true
    }
    return {
      bytes: this.bytes,
      writes: this.writes,
      sha256: this.digest,
      gridSha256: gridSha256(this.virtualTerminal.snapshot()),
      backpressureDelays: this.delayed,
    }
  }
}

/** Forward terminal bytes to the actual PTY while retaining only count/hash. */
class ForwardingTtyStream extends Writable {
  readonly isTTY = true
  private readonly hash: Hash = createHash('sha256')
  private digested = false
  private digest = ''
  private bytes = 0
  private writes = 0

  constructor(private readonly target: NodeJS.WriteStream) {
    super({ highWaterMark: 128 })
  }

  get columns(): number { return this.target.columns ?? WIDTH }
  get rows(): number { return this.target.rows ?? HEIGHT }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      this.bytes += buffer.byteLength
      this.writes += 1
      this.hash.update(buffer)
      this.target.write(buffer, callback)
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  summary(): TerminalSummary {
    if (!this.digested) {
      this.digest = this.hash.digest('hex')
      this.digested = true
    }
    return {
      bytes: this.bytes,
      writes: this.writes,
      sha256: this.digest,
      gridSha256: null,
      backpressureDelays: 0,
    }
  }
}

class NullStderr extends Writable {
  readonly isTTY = true
  writes = 0

  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes += 1
    callback()
  }
}

function parseArgs(argv: readonly string[]): SoakArgs {
  let minutes: number | null = null
  let events: number | null = null
  let profile = DEFAULT_PROFILE
  let output = defaultOutput()
  let seed = DEFAULT_SEED
  let requirePty = false
  let internalPtyChild = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--minutes') {
      const value = Number(argv[++index])
      if (!Number.isFinite(value) || value <= 0) throw new Error('--minutes requires a positive finite number')
      minutes = value
    } else if (arg === '--events') {
      const value = Number(argv[++index])
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('--events requires a positive safe integer')
      events = value
    } else if (arg === '--profile') {
      profile = argv[++index] ?? ''
      if (profile === '') throw new Error('--profile requires an id')
    } else if (arg === '--output') {
      output = argv[++index] ?? ''
      if (output === '') throw new Error('--output requires a path')
    } else if (arg === '--seed') {
      const value = Number(argv[++index])
      if (!Number.isSafeInteger(value)) throw new Error('--seed requires a safe integer')
      seed = value
    } else if (arg === '--require-pty') {
      requirePty = true
    } else if (arg === '--internal-pty-child') {
      internalPtyChild = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (minutes !== null && events !== null) throw new Error('--minutes and --events are mutually exclusive')
  if (minutes === null && events === null) minutes = DEFAULT_MINUTES
  if (requirePty && internalPtyChild) throw new Error('--require-pty cannot be combined with --internal-pty-child')
  if (internalPtyChild) {
    if (!process.env.TUI_V2_PTY_CHILD_TOKEN || process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      throw new Error('--internal-pty-child requires an authenticated real PTY parent')
    }
  }
  getProfile(profile)
  return { minutes, events, profile, output: path.resolve(output), seed, requirePty, internalPtyChild }
}

function defaultOutput(): string {
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', 'soak.json')
}

function outputFromRawArgs(argv: readonly string[]): string {
  const index = argv.indexOf('--output')
  return path.resolve(index >= 0 && argv[index + 1] ? argv[index + 1]! : defaultOutput())
}

function lcg(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitForFrame(app: TuiV2App, before: number, timeoutMs = 5_000): Promise<number> {
  const started = performance.now()
  while (app.coordinator.diagnostics().framesRendered <= before) {
    if (performance.now() - started >= timeoutMs) throw new Error('frame commit timeout')
    await sleep(1)
  }
  return performance.now() - started
}

async function waitForIdle(app: TuiV2App, timeoutMs = 10_000): Promise<void> {
  const started = performance.now()
  for (;;) {
    const diagnostics = app.coordinator.diagnostics()
    if (
      diagnostics.scheduler.pendingFrames === 0 &&
      diagnostics.scheduler.executing === false &&
      diagnostics.writer.queueDepth === 0 &&
      diagnostics.writer.inFlight === 0
    ) return
    if (performance.now() - started >= timeoutMs) throw new Error('coordinator did not become idle')
    await sleep(2)
  }
}

/** Drain product queues and harness latency tasks, then cross one event-loop turn. */
async function settleAsyncWork(app: TuiV2App, inputState: InputLatencyState): Promise<void> {
  await waitForIdle(app)
  await Promise.allSettled([...inputState.pendingTasks])
  await immediate()
  await waitForIdle(app)
  if (inputState.pending || inputState.pendingTasks.size !== 0) {
    throw new Error('latency tasks did not settle before memory sampling')
  }
}

function pushSample(samples: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('latency sample is not finite')
  if (samples.length < SAMPLE_LIMIT) samples.push(Math.round(value * 1_000) / 1_000)
}

function activeResourceCounts(): Record<string, number> {
  const names: string[] = typeof (process as any).getActiveResourcesInfo === 'function'
    ? (process as any).getActiveResourcesInfo()
    : []
  const counts: Record<string, number> = {}
  for (const name of names.sort()) counts[name] = (counts[name] ?? 0) + 1
  return counts
}

function listenerCount(target: NodeJS.EventEmitter): number {
  return target.eventNames().reduce((sum, event) => sum + target.listenerCount(event), 0)
}

function resourceSnapshot(app: TuiV2App, stdin: NodeJS.EventEmitter, output: NodeJS.EventEmitter): ResourceSnapshot {
  const diagnostics = app.coordinator.diagnostics()
  const resources = activeResourceCounts()
  return {
    timers: (resources.Timeout ?? 0) + (resources.Immediate ?? 0),
    listeners: listenerCount(stdin) + listenerCount(output),
    activeResources: resources,
    frameQueue: diagnostics.scheduler.pendingFrames + (diagnostics.scheduler.executing ? 1 : 0),
    pendingBytes: diagnostics.writer.pendingBytes,
  }
}

async function memoryWindow(index: number): Promise<SoakMemoryWindow> {
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc !== 'function') throw new Error('global.gc is unavailable')
  const before = process.memoryUsage()
  gc()
  await immediate()
  gc()
  const after = process.memoryUsage()
  const settledStart = index * SOAK_WINDOW_SETTLED_EVENTS
  const settledEnd = settledStart + SOAK_WINDOW_SETTLED_EVENTS
  return {
    index,
    settledStart,
    settledEnd,
    midpoint: (settledStart + settledEnd) / 2,
    complete: true,
    heapUsedBeforeGc: before.heapUsed,
    heapUsedAfterGc: after.heapUsed,
    rss: after.rss,
  }
}

async function captureVersion(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd: repoRoot })
    return stdout.trim() || 'unavailable'
  } catch {
    return 'unavailable'
  }
}

async function collectIdentity(args: Pick<SoakArgs, 'profile' | 'seed'>, terminalType: string): Promise<Record<string, unknown>> {
  let gitHead = 'unavailable'
  let gitDirty: boolean | 'unavailable' = 'unavailable'
  try {
    gitHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim() || 'unavailable'
    gitDirty = (await execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot })).stdout.trim().length > 0
  } catch {
    // Keep explicit unavailable sentinels; identity fields never disappear.
  }
  let lockfileSha256 = 'unavailable'
  try {
    lockfileSha256 = createHash('sha256').update(await readFile(path.join(repoRoot, 'pnpm-lock.yaml'))).digest('hex')
  } catch {
    // Keep sentinel.
  }
  const cpus = os.cpus()
  return {
    runnerId: process.env.TUI_V2_RUNNER_ID || os.hostname() || 'unavailable',
    cpuModel: cpus[0]?.model || 'unavailable',
    cpuCores: cpus.length,
    ramBytes: os.totalmem(),
    containerImage: process.env.TUI_V2_CONTAINER_IMAGE || 'not-applicable-host',
    containerDigest: process.env.TUI_V2_CONTAINER_DIGEST || 'not-applicable-host',
    os: `${os.platform()} ${os.arch()}`,
    kernel: os.release(),
    node: process.version,
    npmVersion: await captureVersion('npm', ['--version']),
    pnpmVersion: await captureVersion('pnpm', ['--version']),
    gitDirty,
    gitHead,
    lockfileSha256,
    commandLine: [...process.argv],
    profile: args.profile,
    fixture: FIXTURE,
    seed: args.seed,
    terminalType,
  }
}

async function writeArtifactAtomic(output: string, artifact: unknown): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true })
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temporary, JSON.stringify(artifact, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, output)
}

function baseArtifact(startedAt: string): Record<string, any> {
  return {
    schemaVersion: 1,
    kind: 'tui-v2-soak',
    status: 'fail',
    reason: 'not-run',
    coverageMode: 'smoke',
    gateEligible: false,
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    runnerId: 'unavailable',
    cpuModel: 'unavailable',
    cpuCores: 0,
    ramBytes: 0,
    containerImage: 'unavailable',
    containerDigest: 'unavailable',
    os: 'unavailable',
    kernel: 'unavailable',
    node: process.version,
    npmVersion: 'unavailable',
    pnpmVersion: 'unavailable',
    gitDirty: 'unavailable',
    gitHead: 'unavailable',
    lockfileSha256: 'unavailable',
    commandLine: [...process.argv],
    profile: DEFAULT_PROFILE,
    fixture: FIXTURE,
    seed: DEFAULT_SEED,
    terminalType: 'unavailable',
    requested: null,
    settledEvents: 0,
    metrics: null,
    gates: null,
    errors: [],
  }
}

function createRig(args: SoakArgs, terminalType: 'fake-duplex' | 'real-pty'): RunContext {
  const profile = { ...getProfile(args.profile), columns: WIDTH, rows: HEIGHT }
  const channel = createFakeChannel()
  let stdin: FakeDuplexInput | NodeJS.ReadStream
  let output: FakeDuplexTerminal | ForwardingTtyStream
  let stderr: NullStderr | NodeJS.WriteStream
  if (terminalType === 'fake-duplex') {
    stdin = new FakeDuplexInput()
    output = new FakeDuplexTerminal(new VirtualTerminal(profile))
    stderr = new NullStderr()
  } else {
    stdin = process.stdin
    output = new ForwardingTtyStream(process.stdout)
    stderr = process.stderr
  }
  const app = createTuiV2App({
    channel: channel as any,
    stdin: stdin as any,
    stdout: output as unknown as NodeJS.WriteStream,
    stderr: stderr as NodeJS.WriteStream,
    profile,
    mode: 'inline',
    language: 'en',
    theme: 'default',
    welcomeText: 'tui-v2-soak',
    historyPersistence: null,
    attachProcessHandlers: terminalType === 'real-pty',
    restartRunner: null,
    trajectory: false,
  })
  return { app, channel, stdin, output, terminalType, seed: args.seed }
}

function attachInputLatency(context: RunContext, state: InputLatencyState, frameSamples: number[]): () => void {
  const onData = (): void => {
    state.total += 1
    if (state.pending || state.samples.length >= SAMPLE_LIMIT) return
    const before = context.app.coordinator.diagnostics()
    if (before.writer.inFlight > 0 || before.scheduler.executing) state.busy += 1
    state.pending = true
    const started = performance.now()
    const task = waitForFrame(context.app, before.framesRendered)
      .then(() => {
        const latency = performance.now() - started
        pushSample(state.samples, latency)
        pushSample(frameSamples, latency)
      })
      .catch(() => undefined)
      .finally(() => {
        state.pending = false
        state.pendingTasks.delete(task)
      })
    state.pendingTasks.add(task)
  }
  context.stdin.on('data', onData)
  return () => context.stdin.removeListener('data', onData)
}

async function runSoak(args: SoakArgs, terminalType: 'fake-duplex' | 'real-pty'): Promise<Record<string, any>> {
  const context = createRig(args, terminalType)
  const { app, channel } = context
  const frameSamples: number[] = []
  const streamSamples: number[] = []
  const inputState: InputLatencyState = { samples: [], total: 0, busy: 0, pending: false, pendingTasks: new Set() }
  const windows: SoakMemoryWindow[] = []
  const errors: string[] = []
  const random = lcg(args.seed)
  const requestedDurationMs = args.minutes === null ? null : args.minutes * 60_000
  const requestedEvents = args.events
  let activeStarted = 0
  let activeDurationMs = 0
  let settledEvents = 0
  let maxWriterQueueDepth = 0
  let maxWriterPendingBytes = 0
  let maxFrameQueue = 0
  let resourceBaseline: ResourceSnapshot | null = null
  let resourceFinal: ResourceSnapshot | null = null
  let resourceStopped: ResourceSnapshot | null = null
  let terminalSummary: TerminalSummary | null = null
  let detachInputLatency = (): void => undefined

  try {
    await app.start()
    await waitForFrame(app, 0)

    const inputInterval = requestedEvents === null ? 100 : Math.max(1, Math.floor(requestedEvents / 250))
    const streamInterval = requestedEvents === null ? 100 : Math.max(1, Math.floor(requestedEvents / 250))
    const resizeInterval = requestedEvents === null ? 2_000 : Math.max(10, Math.floor(requestedEvents / 40))
    const overlayInterval = requestedEvents === null ? 4_000 : Math.max(20, Math.floor(requestedEvents / 25))
    const row = channel.startAssistant('warmup')
    for (let index = 0; index < WARMUP_SETTLED; index += 1) {
      row.streaming = true
      row.text = `warmup-${index % 1_024}-${index.toString(36)}`
      channel.setWorking(true)
      if (index % streamInterval === 0) {
        channel.appendAssistant('-stream-a')
        channel.appendAssistant('-stream-b')
      } else if (index % 31 === 0) {
        channel.appendAssistant('-long-stream')
      }
      channel.settleAssistant()
      const warmed = index + 1
      if (terminalType === 'fake-duplex' && warmed % inputInterval === 0) {
        ;(context.stdin as FakeDuplexInput).write('x\x7f')
      }
      if (terminalType === 'fake-duplex' && warmed % resizeInterval === 0) {
        const narrow = (warmed / resizeInterval) % 2 === 1
        const columns = narrow ? 119 : WIDTH
        const rows = narrow ? 39 : HEIGHT
        ;(context.output as FakeDuplexTerminal).resize(columns, rows)
        app.coordinator.controllers.terminal.handleResize(columns, rows)
      }
      if (warmed % overlayInterval === 0) {
        app.coordinator.controllers.interactiveOverlays.openHelp({
          key: `soak-warmup-${warmed}`,
          title: 'Soak warmup',
          items: [{ id: 'bounded', label: 'Bounded overlay' }],
          onSelect: () => undefined,
        })
        await immediate()
        app.coordinator.controllers.interactiveOverlays.close()
      }
      if (warmed % 500 === 0) await immediate()
    }
    detachInputLatency = attachInputLatency(context, inputState, frameSamples)
    await settleAsyncWork(app, inputState)
    const gc = (globalThis as { gc?: () => void }).gc
    if (typeof gc !== 'function') throw new Error('global.gc is unavailable')
    gc()
    await immediate()
    gc()
    resourceBaseline = resourceSnapshot(app, context.stdin as NodeJS.EventEmitter, context.output)
    activeStarted = performance.now()
    const deadline = requestedDurationMs === null ? Number.POSITIVE_INFINITY : activeStarted + requestedDurationMs

    while (
      (requestedEvents === null || settledEvents < requestedEvents) &&
      (requestedDurationMs === null || performance.now() < deadline)
    ) {
      row.streaming = true
      row.text = `settled-${settledEvents % 1_024}-${Math.floor(random() * 65_536).toString(36)}`
      channel.setWorking(true)

      if (settledEvents % streamInterval === 0) {
        const beforeFrames = app.coordinator.diagnostics().framesRendered
        const sampleStarted = performance.now()
        channel.appendAssistant('-stream-a')
        channel.appendAssistant('-stream-b')
        try {
          await waitForFrame(app, beforeFrames)
          const latency = performance.now() - sampleStarted
          pushSample(streamSamples, latency)
          pushSample(frameSamples, latency)
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      } else if (settledEvents % 31 === 0) {
        channel.appendAssistant('-long-stream')
      }
      channel.settleAssistant()
      settledEvents += 1

      if (terminalType === 'fake-duplex' && settledEvents % inputInterval === 0) {
        ;(context.stdin as FakeDuplexInput).write('x\x7f')
      }
      if (terminalType === 'fake-duplex' && settledEvents % resizeInterval === 0) {
        const narrow = (settledEvents / resizeInterval) % 2 === 1
        const columns = narrow ? 119 : WIDTH
        const rows = narrow ? 39 : HEIGHT
        ;(context.output as FakeDuplexTerminal).resize(columns, rows)
        app.coordinator.controllers.terminal.handleResize(columns, rows)
      }
      if (settledEvents % overlayInterval === 0) {
        app.coordinator.controllers.interactiveOverlays.openHelp({
          key: `soak-${settledEvents}`,
          title: 'Soak help',
          items: [{ id: 'bounded', label: 'Bounded overlay' }],
          onSelect: () => undefined,
        })
        await immediate()
        app.coordinator.controllers.interactiveOverlays.close()
      }

      const diagnostics = app.coordinator.diagnostics()
      maxWriterQueueDepth = Math.max(maxWriterQueueDepth, diagnostics.writer.maxQueueDepth)
      maxWriterPendingBytes = Math.max(maxWriterPendingBytes, diagnostics.writer.maxPendingBytes)
      maxFrameQueue = Math.max(
        maxFrameQueue,
        diagnostics.scheduler.pendingFrames + (diagnostics.scheduler.executing ? 1 : 0),
      )

      if (settledEvents % SOAK_WINDOW_SETTLED_EVENTS === 0) {
        await settleAsyncWork(app, inputState)
        if (windows.length >= WINDOW_LIMIT) throw new Error(`memory window limit ${WINDOW_LIMIT} exceeded`)
        windows.push(await memoryWindow(windows.length))
      }

      if (requestedDurationMs === null) {
        if (settledEvents % 500 === 0) await immediate()
      } else if (settledEvents % 20 === 0) {
        const expectedElapsed = (settledEvents / DURATION_SETTLED_PER_SECOND) * 1_000
        const aheadBy = expectedElapsed - (performance.now() - activeStarted)
        if (aheadBy > 0) await sleep(Math.min(aheadBy, 100))
        else await immediate()
      }
    }

    activeDurationMs = performance.now() - activeStarted
    await settleAsyncWork(app, inputState)
    resourceFinal = resourceSnapshot(app, context.stdin as NodeJS.EventEmitter, context.output)
  } finally {
    detachInputLatency()
    if (app.coordinator.phase !== 'stopped') await app.stop('user-exit').catch((error) => {
      errors.push(`stop: ${error instanceof Error ? error.message : String(error)}`)
    })
    await app.awaitStop().catch((error) => {
      errors.push(`awaitStop: ${error instanceof Error ? error.message : String(error)}`)
    })
    resourceStopped = resourceSnapshot(app, context.stdin as NodeJS.EventEmitter, context.output)
    terminalSummary = context.output.summary()
  }

  const memory = evaluateMemoryGate(windows)
  const inputLatency = percentileSummary(inputState.samples)
  const streamLatency = percentileSummary(streamSamples)
  const frameLatency = percentileSummary(frameSamples)
  const durationContract = requestedDurationMs !== null && requestedDurationMs >= 10 * 60_000 && activeDurationMs >= requestedDurationMs
  const eventContract = requestedEvents !== null && requestedEvents >= SOAK_FULL_SETTLED_EVENTS && settledEvents >= requestedEvents
  const gateEligible = (durationContract || eventContract) && memory.eligible
  const coverageMode = gateEligible ? (eventContract ? 'full-events' : 'full-duration') : 'smoke'
  const queueGate = maxWriterQueueDepth <= 2 && maxWriterPendingBytes <= WRITER_MAX_PENDING_BYTES && maxFrameQueue <= 2
  const resourceGate = resourceBaseline !== null && resourceFinal !== null &&
    resourceFinal.timers <= resourceBaseline.timers && resourceFinal.listeners <= resourceBaseline.listeners
  const latencyFinite = frameLatency.p95 !== null && inputLatency.p95 !== null && inputLatency.p99 !== null && streamLatency.p95 !== null
  const latencySchema = frameLatency.p95 !== null && streamLatency.p95 !== null &&
    (inputState.total === 0 || (inputLatency.p95 !== null && inputLatency.p99 !== null))
  const latencyGate = latencyFinite && inputLatency.p95! < 16 && inputLatency.p99! < 100 && streamLatency.p95! < 33
  const fullGate = gateEligible && memory.pass && queueGate && resourceGate && latencyGate && errors.length === 0
  const smokeGate = !gateEligible && queueGate && resourceGate && latencySchema && errors.length === 0
  const status = fullGate || smokeGate ? 'pass' : 'fail'
  const reason = status === 'pass' ? null : errors[0] ?? (gateEligible ? 'gate-failed' : 'smoke-validation-failed')
  const diagnostics = app.coordinator.diagnostics()

  return {
    status,
    reason,
    coverageMode,
    gateEligible,
    requested: requestedEvents === null
      ? { mode: 'duration', minutes: args.minutes, durationMs: requestedDurationMs }
      : { mode: 'events', events: requestedEvents },
    activeDurationMs: Math.round(activeDurationMs * 1_000) / 1_000,
    warmupSettledEvents: WARMUP_SETTLED,
    settledEvents,
    partialWindowSettledEvents: settledEvents % SOAK_WINDOW_SETTLED_EVENTS,
    terminal: {
      type: terminalType,
      realPty: terminalType === 'real-pty',
      columns: WIDTH,
      rows: HEIGHT,
      summary: terminalSummary,
    },
    metrics: {
      latencyMs: { frame: frameLatency, input: inputLatency, stream: streamLatency },
      busyAtInput: {
        inputsObserved: inputState.total,
        busy: inputState.busy,
        ratio: inputState.total === 0 ? 0 : Math.round((inputState.busy / inputState.total) * 1_000_000) / 1_000_000,
      },
      writer: {
        final: diagnostics.writer,
        maxQueueDepth: maxWriterQueueDepth,
        maxPendingBytes: maxWriterPendingBytes,
        pendingBytesLimit: WRITER_MAX_PENDING_BYTES,
      },
      scheduler: { final: diagnostics.scheduler, maxFrameQueue },
      resources: { activeBaseline: resourceBaseline, activeFinal: resourceFinal, stopped: resourceStopped },
      memory: { settlingProtocol: MEMORY_SETTLING_PROTOCOL, windows, evaluation: memory },
      controller: {
        framesRendered: diagnostics.framesRendered,
        eventsApplied: diagnostics.eventsApplied,
        input: diagnostics.input,
        streaming: diagnostics.streaming,
        overlays: diagnostics.interactiveOverlays,
        resizes: diagnostics.terminal.resizes,
      },
    },
    gates: {
      fullGate,
      smokeGate,
      memory: memory.pass,
      queue: queueGate,
      resources: resourceGate,
      latency: latencyGate,
      latencySchema,
      rules: {
        inputP95Lt16Ms: inputLatency.p95 !== null && inputLatency.p95 < 16,
        inputP99Lt100Ms: inputLatency.p99 !== null && inputLatency.p99 < 100,
        streamP95Lt33Ms: streamLatency.p95 !== null && streamLatency.p95 < 33,
        writerQueueDepthLe2: maxWriterQueueDepth <= 2,
        writerPendingBytesLe8MiB: maxWriterPendingBytes <= WRITER_MAX_PENDING_BYTES,
        frameQueueLe2: maxFrameQueue <= 2,
        timerGrowthNonPositive: resourceBaseline !== null && resourceFinal !== null && resourceFinal.timers <= resourceBaseline.timers,
        listenerGrowthNonPositive: resourceBaseline !== null && resourceFinal !== null && resourceFinal.listeners <= resourceBaseline.listeners,
      },
    },
    errors,
  }
}

function ptyChildArgs(args: SoakArgs, childOutput: string): string[] {
  const out = [
    '--expose-gc',
    '--import',
    'tsx/esm',
    scriptPath,
    '--internal-pty-child',
    '--profile',
    args.profile,
    '--output',
    childOutput,
    '--seed',
    String(args.seed),
  ]
  if (args.events !== null) out.push('--events', String(args.events))
  else out.push('--minutes', String(args.minutes))
  return out
}

async function runRequiredPty(args: SoakArgs): Promise<Record<string, any>> {
  if (process.env.NODE_ENV === 'test' && process.env.TUI_V2_TEST_PTY_UNAVAILABLE === '1') {
    throw Object.assign(new Error('node-pty unavailable (test seam)'), { code: 'pty-unavailable' })
  }
  const moduleName = 'node-pty'
  let nodePty: any
  try {
    nodePty = await import(moduleName)
  } catch (error) {
    throw Object.assign(new Error(`node-pty load failed: ${error instanceof Error ? error.message : String(error)}`), { code: 'pty-unavailable' })
  }
  const spawnPty = nodePty.spawn ?? nodePty.default?.spawn
  if (typeof spawnPty !== 'function') {
    throw Object.assign(new Error('node-pty does not export spawn()'), { code: 'pty-unavailable' })
  }

  const token = randomUUID()
  const childOutput = path.join(os.tmpdir(), `tui-v2-soak-pty-child-${process.pid}-${Date.now()}.json`)
  const transportHash = createHash('sha256')
  let transportBytes = 0
  let transportChunks = 0
  let inputWrites = 0
  let resizeEvents = 0
  let terminal: any
  try {
    terminal = spawnPty(process.execPath, ptyChildArgs(args, childOutput), {
      name: 'xterm-256color',
      cols: WIDTH,
      rows: HEIGHT,
      cwd: repoRoot,
      env: { ...process.env, TUI_V2_PTY_CHILD_TOKEN: token },
    })
  } catch (error) {
    throw Object.assign(new Error(`PTY spawn failed: ${error instanceof Error ? error.message : String(error)}`), { code: 'pty-unavailable' })
  }

  terminal.onData((data: string) => {
    const bytes = Buffer.byteLength(data)
    transportBytes += bytes
    transportChunks += 1
    transportHash.update(data, 'utf8')
  })
  const inputTimer = setInterval(() => {
    if (inputWrites >= 1_000) return
    terminal.write('x\x7f')
    inputWrites += 1
  }, 100)
  const resizeTimer = setInterval(() => {
    const narrow = resizeEvents % 2 === 0
    terminal.resize(narrow ? 119 : WIDTH, narrow ? 39 : HEIGHT)
    resizeEvents += 1
  }, 500)

  const exit = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
    terminal.onExit((event: { exitCode: number; signal: number }) => resolve(event))
  })
  clearInterval(inputTimer)
  clearInterval(resizeTimer)

  let childArtifact: Record<string, any>
  try {
    childArtifact = JSON.parse(await readFile(childOutput, 'utf8'))
  } catch (error) {
    throw Object.assign(new Error(`PTY child artifact unavailable: ${error instanceof Error ? error.message : String(error)}`), { code: 'pty-unavailable' })
  } finally {
    await unlink(childOutput).catch(() => undefined)
  }
  if (exit.exitCode !== 0 || childArtifact.status !== 'pass') {
    throw Object.assign(new Error(`PTY child failed (exit=${exit.exitCode}, status=${childArtifact.status ?? 'missing'})`), {
      code: childArtifact.reason === 'pty-unavailable' ? 'pty-unavailable' : 'pty-child-failed',
      childArtifact,
    })
  }
  return {
    ...childArtifact,
    commandLine: [...process.argv],
    terminalType: 'real-pty',
    terminal: {
      ...childArtifact.terminal,
      type: 'real-pty',
      realPty: true,
      required: true,
      nodePtyVersion: '1.1.0',
      transport: {
        bytes: transportBytes,
        chunks: transportChunks,
        sha256: transportHash.digest('hex'),
        inputWrites,
        resizeEvents,
        exitCode: exit.exitCode,
        signal: exit.signal,
      },
    },
  }
}

export async function runSoakCli(argv: readonly string[]): Promise<number> {
  const overallStarted = performance.now()
  const startedAt = new Date().toISOString()
  const output = outputFromRawArgs(argv)
  let artifact = baseArtifact(startedAt)
  let exitCode = 1
  try {
    const args = parseArgs(argv)
    artifact.profile = args.profile
    artifact.seed = args.seed
    artifact.requested = args.events === null ? { mode: 'duration', minutes: args.minutes } : { mode: 'events', events: args.events }
    const terminalType = args.requirePty || args.internalPtyChild ? 'real-pty' : 'fake-duplex'
    Object.assign(artifact, await collectIdentity(args, terminalType))
    if (typeof (globalThis as { gc?: () => void }).gc !== 'function') {
      artifact.reason = 'gc-unavailable'
      artifact.errors = ['soak-tui-v2 requires --expose-gc (global.gc is not a function)']
      return 1
    }

    const result = args.requirePty
      ? await runRequiredPty(args)
      : await runSoak(args, args.internalPtyChild ? 'real-pty' : 'fake-duplex')
    artifact = { ...artifact, ...result }
    exitCode = artifact.status === 'pass' ? 0 : 1
  } catch (error: any) {
    const childArtifact = error?.childArtifact
    if (childArtifact && typeof childArtifact === 'object') artifact = { ...artifact, ...childArtifact, status: 'fail' }
    artifact.reason = error?.code === 'pty-unavailable' ? 'pty-unavailable' : error?.code ?? 'execution-failed'
    artifact.status = 'fail'
    artifact.errors = [...(Array.isArray(artifact.errors) ? artifact.errors : []), String(error?.message || error)]
    exitCode = 1
  } finally {
    artifact.startedAt = artifact.startedAt || startedAt
    artifact.endedAt = new Date().toISOString()
    artifact.durationMs = Math.round((performance.now() - overallStarted) * 1_000) / 1_000
    try {
      await writeArtifactAtomic(output, artifact)
      console.log(`tui-v2 soak artifact written to ${output} (status=${artifact.status}, coverage=${artifact.coverageMode})`)
    } catch (error) {
      console.error(`failed to write soak artifact to ${output}: ${error instanceof Error ? error.message : String(error)}`)
      exitCode = 1
    }
  }
  return exitCode
}

const invokedAsMain = typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === scriptPath
if (invokedAsMain) process.exitCode = await runSoakCli(process.argv.slice(2))
