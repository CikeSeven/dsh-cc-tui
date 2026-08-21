/**
 * WP-09a offline baseline compare harness.
 *
 * This is an executable dev-only tool. It loads a frozen V1 artifact and runs
 * the existing v2 fullscreen differential pipeline on the same versioned trace.
 * It never starts a Channel, command, timer, or real terminal writer.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'

import { computeSnapshotHash } from '../../src/tui-v2/model/projections.js'
import { validateAppEvent } from '../../src/tui-v2/model/events.js'
import { createReducer } from '../../src/tui-v2/model/reducer.js'
import { initialUiState, type UiState } from '../../src/tui-v2/model/state.js'
import type { UiSnapshot, SerializableValue } from '../../src/tui-v2/model/schema.js'
import { canonicalJson, compareGrid, gridSha256, type CanonicalGridV1, type GridDiff } from '../../src/tui-v2/testkit/canonical.js'
import { findLineWidthViolations } from '../../src/tui-v2/testkit/frame-assert.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { readTrace, type Trace } from '../../src/tui-v2/testkit/trace.js'
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js'
import { runTraceDifferential } from '../../test/tui-v2/helpers/fullscreen-harness.js'
import { createFakeTerminalWriter } from './fake-terminal-writer.js'
import { artifactRelativePath, createV1CaptureRenderer, loadAndVerifyBaselineBundle } from './capture.js'
import { sha256Hex as contractSha256Hex, validateFrozenBaselineArtifact, type FrozenCaptureArtifact, type FrozenCaptureRecord, type V1CaptureResult } from './contract.js'
import { createSideEffectSpy, type SideEffectSnapshot } from './side-effect-spy.js'

const execFileAsync = promisify(execFile)
const DEFAULT_MANIFEST = 'tools/tui-v2-baseline/manifest.json'
const DEFAULT_OUTPUT = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', 'baseline-compare.json')

export interface CompareHarnessOptions {
  readonly repoRoot?: string
  readonly manifestPath?: string
  readonly baselinePath?: string
  readonly profile?: string
  readonly traceIds?: readonly string[]
  readonly filter?: RegExp
  readonly output?: string
  /** Staged verifier mode records mismatches as review instead of failing. */
  readonly allowMismatches?: boolean
}

export interface SanitizedComparison {
  readonly grid: { readonly ok: boolean; readonly diffs?: readonly GridDiff[] }
  readonly cursor: { readonly ok: boolean; readonly expectedHash: string; readonly actualHash: string }
  readonly modes: { readonly ok: boolean; readonly expectedHash: string; readonly actualHash: string }
  readonly width: { readonly ok: boolean; readonly expected: number; readonly actual: number }
  readonly height: { readonly ok: boolean; readonly expected: number; readonly actual: number }
}

export interface CompareTraceReport {
  readonly traceId: string
  readonly profile: string
  readonly status: 'pass' | 'review' | 'fail'
  readonly v1: {
    readonly frameCount: number
    readonly width: number
    readonly height: number
    readonly gridHash: string
    readonly ansiBytesHash: string
    readonly ansiBytes: number
    readonly durationMs: number
    readonly meanFrameDurationMs: number | 'unknown'
    readonly inputLatencyMs: 'unknown'
    readonly heapBefore: number | 'unknown'
    readonly heapAfter: number | 'unknown'
    readonly heapPeak: 'unknown'
    readonly steadyHeap: 'unknown'
    readonly rssAfter: number | 'unknown'
    readonly diagnostics: readonly { readonly code: string; readonly recoverable: boolean }[]
  }
  readonly v2: {
    readonly frames: number
    readonly fullRedraws: number
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly gridHash: string
    readonly vtHash: string
    readonly ansiBytesHash: string
    readonly durationMs: number
    readonly meanFrameDurationMs: number | 'unknown'
    readonly inputLatencyMs: 'unknown'
    readonly heapBefore: number | 'unknown'
    readonly heapAfter: number | 'unknown'
    readonly heapPeak: 'unknown'
    readonly steadyHeap: 'unknown'
    readonly rssAfter: number | 'unknown'
    readonly failures: readonly { readonly scope: string; readonly frameId?: string; readonly eventIndex?: number; readonly message: string }[]
  }
  readonly comparison: SanitizedComparison
  readonly physicalWidthViolations: readonly string[]
  readonly sideEffects: SideEffectSnapshot
}

