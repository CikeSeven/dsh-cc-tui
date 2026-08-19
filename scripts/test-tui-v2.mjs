/**
 * tui-v2 test runner wrapper (WP-01).
 *
 * Recursively discovers every `.test.ts` file under test/tui-v2
 * (POSIX-sorted relative paths), then runs them in a child process:
 *   process.execPath --test --test-timeout=120000 --import tsx/esm
 *     --test-reporter=<absolute file URL to tui-v2-test-reporter.mjs>
 *     --test-reporter-destination=<temporary JSONL> [files...]
 * and writes a versioned JSON artifact atomically:
 *   { schemaVersion: 1, status, exitCode, signal, files, selectedPattern,
 *     tests, failures, startedAt, durationMs, node, platform, cwd, gitHead,
 *     lockfileHash }
 * Default output: $RUNNER_TEMP/tui-v2/test.json, else os.tmpdir()/tui-v2/test.json.
 *
 * Every failure mode (bad CLI args, discovery failure, spawn failure,
 * reporter load failure/empty output, failing tests, timeout, signal) still
 * writes the artifact and exits non-zero.
 */
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const testDir = path.join(repoRoot, 'test', 'tui-v2')
const reporterUrl = pathToFileURL(path.join(scriptDir, 'tui-v2-test-reporter.mjs')).href

const defaultOutput = () =>
  path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', 'test.json')

function parseArgs(argv) {
  const out = { output: defaultOutput(), testNamePattern: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // pnpm forwards a literal `--` separator; skip it.
    if (arg === '--') continue
    if (arg === '--output') {
      out.output = argv[++i]
      if (!out.output) throw new Error('--output requires a path')
    } else if (arg === '--test-name-pattern') {
      out.testNamePattern = argv[++i]
      if (!out.testNamePattern) throw new Error('--test-name-pattern requires a regex')
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

/** Recursively collect `.test.ts` files under dir as POSIX relative paths. */
async function discoverTests(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await discoverTests(full, base)))
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(path.relative(base, full).split(path.sep).join('/'))
    }
  }
  return files.sort()
}

async function gitHead() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function lockfileHash() {
  try {
    const content = await readFile(path.join(repoRoot, 'pnpm-lock.yaml'))
    return createHash('sha256').update(content).digest('hex')
  } catch {
    return null
  }
}

async function writeArtifactAtomic(outputPath, artifact) {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const tmp = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  )
  await writeFile(tmp, JSON.stringify(artifact, null, 2) + '\n', 'utf8')
  await rename(tmp, outputPath)
}

function runNodeTest(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: repoRoot })
    child.on('error', (error) => resolve({ spawnError: String(error?.message || error), code: null, signal: null }))
    child.on('close', (code, signal) => resolve({ spawnError: null, code, signal }))
  })
}

async function main() {
  const startedAt = new Date().toISOString()
  const t0 = performance.now()
  const artifact = {
    schemaVersion: 1,
    status: 'fail',
    exitCode: null,
    signal: null,
    files: [],
    selectedPattern: null,
    tests: 0,
    failures: [],
    startedAt,
    durationMs: 0,
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    cwd: process.cwd(),
    gitHead: await gitHead(),
    lockfileHash: await lockfileHash(),
  }

  let outputPath = defaultOutput()
  // Best-effort: honor --output even if a later unknown argument fails parsing,
  // so the artifact always lands where the caller looks for it.
  const rawArgs = process.argv.slice(2)
  const outputIndex = rawArgs.indexOf('--output')
  if (outputIndex >= 0 && rawArgs[outputIndex + 1]) {
    outputPath = path.resolve(rawArgs[outputIndex + 1])
  }
  let exitCode = 1
  try {
    const args = parseArgs(rawArgs)
    outputPath = path.resolve(args.output)
    artifact.selectedPattern = args.testNamePattern

    // Discovery: missing directory or zero files is a hard failure.
    const dirStat = await stat(testDir).catch(() => null)
    if (!dirStat?.isDirectory()) {
      artifact.failures.push({ kind: 'discovery', message: `test directory not found: ${testDir}` })
      return
    }
    const files = await discoverTests(testDir)
    if (files.length === 0) {
      artifact.failures.push({ kind: 'discovery', message: `no *.test.ts files under ${testDir}` })
      return
    }
    artifact.files = files

    const tmpDir = process.env.RUNNER_TEMP || os.tmpdir()
    await mkdir(tmpDir, { recursive: true })
    const jsonlPath = path.join(tmpDir, `tui-v2-reporter-${process.pid}-${Date.now()}.jsonl`)

    const nodeArgs = [
      '--test',
      '--test-timeout=120000',
      '--import',
      'tsx/esm',
      `--test-reporter=${reporterUrl}`,
      `--test-reporter-destination=${jsonlPath}`,
    ]
    if (args.testNamePattern) nodeArgs.push(`--test-name-pattern=${args.testNamePattern}`)
    nodeArgs.push(...files.map((f) => path.join(testDir, f)))

    const result = await runNodeTest(nodeArgs)
    artifact.exitCode = result.code
    artifact.signal = result.signal

    // The reporter must have produced parseable, non-empty JSONL output.
    let events = null
    try {
      const raw = await readFile(jsonlPath, 'utf8')
      events = raw
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))
    } catch (error) {
      artifact.failures.push({
        kind: 'reporter',
        message: `reporter output missing or not parseable: ${String(error?.message || error)}`,
      })
      return
    }
    if (result.spawnError) {
      artifact.failures.push({ kind: 'spawn', message: result.spawnError })
      return
    }
    if (events.length === 0) {
      artifact.failures.push({ kind: 'reporter', message: 'reporter produced no events' })
      return
    }

    let passed = 0
    let failed = 0
    for (const event of events) {
      if (event.type === 'test:pass') passed++
      if (event.type === 'test:fail') {
        failed++
        artifact.failures.push({
          kind: 'test',
          name: event.data?.name ?? event.name ?? null,
          file: event.data?.file ?? null,
          error: event.data?.details?.error ?? null,
        })
      }
    }
    artifact.tests = passed + failed

    if (result.signal) {
      artifact.failures.push({ kind: 'signal', message: `test process terminated by ${result.signal}` })
      return
    }
    if (result.code !== 0) {
      // Failing tests/timeouts already landed in failures; a non-zero exit
      // without any test:fail event is reported generically.
      if (failed === 0) {
        artifact.failures.push({ kind: 'exit', message: `node --test exited with code ${result.code}` })
      }
      return
    }
    artifact.status = 'pass'
    exitCode = 0
  } catch (error) {
    artifact.failures.push({ kind: 'wrapper', message: String(error?.message || error) })
  } finally {
    artifact.durationMs = Math.round((performance.now() - t0) * 1000) / 1000
    try {
      await writeArtifactAtomic(outputPath, artifact)
      console.log(`tui-v2 test artifact written to ${outputPath} (status=${artifact.status})`)
    } catch (error) {
      console.error(`failed to write artifact to ${outputPath}:`, error)
      exitCode = 1
    }
    process.exitCode = artifact.status === 'pass' ? 0 : exitCode === 0 ? 1 : exitCode
  }
}

await main()
