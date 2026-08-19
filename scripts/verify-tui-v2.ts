/**
 * tui-v2 verifier (WP-01): `node --import tsx/esm scripts/verify-tui-v2.ts --check <name>`
 *
 * Check registry (Map) so later WPs can register ownership / trace / fork /
 * skeleton / controllers / fullscreen / inline / v2-only / ci-integration.
 * This WP implements:
 *   - baseline:          docs/tui-v2/baseline/{baseline,clean-stop}.json exist
 *                        with the required identity fields; the clean-stop
 *                        report records 3 child exits, all code 0.
 *   - regression-matrix: parse the machine-readable json block in
 *                        docs/tui-v2-regression-matrix.md, validate every row
 *                        (fields/enums/UTC RFC 3339), re-run the entry scan
 *                        and compare listHash, and require every scanned CI
 *                        entry point to be covered by a row.
 *
 * Every check writes an atomic JSON artifact
 *   { schemaVersion: 1, check, status, details, startedAt, durationMs,
 *     node, gitHead, lockfileHash }
 * and exits non-zero on failure (including unknown CLI args / unknown check).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

const SCAN_COMMAND = "rg -o 'scripts/[A-Za-z0-9_.-]+' .github/workflows package.json | LC_ALL=C sort -u"

interface CheckContext {
  output: string
  profile: string | null
  fixture: string | null
}
interface CheckResult {
  status: 'pass' | 'fail'
  details: Record<string, unknown>
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

async function gitHead(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function lockfileHash(): Promise<string | null> {
  try {
    return sha256Hex(await readFile(path.join(repoRoot, 'pnpm-lock.yaml')))
  } catch {
    return null
  }
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

/**
 * Pure-Node reimplementation of SCAN_COMMAND so the check is deterministic
 * and does not depend on ripgrep/locale at runtime. Byte-identical to
 * `rg -o ... | LC_ALL=C sort -u` for this repository's ASCII entry names.
 */
export async function computeEntryScan(): Promise<{ entries: string[]; listHash: string }> {
  const files: string[] = []
  const workflowsDir = path.join(repoRoot, '.github', 'workflows')
  for (const name of (await readdir(workflowsDir)).sort()) {
    if (name.endsWith('.yml') || name.endsWith('.yaml')) {
      files.push(`.github/workflows/${name}`)
    }
  }
  files.push('package.json')

  const found = new Set<string>()
  const pattern = /scripts\/[A-Za-z0-9_.-]+/g
  for (const rel of files) {
    const content = await readFile(path.join(repoRoot, rel), 'utf8')
    for (const match of content.matchAll(pattern)) {
      found.add(`${rel}:${match[0]}`)
    }
  }
  // Default JS sort is UTF-16 code-unit order == LC_ALL=C byte order (ASCII).
  const entries = [...found].sort()
  return { entries, listHash: sha256Hex(entries.join('\n') + '\n') }
}

// ---------------------------------------------------------------------------
// baseline check
// ---------------------------------------------------------------------------

const BASELINE_DIR = path.join(repoRoot, 'docs', 'tui-v2', 'baseline')
const BASELINE_IDENTITY_FIELDS = ['node', 'os', 'profile', 'gitHead', 'lockfileSha256'] as const

async function readJsonIfExists(file: string): Promise<{ ok: boolean; value?: any; error?: string }> {
  try {
    return { ok: true, value: JSON.parse(await readFile(file, 'utf8')) }
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) }
  }
}

async function checkBaseline(): Promise<CheckResult> {
  const errors: string[] = []
  const details: Record<string, unknown> = { files: {} }

  const baselinePath = path.join(BASELINE_DIR, 'baseline.json')
  const baseline = await readJsonIfExists(baselinePath)
  if (!baseline.ok) {
    errors.push(`baseline.json unreadable: ${baseline.error}`)
  } else {
    const value = baseline.value
    const missing = BASELINE_IDENTITY_FIELDS.filter((f) => value?.[f] == null || value?.[f] === '')
    if (missing.length > 0) errors.push(`baseline.json missing identity fields: ${missing.join(', ')}`)
    if (!Array.isArray(value?.results) || value.results.length === 0) {
      errors.push('baseline.json has no results[]')
    } else {
      const fixtures = new Set(value.results.map((r: any) => r?.fixture))
      for (const required of ['v1-chat-startup', 'v1-stream-200']) {
        if (!fixtures.has(required)) errors.push(`baseline.json missing fixture result: ${required}`)
      }
      for (const r of value.results) {
        if (typeof r?.fixture !== 'string') errors.push('baseline.json result without fixture id')
      }
    }
    ;(details.files as any).baseline = {
      node: value?.node ?? null,
      os: value?.os ?? null,
      gitHead: value?.gitHead ?? null,
      fixtures: Array.isArray(value?.results) ? value.results.map((r: any) => r?.fixture ?? null) : [],
    }
  }

  const cleanStopPath = path.join(BASELINE_DIR, 'clean-stop.json')
  const cleanStop = await readJsonIfExists(cleanStopPath)
  if (!cleanStop.ok) {
    errors.push(`clean-stop.json unreadable: ${cleanStop.error}`)
  } else {
    const value = cleanStop.value
    const missing = BASELINE_IDENTITY_FIELDS.filter((f) => value?.[f] == null || value?.[f] === '')
    if (missing.length > 0) errors.push(`clean-stop.json missing identity fields: ${missing.join(', ')}`)
    const result = Array.isArray(value?.results)
      ? value.results.find((r: any) => r?.fixture === 'v1-clean-stop')
      : null
    const exitCodes: unknown = result?.details?.exitCodes
    if (!Array.isArray(exitCodes) || exitCodes.length !== 3) {
      errors.push('clean-stop.json must record exactly 3 child exit codes (results[].details.exitCodes)')
    } else if (!exitCodes.every((code) => code === 0)) {
      errors.push(`clean-stop child exits must all be 0, got ${JSON.stringify(exitCodes)}`)
    }
    ;(details.files as any).cleanStop = {
      node: value?.node ?? null,
      exitCodes: Array.isArray(exitCodes) ? exitCodes : null,
    }
  }

  details.errors = errors
  return { status: errors.length === 0 ? 'pass' : 'fail', details }
}