export interface CompareHarnessReport {
  readonly schemaVersion: 1
  readonly kind: 'tui-v2-baseline-compare'
  readonly status: 'pass' | 'review' | 'fail'
  readonly source: {
    readonly manifest: string
    readonly artifact: string
    readonly sourceCommit: string
    readonly sourceTreeSha256: string
    readonly artifactSha256: string
    readonly missingSourceFiles: readonly string[]
    readonly sourceMismatches: readonly string[]
  }
  readonly selected: {
    readonly profiles: readonly string[]
    readonly traces: readonly string[]
    readonly filter: string | null
  }
  readonly comparePolicy: {
    readonly gridAssertion: 'compareGrid'
    readonly mismatch: 'allow-review' | 'fail'
    readonly redactionVersion: 1
  }
  readonly traces: readonly CompareTraceReport[]
  readonly errors: readonly string[]
  readonly startedAt: string
  readonly durationMs: number
  readonly node: string
  readonly gitHead: string | null
  readonly lockfileHash: string | null
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function gitHead(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function lockfileHash(repoRoot: string): Promise<string | null> {
  try {
    return sha256Hex(await readFile(path.join(repoRoot, 'pnpm-lock.yaml')))
  } catch {
    return null
  }
}

async function writeAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temp, filePath)
}

function memoryBefore(): { heap: number | 'unknown'; rss: number | 'unknown' } {
  try {
    const usage = process.memoryUsage()
    return { heap: usage.heapUsed, rss: usage.rss }
  } catch {
    return { heap: 'unknown', rss: 'unknown' }
  }
}

function memoryAfter(before: { heap: number | 'unknown'; rss: number | 'unknown' }): {
  heapBefore: number | 'unknown'
  heapAfter: number | 'unknown'
  rssAfter: number | 'unknown'
} {
  const after = memoryBefore()
  return {
    heapBefore: before.heap,
    heapAfter: after.heap,
    rssAfter: after.rss,
  }
}

function snapshotFromState(state: UiState, revision: number): UiSnapshot {
  const rows = state.session.rowOrder.map((rowId) => state.session.rowsById[rowId]).filter((row): row is NonNullable<typeof row> => row !== undefined)
  return {
    schemaVersion: 1,
    adapterInstanceId: state.bookkeeping.adapterInstanceId || 'offline-trace',
    durableSessionId: state.session.durableSessionId || 'offline-trace-session',
    uiSessionGeneration: state.session.uiSessionGeneration || 'offline-trace-generation',
    resetEpoch: Math.max(0, state.session.resetEpoch),
    sessionEpoch: state.session.sessionEpoch || 'offline-trace-generation:0',
    revision,
    rows,
    snapshotHash: computeSnapshotHash(rows),
    status: state.dock.status as unknown as SerializableValue,
  }
}

function replaySnapshot(trace: Trace, width: number, height: number): UiSnapshot {
  const reducer = createReducer({ clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined } })
  let state = initialUiState({ width, height, profileId: String(trace.header.terminalProfile), theme: 'offline-baseline', language: 'en' })
  let revision = 0
  for (const line of trace.lines) {
    if (line.kind !== 'event') continue
    revision += 1
    state = reducer.reduce(state, validateAppEvent(line.event))
  }
  return snapshotFromState(state, revision)
}

function hashEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

function scalarComparison(expected: CanonicalGridV1, actual: CanonicalGridV1): SanitizedComparison {
  const cursorExpectedHash = sha256Hex(canonicalJson(expected.cursor))
  const cursorActualHash = sha256Hex(canonicalJson(actual.cursor))
  const modesExpectedHash = sha256Hex(canonicalJson(expected.modes))
  const modesActualHash = sha256Hex(canonicalJson(actual.modes))
  const grid = compareGrid(actual, { gridEncoding: 'readable', value: expected })
  return {
    grid: grid.ok ? { ok: true } : { ok: false, diffs: grid.diffs.slice(0, 16) },
    cursor: { ok: hashEqual(expected.cursor, actual.cursor), expectedHash: cursorExpectedHash, actualHash: cursorActualHash },
    modes: { ok: hashEqual(expected.modes, actual.modes), expectedHash: modesExpectedHash, actualHash: modesActualHash },
    width: { ok: expected.width === actual.width, expected: expected.width, actual: actual.width },
    height: { ok: expected.height === actual.height, expected: expected.height, actual: actual.height },
  }
}

