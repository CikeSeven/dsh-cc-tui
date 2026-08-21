import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import {
  assertSafeArchiveName,
  normalizePackFileName,
} from '../../scripts/verify-tui-v2-tarball.mjs'
import { checkCiIntegration, checkV2Only } from '../../scripts/verify-tui-v2.js'

const execFileAsync = promisify(execFile)
const repoRoot = process.cwd()
const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const verifier = path.join(repoRoot, 'scripts', 'verify-tui-v2-tarball.mjs')
const generator = path.join(repoRoot, 'scripts', 'create-tui-v2-rollback-manifest.mjs')
const packageVerifier = path.join(repoRoot, 'scripts', 'verify-package.mjs')

async function runNode(script: string, args: readonly string[], options: { input?: string; expectFailure?: boolean } = {}) {
  try {
    if (options.input === undefined) {
      const result = await execFileAsync(process.execPath, [script, ...args], {
        cwd: repoRoot,
        maxBuffer: 128 * 1024 * 1024,
      })
      if (options.expectFailure) assert.fail(`expected ${path.basename(script)} to fail`)
      return result
    }
    const result = await new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('close', status => resolve({ stdout, stderr, status }))
      child.stdin.end(options.input)
    })
    if (result.status !== 0) throw Object.assign(new Error(result.stderr), { stdout: result.stdout, stderr: result.stderr, status: result.status })
    if (options.expectFailure) assert.fail(`expected ${path.basename(script)} to fail`)
    return result
  } catch (error: any) {
    if (!options.expectFailure) throw error
    return error
  }
}

async function makePack(directory: string) {
  const result = await execFileAsync('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', directory, '--foreground-scripts=false',
  ], { cwd: repoRoot, maxBuffer: 128 * 1024 * 1024 })
  const parsed = JSON.parse(result.stdout)
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  assert.ok(report && typeof report === 'object')
  const filename = path.resolve(directory, (report as any).filename)
  // npm reports a basename; make the contract explicit for the fixture.
  assert.equal(path.basename(filename), (report as any).filename)
  return { report: report as any, filename, packJson: parsed }
}

async function sha256(file: string) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function makeManifest(directory: string, tarball: string, hash: string) {
  const output = path.join(directory, 'rollback-manifest.json')
  await runNode(generator, [
    '--registry', 'https://registry.example.invalid/',
    '--package', packageJson.name,
    '--version', packageJson.version,
    '--tarball', tarball,
    '--sha256', hash,
    '--signature-algorithm', 'sigstore',
    '--signature-ref', 'fixture-test-signature-ref',
    '--session-min', '1', '--session-max', '1',
    '--launcher-command', 'fixture-rollback-launcher',
    '--launcher-args-json', '["--package","fixture"]',
    '--launcher-timeout-ms', '30000', '--launcher-retries', '2',
    '--keep-stable-versions', '1', '--expires-at', '2030-01-01T00:00:00Z',
    '--output', output,
  ])
  return output
}