// ---------------------------------------------------------------------------
// regression-matrix check
// ---------------------------------------------------------------------------

const MATRIX_DOC = path.join(repoRoot, 'docs', 'tui-v2-regression-matrix.md')
const ROW_REQUIRED_FIELDS = [
  'id',
  'severity',
  'owner',
  'status',
  'updatedAt',
  'traceId',
  'assertion',
  'ciCommand',
  'blockDefault',
  'deleteCondition',
  'disposition',
] as const
const SEVERITIES = new Set(['P0', 'P1', 'P2'])
const STATUSES = new Set(['open', 'in-progress', 'verified', 'accepted-risk', 'retired'])
const DISPOSITIONS = new Set(['rewrite-v2', 'remove', 'offline-baseline', 'unaffected'])
const UTC_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

function extractMachineBlock(markdown: string): { scan?: any; rows?: any[] } | null {
  const fence = /```json\s*\n([\s\S]*?)```/g
  for (const match of markdown.matchAll(fence)) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rows)) return parsed
    } catch {
      // Not the machine block; keep scanning.
    }
  }
  return null
}

async function checkRegressionMatrix(): Promise<CheckResult> {
  const errors: string[] = []
  const warnings: string[] = []

  let markdown: string
  try {
    markdown = await readFile(MATRIX_DOC, 'utf8')
  } catch (error: any) {
    return {
      status: 'fail',
      details: { errors: [`regression matrix doc unreadable: ${String(error?.message || error)}`] },
    }
  }

  const machine = extractMachineBlock(markdown)
  if (!machine) {
    return { status: 'fail', details: { errors: ['no ```json machine block with a rows array found'] } }
  }

  const scan = await computeEntryScan()

  // Scan metadata: sourceCommit / scanCommand / listHash must be present and
  // listHash must match a fresh re-scan of the current tree.
  const meta = machine.scan
  if (!meta || typeof meta !== 'object') {
    errors.push('machine block missing scan metadata object')
  } else {
    if (typeof meta.sourceCommit !== 'string' || meta.sourceCommit.length === 0) {
      errors.push('scan.sourceCommit missing')
    }
    if (typeof meta.scanCommand !== 'string' || meta.scanCommand.length === 0) {
      errors.push('scan.scanCommand missing')
    }
    if (typeof meta.listHash !== 'string' || meta.listHash.length === 0) {
      errors.push('scan.listHash missing')
    } else if (meta.listHash !== scan.listHash) {
      errors.push(
        `scan.listHash ${meta.listHash} does not match re-scan ${scan.listHash} ` +
          `(entry list changed; re-run: ${SCAN_COMMAND})`,
      )
    }
  }

  // Row validation.
  const ids = new Set<string>()
  const coveredScripts = new Set<string>()
  const severityCounts: Record<string, number> = {}
  const dispositionCounts: Record<string, number> = {}
  const rows = Array.isArray(machine.rows) ? machine.rows : []
  if (rows.length === 0) errors.push('machine block has zero rows')

  rows.forEach((row: any, index: number) => {
    const where = row && typeof row === 'object' && typeof row.id === 'string' ? row.id : `row[${index}]`
    if (!row || typeof row !== 'object') {
      errors.push(`${where}: not an object`)
      return
    }
    for (const field of ROW_REQUIRED_FIELDS) {
      if (row[field] === undefined || row[field] === null || row[field] === '') {
        errors.push(`${where}: missing field ${field}`)
      }
    }
    if (typeof row.id === 'string' && row.id !== '') {
      if (!/^REG-\d+$/.test(row.id)) errors.push(`${where}: id must match REG-<n>`)
      if (ids.has(row.id)) errors.push(`${where}: duplicate id`)
      ids.add(row.id)
    }
    if (!SEVERITIES.has(row.severity)) errors.push(`${where}: invalid severity ${JSON.stringify(row.severity)}`)
    if (!STATUSES.has(row.status)) errors.push(`${where}: invalid status ${JSON.stringify(row.status)}`)
    if (!DISPOSITIONS.has(row.disposition)) {
      errors.push(`${where}: invalid disposition ${JSON.stringify(row.disposition)}`)
    }
    if (typeof row.updatedAt === 'string' && !UTC_RFC3339.test(row.updatedAt)) {
      errors.push(`${where}: updatedAt must be UTC RFC 3339 (…Z), got ${row.updatedAt}`)
    }
    if (typeof row.blockDefault !== 'boolean') {
      errors.push(`${where}: blockDefault must be boolean`)
    }
    if (typeof row.ciCommand === 'string') {
      for (const match of row.ciCommand.matchAll(/scripts\/[A-Za-z0-9_.-]+/g)) {
        coveredScripts.add(match[0])
      }
    }
    if (row.severity) severityCounts[row.severity] = (severityCounts[row.severity] ?? 0) + 1
    if (row.disposition) dispositionCounts[row.disposition] = (dispositionCounts[row.disposition] ?? 0) + 1

    // Final-gate semantics land in WP-09; at this stage open/in-progress
    // blocking rows only warn.
    if ((row.status === 'open' || row.status === 'in-progress') && row.blockDefault === true) {
      warnings.push(`${where}: ${row.status} with blockDefault=true (will block the final gate)`)
    }
  })

  // A scanned CI entry point without a matrix row fails immediately (this is
  // how "new CI script without a matrix update" is caught).
  const scannedScripts = new Set(scan.entries.map((entry) => entry.slice(entry.indexOf(':') + 1)))
  for (const script of scannedScripts) {
    if (!coveredScripts.has(script)) {
      errors.push(`scanned entry point has no matrix row: ${script}`)
    }
  }

  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    details: {
      rows: rows.length,
      scannedEntries: scan.entries.length,
      listHash: scan.listHash,
      severityCounts,
      dispositionCounts,
      warnings,
      errors,
    },
  }
}

