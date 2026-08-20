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
 *   - trace (WP-02):     fixtures/tui-v2/traces/*.jsonl load+validate;
 *                        fixtures/tui-v2/conformance/*.jsonl load, replay
 *                        through the local VirtualTerminal (and the pinned
 *                        xterm oracle for cross-check cases) and compare via
 *                        compareGrid; all five required golden grids exist,
 *                        validate and replay; every stored expected grid is
 *                        scanned for line-width violations and control-char
 *                        injection.
 *   - controllers (WP-05): static guards — src/tui-v2/controllers/** never
 *                        touch process.stdout/process.stderr/console;
 *                        src/tui-v2/components/** never import dsh-adapter or
 *                        cordis modules — plus a live/replay canonical-state
 *                        equivalence run driven through the controller rig
 *                        with dialog overlay open/navigate/settle/timeout.
 *
 * Every check writes an atomic JSON artifact
 *   { schemaVersion: 1, check, status, details, startedAt, durationMs,
 *     node, gitHead, lockfileHash }
 * and exits non-zero on failure (including unknown CLI args / unknown check).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { checkVendorTree, PINNED_COMMIT, VENDOR_REL } from './vendor-pi-tui.mjs'

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
// trace check (WP-02): trace fixtures + conformance corpus + golden grids
// ---------------------------------------------------------------------------

async function checkTrace(): Promise<CheckResult> {
  const {
    evaluateConformanceCase,
    evaluateGoldenFile,
    findGridControlInjection,
    readConformance,
    readGoldenFile,
    validateGoldenFile,
    REQUIRED_GOLDENS,
  } = await import('../src/tui-v2/testkit/conformance.js')
  const { findLineWidthViolations } = await import('../src/tui-v2/testkit/frame-assert.js')
  const { readTrace } = await import('../src/tui-v2/testkit/trace.js')

  const errors: string[] = []
  const tracesDir = path.join(repoRoot, 'fixtures', 'tui-v2', 'traces')
  const conformanceDir = path.join(repoRoot, 'fixtures', 'tui-v2', 'conformance')
  const goldensDir = path.join(repoRoot, 'test', 'tui-v2', 'goldens')

  // 1. Trace fixtures: load + validate (redaction integrity is covered by
  //    trace.test.ts; here we require the corpus to stay parseable).
  let traceCount = 0
  let traceFiles: string[] = []
  try {
    traceFiles = (await readdir(tracesDir)).filter((f) => f.endsWith('.jsonl')).sort()
    for (const file of traceFiles) {
      try {
        await readTrace(path.join(tracesDir, file))
        traceCount += 1
      } catch (error: any) {
        errors.push(`trace fixture ${file}: ${String(error?.message || error)}`)
      }
    }
  } catch (error: any) {
    errors.push(`traces dir unreadable: ${String(error?.message || error)}`)
  }

  // 2. Conformance corpus: load + validate + replay (local VT, plus the
  //    pinned xterm oracle for cross-check cases).
  const conformanceReport: {
    cases: number
    passed: number
    mismatches: { name: string; vtHash: string; xtermHash: string | null }[]
    byOracle: Record<string, number>
  } = { cases: 0, passed: 0, mismatches: [], byOracle: {} }
  let conformanceFiles: string[] = []
  try {
    conformanceFiles = (await readdir(conformanceDir)).filter((f) => f.endsWith('.jsonl')).sort()
  } catch (error: any) {
    errors.push(`conformance dir unreadable: ${String(error?.message || error)}`)
  }
  for (const file of conformanceFiles) {
    let kase: Awaited<ReturnType<typeof readConformance>>
    try {
      kase = await readConformance(path.join(conformanceDir, file))
    } catch (error: any) {
      errors.push(`conformance fixture ${file}: ${String(error?.message || error)}`)
      continue
    }
    conformanceReport.cases += 1
    const oracle = kase.header.oracle
    conformanceReport.byOracle[oracle] = (conformanceReport.byOracle[oracle] ?? 0) + 1
    for (const line of kase.lines) {
      if (line.kind === 'expectedGrid' && line.value.gridEncoding === 'readable') {
        for (const violation of findLineWidthViolations(line.value.value)) {
          errors.push(`conformance ${kase.header.name}: expected grid line-width invariant: ${violation}`)
        }
        for (const injection of findGridControlInjection(line.value.value)) {
          errors.push(`conformance ${kase.header.name}: expected grid ${injection}`)
        }
      }
    }
    const evaluation = await evaluateConformanceCase(kase)
    if (evaluation.ok) {
      conformanceReport.passed += 1
    } else {
      conformanceReport.mismatches.push({
        name: kase.header.name,
        vtHash: evaluation.vtHash,
        xtermHash: evaluation.xtermHash ?? null,
      })
      errors.push(`conformance ${kase.header.name}: ${evaluation.errors.join('; ')}`)
    }
  }

  // 3. Golden grids: all five required classes exist, validate, replay.
  let goldenCount = 0
  const seenGoldens = new Set<string>()
  let goldenFiles: string[] = []
  try {
    goldenFiles = (await readdir(goldensDir)).filter((f) => f.endsWith('.json')).sort()
  } catch (error: any) {
    errors.push(`goldens dir unreadable: ${String(error?.message || error)}`)
  }
  for (const file of goldenFiles) {
    let golden: Awaited<ReturnType<typeof readGoldenFile>>
    try {
      golden = await readGoldenFile(path.join(goldensDir, file))
    } catch (error: any) {
      errors.push(`golden ${file}: ${String(error?.message || error)}`)
      continue
    }
    seenGoldens.add(golden.name)
    goldenCount += 1
    const evaluation = evaluateGoldenFile(golden)
    if (!evaluation.ok) {
      errors.push(`golden ${golden.name}: ${evaluation.errors.join('; ')}`)
    }
    if (golden.expected.gridEncoding === 'readable') {
      for (const violation of findLineWidthViolations(golden.expected.value)) {
        errors.push(`golden ${golden.name}: expected grid line-width invariant: ${violation}`)
      }
      for (const injection of findGridControlInjection(golden.expected.value)) {
        errors.push(`golden ${golden.name}: expected grid ${injection}`)
      }
    }
  }
  for (const required of REQUIRED_GOLDENS) {
    if (!seenGoldens.has(required)) errors.push(`missing required golden: ${required}.json`)
  }

  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    details: {
      traces: { files: traceFiles.length, loaded: traceCount },
      parserConformance: conformanceReport,
      goldens: { files: goldenFiles.length, loaded: goldenCount, required: [...REQUIRED_GOLDENS] },
      errors,
    },
  }
}

// ---------------------------------------------------------------------------
// fork check (WP-03): vendored pi-tui integrity + facade boundary guards
// ---------------------------------------------------------------------------

const VENDOR_DIR = path.join(repoRoot, VENDOR_REL)
const FORK_REQUIRED_FILES = ['LICENSE', 'NOTICE', 'PATCH-LEDGER.md', 'VENDOR-MANIFEST.json']
// Importers allowed to reference the vendored tree: the terminal facade, the
// ported upstream tests and the re-vendor script itself.
const FORK_IMPORT_ALLOWLIST = [
  'src/tui-v2/terminal/pi.ts',
  'scripts/vendor-pi-tui.mjs',
]
const FORK_IMPORT_ALLOWLIST_PREFIX = ['test/tui-v2/pi-fork/']
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', 'lib', '.pnpm'])
// react/react-reconciler/react/jsx-runtime/yoga* specifiers (d: hot-path guard).
const FORBIDDEN_DEP_RE = /^(react|react-reconciler|yoga|yoga-layout)(\/.*)?$/
const IMPORT_SPEC_RE =
  /(?:\bfrom\s*|^import\s*|\bimport\s*\(\s*)(["'])([^"']+)\1/gm

async function walkCodeFiles(dir: string, base: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue
      out.push(...(await walkCodeFiles(full, base)))
    } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.relative(base, full).split(path.sep).join('/'))
    }
  }
  return out.sort()
}

/** Every import/export specifier referenced by a code file. */
async function fileSpecifiers(rel: string): Promise<string[]> {
  const content = await readFile(path.join(repoRoot, rel), 'utf8')
  return [...content.matchAll(IMPORT_SPEC_RE)].map((m) => m[2])
}

