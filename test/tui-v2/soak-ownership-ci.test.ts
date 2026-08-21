import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  evaluateMemoryGate,
  leastSquaresTrend,
  nearestRank,
  percentileSummary,
  SOAK_MEMORY_THRESHOLDS,
  SOAK_WINDOW_SETTLED_EVENTS,
  type SoakMemoryWindow,
} from '../../scripts/tui-v2-soak-stats.js'
import {
  checkCiIntegration,
  checkOwnership,
  ownershipRegistrationErrors,
  scanOwnershipSourceForTest,
} from '../../scripts/verify-tui-v2.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const soakScript = path.join(repoRoot, 'scripts', 'soak-tui-v2.ts')

function windows(heapMiB: readonly number[], rssMiB: readonly number[] = heapMiB): SoakMemoryWindow[] {
  assert.equal(heapMiB.length, rssMiB.length)
  return heapMiB.map((heap, index) => {
    const settledStart = index * SOAK_WINDOW_SETTLED_EVENTS
    const settledEnd = settledStart + SOAK_WINDOW_SETTLED_EVENTS
    return {
      index,
      settledStart,
      settledEnd,
      midpoint: (settledStart + settledEnd) / 2,
      complete: true,
      heapUsedBeforeGc: (heap + 5) * 1024 * 1024,
      heapUsedAfterGc: heap * 1024 * 1024,
      rss: rssMiB[index]! * 1024 * 1024,
    }
  })
}

function runNode(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd: repoRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

test('soak stats: nearest-rank percentiles are deterministic and reject missing/non-finite data', () => {
  assert.equal(nearestRank([4, 1, 3, 2], 95), 4)
  assert.deepEqual(percentileSummary([]), {
    samples: 0,
    p50: null,
    p95: null,
    p99: null,
    min: null,
    max: null,
  })
  assert.deepEqual(percentileSummary([4, 1, 3, 2]), {
    samples: 4,
    p50: 2,
    p95: 4,
    p99: 4,
    min: 1,
    max: 4,
  })
  assert.throws(() => nearestRank([], 95), /at least one/u)
  assert.throws(() => nearestRank([1, Number.NaN], 95), /non-finite/u)
})

test('soak stats: midpoint least-squares uses MiB/10k and constant R² is exactly zero', () => {
  const constant = leastSquaresTrend([
    { midpoint: 10_000, bytes: 10 * 1024 * 1024 },
    { midpoint: 30_000, bytes: 10 * 1024 * 1024 },
    { midpoint: 50_000, bytes: 10 * 1024 * 1024 },
  ])
  assert.deepEqual(constant, { slopeMbPer10k: 0, rSquared: 0, monotonicIncreaseRatio: 0 })

  const linear = leastSquaresTrend([
    { midpoint: 10_000, bytes: 10 * 1024 * 1024 },
    { midpoint: 30_000, bytes: 12 * 1024 * 1024 },
    { midpoint: 50_000, bytes: 14 * 1024 * 1024 },
  ])
  assert.deepEqual(linear, { slopeMbPer10k: 1, rSquared: 1, monotonicIncreaseRatio: 1 })
})

test('soak stats: five complete 20k windows pass only when every §10.1 AND rule passes', () => {
  const stable = evaluateMemoryGate(windows([100, 100, 100, 100, 100], [200, 200, 200, 200, 200]))
  assert.equal(stable.eligible, true)
  assert.equal(stable.pass, true)
  assert.equal(stable.heapTrend?.rSquared, 0)
  assert.equal(stable.rssTrend?.rSquared, 0)
  assert.equal(Object.values(stable.checks).every(Boolean), true)

  // A middle window over 1.25x must fail even though the final window recovers.
  const transientHardLimit = evaluateMemoryGate(windows([100, 130, 100, 100, 100], [200, 200, 200, 200, 200]))
  assert.equal(transientHardLimit.heapFinalToBaselineRatio, 1)
  assert.equal(transientHardLimit.heapMaxToBaselineRatio, 1.3)
  assert.equal(transientHardLimit.checks.heapRatio, false)
  assert.equal(transientHardLimit.pass, false)

  // A perfectly fitted decreasing sequence has monotonic ratio 0 but R² 1;
  // the required `monotonic < .9 AND R² < .8` therefore still fails.
  const significantTrend = evaluateMemoryGate(windows([104, 103, 102, 101, 100], [204, 203, 202, 201, 200]))
  assert.equal(significantTrend.heapTrend?.monotonicIncreaseRatio, 0)
  assert.equal(significantTrend.heapTrend?.rSquared, 1)
  assert.equal(significantTrend.checks.heapMonotonic, true)
  assert.equal(significantTrend.checks.heapRSquared, false)
  assert.equal(significantTrend.pass, false)
  assert.deepEqual(significantTrend.thresholds, SOAK_MEMORY_THRESHOLDS)
})

test('soak stats: incomplete and NaN windows fail closed', () => {
  const incomplete = evaluateMemoryGate(windows([100, 100, 100, 100]))
  assert.equal(incomplete.eligible, false)
  assert.equal(incomplete.pass, false)
  const invalid = windows([100, 100, 100, 100, 100])
  invalid[3] = { ...invalid[3]!, rss: Number.NaN }
  const result = evaluateMemoryGate(invalid)
  assert.equal(result.eligible, false)
  assert.equal(result.pass, false)
  assert.match(result.errors.join('\n'), /finite/u)
})

test('soak child: fake short duration writes a passing smoke artifact without claiming a full gate', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-soak-test-'))
  const output = path.join(directory, 'fake.json')
  const result = await runNode([
    '--expose-gc', '--import', 'tsx/esm', soakScript,
    '--minutes', '0.001', '--profile', 'unknown-conservative', '--seed', '1', '--output', output,
  ])
  assert.equal(result.code, 0)
  assert.equal(result.signal, null)
  const artifact = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(artifact.schemaVersion, 1)
  assert.equal(artifact.status, 'pass')
  assert.equal(artifact.coverageMode, 'smoke')
  assert.equal(artifact.gateEligible, false)
  assert.equal(artifact.terminal.type, 'fake-duplex')
  assert.equal(artifact.terminal.realPty, false)
  assert.equal(artifact.metrics.memory.settlingProtocol, 'idle-input-turn-gc-turn-gc-v1')
  assert.equal(artifact.metrics.memory.windows.length, 0)
  assert.equal(artifact.gates.smokeGate, true)
  assert.equal(typeof artifact.lockfileSha256, 'string')
  assert.equal('rawBytes' in artifact, false)
})