function comparisonOk(comparison: SanitizedComparison): boolean {
  return comparison.grid.ok && comparison.cursor.ok && comparison.modes.ok && comparison.width.ok && comparison.height.ok
}

/**
 * Hash only stable comparison evidence. Timings, heap samples, git state and
 * absolute report paths are intentionally excluded from review decisions.
 */
export function reviewedDifferenceFingerprint(
  report: CompareTraceReport,
  artifactSha256: string,
): string {
  return sha256Hex(canonicalJson({
    schemaVersion: 1,
    artifactSha256,
    traceId: report.traceId,
    profile: report.profile,
    v1: {
      frameCount: report.v1.frameCount,
      width: report.v1.width,
      height: report.v1.height,
      gridHash: report.v1.gridHash,
      ansiBytesHash: report.v1.ansiBytesHash,
      ansiBytes: report.v1.ansiBytes,
      diagnostics: report.v1.diagnostics,
    },
    v2: {
      frames: report.v2.frames,
      fullRedraws: report.v2.fullRedraws,
      bytes: report.v2.bytes,
      width: report.v2.width,
      height: report.v2.height,
      gridHash: report.v2.gridHash,
      vtHash: report.v2.vtHash,
      ansiBytesHash: report.v2.ansiBytesHash,
      failures: report.v2.failures,
    },
    comparison: report.comparison,
    physicalWidthViolations: report.physicalWidthViolations,
    sideEffects: report.sideEffects,
  }))
}

function safeFailure(value: { scope: string; frameId?: string; eventIndex?: number; message: string }): { scope: string; frameId?: string; eventIndex?: number; message: string } {
  return {
    scope: value.scope,
    ...(value.frameId === undefined ? {} : { frameId: value.frameId }),
    ...(value.eventIndex === undefined ? {} : { eventIndex: value.eventIndex }),
    message: String(value.message).replace(/[\u0000-\u001f\u007f-\u009f]/gu, '<control>').slice(0, 240),
  }
}

function assertReportRedacted(value: unknown): void {
  const seen = new Set<object>()
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      if (/\u001b|\u009b|\u009d|Bearer\s+\S+|(?:token|secret|password|api[-_]?key)\s*[:=]\s*\S+/iu.test(item)) {
        throw new Error('compare report contains forbidden raw/control or credential-shaped text')
      }
      return
    }
    if (item === null || typeof item !== 'object') return
    if (seen.has(item)) return
    seen.add(item)
    if (Array.isArray(item)) item.forEach(visit)
    else Object.values(item as Record<string, unknown>).forEach(visit)
  }
  visit(value)
}