test('exact pack flow produces a verified artifact with file hashes and fork metadata', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-tarball-test-'))
  try {
    const packed = await makePack(directory)
    const hash = await sha256(packed.filename)
    const manifest = await makeManifest(directory, packed.filename, hash)
    const packJsonPath = path.join(directory, 'pack.json')
    await writeFile(packJsonPath, JSON.stringify(packed.packJson))
    const output = path.join(directory, 'verified-tarball.json')
    await runNode(verifier, [
      '--tarball', packed.filename,
      '--sha256', hash,
      '--pack-json', packJsonPath,
      '--rollback-manifest', manifest,
      '--output', output,
    ])
    const artifact = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(artifact.schemaVersion, 1)
    assert.equal(artifact.status, 'pass')
    assert.equal(artifact.artifact.tarball, packed.filename)
    assert.equal(artifact.artifact.sha256, hash)
    assert.equal(artifact.pack.artifactCount, 1)
    assert.match(artifact.files.sha256, /^[0-9a-f]{64}$/u)
    assert.ok(artifact.files.manifest.some((entry: any) => entry.path === 'LICENSE'))
    assert.ok(artifact.files.manifest.some((entry: any) => entry.path === 'lib/types/tui-v2/vendor/pi-tui/NOTICE'))
    assert.ok(artifact.files.manifest.some((entry: any) => entry.path === 'lib/types/tui-v2/vendor/pi-tui/PATCH-LEDGER.md'))
    assert.ok(artifact.files.manifest.some((entry: any) => entry.path === 'lib/types/tui-v2/vendor/pi-tui/VENDOR-MANIFEST.json'))
    assert.equal(artifact.surface.dependencyHits.length, 0)
    assert.equal(artifact.surface.legacyChecks.secondRenderer, false)
    assert.equal(artifact.rollback.status, 'verified')
    assert.equal(artifact.rollback.signature.refPresent, true)
    assert.equal(JSON.stringify(artifact).includes('fixture-test-signature-ref'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('final ci-integration and v2-only accept the same local verified artifact', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-final-artifact-'))
  try {
    const packed = await makePack(directory)
    const hash = await sha256(packed.filename)
    const manifest = await makeManifest(directory, packed.filename, hash)
    const packJsonPath = path.join(directory, 'pack.json')
    await writeFile(packJsonPath, JSON.stringify(packed.packJson))
    const verifiedPath = path.join(directory, 'verified-tarball.json')
    await runNode(verifier, [
      '--tarball', packed.filename, '--sha256', hash, '--pack-json', packJsonPath,
      '--rollback-manifest', manifest, '--output', verifiedPath,
    ])
    const ci = await checkCiIntegration({
      output: path.join(directory, 'ci-final.json'), profile: null, fixture: null, final: true,
      rollbackManifest: manifest, tarball: packed.filename, verifiedTarball: verifiedPath,
    })
    assert.equal(ci.status, 'pass', JSON.stringify(ci.details))
    const v2 = await checkV2Only({
      output: path.join(directory, 'v2-final.json'), profile: null, fixture: null, final: true,
      rollbackManifest: manifest, tarball: packed.filename, verifiedTarball: verifiedPath,
    })
    assert.equal(v2.status, 'pass', JSON.stringify(v2.details))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stdin package verifier remains independent from rollback verifier', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-package-stdin-'))
  try {
    const packed = await makePack(directory)
    const result = await runNode(packageVerifier, [], { input: JSON.stringify(packed.packJson) })
    assert.match(result.stdout, /package surface OK/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('tampered exact tarball and malformed pack reports fail closed', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-tarball-tamper-'))
  try {
    const packed = await makePack(directory)
    const hash = await sha256(packed.filename)
    const manifest = await makeManifest(directory, packed.filename, hash)
    const packJsonPath = path.join(directory, 'pack.json')
    await writeFile(packJsonPath, JSON.stringify(packed.packJson))
    const tampered = path.join(directory, path.basename(packed.filename, '.tgz') + '-tampered.tgz')
    await writeFile(tampered, Buffer.concat([await readFile(packed.filename), Buffer.from('tamper')]))
    const failed = await runNode(verifier, [
      '--tarball', tampered, '--sha256', hash, '--pack-json', packJsonPath,
      '--rollback-manifest', manifest, '--output', path.join(directory, 'fail.json'),
    ], { expectFailure: true })
    assert.match(String(failed.stderr || failed.message), /sha256|filename/u)

    await writeFile(packJsonPath, JSON.stringify([{ ...packed.report }, { ...packed.report }]))
    const duplicateFailed = await runNode(verifier, [
      '--tarball', packed.filename, '--sha256', hash, '--pack-json', packJsonPath,
      '--rollback-manifest', manifest, '--output', path.join(directory, 'duplicate.json'),
    ], { expectFailure: true })
    assert.match(String(duplicateFailed.stderr || duplicateFailed.message), /exactly one/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('tar verifier rejects symlink entries before extraction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-tarball-symlink-'))
  try {
    const root = path.join(directory, 'package')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: packageJson.name, version: packageJson.version }))
    await symlink('/etc/passwd', path.join(root, 'escape'))
    const tarball = path.join(directory, 'deepseek-harness-tui-dsh-tui-0.8.2.tgz')
    await execFileAsync('tar', ['--create', '--gzip', '--file', tarball, '--directory', directory, 'package'])
    const hash = await sha256(tarball)
    const packJson = path.join(directory, 'pack.json')
    await writeFile(packJson, JSON.stringify([{ name: packageJson.name, version: packageJson.version, filename: path.basename(tarball), size: (await readFile(tarball)).byteLength, files: [] }]))
    const manifest = path.join(directory, 'rollback.json')
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, registry: 'https://registry.example.invalid/', package: packageJson.name, version: packageJson.version, tarball: path.basename(tarball), sha256: hash, signature: { algorithm: 'sigstore', ref: 'fixture' }, sessionSchema: { min: 1, max: 1 }, launcher: { command: 'fixture', args: [], timeoutMs: 1000, retries: 0 }, retention: { keepStableVersions: 1, expiresAt: '2030-01-01T00:00:00Z' } }))
    const failed = await runNode(verifier, ['--tarball', tarball, '--sha256', hash, '--pack-json', packJson, '--rollback-manifest', manifest, '--output', path.join(directory, 'fail.json')], { expectFailure: true })
    assert.match(String(failed.stderr || failed.message), /unsafe entry type|symlink/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('archive path guards reject traversal, absolute paths, and unsafe pack paths', () => {
  assert.throws(() => assertSafeArchiveName('package/../escape'), /traversal/u)
  assert.throws(() => assertSafeArchiveName('/package/file'), /absolute/u)
  assert.throws(() => assertSafeArchiveName('package\\file'), /absolute|backslash/u)
  assert.throws(() => normalizePackFileName('../escape'), /traversal/u)
  assert.equal(normalizePackFileName('lib/index.js'), 'lib/index.js')
})

test('publish workflow statically enforces one compile and exact verified publish', async () => {
  const workflow = await readFile(path.join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf8')
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/u)
  assert.match(workflow, /npm pack --ignore-scripts --json --pack-destination/u)
  assert.match(workflow, /--foreground-scripts=false/u)
  assert.equal(packageJson.scripts.prepare, undefined)
  assert.match(workflow, /node scripts\/verify-package\.mjs < "\$packJson"/u)
  assert.match(workflow, /node scripts\/verify-tui-v2-tarball\.mjs/u)
  assert.match(workflow, /actions\/download-artifact@v4/u)
  assert.match(workflow, /TUI_V2_ROLLBACK_ARTIFACT_RUN_ID/u)
  assert.match(workflow, /verified-tarball\.json/u)
  assert.match(workflow, /npm publish "\$tgz" --ignore-scripts --access public --provenance/u)
  assert.match(workflow, /publish-response\.json/u)
  assert.equal((workflow.match(/\bpnpm compile\b/gu) ?? []).length, 1)
  assert.equal((workflow.match(/\bnpm pack\b/gu) ?? []).length, 1)
  assert.equal((workflow.match(/\bnpm publish\b/gu) ?? []).length, 1)
  assert.doesNotMatch(workflow, /npm publish\s+--access public\s+--provenance(?![\s\S]*\$tgz)/u)
})

test('generator requires explicit release values and emits deterministic JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-generator-'))
  try {
    const missing = await runNode(generator, [], { expectFailure: true })
    assert.match(String(missing.stderr || missing.message), /required/u)
    const packed = await makePack(directory)
    const hash = await sha256(packed.filename)
    const first = await makeManifest(directory, packed.filename, hash)
    const firstBytes = await readFile(first)
    const second = path.join(directory, 'second.json')
    await runNode(generator, [
      '--registry', 'https://registry.example.invalid/', '--package', packageJson.name,
      '--version', packageJson.version, '--tarball', packed.filename, '--sha256', hash,
      '--signature-algorithm', 'sigstore', '--signature-ref', 'fixture-test-signature-ref',
      '--session-min', '1', '--session-max', '1', '--launcher-command', 'fixture-rollback-launcher',
      '--launcher-args-json', '["--package","fixture"]', '--launcher-timeout-ms', '30000', '--launcher-retries', '2',
      '--keep-stable-versions', '1', '--expires-at', '2030-01-01T00:00:00Z', '--output', second,
    ])
    assert.deepEqual(await readFile(second), firstBytes)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
