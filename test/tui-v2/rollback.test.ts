import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import {
  validateRollbackShape,
} from '../../scripts/tui-v2-rollback.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = process.cwd()
const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const generator = path.join(repoRoot, 'scripts', 'create-tui-v2-rollback-manifest.mjs')
const verifier = path.join(repoRoot, 'scripts', 'verify-package.mjs')
const drill = path.join(repoRoot, 'scripts', 'verify-tui-v2-rollback.mjs')

async function run(script: string, args: readonly string[], expectFailure = false) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (expectFailure) assert.fail(`${path.basename(script)} unexpectedly passed`)
    return result
  } catch (error: any) {
    if (!expectFailure) throw error
    return error
  }
}

function validManifest(tarball: string, sha256: string) {
  return {
    schemaVersion: 1,
    registry: 'https://registry.example.invalid/',
    package: packageJson.name,
    version: packageJson.version,
    tarball: path.basename(tarball),
    sha256,
    signature: { algorithm: 'sigstore', ref: 'fixture-test-signature-ref' },
    sessionSchema: { min: 1, max: 1 },
    launcher: { command: 'fixture-launcher', args: ['--package', path.basename(tarball)], timeoutMs: 30_000, retries: 2 },
    retention: { keepStableVersions: 1, expiresAt: '2030-01-01T00:00:00Z' },
  }
}

test('rollback schema is strict and requires current session compatibility', () => {
  const base = validManifest('deepseek-harness-tui-dsh-tui-0.8.2.tgz', 'a'.repeat(64))
  assert.deepEqual(validateRollbackShape(base, { expectedPackageName: packageJson.name }).errors, [])
  assert.match(validateRollbackShape({ ...base, unexpected: true }).errors.join('\n'), /unknown field/u)
  assert.match(validateRollbackShape({ ...base, sessionSchema: { min: 2, max: 3 } }).errors.join('\n'), /include current schema/u)
  assert.match(validateRollbackShape({ ...base, tarball: '../escape.tgz' }).errors.join('\n'), /basename|safe/u)
  assert.match(validateRollbackShape({ ...base, signature: { algorithm: 'none', ref: '' } }).errors.join('\n'), /signature/u)
  assert.match(validateRollbackShape({ ...base, launcher: { ...base.launcher, timeoutMs: 0 } }).errors.join('\n'), /timeoutMs/u)
})

test('rollback child drill covers cleanup, repeated signal, timeout, and dry-run launcher', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-rollback-test-'))
  try {
    const output = path.join(directory, 'drill.json')
    await run(drill, ['--output', output])
    const artifact = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(artifact.schemaVersion, 1)
    assert.equal(artifact.status, 'pass')
    assert.equal(artifact.mode, 'fixture')
    assert.equal(artifact.rollbackArtifact, 'unsupported-by-host')
    assert.equal(artifact.launcher.network, false)
    assert.deepEqual(artifact.launcherTimeout, {
      status: 'expected-failure',
      reason: 'timeout-retries-exhausted',
      attempts: 3,
      retries: 2,
      timeoutMs: 25,
      network: false,
    })
    assert.equal(artifact.children.length, 4)
    assert.ok(artifact.children.some((child: any) => child.scenario === 'failed-after-takeover' && child.repeatedSignals >= 1))
    assert.ok(artifact.children.some((child: any) => child.scenario === 'cleanup-timeout' && child.cleanupDeadlineHit === true && child.code !== 0))
    for (const child of artifact.children) {
      assert.equal(child.cleanupCount, 1)
      assert.equal(child.stdoutWrites, 0)
      assert.equal(child.fallbackSwitchCount, 0)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('verify-package --rollback rejects tampered tarball and invalid manifest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-rollback-invalid-'))
  try {
    const tarball = path.join(directory, 'deepseek-harness-tui-dsh-tui-0.8.2.tgz')
    await writeFile(tarball, 'fixture-not-a-real-tarball')
    const hash = 'b'.repeat(64)
    const manifest = path.join(directory, 'rollback.json')
    await writeFile(manifest, JSON.stringify(validManifest(tarball, hash)))
    const result = await run(verifier, ['--rollback', manifest, '--tarball', tarball], true)
    assert.match(String(result.stderr || result.message), /sha256|tarball/u)

    const malformed = path.join(directory, 'malformed.json')
    await writeFile(malformed, JSON.stringify({ schemaVersion: 1 }))
    const malformedResult = await run(verifier, ['--rollback', malformed, '--tarball', tarball], true)
    assert.match(String(malformedResult.stderr || malformedResult.message), /missing|manifest/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
