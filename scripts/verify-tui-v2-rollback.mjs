#!/usr/bin/env node
/**
 * Child-process rollback drill (WP-09c2).
 *
 * The default invocation uses a temporary, explicitly labelled fixture so the
 * command is useful on a clean checkout without pretending that a production
 * previous release exists.  A real local manifest/tarball can be supplied for
 * the stronger exact-artifact path.  No registry or launcher network is used.
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  expectedTarballBasename,
  isRegularFile,
  sha256File,
  validateRollbackLocal,
  validateRollbackShape,
  writeJsonAtomic,
} from './tui-v2-rollback.mjs'

const execFileAsync = promisify(execFile)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const childScript = path.join(scriptDir, 'tui-v2-rollback-child.mjs')
const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))

function parseArgs(argv) {
  const result = { manifest: null, tarball: null, output: null, timeoutMs: 30_000, help: false }
  const allowed = new Set(['--manifest', '--tarball', '--output', '--timeout-ms'])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--help') {
      result.help = true
      continue
    }
    if (!allowed.has(arg)) throw new Error(`unknown argument: ${arg}`)
    const key = { '--manifest': 'manifest', '--tarball': 'tarball', '--output': 'output', '--timeout-ms': 'timeoutMs' }[arg]
    if (result[key] !== null && result[key] !== 30_000) throw new Error(`duplicate argument: ${arg}`)
    const value = argv[++index]
    if (value === undefined || value === '') throw new Error(`${arg} requires a value`)
    result[key] = key === 'timeoutMs' ? Number(value) : value
  }
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer')
  if ((result.manifest === null) !== (result.tarball === null)) {
    throw new Error('--manifest and --tarball must be supplied together')
  }
  return result
}

function fail(message) {
  throw new Error(message)
}

async function makeFixture(directory) {
  const packageDirectory = path.join(directory, 'fixture-package', 'package')
  await mkdir(packageDirectory, { recursive: true })
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    fixture: 'tui-v2-rollback-drill',
  }, null, 2) + '\n')
  const tarball = path.join(directory, expectedTarballBasename(packageJson.name, packageJson.version))
  await execFileAsync('tar', ['--create', '--gzip', '--file', tarball, '--directory', path.dirname(packageDirectory), 'package'])
  const sha256 = await sha256File(tarball)
  const manifestPath = path.join(directory, 'rollback-manifest.json')
  const manifest = {
    schemaVersion: 1,
    registry: 'https://registry.example.invalid/',
    package: packageJson.name,
    version: packageJson.version,
    tarball: path.basename(tarball),
    sha256,
    signature: { algorithm: 'sigstore', ref: 'fixture-test-signature-ref' },
    sessionSchema: { min: 1, max: 1 },
    launcher: {
      command: process.execPath,
      args: [],
      timeoutMs: 30_000,
      retries: 2,
    },
    retention: { keepStableVersions: 1, expiresAt: '2030-01-01T00:00:00Z' },
  }
  return { tarball, sha256, manifestPath, manifest, mode: 'fixture' }
}

function runChild(directory, scenario, timeoutMs, repeatSignal = false) {
  const reportPath = path.join(directory, `child-${scenario}.json`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript, scenario, reportPath], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    })
    let stderr = ''
    let triggered = false
    child.stderr.setEncoding('utf8')
    const trigger = () => {
      if (triggered || child.exitCode !== null) return
      triggered = true
      clearTimeout(signalTimer)
      if (scenario === 'stdin-close') {
        child.stdin.end()
      } else if (scenario !== 'cleanup-timeout') {
        child.kill('SIGTERM')
        if (repeatSignal) setTimeout(() => child.kill('SIGTERM'), 1)
      }
    }
    child.stderr.on('data', chunk => {
      stderr += chunk
      if (stderr.includes('READY')) trigger()
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`rollback child ${scenario} exceeded ${timeoutMs}ms`))
    }, timeoutMs)
    const signalTimer = setTimeout(trigger, 500)
    child.once('error', error => {
      clearTimeout(timer)
      clearTimeout(signalTimer)
      reject(error)
    })
    child.once('close', async (code, signal) => {
      clearTimeout(timer)
      clearTimeout(signalTimer)
      try {
        const report = JSON.parse(await readFile(reportPath, 'utf8'))
        resolve({ scenario, code, signal, report, stderr })
      } catch (error) {
        reject(new Error(`rollback child ${scenario} produced no report: ${String(error?.message || error)}`))
      }
    })
  })
}

async function runLauncherDryRun(directory, release) {
  const argvPath = path.join(directory, 'launcher-argv.json')
  const launcherScript = path.join(directory, 'launcher-dry-run.mjs')
  await writeFile(launcherScript, `import { writeFile } from 'node:fs/promises'\nawait writeFile(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))\n`)
  const args = [launcherScript, '--package', release.tarball, '--sha256', release.sha256, '--dry-run']
  const value = { ...release.manifest, launcher: { ...release.manifest.launcher, command: process.execPath, args } }
  const checked = validateRollbackShape(value, { expectedPackageName: packageJson.name, requireUnexpired: true })
  if (checked.errors.length > 0) fail(checked.errors.join('; '))
  const result = await new Promise((resolve, reject) => {
    const child = spawn(value.launcher.command, value.launcher.args, {
      cwd: repoRoot,
      env: { ...process.env, NO_NETWORK: '1', TUI_V2_ROLLBACK_DRY_RUN: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('rollback launcher dry-run timed out'))
    }, value.launcher.timeoutMs)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stderr })
    })
  })
  if (result.code !== 0 || result.signal !== null) fail(`rollback launcher dry-run failed: ${JSON.stringify(result)}`)
  const recorded = JSON.parse(await readFile(argvPath, 'utf8'))
  if (JSON.stringify(recorded) !== JSON.stringify(args.slice(1))) {
    fail(`rollback launcher argv changed: ${JSON.stringify(recorded)}`)
  }
  return { status: 'pass', command: value.launcher.command, argvHash: createHash('sha256').update(JSON.stringify(recorded)).digest('hex'), network: false }
}

async function runLauncherTimeoutDrill() {
  const timeoutMs = 25
  const retries = 2
  let attempts = 0
  for (; attempts <= retries; attempts += 1) {
    const timedOut = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
        cwd: repoRoot,
        env: { ...process.env, NO_NETWORK: '1', TUI_V2_ROLLBACK_DRY_RUN: '1' },
        stdio: 'ignore',
      })
      let timeoutHit = false
      const timer = setTimeout(() => {
        timeoutHit = true
        child.kill('SIGKILL')
      }, timeoutMs)
      child.once('error', reject)
      child.once('close', () => {
        clearTimeout(timer)
        resolve(timeoutHit)
      })
    })
    if (!timedOut) fail('rollback launcher timeout fixture unexpectedly completed')
  }
  return {
    status: 'expected-failure',
    reason: 'timeout-retries-exhausted',
    attempts,
    retries,
    timeoutMs,
    network: false,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('Usage: node scripts/verify-tui-v2-rollback.mjs [--manifest <json> --tarball <tgz>] [--output <json>]')
    return
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-rollback-drill-'))
  const output = path.resolve(args.output ?? path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', 'rollback-drill.json'))
  const startedAt = new Date().toISOString()
  let release
  let artifact
  try {
    if (args.manifest === null) {
      release = await makeFixture(directory)
      await writeJsonAtomic(release.manifestPath, release.manifest)
      artifact = { schemaVersion: 1, status: 'pass', mode: 'fixture', rollbackArtifact: 'unsupported-by-host', startedAt, errors: [] }
    } else {
      release = {
        manifestPath: path.resolve(args.manifest),
        tarball: path.resolve(args.tarball),
        sha256: await sha256File(path.resolve(args.tarball)),
        manifest: JSON.parse(await readFile(path.resolve(args.manifest), 'utf8')),
        mode: 'local-artifact',
      }
      const checked = await validateRollbackLocal(release.manifestPath, {
        expectedPackageName: packageJson.name,
        tarballPath: release.tarball,
        requireUnexpired: true,
      })
      if (checked.errors.length > 0) fail(checked.errors.join('; '))
      artifact = { schemaVersion: 1, status: 'pass', mode: 'local-artifact', rollbackArtifact: 'verified-local', startedAt, errors: [] }
    }
    const childScenarios = ['failed-before-takeover', 'failed-after-takeover', 'cleanup-timeout', 'stdin-close']
    const children = []
    for (const scenario of childScenarios) {
      const result = await runChild(directory, scenario, args.timeoutMs, scenario === 'failed-after-takeover')
      const expectedCode = scenario === 'cleanup-timeout' ? 74 : 73
      const report = result.report
      const ok = result.code === expectedCode && result.signal === null
        && report.cleanupCount === 1 && report.cleanupCompleted === true
        && report.fallbackSwitchCount === 0 && report.stdoutWrites === 0
        && report.modesAfterCleanup?.rawInput === false
        && report.modesAfterCleanup?.alternateScreen === false
        && report.modesAfterCleanup?.mouse === false
        && report.modesAfterCleanup?.bracketedPaste === false
        && report.modesAfterCleanup?.cursorVisible === true
      if (!ok) fail(`rollback child ${scenario} evidence failed: ${JSON.stringify(report)}`)
      children.push({ scenario, code: result.code, signal: result.signal, cleanupCount: report.cleanupCount, repeatedSignals: report.repeatedSignals, cleanupDeadlineHit: report.cleanupDeadlineHit, stdoutWrites: report.stdoutWrites, fallbackSwitchCount: report.fallbackSwitchCount })
    }
    const launcher = await runLauncherDryRun(directory, release)
    const launcherTimeout = await runLauncherTimeoutDrill()
    artifact.children = children
    artifact.launcher = launcher
    artifact.launcherTimeout = launcherTimeout
    artifact.exact = { tarball: path.resolve(release.tarball), sha256: release.sha256 }
    await writeJsonAtomic(output, artifact)
    console.log(`rollback drill artifact written to ${output} (status=pass, mode=${artifact.mode})`)
  } catch (error) {
    artifact ??= { schemaVersion: 1, status: 'fail', mode: release?.mode ?? 'unknown', startedAt, errors: [] }
    artifact.status = 'fail'
    artifact.errors = [String(error?.message || error)]
    await writeJsonAtomic(output, artifact)
    console.error(`rollback drill failed; artifact written to ${output}: ${artifact.errors[0]}`)
    process.exitCode = 1
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

await main()
