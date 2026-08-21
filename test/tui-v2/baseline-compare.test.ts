/**
 * WP-09a offline baseline/compare/v2-only contract tests.
 *
 * These tests deliberately exercise the independent offline-tools boundary.
 * They never compare cell arrays outside `compareGrid`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareGrid, gridSha256 } from '../../src/tui-v2/testkit/canonical.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js'
import { createFakeTerminalWriter } from '../../tools/tui-v2-baseline/fake-terminal-writer.js'
import {
  createV1CaptureRenderer,
  loadAndVerifyBaselineBundle,
} from '../../tools/tui-v2-baseline/capture.js'
import { loadFrozenBaselineArtifact } from '../../tools/tui-v2-baseline/capture.js'
import { createSideEffectSpy, assertZeroForbiddenSideEffects } from '../../tools/tui-v2-baseline/side-effect-spy.js'
import { runCompareHarness } from '../../tools/tui-v2-baseline/compare-harness.js'
import { checkRollbackManifest, checkV2Only } from '../../scripts/verify-tui-v2.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const artifactPath = path.join(repoRoot, 'tools', 'tui-v2-baseline', 'artifacts', 'v1-capture@v1.json')
const manifestPath = path.join(repoRoot, 'tools', 'tui-v2-baseline', 'manifest.json')

function snapshotFor(hash: string, width: number, height: number) {
  return {
    schemaVersion: 1 as const,
    adapterInstanceId: 'offline-test',
    durableSessionId: 'offline-test-session',
    uiSessionGeneration: 'offline-test-generation',
    resetEpoch: 0,
    sessionEpoch: 'offline-test-generation:0',
    revision: 0,
    rows: [],
    snapshotHash: hash,
    status: { width, height },
  }
}

test('baseline writer spy: only fake writer operations are observable', () => {
  const spy = createSideEffectSpy()
  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write
  const scope = spy.install()
  try {
    const writer = createFakeTerminalWriter({ sideEffects: spy })
    writer.write('offline bytes')
    assert.equal(spy.snapshot().stdoutWrites, 0)
    assert.equal(spy.snapshot().stderrWrites, 0)
    assert.equal(writer.writes.length, 1)
    assertZeroForbiddenSideEffects(spy)
  } finally {
    scope.close()
  }
  assert.equal(process.stdout.write, originalStdout)
  assert.equal(process.stderr.write, originalStderr)
})

test('baseline side-effect spy: emergency fs.writeSync output is blocked and counted', () => {
  const spy = createSideEffectSpy()
  const scope = spy.install()
  try {
    assert.equal(writeSync(1, 'blocked-offline-output'), Buffer.byteLength('blocked-offline-output'))
    assert.equal(spy.snapshot().stdoutWrites, 1)
    assert.throws(() => assertZeroForbiddenSideEffects(spy), /stdout/)
  } finally {
    scope.close()
  }
})

test('baseline forbidden side effects: subscriptions, timers, commands and session writes fail closed', () => {
  const spy = createSideEffectSpy()
  spy.recordSubscription()
  spy.recordCommand()
  spy.recordSessionWrite()
  spy.ledger.timersCreated += 1
  assert.throws(() => assertZeroForbiddenSideEffects(spy), /subscription|command|session-write|timer/)
  assert.deepEqual([...spy.snapshot().violations].sort(), ['command', 'session-write', 'subscription'])
})

test('baseline capture: frozen artifact replays through fake writer and canonical comparison', async () => {
  const artifact = await loadFrozenBaselineArtifact(artifactPath)
  const record = artifact.captures[0]
  assert.ok(record)
  const profile = { ...getProfile(record.profile), columns: record.width, rows: record.height }
  const spy = createSideEffectSpy()
  const vt = new VirtualTerminal(profile)
  const writer = createFakeTerminalWriter({ sideEffects: spy })
  const renderer = createV1CaptureRenderer({ artifact, sideEffects: spy })
  const result = await renderer.render(snapshotFor(record.snapshotHash, record.width, record.height), {
    profile,
    writer,
    virtualTerminal: vt,
    traceId: record.traceId,
  })
  assert.equal(result.ansiBytesHash, record.ansiBytesHash)
  assert.deepEqual(compareGrid(result.grid, { gridEncoding: 'readable', value: record.grid }), { ok: true })
  assert.equal(gridSha256(result.grid), gridSha256(record.grid))
  assert.equal(spy.snapshot().subscriptions, 0)
  assert.equal(spy.snapshot().timersCreated, 0)
  assert.equal(spy.snapshot().commands, 0)
  assert.equal(spy.snapshot().sessionWrites, 0)
})

test('compare report: same trace emits hashes, frame/bytes/memory metrics and no raw ANSI', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-baseline-test-'))
  const output = path.join(dir, 'compare.json')
  const report = await runCompareHarness({ repoRoot, traceIds: ['user-submit'], allowMismatches: true, output })
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.comparePolicy.gridAssertion, 'compareGrid')
  assert.equal(report.traces.length, 1)
  assert.equal(report.traces[0]?.sideEffects.stdoutWrites, 0)
  assert.equal(report.traces[0]?.sideEffects.stderrWrites, 0)
  assert.ok(report.traces[0]?.v1.ansiBytesHash.match(/^[0-9a-f]{64}$/u))
  assert.ok(report.traces[0]?.v2.ansiBytesHash.match(/^[0-9a-f]{64}$/u))
  assert.equal(report.traces[0]?.v1.inputLatencyMs, 'unknown')
  assert.equal(report.traces[0]?.v2.inputLatencyMs, 'unknown')
  assert.equal(report.traces[0]?.v1.heapPeak, 'unknown')
  assert.equal(report.traces[0]?.v2.steadyHeap, 'unknown')
  const raw = await readFile(output, 'utf8')
  assert.equal(/\x1b|\u001b|\u009b|\u009d/u.test(raw), false)
  assert.equal(raw.includes('DeepSeek Harness'), false)
})

test('v2-only gate: legacy scan is clean and only WP-09c2 remains deferred', async () => {
  const staged = await checkV2Only({ output: path.join(os.tmpdir(), 'v2-only-staged-test.json'), profile: null, fixture: null, final: false, rollbackManifest: null })
  assert.equal(staged.status, 'pass')
  const stagedDeferred = (staged.details.deferred as { deferredTo: string }[])
  assert.deepEqual(stagedDeferred, [{ reason: 'no immutable rollback-manifest.json supplied in this work package', deferredTo: 'WP-09c2' }])
  const stagedLegacy = staged.details.legacyScan as { counts: { sourcePaths: number; switches: number; jsx: number; direct: number } }
  assert.deepEqual(stagedLegacy.counts, { sourcePaths: 0, switches: 0, jsx: 0, direct: 0 })

  const final = await checkV2Only({ output: path.join(os.tmpdir(), 'v2-only-final-test.json'), profile: null, fixture: null, final: true, rollbackManifest: null })
  assert.equal(final.status, 'fail')
  assert.ok((final.details.errors as string[]).some((error) => error.includes('WP-09c2')))
  assert.equal((final.details.errors as string[]).some((error) => error.includes('WP-09b')), false)
})

test('v2-only rollback preflight: exact local tarball and manifest hash are enforced', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-rollback-test-'))
  const tarball = Buffer.from('offline-rollback-tarball', 'utf8')
  const tarballName = 'dsh-tui-0.8.1.tgz'
  await writeFile(path.join(dir, tarballName), tarball)
  const manifestPath = path.join(dir, 'rollback-manifest.json')
  const manifest = {
    schemaVersion: 1,
    registry: 'https://registry.example.invalid',
    package: '@deepseek-harness-tui/dsh-tui',
    version: '0.8.1',
    tarball: tarballName,
    sha256: createHash('sha256').update(tarball).digest('hex'),
    signature: { algorithm: 'sigstore', ref: 'sha256:immutable-signature' },
    sessionSchema: { min: 1, max: 1 },
    launcher: { command: 'dsh-tui-rollback', args: ['--package', tarballName], timeoutMs: 30_000, retries: 2 },
    retention: { keepStableVersions: 1, expiresAt: '2027-01-01T00:00:00Z' },
  }
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
  const verified = await checkRollbackManifest(manifestPath)
  assert.deepEqual(verified.errors, [])
  assert.deepEqual(verified.deferred, [])
  assert.equal(verified.details.tarballStatus, 'verified')

  await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }), 'utf8')
  const tampered = await checkRollbackManifest(manifestPath)
  assert.ok(tampered.errors.some((error) => error.includes('sha256 does not match')))
})

test('runtime boundary: missing retired sources do not weaken artifact provenance', async () => {
  const bundle = await loadAndVerifyBaselineBundle(manifestPath, repoRoot)
  assert.equal(bundle.manifest.captureBackend, 'frozen-artifact')
  assert.equal(bundle.artifact.sourceCommit, bundle.manifest.source.commit)
  assert.equal(bundle.artifact.sourceTreeSha256, bundle.manifest.source.treeSha256)
  assert.equal(bundle.artifact.license.spdx, bundle.manifest.source.license.spdx)
  assert.equal(bundle.artifact.license.sha256, bundle.manifest.source.license.sha256)
  assert.deepEqual(bundle.sourceMismatches, [])
  const manifestSources = new Set(bundle.manifest.source.files.map((file) => file.path))
  assert.ok(bundle.missingSourceFiles.includes('test/tui-v2/helpers/harness.tsx'))
  assert.ok(bundle.missingSourceFiles.every((file) => manifestSources.has(file)))
})