test('soak child: missing --expose-gc fails fast but still writes an artifact', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-soak-gc-test-'))
  const output = path.join(directory, 'gc.json')
  const result = await runNode([
    '--import', 'tsx/esm', soakScript,
    '--minutes', '0.001', '--output', output,
  ])
  assert.notEqual(result.code, 0)
  const artifact = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(artifact.status, 'fail')
  assert.equal(artifact.reason, 'gc-unavailable')
})

test('soak child: required PTY unavailable is non-zero and never marked skipped/fake', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-soak-pty-test-'))
  const output = path.join(directory, 'pty.json')
  const result = await runNode([
    '--expose-gc', '--import', 'tsx/esm', soakScript,
    '--minutes', '0.001', '--require-pty', '--output', output,
  ], { ...process.env, NODE_ENV: 'test', TUI_V2_TEST_PTY_UNAVAILABLE: '1' })
  assert.notEqual(result.code, 0)
  const artifact = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(artifact.status, 'fail')
  assert.equal(artifact.reason, 'pty-unavailable')
  assert.notEqual(artifact.status, 'skipped')
  assert.notEqual(artifact.terminalType, 'fake-duplex')
})

test('ownership guard: AST detects an unregistered controller stdout write', () => {
  const hits = scanOwnershipSourceForTest(
    'src/tui-v2/controllers/unregistered.ts',
    `export function bad(): void { process.stdout.write('not allowed') }`,
  )
  assert.deepEqual(hits.map(hit => hit.kind), ['stdout-write'])
  const errors = ownershipRegistrationErrors(hits, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /0 registered owners/u)
})