async function runOne(
  trace: Trace,
  artifact: FrozenCaptureArtifact,
  record: FrozenCaptureRecord,
  profileId: string,
  allowMismatches: boolean,
): Promise<CompareTraceReport> {
  const profile = { ...getProfile(profileId), columns: record.width, rows: record.height }
  const v1Memory = memoryBefore()
  const v1Start = performance.now()
  const sideEffects = createSideEffectSpy()
  const v1Terminal = new VirtualTerminal(profile)
  const v1Writer = createFakeTerminalWriter({ sideEffects })
  const renderer = createV1CaptureRenderer({ artifact, sideEffects })
  let v1Result: V1CaptureResult
  try {
    const snapshot = replaySnapshot(trace, record.width, record.height)
    v1Result = await renderer.render(snapshot, { profile, writer: v1Writer, virtualTerminal: v1Terminal, traceId: trace.header.name })
  } catch (error) {
    throw new Error(`v1 capture ${trace.header.name}: ${String((error as Error)?.message ?? error)}`)
  }
  const v1Duration = performance.now() - v1Start
  const v1MemoryAfter = memoryAfter(v1Memory)

  const v2Memory = memoryBefore()
  const v2Start = performance.now()
  const v2 = runTraceDifferential(trace, getProfile(profileId), {
    width: record.width,
    height: record.height,
    includeFinalGrids: true,
  })
  const v2Duration = performance.now() - v2Start
  const v2MemoryAfter = memoryAfter(v2Memory)
  const v2Grid = v2.finalVtGrid ?? v2.finalGrid
  if (v2Grid === undefined || v2Grid === null) throw new Error(`v2 pipeline produced no final grid for ${trace.header.name}`)
  const comparison = scalarComparison(v1Result.grid, v2Grid)
  const widthViolations = findLineWidthViolations(v2Grid).slice(0, 16)
  const hardFailure = !v2.ok || widthViolations.length > 0
  const mismatch = !comparisonOk(comparison)
  const status = hardFailure ? 'fail' : mismatch ? (allowMismatches ? 'review' : 'fail') : 'pass'
  return {
    traceId: trace.header.name,
    profile: profileId,
    status,
    v1: {
      frameCount: record.frameCount,
      width: v1Result.grid.width,
      height: v1Result.grid.height,
      gridHash: gridSha256(v1Result.grid),
      ansiBytesHash: v1Result.ansiBytesHash,
      ansiBytes: v1Writer.writes.reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0),
      durationMs: Math.round(v1Duration * 1000) / 1000,
      meanFrameDurationMs: record.frameCount > 0 ? Math.round((v1Duration / record.frameCount) * 1000) / 1000 : 'unknown',
      inputLatencyMs: 'unknown',
      ...v1MemoryAfter,
      heapPeak: 'unknown',
      steadyHeap: 'unknown',
      diagnostics: v1Result.diagnostics.map((diagnostic) => ({ code: diagnostic.code, recoverable: diagnostic.recoverable })),
    },
    v2: {
      frames: v2.frames,
      fullRedraws: v2.fullRedraws,
      bytes: v2.bytes,
      width: v2Grid.width,
      height: v2Grid.height,
      gridHash: gridSha256(v2Grid),
      vtHash: v2.vtHash,
      ansiBytesHash: v2.ansiBytesHash,
      durationMs: Math.round(v2Duration * 1000) / 1000,
      meanFrameDurationMs: v2.frames > 0 ? Math.round((v2Duration / v2.frames) * 1000) / 1000 : 'unknown',
      inputLatencyMs: 'unknown',
      ...v2MemoryAfter,
      heapPeak: 'unknown',
      steadyHeap: 'unknown',
      failures: v2.failures.slice(0, 16).map(safeFailure),
    },
    comparison,
    physicalWidthViolations: widthViolations,
    sideEffects: sideEffects.snapshot(),
  }
}

function parseTraceFilter(value: string | undefined): RegExp | undefined {
  if (value === undefined) return undefined
  try {
    return new RegExp(value)
  } catch (error) {
    throw new Error(`invalid --filter regex: ${String((error as Error)?.message ?? error)}`)
  }
}