// ---------------------------------------------------------------------------
// registry + CLI
// ---------------------------------------------------------------------------

const checks = new Map<string, (ctx: CheckContext) => Promise<CheckResult>>([
  ['baseline', () => checkBaseline()],
  ['regression-matrix', () => checkRegressionMatrix()],
])

function defaultOutput(check: string): string {
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', `${check}.json`)
}

function parseArgs(argv: string[]) {
  const out: { check: string | null; output: string | null; profile: string | null; fixture: string | null } = {
    check: null,
    output: null,
    profile: null,
    fixture: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // pnpm forwards a literal `--` separator; skip it.
    if (arg === '--') continue
    if (arg === '--check') out.check = argv[++i] ?? null
    else if (arg === '--output') out.output = argv[++i] ?? null
    else if (arg === '--profile') out.profile = argv[++i] ?? null
    else if (arg === '--fixture') out.fixture = argv[++i] ?? null
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!out.check) throw new Error('--check <name> is required')
  return out
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  const t0 = performance.now()
  const artifact: Record<string, any> = {
    schemaVersion: 1,
    check: null,
    status: 'fail',
    details: {},
    startedAt,
    durationMs: 0,
    node: process.version,
    gitHead: await gitHead(),
    lockfileHash: await lockfileHash(),
  }

  let outputPath: string | null = null
  // Best-effort: honor --output even if a later unknown argument fails parsing.
  const rawArgs = process.argv.slice(2)
  const outputIndex = rawArgs.indexOf('--output')
  if (outputIndex >= 0 && rawArgs[outputIndex + 1]) {
    outputPath = path.resolve(rawArgs[outputIndex + 1])
  }
  let exitCode = 1
  try {
    const args = parseArgs(rawArgs)
    artifact.check = args.check
    outputPath = path.resolve(args.output ?? defaultOutput(args.check!))

    const check = checks.get(args.check!)
    if (!check) {
      artifact.details = { errors: [`unknown check: ${args.check}`, `available: ${[...checks.keys()].join(', ')}`] }
      return
    }
    const result = await check({ output: outputPath, profile: args.profile, fixture: args.fixture })
    artifact.status = result.status
    artifact.details = result.details
    exitCode = result.status === 'pass' ? 0 : 1
  } catch (error: any) {
    artifact.details = { errors: [String(error?.message || error)] }
    // --check may have parsed before the error (e.g. bad --output value);
    // fall back to a generic artifact path when the check name is unknown.
    outputPath ??= path.resolve(defaultOutput('unknown'))
  } finally {
    artifact.durationMs = Math.round((performance.now() - t0) * 1000) / 1000
    try {
      await writeArtifactAtomic(outputPath ?? path.resolve(defaultOutput('unknown')), artifact)
      console.log(`tui-v2 verify artifact written to ${outputPath} (check=${artifact.check ?? 'unknown'}, status=${artifact.status})`)
    } catch (error: any) {
      console.error(`failed to write artifact: ${String(error?.message || error)}`)
      exitCode = 1
    }
    process.exitCode = exitCode
  }
}

const invokedAsMain =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsMain) {
  await main()
}