test('ownership gate: production graph has one writer and all structured owners match', { timeout: 30_000 }, async () => {
  const result = await checkOwnership()
  assert.equal(result.status, 'pass', JSON.stringify(result.details))
  assert.deepEqual((result.details.uniquePhysicalWriter as any).hits, [])
  assert.equal((result.details.writer as any).status, 'pass')
  assert.match(String(result.details.hitHash), /^[0-9a-f]{64}$/u)
})

test('ci-integration gate: staged mode passes and defers only exact publish to WP-09c2', { timeout: 90_000 }, async () => {
  const result = await checkCiIntegration({
    output: path.join(os.tmpdir(), 'unused-ci-integration-test.json'),
    profile: null,
    fixture: null,
    final: false,
    rollbackManifest: null,
  })
  assert.equal(result.status, 'pass', JSON.stringify(result.details))
  const publish = result.details.publish as any
  assert.equal(publish.deferred.length, 1)
  assert.equal(publish.deferred[0].deferredTo, 'WP-09c2')
  const probes = result.details.probes as any[]
  assert.deepEqual(probes.map(probe => probe.exitCode), [0, 0, 0, 0])
  assert.equal(probes.every(probe => probe.artifactStatus === 'pass' && /^[0-9a-f]{64}$/u.test(probe.artifactSha256)), true)
})

test('soak continuation merge: real-PTY segments require identity/hash continuity and exact aggregate duration', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-soak-chain-test-'))
  const segment = (runnerId: string) => ({
    schemaVersion: 1,
    kind: 'tui-v2-soak',
    status: 'pass',
    coverageMode: 'full-duration',
    gateEligible: true,
    runnerId,
    node: 'v24.1.0',
    profile: 'unknown-conservative',
    seed: 1,
    terminalType: 'real-pty',
    terminal: { type: 'real-pty', realPty: true, required: true, nodePtyVersion: '1.1.0' },
    requested: { mode: 'duration', minutes: 240 },
    activeDurationMs: 240 * 60_000,
    gates: { fullGate: true, memory: true },
    metrics: { memory: { evaluation: { eligible: true, pass: true } } },
    startedAt: '2026-08-21T00:00:00.000Z',
    endedAt: '2026-08-21T04:00:00.000Z',
  })
  const input1 = path.join(directory, 'soak-1.json')
  const input2 = path.join(directory, 'soak-2.json')
  const chain1 = path.join(directory, 'chain-1.json')
  const chain2 = path.join(directory, 'chain-2.json')
  const aggregate = path.join(directory, 'aggregate.json')
  await import('node:fs/promises').then(({ writeFile }) => Promise.all([
    writeFile(input1, JSON.stringify(segment('runner-a'))),
    writeFile(input2, JSON.stringify(segment('runner-b'))),
  ]))
  const mergeScript = path.join(repoRoot, 'scripts', 'merge-tui-v2-soak.ts')
  const first = await runNode([
    '--import', 'tsx/esm', mergeScript,
    '--mode', 'chain', '--input', input1, '--output', chain1,
    '--run-id', 'run-1', '--host', 'ubuntu-latest', '--node', '24',
    '--segment', '1', '--expected-segments', '2', '--segment-minutes', '240',
  ])
  assert.equal(first.code, 0)
  const second = await runNode([
    '--import', 'tsx/esm', mergeScript,
    '--mode', 'chain', '--input', input2, '--output', chain2,
    '--run-id', 'run-1', '--host', 'ubuntu-latest', '--node', '24',
    '--segment', '2', '--expected-segments', '2', '--segment-minutes', '240',
    '--previous', chain1,
  ])
  assert.equal(second.code, 0)
  const merged = await runNode([
    '--import', 'tsx/esm', mergeScript,
    '--mode', 'aggregate', '--directory', directory, '--output', aggregate,
    '--expected-segments', '2', '--expected-total-minutes', '480',
    '--expected-hosts', 'ubuntu-latest', '--expected-nodes', '24',
  ])
  assert.equal(merged.code, 0)
  const artifact = JSON.parse(await readFile(aggregate, 'utf8'))
  assert.equal(artifact.status, 'pass')
  assert.equal(artifact.chains.length, 1)
  assert.equal(artifact.chains[0].segments, 2)
})