export async function runCompareHarness(options: CompareHarnessOptions = {}): Promise<CompareHarnessReport> {
  const repoRoot = options.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const startedAt = new Date().toISOString()
  const started = performance.now()
  let artifactOverride: string | null = null
  let baselineManifest = options.manifestPath
  if (options.baselinePath !== undefined) {
    const candidate = path.resolve(repoRoot, options.baselinePath)
    const parsed = JSON.parse(await readFile(candidate, 'utf8')) as { kind?: unknown }
    if (parsed.kind === 'tui-v2-baseline-manifest') baselineManifest = candidate
    else artifactOverride = candidate
  }
  const manifestPath = path.resolve(repoRoot, baselineManifest ?? DEFAULT_MANIFEST)
  let bundle = await loadAndVerifyBaselineBundle(manifestPath, repoRoot)
  let effectiveArtifactSha256 = bundle.manifest.artifact.sha256
  if (artifactOverride !== null) {
    const bytes = await readFile(artifactOverride)
    const artifact = validateFrozenBaselineArtifact(JSON.parse(bytes.toString('utf8')))
    if (artifact.sourceCommit !== bundle.manifest.source.commit || artifact.sourceTreeSha256 !== bundle.manifest.source.treeSha256 || artifact.license.sha256 !== bundle.manifest.source.license.sha256) {
      throw new Error('explicit baseline artifact provenance does not match manifest')
    }
    effectiveArtifactSha256 = contractSha256Hex(bytes)
    bundle = { ...bundle, artifact, artifactPath: artifactOverride }
  }
  const filter = options.filter
  const requested = options.traceIds === undefined || options.traceIds.length === 0 ? null : new Set(options.traceIds)
  const selectedRecords = bundle.artifact.captures.filter((record) => {
    if (requested !== null && !requested.has(record.traceId)) return false
    return filter === undefined || filter.test(record.traceId)
  })
  if (selectedRecords.length === 0) throw new Error('compare selection contains no frozen baseline captures')
  const reports: CompareTraceReport[] = []
  const errors: string[] = []
  for (const record of selectedRecords) {
    const tracePath = path.join(repoRoot, 'fixtures', 'tui-v2', 'traces', `${record.traceId}.jsonl`)
    try {
      const trace = await readTrace(tracePath)
      const profileId = options.profile ?? record.profile
      if (profileId !== record.profile) throw new Error(`profile ${profileId} has no matching frozen capture (expected ${record.profile})`)
      reports.push(await runOne(trace, bundle.artifact, record, profileId, options.allowMismatches === true))
    } catch (error) {
      errors.push(String((error as Error)?.message ?? error).replace(/[\u0000-\u001f\u007f-\u009f]/gu, '<control>').slice(0, 300))
    }
  }
  const hasFailures = errors.length > 0 || reports.some((report) => report.status === 'fail')
  const hasReview = reports.some((report) => report.status === 'review')
  const status: CompareHarnessReport['status'] = hasFailures ? 'fail' : hasReview ? 'review' : 'pass'
  const report: CompareHarnessReport = {
    schemaVersion: 1,
    kind: 'tui-v2-baseline-compare',
    status,
    source: {
      manifest: artifactRelativePath(manifestPath, repoRoot),
      artifact: artifactRelativePath(bundle.artifactPath, repoRoot),
      sourceCommit: bundle.manifest.source.commit,
      sourceTreeSha256: bundle.manifest.source.treeSha256,
      artifactSha256: effectiveArtifactSha256,
      missingSourceFiles: bundle.missingSourceFiles,
      sourceMismatches: bundle.sourceMismatches,
    },
    selected: {
      profiles: [...new Set(selectedRecords.map((record) => options.profile ?? record.profile))],
      traces: selectedRecords.map((record) => record.traceId),
      filter: filter?.source ?? null,
    },
    comparePolicy: {
      gridAssertion: 'compareGrid',
      mismatch: options.allowMismatches === true ? 'allow-review' : 'fail',
      redactionVersion: 1,
    },
    traces: reports,
    errors,
    startedAt,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    node: process.version,
    gitHead: await gitHead(repoRoot),
    lockfileHash: await lockfileHash(repoRoot),
  }
  assertReportRedacted(report)
  if (options.output !== undefined) await writeAtomic(path.resolve(options.output), report)
  return report
}

interface CliOptions {
  manifestPath?: string
  baselinePath?: string
  profile?: string
  traceIds?: string[]
  filter?: RegExp
  output: string
  allowMismatches: boolean
  help: boolean
}

function helpText(): string {
  return [
    'Offline tui-v2 baseline compare',
    '  --profile <id>           terminal profile pinned by the frozen artifact',
    '  --trace <id[,id...]>    select frozen trace ids',
    '  --filter <regex>         filter selected trace ids',
    '  --baseline <path>        baseline artifact/manifest path (manifest is default)',
    '  --output <path>          atomic JSON report path',
    '  --allow-mismatches       report grid differences as review',
    '  --help                   show this help',
  ].join('\n')
}

function parseArgs(argv: readonly string[]): CliOptions {
  const out: CliOptions = { output: DEFAULT_OUTPUT, allowMismatches: false, help: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--help') out.help = true
    else if (arg === '--profile') out.profile = argv[++index]
    else if (arg === '--trace') out.traceIds = (argv[++index] ?? '').split(',').filter(Boolean)
    else if (arg === '--filter') out.filter = parseTraceFilter(argv[++index])
    else if (arg === '--baseline') out.baselinePath = argv[++index]
    else if (arg === '--output') out.output = argv[++index] ?? ''
    else if (arg === '--allow-mismatches') out.allowMismatches = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (out.output === '') throw new Error('--output requires a path')
  return out
}

const invokedAsMain = typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      process.stdout.write(helpText() + '\n')
      process.exitCode = 0
    } else {
      const report = await runCompareHarness({
        manifestPath: args.manifestPath,
        baselinePath: args.baselinePath,
        profile: args.profile,
        traceIds: args.traceIds,
        filter: args.filter,
        output: args.output,
        allowMismatches: args.allowMismatches,
      })
      process.exitCode = report.status === 'pass' || report.status === 'review' && args.allowMismatches ? 0 : 1
    }
  } catch {
    process.exitCode = 1
  }
}