function resolvesIntoVendor(importerRel: string, spec: string): boolean {
  if (spec.includes('vendor/pi-tui')) return true
  if (!spec.startsWith('./') && !spec.startsWith('../')) return false
  const resolved = path
    .resolve(repoRoot, path.dirname(importerRel), spec)
    .split(path.sep)
    .join('/')
  return resolved.includes(`/${VENDOR_REL}/`) || resolved.endsWith(`/${VENDOR_REL}`)
}

function isAllowedForkImporter(rel: string): boolean {
  if (FORK_IMPORT_ALLOWLIST.includes(rel)) return true
  return FORK_IMPORT_ALLOWLIST_PREFIX.some((prefix) => rel.startsWith(prefix))
}

async function checkFork(): Promise<CheckResult> {
  const errors: string[] = []
  const details: Record<string, unknown> = {}

  // (a) vendor tree == manifest (identical logic to vendor-pi-tui.mjs --check,
  //     without the upstream checkout; CI-safe).
  const vendorCheck = await checkVendorTree({})
  details.manifest = {
    commit: vendorCheck.manifest?.commit ?? null,
    packageVersion: vendorCheck.manifest?.packageVersion ?? null,
    files: vendorCheck.counts?.files ?? 0,
    onDisk: vendorCheck.counts?.onDisk ?? 0,
    vendoredTs: vendorCheck.counts?.vendoredTs ?? 0,
  }
  for (const error of vendorCheck.errors) errors.push(`manifest: ${error}`)

  // (b) license/notice/ledger files exist.
  for (const name of FORK_REQUIRED_FILES) {
    if (!(await stat(path.join(VENDOR_DIR, name)).catch(() => null))?.isFile()) {
      errors.push(`missing required vendor file: ${VENDOR_REL}/${name}`)
    }
  }

  // (c) import guard: only the facade, the ported tests and the re-vendor
  //     script may reference src/tui-v2/vendor/pi-tui. Vendored files import
  //     each other relatively and are not importers for this guard.
  const codeFiles = await walkCodeFiles(repoRoot, repoRoot)
  const guardViolations: { file: string; specifier: string }[] = []
  for (const rel of codeFiles) {
    if (rel.startsWith(`${VENDOR_REL}/`)) continue
    if (isAllowedForkImporter(rel)) continue
    for (const spec of await fileSpecifiers(rel)) {
      if (resolvesIntoVendor(rel, spec)) guardViolations.push({ file: rel, specifier: spec })
    }
  }
  details.importGuard = { scannedFiles: codeFiles.length, violations: guardViolations }
  for (const v of guardViolations) {
    errors.push(`import guard: ${v.file} imports vendored path ${v.specifier} (only ${[...FORK_IMPORT_ALLOWLIST, ...FORK_IMPORT_ALLOWLIST_PREFIX].join(', ')} allowed)`)
  }

  // (d) no react/react-reconciler/yoga imports anywhere under src/tui-v2/**
  //     (the vendored tree included).
  const tuiV2Files = codeFiles.filter((f) => f.startsWith('src/tui-v2/'))
  const forbiddenHits: { file: string; specifier: string }[] = []
  for (const rel of tuiV2Files) {
    for (const spec of await fileSpecifiers(rel)) {
      if (FORBIDDEN_DEP_RE.test(spec)) forbiddenHits.push({ file: rel, specifier: spec })
    }
  }
  details.forbiddenDeps = { scannedFiles: tuiV2Files.length, hits: forbiddenHits }
  for (const hit of forbiddenHits) {
    errors.push(`forbidden dependency in ${hit.file}: ${hit.specifier}`)
  }

  // (e) every PATCH-LEDGER row's referenced repo paths must exist.
  const ledgerErrors: string[] = []
  try {
    const ledger = await readFile(path.join(VENDOR_DIR, 'PATCH-LEDGER.md'), 'utf8')
    const rows = ledger
      .split('\n')
      .filter((line) => line.startsWith('|') && !/^\|[\s-|]+\|$/.test(line))
      .filter((line) => !line.includes('| 文件 |'))
    const pathTokenRe = /(?:src|test|scripts|docs|fixtures)\/[\w./-]+/g
    let rowCount = 0
    for (const row of rows) {
      rowCount += 1
      const tokens = [...row.matchAll(/`([^`]+)`/g)].flatMap(
        (m) => [...m[1].matchAll(pathTokenRe)].map((t) => t[0]),
      )
      if (tokens.length === 0) {
        ledgerErrors.push(`ledger row ${rowCount} references no backticked repo path`)
        continue
      }
      for (const token of tokens) {
        let probe = token
        if (probe.includes('*')) probe = probe.slice(0, probe.indexOf('*'))
        probe = probe.replace(/[/.]+$/, '')
        if (probe === '') continue
        if (!(await stat(path.join(repoRoot, probe)).catch(() => null))) {
          ledgerErrors.push(`ledger row ${rowCount}: referenced path does not exist: ${token}`)
        }
      }
    }
    details.patchLedger = { rows: rowCount, errors: ledgerErrors }
  } catch (error: any) {
    ledgerErrors.push(`PATCH-LEDGER.md unreadable: ${String(error?.message || error)}`)
  }
  errors.push(...ledgerErrors)

  details.pinnedCommit = PINNED_COMMIT
  details.errors = errors
  return { status: errors.length === 0 ? 'pass' : 'fail', details }
}

// ---------------------------------------------------------------------------
// skeleton check (WP-04): traces through reducer+selectors+base-renderer,
// plus the three skeleton child-process cleanup scenarios
// ---------------------------------------------------------------------------

async function checkSkeleton(): Promise<CheckResult> {
  const { validateAppEvent } = await import('../src/tui-v2/model/events.js')
  const { createReducer } = await import('../src/tui-v2/model/reducer.js')
  const { serializeCanonicalUiState } = await import('../src/tui-v2/model/canonical-state.js')
  const { initialUiState } = await import('../src/tui-v2/model/state.js')
  const {
    selectDockView,
    selectEditorView,
    selectStatusLine,
    selectTranscriptView,
  } = await import('../src/tui-v2/model/selectors.js')
  const { createBaseRenderer } = await import('../src/tui-v2/renderer/base-renderer.js')
  const { measureLineWidth } = await import('../src/tui-v2/renderer/lines.js')
  const { createStatusLine } = await import('../src/tui-v2/components/chrome/status-line.js')
  const { createPromptEditor } = await import('../src/tui-v2/components/editor/prompt-editor.js')
  const { DEFAULT_COMPONENT_THEME } = await import('../src/tui-v2/components/theme.js')
  const { createAssistantMessage } = await import('../src/tui-v2/components/transcript/assistant-message.js')
  const { asRowBlocks } = await import('../src/tui-v2/components/transcript/row-view.js')
  const { createToolRow } = await import('../src/tui-v2/components/transcript/tool-row.js')
  const { createUserMessage } = await import('../src/tui-v2/components/transcript/user-message.js')
  const { getProfile } = await import('../src/tui-v2/testkit/terminal-profiles.js')
  const { readTrace } = await import('../src/tui-v2/testkit/trace.js')
  const { runSkeletonChild } = await import('../test/tui-v2/helpers/run-skeleton-child.js')

  const errors: string[] = []
  const warnings: string[] = []
  const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }

  // ---- part 1: every trace through reducer + selectors + base-renderer ----
  // All current fixtures are oracle='differential-only': no golden grid is
  // consulted; we assert the pipeline never throws, physical line widths stay
  // inside the viewport, and the final canonical state serializes.
  const WIDTH = 120
  const HEIGHT = 40
  const tracesDir = path.join(repoRoot, 'fixtures', 'tui-v2', 'traces')
  const traceReports: {
    name: string
    oracle: string
    events: number
    frames: number
    maxLineWidth: number
    canonicalHash: string
    diagnostics: Record<string, number>
  }[] = []

  const traceFiles = (await readdir(tracesDir)).filter((f) => f.endsWith('.jsonl')).sort()
  for (const file of traceFiles) {
    const name = file.replace(/\.jsonl$/, '')
    try {
      const trace = await readTrace(path.join(tracesDir, file))
      const profile =
        typeof trace.header.terminalProfile === 'string'
          ? { ...getProfile(trace.header.terminalProfile), columns: WIDTH, rows: HEIGHT }
          : { ...trace.header.terminalProfile, columns: WIDTH, rows: HEIGHT }
      if (trace.header.oracle !== 'differential-only') {
        warnings.push(`${name}: oracle=${trace.header.oracle} rendered without golden comparison (skeleton scope)`)
      }

      const editor = createPromptEditor({ profile, theme: DEFAULT_COMPONENT_THEME, terminalRows: HEIGHT })
      const renderer = createBaseRenderer({
        profile,
        theme: 'verify-skeleton',
        registry: {
          componentFor: (kind) => {
            if (kind === 'user') return (row) => createUserMessage(viewOf(row, false), profile)
            if (kind === 'assistant') return (row, streaming) => createAssistantMessage(viewOf(row, streaming), profile)
            if (kind === 'tool') return (row, streaming) => createToolRow(viewOf(row, streaming), profile)
            return undefined
          },
        },
        dock: {
          editor: (view) => {
            editor.syncFromView(view)
            return editor
          },
          status: (view) => createStatusLine(view, { profile, theme: DEFAULT_COMPONENT_THEME }),
          activity: () => null,
        },
      })
      const viewOf = (row: any, streaming: boolean) => ({
        rowId: row.rowId,
        revision: row.revision,
        blocks: asRowBlocks(row.blocks),
        streaming,
        ...(row.tool !== undefined ? { tool: row.tool } : {}),
        theme: DEFAULT_COMPONENT_THEME,
      })

      const reducer = createReducer({ clock })
      let state = initialUiState({
        width: WIDTH,
        height: HEIGHT,
        profileId: profile.id,
        theme: 'verify-skeleton',
        language: 'en',
      })
      let events = 0
      let frames = 0
      let maxLineWidth = 0
      for (const line of trace.lines) {
        if (line.kind !== 'event') continue
        events += 1
        state = reducer.reduce(state, validateAppEvent(line.event))
        const width = state.viewport.width
        const output = renderer.render({
          transcript: selectTranscriptView(state),
          dock: selectDockView(state),
          editor: selectEditorView(state),
          status: selectStatusLine(state),
          width,
          height: state.viewport.height,
          sessionEpoch: state.session.sessionEpoch,
          sticky: state.viewport.sticky,
        })
        frames += 1
        if (output.lines.length !== state.viewport.height && output.lines.length !== 0) {
          errors.push(`${name}: event ${events}: rendered ${output.lines.length} lines for height ${state.viewport.height}`)
        }
        for (const [lineNo, rendered] of output.lines.entries()) {
          const w = measureLineWidth(rendered, profile)
          if (w > maxLineWidth) maxLineWidth = w
          if (w > width) {
            errors.push(`${name}: event ${events} line ${lineNo}: physical width ${w} exceeds viewport ${width}`)
          }
        }
      }
      const canonical = serializeCanonicalUiState(state)
      traceReports.push({
        name,
        oracle: trace.header.oracle,
        events,
        frames,
        maxLineWidth,
        canonicalHash: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
        diagnostics: { ...state.diagnostics },
      })
    } catch (error: any) {
      errors.push(`trace ${name}: ${String(error?.message || error)}`)
    }
  }

  // ---- part 2: child-process cleanup scenarios ----
  const reportDir = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-skeleton-verify-'))
  const childReports: { scenario: string; exitCode: number | null; checks: Record<string, boolean> }[] = []
  const expectedExit: Record<string, number> = { normal: 0, sigterm: 0, error: 3 }
  for (const scenario of ['normal', 'sigterm', 'error'] as const) {
    try {
      const result = await runSkeletonChild(scenario, { reportDir })
      childReports.push({ scenario, exitCode: result.exitCode, checks: result.report.checks })
      if (result.exitCode !== expectedExit[scenario]) {
        errors.push(`skeleton child ${scenario}: exit ${result.exitCode} (want ${expectedExit[scenario]}); stderr: ${result.stderrTail.slice(-400)}`)
      }
      for (const [checkName, ok] of Object.entries(result.report.checks)) {
        if (!ok) errors.push(`skeleton child ${scenario}: check ${checkName} failed`)
      }
      if (result.report.vtModesAfterStop.alternateScreen === true) {
        errors.push(`skeleton child ${scenario}: alternate screen still on after stop`)
      }
      const rawModes = result.report.stdinRawModes
      if (rawModes.length === 0 || rawModes[rawModes.length - 1] !== false) {
        errors.push(`skeleton child ${scenario}: stdin raw mode not restored: ${JSON.stringify(rawModes)}`)
      }
    } catch (error: any) {
      errors.push(`skeleton child ${scenario}: ${String(error?.message || error)}`)
    }
  }

  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    details: { traces: traceReports, children: childReports, warnings, errors },
  }
}

// ---------------------------------------------------------------------------
// controllers check (WP-05): static guards + live/replay canonical equivalence
// ---------------------------------------------------------------------------

async function checkControllers(): Promise<CheckResult> {
  const errors: string[] = []
  const details: Record<string, unknown> = {}

  // (a) controllers never write to the terminal directly: no process.stdout /
  //     process.stderr / console.* outside comment lines (the model is the
  //     only output; §4.3/§5.2).
  const controllersDir = path.join(repoRoot, 'src', 'tui-v2', 'controllers')
  const controllerFiles = (await readdir(controllersDir)).filter((f) => f.endsWith('.ts')).sort()
  const CONTROLLER_FORBIDDEN = /process\.stdout|process\.stderr|console\./
  const stdoutHits: { file: string; line: number; text: string }[] = []
  for (const file of controllerFiles) {
    const source = await readFile(path.join(controllersDir, file), 'utf8')
    source.split('\n').forEach((line, index) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      if (CONTROLLER_FORBIDDEN.test(line)) {
        stdoutHits.push({ file, line: index + 1, text: trimmed.slice(0, 120) })
      }
    })
  }
  for (const hit of stdoutHits) {
    errors.push(`controllers guard: ${hit.file}:${hit.line} touches stdout/stderr/console: ${hit.text}`)
  }
  details.controllerGuard = { files: controllerFiles, hits: stdoutHits }

  // (b) components never import dsh-adapter / cordis (pure renderers, §4.3).
  const componentFiles = await walkCodeFiles(path.join(repoRoot, 'src', 'tui-v2', 'components'), repoRoot)
  const COMPONENT_FORBIDDEN = /dsh-adapter|cordis/i
  const importHits: { file: string; specifier: string }[] = []
  for (const rel of componentFiles) {
    for (const spec of await fileSpecifiers(rel)) {
      if (COMPONENT_FORBIDDEN.test(spec)) importHits.push({ file: rel, specifier: spec })
    }
  }
  for (const hit of importHits) {
    errors.push(`components guard: ${hit.file} imports ${hit.specifier} (dsh-adapter/cordis forbidden in components)`)
  }
  details.componentGuard = { files: componentFiles, hits: importHits }

  // (c) live/replay canonical equivalence over a dialog scenario: overlay
  //     open / navigate / preemption chain / settle / timeout, driven through
  //     the controller rig; the recorded live stream must replay to a
  //     byte-identical canonical state (§5.2).
  const { createControllerRig, ManualClock, addUserRows } = await import(
    '../test/tui-v2/helpers/controller-rig.js'
  )
  const { createFakeApprovalStore, createFakePluginDialogStore, createFakeQuestionStore } = await import(
    '../test/tui-v2/helpers/fake-dialog-stores.js'
  )
  const { createDialogsController } = await import('../src/tui-v2/controllers/dialogs.js')
  const { replayTrace } = await import('../src/tui-v2/controllers/replay.js')
  const { serializeCanonicalUiState } = await import('../src/tui-v2/model/canonical-state.js')
  const { createReducer } = await import('../src/tui-v2/model/reducer.js')

  try {
    const rig = createControllerRig({ height: 8 })
    const approvals = createFakeApprovalStore()
    const questions = createFakeQuestionStore()
    const dialogs = createFakePluginDialogStore(rig.clock)
    const controller = createDialogsController({
      dispatch: (event) => rig.streaming.ingest(event),
      nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
      getState: rig.state,
      approvals,
      questions,
      dialogs,
    })
    controller.start()
    const key = (name: string) =>
      ({
        kind: 'key' as const,
        sequence: 0,
        generation: 0,
        payload: { key: name, raw: '', text: null, eventType: 'press' as const },
      })
    const focusId = () => {
      const focus = rig.state().focus
      return focus.target === 'overlay' ? focus.overlayId : 'editor'
    }

    addUserRows(rig, 2)

    // Priority chain: question < plugin dialog < approval. The question parks
    // first; the plugin dialog preempts it; the approval preempts both.
    const questionPromise = questions.ask({
      questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'a' }, { label: 'b' }] }],
    })
    const selectPromise = dialogs.ask({
      kind: 'select',
      title: 'Choose',
      options: [
        { id: 'o1', label: 'One' },
        { id: 'o2', label: 'Two' },
      ],
    })
    const approvalPromise = approvals.park({ toolName: 'Bash', command: 'ls' })
    if (focusId() !== 'dialog/approval/1') errors.push(`approval should hold focus, got ${focusId()}`)

    // Reject the approval (down -> No -> Enter): the plugin dialog resurfaces.
    controller.handleInput(key('down'))
    controller.handleInput(key('enter'))
    if ((await approvalPromise) !== 'rejected') errors.push('approval outcome must be rejected')
    if (focusId() !== 'dialog/plugin-dialog/dlg-1') {
      errors.push(`plugin dialog should resurface after the approval, got ${focusId()}`)
    }

    // Settle the select: the question resurfaces; answer it (down -> 'b').
    controller.handleInput(key('enter'))
    if ((await selectPromise) !== 'o1') errors.push('select answer must be o1')
    if (focusId() !== 'dialog/question/1-0') {
      errors.push(`question should resurface after the select, got ${focusId()}`)
    }
    controller.handleInput(key('down'))
    controller.handleInput(key('enter'))
    const answered = await questionPromise
    if (JSON.stringify(answered.answers) !== JSON.stringify([{ id: 'q1', selected: ['b'] }])) {
      errors.push(`question answers mismatch: ${JSON.stringify(answered.answers)}`)
    }
    if (focusId() !== 'editor') errors.push(`focus must fall back to the editor, got ${focusId()}`)

    // Timeout path: settle via the store clock, overlay closes, focus editor.
    const timed = dialogs.ask({ kind: 'confirm', title: 'T', confirmLabel: '', cancelLabel: '' }, 250)
    if (focusId() !== 'dialog/plugin-dialog/dlg-2') errors.push(`confirm dialog should open, got ${focusId()}`)
    rig.clock.advance(250)
    if ((await timed) !== undefined) errors.push('a timed-out dialog must resolve undefined')
    if (focusId() !== 'editor') errors.push(`timeout must close the overlay, focus=${focusId()}`)

    controller.dispose()

    // Overlay event hygiene: source discipline + explicit capturing pair.
    const overlayEvents = rig.applied.filter((e) => e.type === 'overlay/open' || e.type === 'overlay/close')
    if (overlayEvents.length === 0) errors.push('scenario produced no overlay events')
    for (const event of overlayEvents) {
      if (event.source !== 'overlay') errors.push(`overlay event with wrong source: ${event.source}`)
      if (event.type === 'overlay/open') {
        const overlay = event.overlay
        if (overlay.captureInput !== true || overlay.nonCapturing !== false) {
          errors.push(`overlay ${overlay.overlayId} not normalized as capturing`)
        }
      }
    }

    const liveCanonical = serializeCanonicalUiState(rig.state())
    const replayed = replayTrace(rig.applied, createReducer({ clock: new ManualClock() }), rig.initialState)
    const replayCanonical = serializeCanonicalUiState(replayed)
    if (liveCanonical !== replayCanonical) {
      errors.push('live/replay canonical state mismatch (serializeCanonicalUiState bytes differ)')
    }
    details.equivalence = {
      events: rig.applied.length,
      overlayEvents: overlayEvents.length,
      canonicalHash: sha256Hex(liveCanonical).slice(0, 16),
      equal: liveCanonical === replayCanonical,
    }
    details.dialogDiagnostics = controller.diagnostics()
  } catch (error: any) {
    errors.push(`scenario failed: ${String(error?.message || error)}`)
  }

  details.errors = errors
  return { status: errors.length === 0 ? 'pass' : 'fail', details }
}

// ---------------------------------------------------------------------------
// registry + CLI
// ---------------------------------------------------------------------------

const checks = new Map<string, (ctx: CheckContext) => Promise<CheckResult>>([
  ['baseline', () => checkBaseline()],
  ['regression-matrix', () => checkRegressionMatrix()],
  ['trace', () => checkTrace()],
  ['fork', () => checkFork()],
  ['skeleton', () => checkSkeleton()],
  ['controllers', () => checkControllers()],
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
