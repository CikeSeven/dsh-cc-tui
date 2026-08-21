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
 *   - fullscreen (WP-06d): the §9.2 differential formula through the real
 *                        pipeline — required goldens reproduced via base
 *                        renderer → buildFrame → compositeFrame → backend →
 *                        encoder → VirtualTerminal; every trace scanned
 *                        frame-by-frame under the golden profiles; a scripted
 *                        overlay open/move/resize/nest/close no-ghosting
 *                        scan; and the §9.3 P0/P1 regression-fixture ledger
 *                        (WP-08 domains registered as deferred).
 *   - inline (WP-07):    every trace replayed through the inline pipeline
 *                        (reducer → selectors → base-renderer → inline hint →
 *                        buildFrame → compositor → InlineBackend) with
 *                        canonical + VT byte replay and append-only scrollback
 *                        invariants; the inline-scrollback trace must
 *                        demonstrate the append recipe (feeds > 0); the
 *                        third-party-output re-anchor drill (guard detection,
 *                        no scrollback growth, detach restore); the cleanup
 *                        drills (sigterm/error: modes restored, cursor parked);
 *                        and the docs/tui-v2/support-matrix.md machine block
 *                        validated against INLINE_/FULLSCREEN_CAPABILITIES.
 *   - ownership (WP-09c1): production dependency closure + AST output/control
 *                        scan matched one-to-one against the structured owner
 *                        ledger, plus a live writer/query/generation drill.
 *   - ci-integration (WP-09c1): parsed workflow/package contracts and bounded
 *                        non-recursive local probes; exact-tarball publish is
 *                        staged until WP-09c2 and becomes strict under --final.
 *
 * Every check writes an atomic JSON artifact
 *   { schemaVersion: 1, check, status, details, startedAt, durationMs,
 *     node, gitHead, lockfileHash }
 * and exits non-zero on failure (including unknown CLI args / unknown check).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as ts from 'typescript'
import { checkVendorTree, PINNED_COMMIT, VENDOR_REL } from './vendor-pi-tui.mjs'

const execFileAsync = promisify(execFile)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

const SCAN_COMMAND = "rg -o 'scripts/[A-Za-z0-9_.-]+' .github/workflows package.json | LC_ALL=C sort -u"

interface CheckContext {
  output: string
  profile: string | null
  fixture: string | null
  final: boolean
  rollbackManifest: string | null
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
    if (!Number.isInteger(meta.entryCount) || meta.entryCount !== scan.entries.length) {
      errors.push(`scan.entryCount ${JSON.stringify(meta.entryCount)} does not match re-scan ${scan.entries.length}`)
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
        const script = match[0]
        coveredScripts.add(script)
        if (row.disposition !== 'remove' && !existsSync(path.join(repoRoot, script))) {
          errors.push(`${where}: non-remove row references missing script ${script}`)
        }
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
  'src/tui-v2/terminal/pi-editor.ts',
  'src/tui-v2/terminal/pi-input.ts',
  'scripts/vendor-pi-tui.mjs',
]
const FORK_IMPORT_ALLOWLIST_PREFIX = ['test/tui-v2/pi-fork/']
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', 'lib', '.pnpm'])
// Retired runtime package specifiers are checked by FORBIDDEN_DEP_RE.
const RETIRED_RUNTIME_NAMES = [
  ['re', 'act'].join(''), ['re', 'act-', 'reconciler'].join(''),
  ['yo', 'ga'].join(''), ['yo', 'ga-layout'].join(''),
] as const
const FORBIDDEN_DEP_RE = new RegExp(`^(?:${RETIRED_RUNTIME_NAMES.join('|')})(/.*)?$`, 'u')
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

  // (d) no retired runtime package imports anywhere under src/tui-v2/**
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
// fullscreen check (WP-06d): §9.2 differential formula through the real
// pipeline (golden replay + trace scan + overlay no-ghosting) and the §9.3
// P0/P1 regression-fixture ledger.
// ---------------------------------------------------------------------------

type FullscreenLedgerRef =
  | { readonly kind: 'conformance' | 'trace'; readonly name: string }
  | { readonly kind: 'golden'; readonly name: string }
  | { readonly kind: 'test'; readonly file: string }
  | { readonly kind: 'check'; readonly name: string }
  | { readonly kind: 'fullscreen-part'; readonly name: 'golden-replay' | 'differential' | 'overlay-scan' }

interface FullscreenLedgerEntry {
  readonly id: string
  readonly severity: 'P0' | 'P1'
  /** §9.3 requirement, abbreviated. */
  readonly requirement: string
  readonly covers: readonly FullscreenLedgerRef[]
  /** Remaining WP-07/WP-08 domain entries may be deferred; completed domains carry explicit coverage. */
  readonly deferred?: 'WP-07' | 'WP-08'
}

const FULLSCREEN_SCAN_PROFILES = ['unicode-ambiguous-narrow', 'kitty-sync'] as const

const FULLSCREEN_LEDGER: readonly FullscreenLedgerEntry[] = [
  {
    id: 'cjk-width1',
    severity: 'P1',
    requirement: '单个 CJK grapheme 在 width=1 时不递归、不溢出、不丢失后续 cursor',
    covers: [{ kind: 'conformance', name: 'wide-cjk-width1' }],
  },
  {
    id: 'wide-grapheme-boundaries',
    severity: 'P1',
    requirement: 'ZWJ emoji、regional indicator、组合字符和宽字符边界不被劈开',
    covers: [
      { kind: 'conformance', name: 'wide-zwj-emoji' },
      { kind: 'conformance', name: 'wide-ambiguous-narrow' },
      { kind: 'conformance', name: 'wide-ambiguous-wide' },
      { kind: 'conformance', name: 'wide-cjk' },
    ],
  },
  {
    id: 'cjk-link-boundary',
    severity: 'P1',
    requirement: 'CJK URL/Markdown 链接在边界处不多一列或少一列',
    covers: [
      { kind: 'test', file: 'test/tui-v2/components-content.test.ts' },
      { kind: 'test', file: 'test/tui-v2/fullscreen-overlay-scan.test.ts' },
    ],
  },
  {
    id: 'sgr-osc8-style-leak',
    severity: 'P0',
    requirement: 'ANSI SGR/OSC 8 在换行、截断、overlay 覆盖后 style 不泄漏',
    covers: [
      { kind: 'conformance', name: 'sgr-attributes' },
      { kind: 'conformance', name: 'osc8-hyperlinks' },
      { kind: 'fullscreen-part', name: 'overlay-scan' },
    ],
  },
  {
    id: 'cache-sliced-string',
    severity: 'P1',
    requirement: '长流式行的 cache key 不持有 sliced string（单调堆增长）',
    covers: [{ kind: 'test', file: 'test/tui-v2/renderer-cache.test.ts' }],
  },
  {
    id: 'row-cache-invalidation',
    severity: 'P1',
    requirement: '完成 row 的 cache 不因 spinner、通知或其他 row 更新而失效',
    covers: [
      { kind: 'test', file: 'test/tui-v2/base-renderer.test.ts' },
      { kind: 'test', file: 'test/tui-v2/renderer-cache.test.ts' },
    ],
  },
  {
    id: 'overlay-restore',
    severity: 'P1',
    requirement: 'overlay 覆盖 transcript 后缩小、移动、关闭，base cell 完全恢复',
    covers: [
      { kind: 'test', file: 'test/tui-v2/compositor.test.ts' },
      { kind: 'fullscreen-part', name: 'overlay-scan' },
    ],
  },
  {
    id: 'resize-no-ghost',
    severity: 'P1',
    requirement: 'resize 在 stream、dialog、selection、scroll 中不重复、不残影、不坐标漂移',
    covers: [
      { kind: 'trace', name: 'resize' },
      { kind: 'golden', name: 'resize' },
      { kind: 'test', file: 'test/tui-v2/fullscreen-backend.test.ts' },
      { kind: 'fullscreen-part', name: 'differential' },
    ],
  },
  {
    id: 'sticky-scroll-resume',
    severity: 'P1',
    requirement: 'sticky scroll 打断后只在明确到达底部时恢复，new-message count 正确递减',
    covers: [
      { kind: 'test', file: 'test/tui-v2/controllers-scrolling.test.ts' },
      { kind: 'trace', name: 'scroll' },
    ],
  },
  {
    id: 'ctrl-c-tristate',
    severity: 'P0',
    requirement: 'Ctrl+C 在 working/idle/second press 三种状态都能得到预期结果',
    covers: [
      { kind: 'test', file: 'test/tui-v2/controllers-input.test.ts' },
      { kind: 'test', file: 'test/tui-v2/walking-skeleton.test.ts' },
    ],
  },
  {
    id: 'signal-mode-restore',
    severity: 'P0',
    requirement: 'SIGINT/SIGTERM/异常/stdin close/update restart 后 raw/alt/mouse/paste/cursor 全部恢复',
    covers: [
      { kind: 'test', file: 'test/tui-v2/terminal-lifecycle.test.ts' },
      { kind: 'test', file: 'test/tui-v2/walking-skeleton.test.ts' },
      { kind: 'golden', name: 'cleanup' },
    ],
  },
  {
    id: 'injection-sanitize',
    severity: 'P0',
    requirement: 'C0/CSI/OSC/DEC/OSC 8/52 payload 被当作数据清洗；fuzz 后 mode/cursor/scrollback/generation 不变量成立',
    covers: [
      { kind: 'conformance', name: 'unknown-sequences' },
      { kind: 'conformance', name: 'dec9001' },
      { kind: 'conformance', name: 'osc8-hyperlinks' },
      { kind: 'conformance', name: 'osc52-clipboard' },
      { kind: 'test', file: 'test/tui-v2/renderer-cells-width.test.ts' },
      { kind: 'check', name: 'trace' },
    ],
  },
  {
    id: 'writer-backpressure',
    severity: 'P1',
    requirement: 'highWaterMark/partial write/write error/过期 frame/cleanup timeout/capability query timeout 有 fixture，诊断有限脱敏',
    covers: [
      { kind: 'test', file: 'test/tui-v2/terminal-writer.test.ts' },
      { kind: 'conformance', name: 'partial-writes' },
      { kind: 'test', file: 'test/tui-v2/terminal-lifecycle.test.ts' },
    ],
  },
  {
    id: 'kitty-keyboard',
    severity: 'P1',
    requirement: 'Kitty keyboard negotiation 最小 trace/profile',
    covers: [{ kind: 'conformance', name: 'kitty-keyboard' }],
  },
  {
    id: 'mouse-modes',
    severity: 'P1',
    requirement: 'mouse 最小 trace/profile',
    covers: [{ kind: 'conformance', name: 'mouse-modes' }],
  },
  {
    id: 'osc52-clipboard',
    severity: 'P1',
    requirement: 'OSC52 最小 trace/profile',
    covers: [{ kind: 'conformance', name: 'osc52-clipboard' }],
  },
  {
    id: 'image-fallback',
    severity: 'P1',
    requirement: 'Kitty/iTerm2 image store、writer ordering/chunking、inline/null/sixel fallback 与 hash-only trace/profile',
    covers: [
      { kind: 'trace', name: 'image-fallback@v1' },
      { kind: 'conformance', name: 'image-kitty' },
      { kind: 'conformance', name: 'image-iterm2-unsupported' },
      { kind: 'test', file: 'test/tui-v2/image-store.test.ts' },
      { kind: 'test', file: 'test/tui-v2/image-placement.test.ts' },
      { kind: 'test', file: 'test/tui-v2/image-writer.test.ts' },
      { kind: 'test', file: 'test/tui-v2/image-adapter-boundary.test.ts' },
    ],
  },
  {
    id: 'inline-scrollback-incremental',
    severity: 'P1',
    requirement: '主屏 inline 不把每次局部更新复制进 scrollback，不用清空 scrollback 的危险序列',
    covers: [
      { kind: 'trace', name: 'inline-scrollback' },
      { kind: 'test', file: 'test/tui-v2/inline-backend.test.ts' },
      { kind: 'test', file: 'test/tui-v2/inline-pipeline.test.ts' },
      { kind: 'check', name: 'inline' },
    ],
  },
  {
    id: 'third-party-stdout',
    severity: 'P1',
    requirement: '第三方 stdout/stderr 最小 trace/profile',
    covers: [
      { kind: 'test', file: 'test/tui-v2/inline-third-party-output.test.ts' },
      { kind: 'check', name: 'inline' },
    ],
  },
  {
    id: 'external-editor-suspend-resume',
    severity: 'P1',
    requirement: 'external editor/update 暂停/恢复最小 trace/profile',
    covers: [],
    deferred: 'WP-08',
  },
  {
    id: 'plugin-component-crash',
    severity: 'P1',
    requirement: 'plugin component 抛错最小 trace/profile',
    covers: [],
    deferred: 'WP-08',
  },
]

async function checkFullscreen(): Promise<CheckResult> {
  const {
    evaluateGoldenFile,
    readConformance,
    readGoldenFile,
    REQUIRED_GOLDENS,
  } = await import('../src/tui-v2/testkit/conformance.js')
  const { readTrace } = await import('../src/tui-v2/testkit/trace.js')
  const { getProfile } = await import('../src/tui-v2/testkit/terminal-profiles.js')
  const {
    runGoldenPipelineReplay,
    runOverlayGhostingScan,
    runTraceDifferential,
  } = await import('../test/tui-v2/helpers/fullscreen-harness.js')

  const errors: string[] = []
  const tracesDir = path.join(repoRoot, 'fixtures', 'tui-v2', 'traces')
  const conformanceDir = path.join(repoRoot, 'fixtures', 'tui-v2', 'conformance')
  const goldensDir = path.join(repoRoot, 'test', 'tui-v2', 'goldens')

  // Part 1 — golden screens reproduced through the v2 fullscreen pipeline.
  // Half A is the oracle replay (evaluateGoldenFile, reused as-is); half B
  // rebuilds the same expected grid from base renderer output bytes.
  const goldenResults: Record<string, unknown>[] = []
  let goldenFiles: string[] = []
  try {
    goldenFiles = (await readdir(goldensDir)).filter((f) => f.endsWith('.json')).sort()
  } catch (error: any) {
    errors.push(`goldens dir unreadable: ${String(error?.message || error)}`)
  }
  const seenGoldens = new Set<string>()
  for (const file of goldenFiles) {
    try {
      const golden = await readGoldenFile(path.join(goldensDir, file))
      seenGoldens.add(golden.name)
      const oracle = evaluateGoldenFile(golden)
      const replay = runGoldenPipelineReplay(golden)
      if (!oracle.ok) errors.push(`golden ${golden.name} oracle half: ${oracle.errors.join('; ')}`)
      if (!replay.ok) {
        errors.push(
          `golden ${golden.name} pipeline half: ${replay.failures.map((f) => `[${f.scope}] ${f.message}`).join('; ')}`,
        )
      }
      goldenResults.push({
        name: golden.name,
        profile: golden.profile,
        oracleOk: oracle.ok,
        pipelineOk: replay.ok,
        bytes: replay.bytes,
        gridHash: replay.gridHash,
        projections: replay.projections,
        failures: replay.failures,
      })
    } catch (error: any) {
      errors.push(`golden ${file}: ${String(error?.message || error)}`)
    }
  }
  for (const required of REQUIRED_GOLDENS) {
    if (!seenGoldens.has(required)) errors.push(`missing required golden: ${required}.json`)
  }

  // Part 2 — §9.2 differential formula over every trace, under exactly the
  // profiles the goldens pin.
  const differential = {
    profiles: [...FULLSCREEN_SCAN_PROFILES],
    traces: 0,
    frames: 0,
    fullRedraws: 0,
    modeOps: 0,
    bytes: 0,
    maxRowWidth: 0,
    perTrace: [] as Record<string, unknown>[],
    failures: [] as unknown[],
  }
  let traceFiles: string[] = []
  try {
    traceFiles = (await readdir(tracesDir)).filter((f) => f.endsWith('.jsonl')).sort()
  } catch (error: any) {
    errors.push(`traces dir unreadable: ${String(error?.message || error)}`)
  }
  for (const file of traceFiles) {
    try {
      const trace = await readTrace(path.join(tracesDir, file))
      differential.traces += 1
      for (const profileId of FULLSCREEN_SCAN_PROFILES) {
        const result = runTraceDifferential(trace, getProfile(profileId))
        differential.frames += result.frames
        differential.fullRedraws += result.fullRedraws
        differential.modeOps += result.modeOps
        differential.bytes += result.bytes
        differential.maxRowWidth = Math.max(differential.maxRowWidth, result.maxRowWidth)
        if (!result.ok) {
          errors.push(
            `trace ${result.trace} @ ${profileId}: ${result.failures.map((f) => `[${f.scope}] ${f.frameId ?? ''} ${f.message}`).join('; ')}`,
          )
          differential.failures.push(...result.failures)
        }
        differential.perTrace.push({
          trace: result.trace,
          profile: profileId,
          events: result.events,
          frames: result.frames,
          fullRedraws: result.fullRedraws,
          modeOps: result.modeOps,
          bytes: result.bytes,
          ok: result.ok,
          gridHash: result.gridHash,
          vtHash: result.vtHash,
        })
      }
    } catch (error: any) {
      errors.push(`trace fixture ${file}: ${String(error?.message || error)}`)
    }
  }

  // Part 3 — programmatic overlay no-ghosting scan (open/move/resize/nest/
  // close, center+edge anchors, percentage sizes, two-level nesting).
  const overlayScan = {
    scenario: '',
    steps: 0,
    profiles: [] as Record<string, unknown>[],
    failures: [] as unknown[],
  }
  for (const profileId of FULLSCREEN_SCAN_PROFILES) {
    const result = runOverlayGhostingScan(getProfile(profileId))
    overlayScan.scenario = result.scenario
    overlayScan.steps = result.steps
    if (!result.ok) {
      errors.push(
        `overlay scan @ ${profileId}: ${result.failures.map((f) => `[${f.scope}] ${f.frameId ?? ''} ${f.message}`).join('; ')}`,
      )
      overlayScan.failures.push(...result.failures)
    }
    overlayScan.profiles.push({
      profile: profileId,
      frames: result.frames,
      fullRedraws: result.fullRedraws,
      bytes: result.bytes,
      ok: result.ok,
      gridHash: result.gridHash,
      vtHash: result.vtHash,
    })
  }

  // Part 4 — §9.3 P0/P1 ledger: every entry maps to resolvable coverage;
  // WP-08 domains are registered as deferred and never fail.
  const resolveRef = async (ref: FullscreenLedgerRef): Promise<string | null> => {
    try {
      switch (ref.kind) {
        case 'conformance':
          await readConformance(path.join(conformanceDir, `${ref.name}.jsonl`))
          return null
        case 'trace':
          await readTrace(path.join(tracesDir, `${ref.name}.jsonl`))
          return null
        case 'golden':
          await readGoldenFile(path.join(goldensDir, `${ref.name}.json`))
          return null
        case 'test':
          await stat(path.join(repoRoot, ref.file))
          return null
        case 'check':
          return checks.has(ref.name) ? null : `unknown check ${ref.name}`
        case 'fullscreen-part':
          return null
      }
    } catch (error: any) {
      return String(error?.message || error)
    }
  }
  const ledgerEntries: Record<string, unknown>[] = []
  for (const entry of FULLSCREEN_LEDGER) {
    if (entry.deferred !== undefined) {
      ledgerEntries.push({ id: entry.id, severity: entry.severity, requirement: entry.requirement, status: 'deferred', deferred: entry.deferred })
      continue
    }
    if (entry.covers.length === 0) {
      errors.push(`ledger ${entry.id}: no coverage registered and not deferred`)
      ledgerEntries.push({ id: entry.id, severity: entry.severity, requirement: entry.requirement, status: 'uncovered' })
      continue
    }
    const missingRefs: string[] = []
    for (const ref of entry.covers) {
      const problem = await resolveRef(ref)
      if (problem !== null) missingRefs.push(`${ref.kind}:${ref.kind === 'test' ? ref.file : ref.name} (${problem})`)
    }
    if (missingRefs.length > 0) {
      errors.push(`ledger ${entry.id}: unresolved coverage: ${missingRefs.join('; ')}`)
    }
    ledgerEntries.push({
      id: entry.id,
      severity: entry.severity,
      requirement: entry.requirement,
      status: missingRefs.length === 0 ? 'covered' : 'uncovered',
      covers: entry.covers.map((ref) => (ref.kind === 'test' ? ref.file : `${ref.kind}:${ref.name}`)),
      ...(missingRefs.length > 0 ? { missingRefs } : {}),
    })
  }

  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    details: {
      goldens: { required: [...REQUIRED_GOLDENS], results: goldenResults },
      differential,
      overlayScan,
      ledger: {
        total: FULLSCREEN_LEDGER.length,
        covered: ledgerEntries.filter((e: any) => e.status === 'covered').length,
        deferred: FULLSCREEN_LEDGER.filter((e) => e.deferred !== undefined).map((e) => ({ id: e.id, deferred: e.deferred })),
        entries: ledgerEntries,
      },
      errors,
    },
  }
}

// ---------------------------------------------------------------------------
// inline check (WP-07)
// ---------------------------------------------------------------------------

const SUPPORT_MATRIX_DOC = path.join(repoRoot, 'docs', 'tui-v2', 'support-matrix.md')

/**
 * Parse the ```json machine block of docs/tui-v2/support-matrix.md and pin it
 * to the code constants: every capability key must match BOTH backend
 * capability objects, and every capability where the two modes differ must
 * carry a non-empty note (fullscreen-only features never masquerade as parity).
 */
async function checkSupportMatrix(
  inlineCaps: Record<string, boolean>,
  fullscreenCaps: Record<string, boolean>,
): Promise<{ errors: string[]; capabilities: Record<string, unknown> }> {
  const errors: string[] = []
  let markdown: string
  try {
    markdown = await readFile(SUPPORT_MATRIX_DOC, 'utf8')
  } catch (error: any) {
    return { errors: [`support matrix doc unreadable: ${String(error?.message || error)}`], capabilities: {} }
  }
  let machine: any = null
  for (const match of markdown.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed && typeof parsed === 'object' && parsed.capabilities && typeof parsed.capabilities === 'object') {
        machine = parsed
        break
      }
    } catch {
      // Not the machine block; keep scanning.
    }
  }
  if (machine === null) {
    return { errors: ['no ```json machine block with a capabilities object found'], capabilities: {} }
  }
  const documented = machine.capabilities as Record<string, any>
  const expectedKeys = new Set([...Object.keys(fullscreenCaps), ...Object.keys(inlineCaps)])
  for (const key of expectedKeys) {
    const entry = documented[key]
    if (!entry || typeof entry !== 'object') {
      errors.push(`capability ${key}: missing from the matrix`)
      continue
    }
    if (entry.fullscreen !== fullscreenCaps[key]) {
      errors.push(`capability ${key}: matrix fullscreen=${JSON.stringify(entry.fullscreen)} but FULLSCREEN_CAPABILITIES=${fullscreenCaps[key]}`)
    }
    if (entry.inline !== inlineCaps[key]) {
      errors.push(`capability ${key}: matrix inline=${JSON.stringify(entry.inline)} but INLINE_CAPABILITIES=${inlineCaps[key]}`)
    }
    if (entry.fullscreen !== entry.inline && (typeof entry.note !== 'string' || entry.note.trim() === '')) {
      errors.push(`capability ${key}: fullscreen/inline differ but the matrix carries no note (divergence must be explicit)`)
    }
  }
  for (const key of Object.keys(documented)) {
    if (!expectedKeys.has(key)) errors.push(`capability ${key}: documented but not present in either backend`)
  }
  return { errors, capabilities: documented }
}

async function checkInline(): Promise<CheckResult> {
  const { readTrace } = await import('../src/tui-v2/testkit/trace.js')
  const { getProfile } = await import('../src/tui-v2/testkit/terminal-profiles.js')
  const { FULLSCREEN_CAPABILITIES } = await import('../src/tui-v2/terminal/fullscreen-backend.js')
  const { INLINE_CAPABILITIES } = await import('../src/tui-v2/terminal/inline-backend.js')
  const { runInlineCleanup, runInlineTraceReplay, runThirdPartyOutputReanchor } = await import(
    '../test/tui-v2/helpers/inline-harness.js'
  )

  const errors: string[] = []
  const tracesDir = path.join(repoRoot, 'fixtures', 'tui-v2', 'traces')

  // Part 1 — every trace through the inline pipeline (canonical + VT replay,
  // append-only scrollback invariants) under the profiles the fullscreen scan
  // pins. The inline-scrollback trace must DEMONSTRATE the append recipe —
  // feedPatches > 0 — otherwise the scrollback coverage is vacuous.
  const replay = {
    profiles: [...FULLSCREEN_SCAN_PROFILES],
    traces: 0,
    frames: 0,
    fullRedraws: 0,
    feedPatches: 0,
    scrollbackFeeds: 0,
    bytes: 0,
    maxRowWidth: 0,
    strippedOverlays: 0,
    perTrace: [] as Record<string, unknown>[],
    failures: [] as unknown[],
  }
  let traceFiles: string[] = []
  try {
    traceFiles = (await readdir(tracesDir)).filter((f) => f.endsWith('.jsonl')).sort()
  } catch (error: any) {
    errors.push(`traces dir unreadable: ${String(error?.message || error)}`)
  }
  for (const file of traceFiles) {
    try {
      const trace = await readTrace(path.join(tracesDir, file))
      replay.traces += 1
      for (const profileId of FULLSCREEN_SCAN_PROFILES) {
        const result = runInlineTraceReplay(trace, getProfile(profileId))
        replay.frames += result.frames
        replay.fullRedraws += result.fullRedraws
        replay.feedPatches += result.feedPatches
        replay.scrollbackFeeds += result.scrollbackFeeds
        replay.bytes += result.bytes
        replay.maxRowWidth = Math.max(replay.maxRowWidth, result.maxRowWidth)
        replay.strippedOverlays += result.strippedOverlays
        if (!result.ok) {
          errors.push(
            `trace ${result.trace} @ ${profileId}: ${result.failures.map((f) => `[${f.scope}] ${f.frameId ?? ''} ${f.message}`).join('; ')}`,
          )
          replay.failures.push(...result.failures)
        }
        if (result.trace === 'inline-scrollback' && (result.feedPatches === 0 || result.scrollbackLines === 0)) {
          errors.push(
            `trace inline-scrollback @ ${profileId}: append recipe never fired (feedPatches=${result.feedPatches}, scrollbackLines=${result.scrollbackLines}) — scrollback coverage would be vacuous`,
          )
        }
        replay.perTrace.push({
          trace: result.trace,
          profile: profileId,
          events: result.events,
          frames: result.frames,
          fullRedraws: result.fullRedraws,
          feedPatches: result.feedPatches,
          scrollbackLines: result.scrollbackLines,
          strippedOverlays: result.strippedOverlays,
          bytes: result.bytes,
          ok: result.ok,
          gridHash: result.gridHash,
          vtHash: result.vtHash,
        })
      }
    } catch (error: any) {
      errors.push(`trace fixture ${file}: ${String(error?.message || error)}`)
    }
  }

  // Part 2 — third-party output: guard detection + damage re-anchor restores
  // the screen without growing scrollback; detach restores the stream.
  const thirdParty: Record<string, unknown>[] = []
  for (const profileId of FULLSCREEN_SCAN_PROFILES) {
    const result = await runThirdPartyOutputReanchor(getProfile(profileId))
    if (!result.ok) {
      errors.push(
        `third-party re-anchor @ ${profileId}: ${result.failures.map((f) => `[${f.scope}] ${f.message}`).join('; ')}`,
      )
    }
    if (result.foreignWrites !== 1) errors.push(`third-party @ ${profileId}: expected exactly 1 foreign write, got ${result.foreignWrites}`)
    if (result.scrollbackDeltaDuringReanchor !== 0) {
      errors.push(`third-party @ ${profileId}: re-anchor grew scrollback by ${result.scrollbackDeltaDuringReanchor}`)
    }
    if (!result.detachRestored) errors.push(`third-party @ ${profileId}: detach did not restore stream.write`)
    thirdParty.push({
      profile: profileId,
      ok: result.ok,
      foreignWrites: result.foreignWrites,
      reanchorBytes: result.reanchorBytes,
      scrollbackDeltaDuringReanchor: result.scrollbackDeltaDuringReanchor,
      detachRestored: result.detachRestored,
    })
  }

  // Part 3 — cleanup drills: SIGTERM + error stops restore modes and raw mode,
  // and the exit-park cursor survives the writer cleanup bundle.
  const cleanup: Record<string, unknown>[] = []
  for (const profileId of FULLSCREEN_SCAN_PROFILES) {
    for (const scenario of ['sigterm', 'error'] as const) {
      const result = await runInlineCleanup(getProfile(profileId), scenario)
      if (!result.ok) {
        errors.push(
          `inline cleanup @ ${profileId}/${scenario}: ${result.failures.map((f) => `[${f.scope}] ${f.message}`).join('; ')}`,
        )
      }
      if (result.stopReason !== scenario) errors.push(`cleanup @ ${profileId}/${scenario}: stopReason=${result.stopReason}`)
      if (!result.modesRestored) errors.push(`cleanup @ ${profileId}/${scenario}: modes not restored`)
      if (!result.rawModeRestored) errors.push(`cleanup @ ${profileId}/${scenario}: raw mode not restored`)
      if (!result.cursorParked) errors.push(`cleanup @ ${profileId}/${scenario}: cursor not parked`)
      cleanup.push({
        profile: profileId,
        scenario,
        ok: result.ok,
        modesRestored: result.modesRestored,
        rawModeRestored: result.rawModeRestored,
        cursorParked: result.cursorParked,
      })
    }
  }

  // Part 4 — support matrix machine block vs the code constants.
  const supportMatrix = await checkSupportMatrix(
    INLINE_CAPABILITIES as unknown as Record<string, boolean>,
    FULLSCREEN_CAPABILITIES as unknown as Record<string, boolean>,
  )
  errors.push(...supportMatrix.errors)

  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    details: {
      replay,
      thirdParty,
      cleanup,
      supportMatrix: { doc: path.relative(repoRoot, SUPPORT_MATRIX_DOC), errors: supportMatrix.errors, capabilities: supportMatrix.capabilities },
      errors,
    },
  }
}

// ---------------------------------------------------------------------------
// host capability check (WP-08g): canonical snapshot + redacted protocol drills
// ---------------------------------------------------------------------------

async function checkHostCapabilities(): Promise<CheckResult> {
  const errors: string[] = []
  const { detectTerminalCapabilities, hashCapabilitySnapshot } = await import('../src/tui-v2/terminal/capabilities.js')
  const { getProfile } = await import('../src/tui-v2/testkit/terminal-profiles.js')
  const { encodeLifecycleOperation } = await import('../src/tui-v2/terminal/writer.js')
  const { createMouseController } = await import('../src/tui-v2/controllers/mouse.js')
  const ansi = await import('../src/tui-v2/terminal/ansi.js')
  const { createKittyKeyboardNegotiator } = await import('../src/tui-v2/terminal/kitty-keyboard.js')
  const { readTrace } = await import('../src/tui-v2/testkit/trace.js')

  const profile = getProfile('kitty-sync')
  const snapshot = detectTerminalCapabilities({
    profile,
    generation: 0,
    stdinIsTTY: true,
    // Only allowlisted values are examined and no value is copied into details.
    environment: { TERM: profile.term, TERM_PROGRAM: 'kitty', SECRET_TOKEN: 'redacted' },
    queries: [
      {
        token: { tokenId: 'q-host-1', generation: 0, kind: 'kitty-keyboard' },
        status: 'response',
        response: { tokenId: 'q-host-1', generation: 0, kind: 'kitty-keyboard', value: { flags: 1 }, receivedAt: 0 },
      },
      {
        token: { tokenId: 'q-late', generation: 1, kind: 'kitty-keyboard' },
        status: 'response',
        response: { tokenId: 'q-late', generation: 1, kind: 'kitty-keyboard', value: { flags: 1 }, receivedAt: 0 },
      },
    ],
  })
  if (snapshot.queries.accepted.length !== 1) errors.push(`expected one accepted query, got ${snapshot.queries.accepted.length}`)
  if (snapshot.queries.dropped.length !== 1) errors.push(`expected one dropped query, got ${snapshot.queries.dropped.length}`)
  if (JSON.stringify(snapshot).includes('SECRET_TOKEN') || JSON.stringify(snapshot).includes('redacted')) errors.push('snapshot retained environment secret')

  const mouseCleanup = encodeLifecycleOperation({ kind: 'lifecycle', action: 'mouse', enabled: false })
  const mouseCleanupOk = mouseCleanup.includes('\x1b[?1000l') && mouseCleanup.includes('\x1b[?1006l') && mouseCleanup.includes('\x1b[?1015l')
  if (!mouseCleanupOk) errors.push('mouse cleanup reset bundle is incomplete')
  const mouseRoutes: string[] = []
  const mouseProbe = createMouseController({
    mode: 'fullscreen',
    enabled: true,
    supportedProtocols: ['sgr-1006'],
    scrolling: { handleWheel: (direction) => { mouseRoutes.push(`wheel:${direction}`); return true } },
    selection: { handle: (_event, payload) => { mouseRoutes.push(`pointer:${payload.action}`); return true } },
    hitTest: () => 'selection',
  })
  const mouseEvent = (payload: Record<string, unknown>): any => ({
    kind: 'mouse', sequence: 1, generation: 0,
    payload: { protocol: 'sgr-1006', action: 'press', button: 'left', x: 0, y: 0, modifiers: { shift: false, alt: false, ctrl: false }, wheel: null, ...payload },
  })
  const wheelRouted = mouseProbe.handleEvent(mouseEvent({ action: 'wheel', wheel: 'up' }))
  const pointerRouted = mouseProbe.handleEvent(mouseEvent({ action: 'press' }))
  if (!wheelRouted || !pointerRouted || mouseRoutes.length !== 2) errors.push(`mouse route drill failed: ${JSON.stringify(mouseRoutes)}`)

  const kittyClock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }
  const kittyFallback = createKittyKeyboardNegotiator({
    clock: kittyClock,
    initialGeneration: 0,
    generation: () => 0,
    writer: {
      query: async () => { throw new Error('query unavailable') },
      writeControl: async () => ({ status: 'written' as const }),
    },
  })
  const kitty = await kittyFallback.negotiate(0)
  if (kitty.state !== 'fallback' || !kitty.legacyFallback) errors.push(`kitty fallback state is ${kitty.state}`)

  const osc52Text = 'host-capability-clipboard'
  const osc52Payload = Buffer.from(osc52Text, 'utf8').toString('base64')
  const osc52Bytes = ansi.osc52Clipboard(osc52Payload)
  const osc52Hash = sha256Hex(osc52Bytes)
  if (osc52Bytes.includes(osc52Text)) errors.push('OSC52 artifact exposed clipboard text')

  const tracePath = path.join(repoRoot, 'fixtures', 'tui-v2', 'traces', 'host-capabilities@v1.jsonl')
  let traceLoaded = false
  try {
    const trace = await readTrace(tracePath)
    traceLoaded = true
    const raw = await readFile(tracePath, 'utf8')
    if (/SECRET_TOKEN|clipboard bytes|aGVsbG8=|host-capability-clipboard/i.test(raw)) errors.push('host capability trace contains secret/raw payload')
    if (trace.header.name !== 'host-capabilities@v1') errors.push(`unexpected host trace name ${trace.header.name}`)
  } catch (error: any) {
    errors.push(`host capability trace unreadable: ${String(error?.message || error)}`)
  }

  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    details: {
      snapshot,
      snapshotHash: hashCapabilitySnapshot(snapshot),
      query: { accepted: snapshot.queries.accepted.length, dropped: snapshot.queries.dropped.length },
      mouse: { cleanupResetBundle: mouseCleanupOk, cleanupBytes: Buffer.byteLength(mouseCleanup, 'utf8'), wheelRouted, pointerRouted, routes: mouseRoutes.length },
      kitty: { state: kitty.state, reason: kitty.reason, legacyFallback: kitty.legacyFallback },
      osc52: { payloadChars: osc52Payload.length, bytes: Buffer.byteLength(osc52Bytes, 'utf8'), bytesHash: osc52Hash },
      trace: { path: path.relative(repoRoot, tracePath), loaded: traceLoaded, rawPayload: false },
      pty: { status: 'unsupported-by-host', runner: 'fake-stream-only' },
      hosts: { windows: 'manual', macos: 'manual', ssh: 'manual', tmux: 'manual', vscode: 'manual' },
      errors,
    },
  }
}

// ---------------------------------------------------------------------------
// stdout/stderr/terminal ownership gate (WP-09c1)
// ---------------------------------------------------------------------------

const OWNERSHIP_DOC = path.join(repoRoot, 'docs', 'tui-v2-stdout-ownership.md')
export const OWNERSHIP_PRODUCTION_ROOTS = [
  'bin/dsh-tui.js',
  'src/index.ts',
  'src/dsh-adapter/index.ts',
  'src/dsh-adapter/plugin.ts',
  'src/tui-v2/app/bootstrap.ts',
] as const
const OWNERSHIP_LEGACY_ROOTS = [
  'src/ink', 'src/components', 'src/screens', 'src/ui.ts', 'src/native-ts/yoga-layout',
] as const
const OWNERSHIP_FORBIDDEN_PHYSICAL_WRITERS = [
  'src/tui-v2/terminal/pi.ts',
  'src/tui-v2/vendor/pi-tui/src/terminal.ts',
  'src/tui-v2/vendor/pi-tui/src/tui-main-screen.ts',
  'src/tui-v2/vendor/pi-tui/src/tui-alt-screen.ts',
] as const
export type OwnershipHitKind =
  | 'stdout-write'
  | 'stderr-write'
  | 'console-write'
  | 'terminal-stream-write'
  | 'stream-guard'
  | 'external-child'
  | 'control-sequence'

export interface OwnershipHit {
  readonly file: string
  readonly line: number
  readonly kind: OwnershipHitKind
  readonly expression: string
}

export interface OwnershipOwnerRule {
  readonly id: string
  readonly owner: string
  readonly files: readonly string[]
  readonly kinds: readonly OwnershipHitKind[]
  readonly lifecycle: string
  readonly backpressure: string
  readonly cleanup: string
  readonly generation: string
  readonly queue: string
}

interface OwnershipMachineBlock {
  readonly schemaVersion: 1
  readonly ruleVersion: string
  readonly hitHash: string
  readonly roots: readonly string[]
  readonly owners: readonly OwnershipOwnerRule[]
}

function posixRelative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/')
}

function sourceKind(file: string): ts.ScriptKind {
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS
  if (file.endsWith('.tsx') || file.endsWith('.jsx')) return ts.ScriptKind.TSX
  return ts.ScriptKind.TS
}

function sourceDependencies(sourceFile: ts.SourceFile): string[] {
  const out = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const namedBindings = clause?.namedBindings
      const namedTypeOnly = namedBindings !== undefined && ts.isNamedImports(namedBindings) &&
        namedBindings.elements.length > 0 && namedBindings.elements.every(element => element.isTypeOnly)
      const hasRuntimeBinding = clause === undefined || clause.isTypeOnly !== true && (
        clause.name !== undefined || namedBindings === undefined || ts.isNamespaceImport(namedBindings) || !namedTypeOnly
      )
      if (hasRuntimeBinding) out.add(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && node.isTypeOnly !== true && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause
      const namedTypeOnly = clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 &&
        clause.elements.every(element => element.isTypeOnly)
      if (!namedTypeOnly) out.add(node.moduleSpecifier.text)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) out.add(node.arguments[0]!.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return [...out]
}

async function resolveOwnershipModule(importer: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null
  let absolute: string
  if (importer === 'bin/dsh-tui.js' && specifier.startsWith('../lib/types/')) {
    const sourceRel = specifier.slice('../lib/types/'.length).replace(/\.js$/u, '.ts')
    absolute = path.join(repoRoot, 'src', sourceRel)
  } else {
    absolute = path.resolve(repoRoot, path.dirname(importer), specifier)
  }
  const rootPrefix = `${repoRoot}${path.sep}`
  if (absolute !== repoRoot && !absolute.startsWith(rootPrefix)) return null
  const extension = path.extname(absolute)
  const stem = extension === '' ? absolute : absolute.slice(0, -extension.length)
  const candidates = extension === '.js' || extension === '.mjs' || extension === '.cjs'
    ? [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, absolute]
    : extension === ''
      ? [`${absolute}.ts`, `${absolute}.tsx`, `${absolute}.js`, path.join(absolute, 'index.ts'), path.join(absolute, 'index.js')]
      : [absolute]
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => null))?.isFile()) return posixRelative(candidate)
  }
  return null
}

export async function computeOwnershipProductionGraph(
  roots: readonly string[] = OWNERSHIP_PRODUCTION_ROOTS,
): Promise<{ files: string[]; edges: Array<{ importer: string; specifier: string; resolved: string }> }> {
  const queue = [...roots]
  const seen = new Set<string>()
  const edges: Array<{ importer: string; specifier: string; resolved: string }> = []
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    const full = path.join(repoRoot, file)
    if (!(await stat(full).catch(() => null))?.isFile()) throw new Error(`ownership production root/module missing: ${file}`)
    seen.add(file)
    const source = await readFile(full, 'utf8')
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, sourceKind(file))
    for (const specifier of sourceDependencies(parsed)) {
      const resolved = await resolveOwnershipModule(file, specifier)
      if (resolved === null) continue
      edges.push({ importer: file, specifier, resolved })
      if (!seen.has(resolved)) queue.push(resolved)
    }
  }
  return {
    files: [...seen].sort(),
    edges: edges.sort((a, b) => `${a.importer}\0${a.specifier}`.localeCompare(`${b.importer}\0${b.specifier}`)),
  }
}

function compactExpression(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 180)
}

function nodeLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function scanOwnershipFile(file: string, source: string): OwnershipHit[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, sourceKind(file))
  const hits: OwnershipHit[] = []
  const add = (node: ts.Node, kind: OwnershipHitKind, expression = node.getText(parsed)): void => {
    hits.push({ file, line: nodeLine(parsed, node), kind, expression: compactExpression(expression) })
  }
  const isEscapedControl = (node: ts.Node): boolean => {
    if (!(
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      ts.isRegularExpressionLiteral(node)
    )) return false
    return /(?:\\x1b|\\u001b|\\033|\u001b)/iu.test(node.getText(parsed))
  }
  const visit = (node: ts.Node): void => {
    if (isEscapedControl(node)) add(node, 'control-sequence')
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(parsed)
      if (callee === 'process.stdout.write') add(node, 'stdout-write')
      else if (callee === 'process.stderr.write') add(node, 'stderr-write')
      else if (/^console\.(?:log|warn|error|info|debug)$/u.test(callee)) add(node, 'console-write')
      else if (callee === 'this.stream.write' || callee === 'this.terminal.write') add(node, 'terminal-stream-write')
      else if (callee === 'Reflect.apply' && /(?:originalWrite|target\.write)/u.test(node.getText(parsed))) add(node, 'stream-guard')
      else if (/^(?:spawn|spawnSync|execFile|execFileSync)$/u.test(callee)) add(node, 'external-child')
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      /(?:^|\.)stream\.write$|^stream\.write$/u.test(node.left.getText(parsed))
    ) add(node, 'stream-guard')
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  const unique = new Map<string, OwnershipHit>()
  for (const hit of hits) unique.set(`${hit.file}:${hit.line}:${hit.kind}:${hit.expression}`, hit)
  return [...unique.values()].sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind))
}

export async function scanOwnershipProductionTree(
  roots: readonly string[] = OWNERSHIP_PRODUCTION_ROOTS,
): Promise<{ graph: Awaited<ReturnType<typeof computeOwnershipProductionGraph>>; hits: OwnershipHit[] }> {
  const graph = await computeOwnershipProductionGraph(roots)
  const hits: OwnershipHit[] = []
  for (const file of graph.files) hits.push(...scanOwnershipFile(file, await readFile(path.join(repoRoot, file), 'utf8')))
  return { graph, hits }
}

export function scanOwnershipSourceForTest(file: string, source: string): OwnershipHit[] {
  return scanOwnershipFile(file, source)
}

export function ownershipHitHash(hits: readonly OwnershipHit[]): string {
  const material = hits
    .map(hit => `${hit.file}:${hit.line}:${hit.kind}:${hit.expression}`)
    .sort()
    .join('\n') + '\n'
  return sha256Hex(material)
}

function extractOwnershipMachineBlock(markdown: string): OwnershipMachineBlock | null {
  for (const match of markdown.matchAll(/```json\s*\n([\s\S]*?)```/gu)) {
    try {
      const parsed = JSON.parse(match[1]!)
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed?.owners) && Array.isArray(parsed?.roots)) return parsed
    } catch {
      // Continue to the ownership block.
    }
  }
  return null
}

function validateOwnershipMachine(machine: OwnershipMachineBlock, errors: string[]): void {
  if (machine.ruleVersion !== 'tui-v2-ownership-v1') errors.push('ownership machine ruleVersion must be tui-v2-ownership-v1')
  if (!/^[0-9a-f]{64}$/u.test(machine.hitHash)) errors.push('ownership machine hitHash must be lowercase 64-hex')
  if (JSON.stringify(machine.roots) !== JSON.stringify(OWNERSHIP_PRODUCTION_ROOTS)) {
    errors.push('ownership machine roots do not exactly match verifier production roots')
  }
  const ids = new Set<string>()
  for (const owner of machine.owners) {
    const where = typeof owner?.id === 'string' ? owner.id : '<missing-owner-id>'
    if (!owner || typeof owner !== 'object') {
      errors.push('ownership owner entry must be an object')
      continue
    }
    if (typeof owner.id !== 'string' || owner.id === '') errors.push(`${where}: id is required`)
    else if (ids.has(owner.id)) errors.push(`${where}: duplicate id`)
    else ids.add(owner.id)
    for (const field of ['owner', 'lifecycle', 'backpressure', 'cleanup', 'generation', 'queue'] as const) {
      if (typeof owner[field] !== 'string' || owner[field] === '') errors.push(`${where}: ${field} is required`)
    }
    if (!Array.isArray(owner.files) || owner.files.length === 0 || !owner.files.every(file => typeof file === 'string' && file !== '')) {
      errors.push(`${where}: files must be a non-empty string array`)
    }
    if (!Array.isArray(owner.kinds) || owner.kinds.length === 0 || !owner.kinds.every(kind => [
      'stdout-write', 'stderr-write', 'console-write', 'terminal-stream-write', 'stream-guard', 'external-child', 'control-sequence',
    ].includes(kind))) errors.push(`${where}: kinds contains an invalid value`)
  }
}

export function ownershipRegistrationErrors(
  hits: readonly OwnershipHit[],
  owners: readonly Pick<OwnershipOwnerRule, 'id' | 'files' | 'kinds'>[],
): string[] {
  const errors: string[] = []
  for (const hit of hits) {
    const matches = owners.filter(owner => owner.files.includes(hit.file) && owner.kinds.includes(hit.kind))
    if (matches.length !== 1) errors.push(`${hit.file}:${hit.line} ${hit.kind} has ${matches.length} registered owners`)
  }
  return errors
}

async function runOwnershipWriterDrill(): Promise<Record<string, unknown>> {
  const { createQueryBroker } = await import('../src/tui-v2/terminal/query.js')
  const { unknownConservativeDefaults } = await import('../src/tui-v2/terminal/profile.js')
  const { createTerminalWriter, encodePatchOperations } = await import('../src/tui-v2/terminal/writer.js')
  const clock = {
    now: () => performance.now(),
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  class OwnershipStream extends Writable {
    readonly hash = createHash('sha256')
    bytes = 0
    writes = 0
    constructor() { super({ highWaterMark: 1 }) }
    override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      this.bytes += buffer.byteLength
      this.writes += 1
      this.hash.update(buffer)
      setImmediate(callback)
    }
  }
  const stream = new OwnershipStream()
  const broker = createQueryBroker({ clock })
  let token: any = null
  const writer = createTerminalWriter({
    stream,
    clock,
    profile: unknownConservativeDefaults(),
    queryBroker: broker,
    queryTokenSink: value => { token = value },
  })
  const operations: any[] = [
    {
      kind: 'resources',
      resources: {
        styles: [{ id: 0, foreground: null, background: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false }],
        hyperlinks: [],
      },
    },
    { kind: 'write-cells', x: 0, y: 0, cells: [{ grapheme: 'O', width: 1, styleId: 0 }] },
  ]
  const encoded = await encodePatchOperations(operations)
  const patch = (generation: number, patchSeq: number) => ({
    frameId: `ownership-${generation}-${patchSeq}`,
    stateRevision: patchSeq,
    patchSeq,
    generation,
    operations,
    bytes: encoded.bytes,
    fullRedraw: patchSeq === 1,
  }) as any
  const first = await writer.write(patch(0, 1))
  const barrier = await writer.quiesce()
  writer.resume(barrier, 1)
  const second = await writer.write(patch(1, 1))
  const stale = await writer.write(patch(0, 2))
  const query = writer.query({ kind: 'cursor', generation: 1, timeoutMs: 150, retry: 0, expected: 'cursor-report' })
  await new Promise(resolve => setImmediate(resolve))
  const queryAccepted = token !== null && broker.accept(token, {
    kind: 'query-response', sequence: 1, generation: 1, payload: null,
    query: { tokenId: token.id, kind: token.kind, value: '\x1b[1;1R' },
  })
  const response = await query
  const beforeStop = writer.stats()
  await writer.stop()
  const afterStop = writer.stats()
  const outputHash = stream.hash.digest('hex')
  const errors: string[] = []
  if (first.status !== 'written' || second.status !== 'written') errors.push('writer frames did not commit')
  if (stale.status !== 'stale') errors.push('old generation frame was not rejected')
  if (!queryAccepted || response.kind !== 'cursor') errors.push('query did not round-trip through writer/broker')
  if (afterStop.queueDepth !== 0 || afterStop.pendingBytes !== 0 || afterStop.inFlight !== 0) errors.push('writer queue did not drain at cleanup')
  if (afterStop.generation !== 1) errors.push('writer generation evidence is not 1')
  if (afterStop.maxQueueDepth > 2 || afterStop.maxPendingBytes > 8 * 1024 * 1024) errors.push('writer queue bounds exceeded')
  if (writer.lifecycleState() !== 'stopped') errors.push('writer cleanup did not reach stopped')
  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    owner: 'TerminalWriter',
    generation: { initial: 0, barrier, final: afterStop.generation, staleRejected: stale.status === 'stale' },
    query: { accepted: queryAccepted, kind: response.kind, rawResponseRetained: false },
    queue: { beforeStop, afterStop, maxDepthLimit: 2, pendingBytesLimit: 8 * 1024 * 1024 },
    cleanup: { lifecycle: writer.lifecycleState(), bytes: stream.bytes, writes: stream.writes, outputSha256: outputHash, rawBytes: false },
    errors,
  }
}

export async function checkOwnership(): Promise<CheckResult> {
  const errors: string[] = []
  const legacyPaths: string[] = []
  for (const legacy of OWNERSHIP_LEGACY_ROOTS) {
    if (await stat(path.join(repoRoot, legacy)).catch(() => null)) legacyPaths.push(legacy)
  }
  for (const legacy of legacyPaths) errors.push(`legacy output owner path remains: ${legacy}`)

  let machine: OwnershipMachineBlock | null = null
  try {
    machine = extractOwnershipMachineBlock(await readFile(OWNERSHIP_DOC, 'utf8'))
  } catch (error: any) {
    errors.push(`ownership doc unreadable: ${String(error?.message || error)}`)
  }
  if (machine === null) errors.push('ownership doc has no schemaVersion 1 machine block')
  else validateOwnershipMachine(machine, errors)

  let graph: Awaited<ReturnType<typeof computeOwnershipProductionGraph>> = { files: [], edges: [] }
  let hits: OwnershipHit[] = []
  try {
    const scan = await scanOwnershipProductionTree()
    graph = scan.graph
    hits = scan.hits
  } catch (error: any) {
    errors.push(`ownership production scan failed: ${String(error?.message || error)}`)
  }

  const currentHitHash = ownershipHitHash(hits)
  const ownerEvidence: Array<Record<string, unknown>> = []
  if (machine !== null) {
    if (machine.hitHash !== currentHitHash) {
      errors.push(`ownership hitHash ${machine.hitHash} does not match production scan ${currentHitHash}`)
    }
    errors.push(...ownershipRegistrationErrors(hits, machine.owners))
    for (const owner of machine.owners) {
      const ownerHits = hits.filter(hit => owner.files.includes(hit.file) && owner.kinds.includes(hit.kind))
      if (ownerHits.length === 0) errors.push(`${owner.id}: registered owner has no scan hits`)
      ownerEvidence.push({
        id: owner.id,
        owner: owner.owner,
        kinds: owner.kinds,
        files: owner.files,
        hits: ownerHits.length,
        lifecycle: owner.lifecycle,
        backpressure: owner.backpressure,
        cleanup: owner.cleanup,
        generation: owner.generation,
        queue: owner.queue,
      })
    }
  }
  for (const hit of hits) {
    if (hit.file.includes('/controllers/') && ['stdout-write', 'stderr-write', 'console-write', 'terminal-stream-write'].includes(hit.kind)) {
      errors.push(`controller directly writes output: ${hit.file}:${hit.line}`)
    }
  }
  const forbiddenPhysicalWriters = graph.files.filter(file => OWNERSHIP_FORBIDDEN_PHYSICAL_WRITERS.includes(file as any))
  for (const file of forbiddenPhysicalWriters) errors.push(`secondary physical terminal writer is production-reachable: ${file}`)

  const writerDrill = await runOwnershipWriterDrill().catch((error: any) => ({ status: 'fail', errors: [String(error?.message || error)] }))
  if (writerDrill.status !== 'pass') errors.push(`ownership writer drill failed: ${JSON.stringify(writerDrill.errors)}`)
  const graphMaterial = graph.files.join('\n') + '\n--edges--\n' + graph.edges.map(edge => `${edge.importer}:${edge.specifier}->${edge.resolved}`).join('\n')
  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    details: {
      ruleVersion: machine?.ruleVersion ?? null,
      roots: [...OWNERSHIP_PRODUCTION_ROOTS],
      graph: { files: graph.files.length, edges: graph.edges.length, sha256: sha256Hex(graphMaterial) },
      hitHash: currentHitHash,
      hits,
      owners: ownerEvidence,
      legacy: { roots: [...OWNERSHIP_LEGACY_ROOTS], hits: legacyPaths },
      uniquePhysicalWriter: { forbidden: [...OWNERSHIP_FORBIDDEN_PHYSICAL_WRITERS], hits: forbiddenPhysicalWriters },
      writer: writerDrill,
      errors,
    },
  }
}

// ---------------------------------------------------------------------------
// CI/workflow integration gate (WP-09c1; exact publish deferred to WP-09c2)
// ---------------------------------------------------------------------------

interface CiProbeResult {
  readonly name: string
  readonly command: readonly string[]
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly artifactPath: string
  readonly artifactSha256: string | null
  readonly artifactStatus: string | null
  readonly stdoutSha256: string
  readonly stderrSha256: string
}

function executeProbe(command: string, args: readonly string[]): Promise<{
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> {
  return new Promise(resolve => {
    execFile(command, [...args], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }, (error: any, stdout, stderr) => {
      resolve({
        exitCode: error === null ? 0 : typeof error?.code === 'number' ? error.code : null,
        signal: error?.signal ?? null,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

async function probeArtifact(pathname: string): Promise<{ status: string | null; sha256: string | null }> {
  try {
    const bytes = await readFile(pathname)
    const value = JSON.parse(bytes.toString('utf8'))
    const status = typeof value?.status === 'string'
      ? value.status
      : value?.kind === 'bench' && Array.isArray(value?.results) && value.error === undefined
        ? 'pass'
        : null
    return { status, sha256: sha256Hex(bytes) }
  } catch {
    return { status: null, sha256: null }
  }
}

async function runCiProbe(
  name: string,
  command: string,
  args: readonly string[],
  artifactPath: string,
): Promise<CiProbeResult> {
  const result = await executeProbe(command, args)
  const artifact = await probeArtifact(artifactPath)
  return {
    name,
    command: [command, ...args],
    exitCode: result.exitCode,
    signal: result.signal,
    artifactPath,
    artifactSha256: artifact.sha256,
    artifactStatus: artifact.status,
    stdoutSha256: sha256Hex(result.stdout),
    stderrSha256: sha256Hex(result.stderr),
  }
}

async function runCiIntegrationProbes(): Promise<CiProbeResult[]> {
  const artifactRoot = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2')
  await mkdir(artifactRoot, { recursive: true })
  const directory = await mkdtemp(path.join(artifactRoot, 'ci-integration-probes-'))
  const ownershipPath = path.join(directory, 'ownership.json')
  const soakPath = path.join(directory, 'soak.json')
  const benchPath = path.join(directory, 'bench.json')
  const packagePath = path.join(directory, 'package-dry-run.json')
  const node = process.execPath
  const probes: CiProbeResult[] = []
  probes.push(await runCiProbe('ownership', node, [
    '--import', 'tsx/esm', path.join(repoRoot, 'scripts', 'verify-tui-v2.ts'),
    '--check', 'ownership', '--output', ownershipPath,
  ], ownershipPath))
  probes.push(await runCiProbe('bounded-fake-soak', node, [
    '--expose-gc', '--import', 'tsx/esm', path.join(repoRoot, 'scripts', 'soak-tui-v2.ts'),
    '--minutes', '0.001', '--profile', 'unknown-conservative', '--seed', '1', '--output', soakPath,
  ], soakPath))
  probes.push(await runCiProbe('benchmark', node, [
    '--expose-gc', '--import', 'tsx/esm', path.join(repoRoot, 'scripts', 'bench-tui-v2.ts'),
    '--fixture', 'v2-clean-stop', '--iterations', '1', '--seed', '1', '--output', benchPath,
  ], benchPath))

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const packageResult = await executeProbe(pnpm, ['verify:package'])
  const packageSummary = {
    schemaVersion: 1,
    status: packageResult.exitCode === 0 ? 'pass' : 'fail',
    command: [pnpm, 'verify:package'],
    exitCode: packageResult.exitCode,
    signal: packageResult.signal,
    stdoutSha256: sha256Hex(packageResult.stdout),
    stderrSha256: sha256Hex(packageResult.stderr),
    rawOutput: false,
  }
  await writeArtifactAtomic(packagePath, packageSummary)
  probes.push({
    name: 'package-dry-run',
    command: packageSummary.command,
    exitCode: packageResult.exitCode,
    signal: packageResult.signal,
    artifactPath: packagePath,
    artifactSha256: sha256Hex(await readFile(packagePath)),
    artifactStatus: packageSummary.status,
    stdoutSha256: packageSummary.stdoutSha256,
    stderrSha256: packageSummary.stderrSha256,
  })
  return probes
}

function collectWorkflowStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectWorkflowStrings(item, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out.push(key)
      collectWorkflowStrings(nested, out)
    }
  }
}

export async function checkCiIntegration(ctx: CheckContext): Promise<CheckResult> {
  const finalMode = ctx.final || process.env.TUI_V2_FINAL === '1'
  const errors: string[] = []
  const deferred: Array<{ id: string; reason: string; deferredTo: 'WP-09c2' }> = []
  const workflowDirectory = path.join(repoRoot, '.github', 'workflows')
  const workflowFiles = (await readdir(workflowDirectory))
    .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort()
  const { parse } = await import('yaml')
  const workflows: Array<{ file: string; sha256: string; document: unknown; strings: string[]; source: string }> = []
  for (const file of workflowFiles) {
    const source = await readFile(path.join(workflowDirectory, file), 'utf8')
    try {
      const document = parse(source)
      const strings: string[] = []
      collectWorkflowStrings(document, strings)
      workflows.push({ file: `.github/workflows/${file}`, sha256: sha256Hex(source), document, strings, source })
    } catch (error: any) {
      errors.push(`workflow ${file} is not valid YAML: ${String(error?.message || error)}`)
    }
  }
  const workflowText = workflows.map(workflow => workflow.source).join('\n')
  const ciWorkflow = workflows.find(workflow => workflow.file === '.github/workflows/ci.yml')
  const publishWorkflow = workflows.find(workflow => workflow.file === '.github/workflows/publish.yml')
  const hostWorkflowText = workflows
    .filter(workflow => /tui-v2.*soak|soak.*tui-v2/iu.test(workflow.file + workflow.source))
    .map(workflow => workflow.source)
    .join('\n')
  if (ciWorkflow === undefined) errors.push('ci workflow is missing')
  if (publishWorkflow === undefined) errors.push('publish workflow is missing')

  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  const expectedScripts = {
    'test:tui-v2': 'node scripts/test-tui-v2.mjs',
    'verify:tui-v2': 'node --import tsx/esm scripts/verify-tui-v2.ts',
    'bench:tui-v2': 'node --expose-gc --import tsx/esm scripts/bench-tui-v2.ts',
    'soak:tui-v2': 'node --expose-gc --import tsx/esm scripts/soak-tui-v2.ts',
  }
  for (const [name, expected] of Object.entries(expectedScripts)) {
    if (manifest?.scripts?.[name] !== expected) errors.push(`package script ${name} must be exactly ${expected}`)
  }
  if (manifest?.devDependencies?.['node-pty'] !== '1.1.0') errors.push('node-pty devDependency must be exact 1.1.0')
  const workspace = await readFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  if (!/^\s*node-pty:\s*true\s*$/mu.test(workspace)) errors.push('pnpm allowBuilds.node-pty must be true')

  const staticContracts: Array<{ id: string; ok: boolean }> = []
  const contract = (id: string, ok: boolean, message: string): void => {
    staticContracts.push({ id, ok })
    if (!ok) errors.push(message)
  }
  contract('node-22.19', /22\.19/u.test(workflowText), 'workflows do not cover Node 22.19')
  contract('node-24', /node(?:-version)?[^\n]*24|node:\s*\[[^\]]*['"]?24/iu.test(workflowText), 'workflows do not cover Node 24')
  contract('test-wrapper', /pnpm\s+test:tui-v2/u.test(workflowText), 'workflows do not run test:tui-v2 wrapper')
  const wrapperSource = await readFile(path.join(repoRoot, 'scripts', 'test-tui-v2.mjs'), 'utf8')
  const reporterSource = await readFile(path.join(repoRoot, 'scripts', 'tui-v2-test-reporter.mjs'), 'utf8')
  contract('custom-reporter', /tui-v2-test-reporter\.mjs/u.test(wrapperSource) && /reporterVersion/u.test(reporterSource), 'custom test reporter contract is missing')
  const requiredChecks = [
    'baseline', 'regression-matrix', 'trace', 'fork', 'skeleton', 'controllers',
    'fullscreen', 'inline', 'host-capabilities', 'v2-only', 'ownership', 'ci-integration',
  ]
  for (const check of requiredChecks) contract(`check-${check}`, workflowText.includes(check), `workflows do not invoke v2 check ${check}`)
  contract('benchmark', /pnpm\s+bench:tui-v2/u.test(workflowText), 'workflows do not run bench:tui-v2')
  contract('pr-soak-10m', /pnpm\s+soak:tui-v2[^\n]*--minutes\s+10\b/u.test(workflowText), 'PR workflow lacks exact --minutes 10 bounded soak command')
  contract('upload-artifact', /actions\/upload-artifact@v4/u.test(workflowText), 'workflows do not upload v2 artifacts')
  contract('package-dry-run', /pnpm\s+verify:package/u.test(workflowText), 'workflows do not run package dry-run verification')
  for (const host of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
    contract(`host-${host}`, hostWorkflowText.includes(host), `host soak workflow does not cover ${host}`)
  }
  contract('host-schedule', /schedule:/u.test(hostWorkflowText), 'host soak workflow lacks nightly schedule')
  contract('host-release', /release:/u.test(hostWorkflowText), 'host soak workflow lacks release trigger')
  contract('host-manual', /workflow_dispatch:/u.test(hostWorkflowText), 'host soak workflow lacks manual trigger')
  contract('host-require-pty', /--require-pty/u.test(hostWorkflowText), 'host soak workflow does not require PTY')
  contract('nightly-8h-chain', /\b240\b/u.test(hostWorkflowText) && /\b480\b/u.test(hostWorkflowText), 'nightly workflow lacks 2x240m/480m chain contract')
  contract('release-24h-chain', /\b288\b/u.test(hostWorkflowText) && /\b1440\b/u.test(hostWorkflowText), 'release workflow lacks 5x288m/1440m chain contract')
  contract('soak-chain-verifier', /scripts\/merge-tui-v2-soak\.ts/u.test(hostWorkflowText), 'host workflow lacks soak artifact chain verifier')

  const publishSource = publishWorkflow?.source ?? ''
  const exactPublish = /verify-tui-v2-tarball\.mjs/u.test(publishSource) &&
    /npm\s+publish\s+["']?\$\{?tgz\}?|npm\s+publish\s+["']?\$tgz/iu.test(publishSource) &&
    /--ignore-scripts/u.test(publishSource)
  const ordinaryPublishHits = publishSource.split('\n')
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(hit => /\bnpm\s+publish\b/u.test(hit.text) && !/\$\{?tgz\}?|\.tgz/u.test(hit.text))
  if (!exactPublish || ordinaryPublishHits.length > 0) {
    deferred.push({
      id: 'verified-tarball-publish',
      reason: 'publish workflow does not yet consume the exact verified tgz and still contains ordinary npm publish',
      deferredTo: 'WP-09c2',
    })
  }
  if (finalMode) {
    for (const item of deferred) errors.push(`final ci-integration deferred item: ${item.reason} (${item.deferredTo})`)
  }

  const probes = await runCiIntegrationProbes()
  for (const probe of probes) {
    if (probe.exitCode !== 0 || probe.artifactStatus !== 'pass' || probe.artifactSha256 === null) {
      errors.push(`local CI probe ${probe.name} failed (exit=${probe.exitCode}, status=${probe.artifactStatus}, artifact=${probe.artifactPath})`)
    }
  }
  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    details: {
      mode: finalMode ? 'final' : 'staged',
      workflowCommit: await gitHead(),
      workflows: workflows.map(workflow => ({ file: workflow.file, sha256: workflow.sha256 })),
      staticContracts,
      packageScripts: expectedScripts,
      probes,
      publish: { exactVerifiedTarball: exactPublish, ordinaryPublishHits, deferred },
      errors,
    },
  }
}

// ---------------------------------------------------------------------------
// v2-only final legacy-clean gate + rollback preflight (WP-09b; rollback deferred to WP-09c2)
// ---------------------------------------------------------------------------

const retiredSourcePath = (...parts: string[]): string => parts.join('')
const V2_ONLY_FORBIDDEN_SPECIFIER = new RegExp(
  `(?:^|/)tools/tui-v2-baseline(?:/|$)|^(?:${RETIRED_RUNTIME_NAMES.join('|')})(?:$|/)`, 'u')
const OLD_RENDERER_PACKAGE_SPECIFIER = new RegExp(`^(?:${RETIRED_RUNTIME_NAMES.join('|')})(?:$|/)`, 'u')
const V2_BOUNDARY_ROOTS = ['src/tui-v2'] as const
const V2_LEGACY_SCAN_ROOTS = ['src', 'scripts', 'test'] as const
const V2_LEGACY_SOURCE_PATHS = [
  retiredSourcePath('src/', 'ink'),
  retiredSourcePath('src/', 'components'),
  retiredSourcePath('src/', 'screens'),
  retiredSourcePath('src/native-ts/', 'yo', 'ga-layout'),
  retiredSourcePath('src/', 'ui.ts'),
  retiredSourcePath('src/', 'force-production-', 'react.ts'),
  retiredSourcePath('src/hooks/', 'useBlink.ts'),
  retiredSourcePath('src/bootstrap/', 'state.ts'),
  retiredSourcePath('src/', 'customTheme.ts'),
  retiredSourcePath('src/', 'theme.ts'),
  retiredSourcePath('src/sessions/', 'format.ts'),
  retiredSourcePath('src/', 'trajectoryPrefs.ts'),
  retiredSourcePath('src/trajectory/', 'format.ts'),
  retiredSourcePath('src/trajectory/', 'motion.ts'),
  retiredSourcePath('src/trajectory/', 'query.ts'),
  retiredSourcePath('src/utils/', 'sliceAnsi.ts'),
] as const
const V2_SCAN_EXTRA_FILES = [
  'bin/dsh-tui.js',
  'package.json',
  '.github/workflows/ci.yml',
  '.github/workflows/publish.yml',
] as const
const REVIEW_EVIDENCE_CHECKS = new Set([
  'baseline', 'regression-matrix', 'trace', 'fork', 'skeleton', 'controllers',
  'fullscreen', 'inline', 'host-capabilities',
])
const PRODUCTION_ENTRY_ROOTS = [
  'src/index.ts',
  'src/dsh-adapter/index.ts',
  'src/dsh-adapter/plugin.ts',
  'src/tui-v2/app/bootstrap.ts',
] as const
const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u

function sourceWithoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/u, '$1'))
    .join('\n')
}

function resolvesIntoLegacyRenderer(importer: string, specifier: string): boolean {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false
  const resolved = path.resolve(repoRoot, path.dirname(importer), specifier).split(path.sep).join('/')
  const withoutJs = resolved.replace(/\.(?:mjs|cjs|jsx|js)$/u, '')
  const srcRoot = path.join(repoRoot, 'src').split(path.sep).join('/')
  const retiredRoots = [
    `${srcRoot}/${retiredSourcePath('ui')}`,
    `${srcRoot}/${retiredSourcePath('i', 'nk')}/`,
    `${srcRoot}/screens/`,
    `${srcRoot}/components/`,
    `${srcRoot}/native-ts/${retiredSourcePath('yo', 'ga-layout')}/`,
  ]
  return retiredRoots.some(root => withoutJs === root || withoutJs.startsWith(root))
}

async function scanImportBoundary(root: string, forbidden: RegExp): Promise<{ file: string; specifier: string }[]> {
  const hits: { file: string; specifier: string }[] = []
  const files = await walkCodeFiles(path.join(repoRoot, root), repoRoot)
  for (const file of files) {
    for (const specifier of await fileSpecifiers(file)) {
      if (forbidden.test(specifier) || resolvesIntoLegacyRenderer(file, specifier)) hits.push({ file, specifier })
    }
  }
  return hits
}

async function scanLegacySource(): Promise<{
  switchHits: { file: string; line: number; text: string }[]
  jsxHits: string[]
  directHits: { file: string; specifier: string }[]
  sourcePaths: string[]
}> {
  const switchHits: { file: string; line: number; text: string }[] = []
  const jsxHits: string[] = []
  const directHits: { file: string; specifier: string }[] = []
  const files: string[] = []
  for (const root of V2_LEGACY_SCAN_ROOTS) {
    const full = path.join(repoRoot, root)
    if ((await stat(full).catch(() => null))?.isDirectory()) files.push(...await walkCodeFiles(full, repoRoot))
  }
  for (const extra of V2_SCAN_EXTRA_FILES) {
    if ((await stat(path.join(repoRoot, extra)).catch(() => null))?.isFile()) files.push(extra)
  }
  for (const file of [...new Set(files)].sort()) {
    // The verifier necessarily contains the forbidden vocabulary in its own
    // policy regexes; do not treat that policy implementation as application
    // source under test.
    if (file === 'scripts/verify-tui-v2.ts') continue
    const source = await readFile(path.join(repoRoot, file), 'utf8')
    const clean = sourceWithoutComments(source)
    clean.split('\n').forEach((line, index) => {
      if (/DSH_TUI_RENDERER|renderer\s*(?:switch|selector)|(?:v1|v2)\s*renderer\s*(?:switch|fallback)/iu.test(line)) {
        switchHits.push({ file, line: index + 1, text: line.trim().slice(0, 160) })
      }
    })
    if (file.endsWith('.tsx') || /react\/jsx-runtime|jsxImportSource/iu.test(clean)) jsxHits.push(file)
    if (CODE_EXTENSIONS.has(path.extname(file))) {
      for (const specifier of await fileSpecifiers(file)) {
        if (OLD_RENDERER_PACKAGE_SPECIFIER.test(specifier) || resolvesIntoLegacyRenderer(file, specifier)) {
          directHits.push({ file, specifier })
        }
      }
    }
  }
  const sourcePaths: string[] = []
  for (const rel of V2_LEGACY_SOURCE_PATHS) {
    if (await stat(path.join(repoRoot, rel)).catch(() => null)) sourcePaths.push(rel)
  }
  return { switchHits, jsxHits: [...new Set(jsxHits)].sort(), directHits, sourcePaths }
}

function packageSurfaceViolations(): { files: string[]; exports: string[]; runtime: string[]; dependencies: string[] } {
  const manifestPath = path.join(repoRoot, 'package.json')
  const packageJson = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const files = Array.isArray(packageJson.files)
    ? packageJson.files.filter((item): item is string => typeof item === 'string' && /(^|\/)tools(?:\/|$)|tui-v2-baseline/u.test(item))
    : []
  const exports: string[] = []
  const scanExports = (value: unknown, prefix = 'exports'): void => {
    if (typeof value === 'string') {
      if (/(^|\/)tools(?:\/|$)|tui-v2-baseline/u.test(value)) exports.push(`${prefix}:${value}`)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) scanExports(nested, `${prefix}.${key}`)
    }
  }
  scanExports(packageJson.exports)
  const dependencies: string[] = []
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const) {
    const values = packageJson[section]
    if (values === null || typeof values !== 'object' || Array.isArray(values)) continue
    for (const name of Object.keys(values as Record<string, unknown>)) {
      if (OLD_RENDERER_PACKAGE_SPECIFIER.test(name)) dependencies.push(`${section}:${name}`)
    }
  }
  return { files, exports, runtime: [], dependencies }
}

async function reviewBaselineDifferences(
  bundle: any,
  report: any,
  fingerprint: (trace: any, artifactSha256: string) => string,
): Promise<{ errors: string[]; details: Record<string, unknown> }> {
  const errors: string[] = []
  const ledger = bundle.reviewedDifferences
  const required = new Set<string>(ledger.policy.requiredSemanticAssertions)
  const semanticById = new Map<string, any>(ledger.semanticAssertions.map((item: any) => [item.id, item]))
  if (required.size !== semanticById.size || [...required].some(id => !semanticById.has(id))) {
    errors.push('review ledger policy.requiredSemanticAssertions must exactly cover semanticAssertions')
  }
  const evidence: { id: string; tests: string[]; checks: string[] }[] = []
  for (const id of required) {
    const assertion = semanticById.get(id)
    if (assertion === undefined) continue
    const tests: string[] = []
    const checkNames: string[] = []
    for (const item of assertion.evidence) {
      if (item.kind === 'check') {
        checkNames.push(item.name)
        if (!REVIEW_EVIDENCE_CHECKS.has(item.name)) errors.push(`${id}: unknown replacement check ${item.name}`)
        continue
      }
      tests.push(`${item.path}:${item.testNamePattern}`)
      if (!item.path.startsWith('test/tui-v2/')) {
        errors.push(`${id}: replacement test must live under test/tui-v2: ${item.path}`)
        continue
      }
      try {
        const source = await readFile(path.join(repoRoot, item.path), 'utf8')
        if (!(new RegExp(item.testNamePattern, 'u')).test(source)) {
          errors.push(`${id}: replacement test pattern does not match ${item.path}: ${item.testNamePattern}`)
        }
      } catch (error: any) {
        errors.push(`${id}: replacement test evidence invalid: ${String(error?.message || error)}`)
      }
    }
    if (tests.length === 0 || checkNames.length === 0) errors.push(`${id}: replacement assertion requires both v2 test and check evidence`)
    evidence.push({ id, tests, checks: checkNames })
  }

  const ledgerByKey = new Map<string, any>()
  for (const difference of ledger.differences) ledgerByKey.set(`${difference.traceId}\u0000${difference.profile}`, difference)
  const consumed = new Set<string>()
  const accepted: { id: string; traceId: string; profile: string; kinds: string[]; fingerprint: string }[] = []
  const kindOrder = ['grid', 'cursor', 'modes', 'width', 'height'] as const
  for (const trace of report.traces) {
    if (trace.v2.failures.length > 0) errors.push(`${trace.traceId}: v2 differential failures are not reviewable`)
    if (trace.physicalWidthViolations.length > 0) errors.push(`${trace.traceId}: physical width violations are not reviewable`)
    const forbiddenSideEffects = trace.sideEffects.violations.length > 0
      || trace.sideEffects.stdoutWrites !== 0
      || trace.sideEffects.stderrWrites !== 0
      || trace.sideEffects.subscriptions !== 0
      || trace.sideEffects.timersCreated !== 0
      || trace.sideEffects.commands !== 0
      || trace.sideEffects.sessionWrites !== 0
    if (forbiddenSideEffects) errors.push(`${trace.traceId}: baseline compare emitted forbidden side effects`)
    const kinds = kindOrder.filter(kind => trace.comparison[kind].ok !== true)
    const key = `${trace.traceId}\u0000${trace.profile}`
    const difference = ledgerByKey.get(key)
    if (kinds.length === 0) {
      if (difference !== undefined) errors.push(`${trace.traceId}: ledger contains a waiver for a passing comparison`)
      continue
    }
    if (difference === undefined) {
      errors.push(`${trace.traceId}: strict baseline difference has no reviewed ledger entry`)
      continue
    }
    consumed.add(key)
    if (JSON.stringify(difference.differenceKinds) !== JSON.stringify(kinds)) {
      errors.push(`${trace.traceId}: reviewed difference kinds drifted (${JSON.stringify(kinds)})`)
    }
    const actualFingerprint = fingerprint(trace, bundle.manifest.artifact.sha256)
    if (difference.reviewFingerprint !== actualFingerprint) {
      errors.push(`${trace.traceId}: reviewed difference fingerprint drifted`)
    }
    const replacements = new Set<string>(difference.approvedReplacementAssertions)
    if (replacements.size !== required.size || [...required].some(id => !replacements.has(id))) {
      errors.push(`${trace.traceId}: approved replacement assertions do not cover every required P0/P1 semantic`)
    }
    accepted.push({ id: difference.id, traceId: trace.traceId, profile: trace.profile, kinds, fingerprint: actualFingerprint })
  }
  for (const [key, difference] of ledgerByKey) {
    if (!consumed.has(key)) errors.push(`${difference.id}: reviewed ledger entry did not match a strict baseline difference`)
  }
  for (const error of report.errors) errors.push(`strict baseline compare: ${error}`)
  return {
    errors,
    details: {
      ledger: path.relative(repoRoot, bundle.reviewedDifferencesPath).split(path.sep).join('/'),
      ledgerSha256: bundle.manifest.reviewedDifferences.sha256,
      acceptedSeverity: ledger.policy.acceptedSeverity,
      semanticAssertions: evidence,
      accepted,
    },
  }
}

interface RollbackPreflight {
  readonly errors: readonly string[]
  readonly deferred: readonly { readonly reason: string; readonly deferredTo: 'WP-09c2' }[]
  readonly details: Record<string, unknown>
}

export async function checkRollbackManifest(manifestPath: string | null): Promise<RollbackPreflight> {
  if (manifestPath === null || manifestPath === '') {
    return {
      errors: [],
      deferred: [{ reason: 'no immutable rollback-manifest.json supplied in this work package', deferredTo: 'WP-09c2' }],
      details: { status: 'deferred', path: null },
    }
  }
  const errors: string[] = []
  const deferred: { reason: string; deferredTo: 'WP-09c2' }[] = []
  let value: any
  try {
    value = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8'))
  } catch (error: any) {
    return { errors: [`rollback manifest unreadable: ${String(error?.message || error)}`], deferred, details: { path: path.resolve(manifestPath) } }
  }
  const requiredString = (field: string): string => {
    const current = field.split('.').reduce((cursor, key) => cursor?.[key], value)
    if (typeof current !== 'string' || current === '') {
      errors.push(`rollback manifest missing ${field}`)
      return ''
    }
    return current
  }
  if (value?.schemaVersion !== 1) errors.push('rollback manifest schemaVersion must be 1')
  const registry = requiredString('registry')
  const packageName = requiredString('package')
  const version = requiredString('version')
  const tarball = requiredString('tarball')
  const sha256 = requiredString('sha256')
  if (sha256 !== '' && !/^[0-9a-f]{64}$/u.test(sha256)) errors.push('rollback manifest sha256 must be lowercase 64-hex')
  if (tarball !== '' && path.basename(tarball) !== tarball) errors.push('rollback manifest tarball must be a basename')
  if (registry !== '' && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(registry)) errors.push('rollback manifest registry must be an absolute registry URL')
  if (packageName !== '' && !/^@[^/]+\/[^/]+$/u.test(packageName)) errors.push('rollback manifest package must be scoped')
  if (version !== '' && !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) errors.push('rollback manifest version must be exact semver')
  const signature = value?.signature
  if (signature === null || typeof signature !== 'object') errors.push('rollback manifest signature is required')
  else {
    if (!['sigstore', 'gpg'].includes(signature.algorithm)) errors.push('rollback manifest signature.algorithm must be sigstore|gpg')
    if (typeof signature.ref !== 'string' || signature.ref === '') errors.push('rollback manifest signature.ref is required')
  }
  const session = value?.sessionSchema
  if (session === null || typeof session !== 'object' || !Number.isInteger(session.min) || !Number.isInteger(session.max) || session.min < 1 || session.max < session.min) {
    errors.push('rollback manifest sessionSchema min/max are invalid')
  }
  const launcher = value?.launcher
  if (launcher === null || typeof launcher !== 'object' || typeof launcher.command !== 'string' || launcher.command === '' || !Array.isArray(launcher.args) || !launcher.args.every((item: unknown) => typeof item === 'string') || !Number.isInteger(launcher.timeoutMs) || launcher.timeoutMs <= 0 || !Number.isInteger(launcher.retries) || launcher.retries < 0) {
    errors.push('rollback manifest launcher contract is invalid')
  }
  const retention = value?.retention
  if (retention === null || typeof retention !== 'object' || !Number.isInteger(retention.keepStableVersions) || retention.keepStableVersions < 1 || typeof retention.expiresAt !== 'string' || !UTC_DATE.test(retention.expiresAt)) {
    errors.push('rollback manifest retention contract is invalid')
  }
  let tarballStatus: 'verified' | 'missing' | 'not-checked' = 'not-checked'
  if (tarball !== '' && sha256 !== '' && errors.length === 0) {
    const localTarball = path.join(path.dirname(path.resolve(manifestPath)), tarball)
    try {
      const bytes = await readFile(localTarball)
      tarballStatus = 'verified'
      if (sha256Hex(bytes) !== sha256) errors.push('rollback tarball sha256 does not match manifest')
    } catch {
      tarballStatus = 'missing'
      deferred.push({ reason: 'exact rollback tarball is not present beside the manifest', deferredTo: 'WP-09c2' })
    }
  }
  return {
    errors,
    deferred,
    details: {
      path: path.resolve(manifestPath),
      schemaVersion: value?.schemaVersion ?? null,
      package: packageName || null,
      version: version || null,
      tarball: tarball || null,
      tarballStatus,
      signature: signature && typeof signature === 'object' ? { algorithm: signature.algorithm ?? null, refPresent: typeof signature.ref === 'string' && signature.ref !== '' } : null,
      sessionSchema: session && typeof session === 'object' ? { min: session.min ?? null, max: session.max ?? null } : null,
      launcher: launcher && typeof launcher === 'object' ? { command: launcher.command ?? null, timeoutMs: launcher.timeoutMs ?? null, retries: launcher.retries ?? null } : null,
      retention: retention && typeof retention === 'object' ? { keepStableVersions: retention.keepStableVersions ?? null, expiresAt: retention.expiresAt ?? null } : null,
    },
  }
}

export async function checkV2Only(ctx: CheckContext): Promise<CheckResult> {
  const finalMode = ctx.final || process.env.TUI_V2_FINAL === '1'
  const errors: string[] = []
  const deferred: { reason: string; deferredTo: 'WP-09c2' }[] = []
  const details: Record<string, unknown> = { mode: finalMode ? 'final' : 'staged', deferred }

  const boundaryHits: Record<string, { file: string; specifier: string }[]> = {}
  for (const root of V2_BOUNDARY_ROOTS) boundaryHits[root] = await scanImportBoundary(root, V2_ONLY_FORBIDDEN_SPECIFIER)
  const boundaryViolations = Object.values(boundaryHits).flat()
  details.runtimeImportBoundary = {
    roots: [...V2_BOUNDARY_ROOTS],
    forbidden: ['tools/tui-v2-baseline', 'retired renderer source paths', ...RETIRED_RUNTIME_NAMES],
    violations: boundaryViolations,
  }
  for (const hit of boundaryViolations) errors.push(`v2-only runtime boundary: ${hit.file} imports ${hit.specifier}`)

  const entryHits: { file: string; specifier: string }[] = []
  for (const entry of PRODUCTION_ENTRY_ROOTS) {
    if (!(await stat(path.join(repoRoot, entry)).catch(() => null))?.isFile()) continue
    for (const specifier of await fileSpecifiers(entry)) {
      if (/tools\/tui-v2-baseline|compare-harness|baseline\/capture/u.test(specifier)) entryHits.push({ file: entry, specifier })
    }
  }
  details.productionBootstrap = { entries: [...PRODUCTION_ENTRY_ROOTS], compareImports: entryHits }
  for (const hit of entryHits) errors.push(`production bootstrap imports offline compare: ${hit.file} -> ${hit.specifier}`)

  const packageSurface = packageSurfaceViolations()
  if ((await stat(path.join(repoRoot, 'lib')).catch(() => null))?.isDirectory()) {
    const runtimeFiles = await walkCodeFiles(path.join(repoRoot, 'lib'), repoRoot)
    packageSurface.runtime.push(...runtimeFiles.filter((file) =>
      /(^|\/)tools(?:\/|$)|tui-v2-baseline/u.test(file)
      || [retiredSourcePath('ink'), 'components', 'screens', retiredSourcePath('native-ts/', 'yo', 'ga-layout')]
        .some(root => new RegExp(`^lib/types/${root}(?:/|$)`, 'u').test(file))
      || new RegExp(`^lib/types/(?:ui|${retiredSourcePath('force-', 'production-react')}|customTheme|theme|trajectoryPrefs)(?:\\.|$)`, 'u').test(file)))
  }
  details.packageRuntimeBoundary = packageSurface
  for (const item of [...packageSurface.files, ...packageSurface.exports, ...packageSurface.runtime, ...packageSurface.dependencies]) {
    errors.push(`package/runtime contains retired or offline baseline surface: ${item}`)
  }

  const legacy = await scanLegacySource()
  details.legacyScan = {
    roots: [...V2_LEGACY_SCAN_ROOTS, ...V2_SCAN_EXTRA_FILES],
    sourcePaths: legacy.sourcePaths,
    switchHits: legacy.switchHits.slice(0, 64),
    jsxFiles: legacy.jsxHits.slice(0, 64),
    directHotPathImports: legacy.directHits.slice(0, 64),
    counts: {
      sourcePaths: legacy.sourcePaths.length,
      switches: legacy.switchHits.length,
      jsx: legacy.jsxHits.length,
      direct: legacy.directHits.length,
    },
  }
  for (const sourcePath of legacy.sourcePaths) errors.push(`retired renderer source path still exists: ${sourcePath}`)
  for (const hit of legacy.switchHits) errors.push(`retired renderer switch remains: ${hit.file}:${hit.line}`)
  for (const file of legacy.jsxHits) errors.push(`JSX/TSX remains in v2-only scan: ${file}`)
  for (const hit of legacy.directHits) errors.push(`retired renderer import remains: ${hit.file} -> ${hit.specifier}`)

  let bundle: any = null
  try {
    const baseline = await import('../tools/tui-v2-baseline/capture.js')
    bundle = await baseline.loadAndVerifyBaselineBundle(path.join(repoRoot, 'tools', 'tui-v2-baseline', 'manifest.json'), repoRoot)
    details.baseline = {
      artifact: path.relative(repoRoot, bundle.artifactPath).split(path.sep).join('/'),
      artifactSha256: bundle.manifest.artifact.sha256,
      reviewedDifferences: path.relative(repoRoot, bundle.reviewedDifferencesPath).split(path.sep).join('/'),
      reviewedDifferencesSha256: bundle.manifest.reviewedDifferences.sha256,
      sourceCommit: bundle.manifest.source.commit,
      sourceTreeSha256: bundle.manifest.source.treeSha256,
      captures: bundle.artifact.captures.map((capture: any) => ({ traceId: capture.traceId, profile: capture.profile, width: capture.width, height: capture.height, frameCount: capture.frameCount, ansiBytesHash: capture.ansiBytesHash })),
      missingSourceFiles: bundle.missingSourceFiles,
      sourceMismatches: bundle.sourceMismatches,
      sideEffects: bundle.manifest.sideEffects,
    }
    if (bundle.sourceMismatches.length > 0) errors.push(`baseline source hash mismatch: ${bundle.sourceMismatches.join(', ')}`)
  } catch (error: any) {
    errors.push(`baseline artifact validation failed: ${String(error?.message || error)}`)
  }

  if (bundle !== null) {
    try {
      const compare = await import('../tools/tui-v2-baseline/compare-harness.js')
      const smokeDir = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-v2-only-'))
      const smokeOutput = path.join(smokeDir, 'baseline-compare.json')
      const smoke = await compare.runCompareHarness({
        repoRoot,
        traceIds: bundle.artifact.captures.map((capture: any) => capture.traceId),
        allowMismatches: false,
        output: smokeOutput,
      })
      const review = await reviewBaselineDifferences(bundle, smoke, compare.reviewedDifferenceFingerprint)
      errors.push(...review.errors)
      details.compareSmoke = {
        strictStatus: smoke.status,
        policyStatus: review.errors.length === 0 ? 'pass' : 'fail',
        mismatchPolicy: smoke.comparePolicy.mismatch,
        artifact: path.basename(smokeOutput),
        traces: smoke.traces.map((trace) => ({ traceId: trace.traceId, profile: trace.profile, strictStatus: trace.status, sideEffects: trace.sideEffects, v1: { frames: trace.v1.frameCount, bytes: trace.v1.ansiBytes, gridHash: trace.v1.gridHash, ansiBytesHash: trace.v1.ansiBytesHash }, v2: { frames: trace.v2.frames, bytes: trace.v2.bytes, gridHash: trace.v2.gridHash, ansiBytesHash: trace.v2.ansiBytesHash }, comparison: { grid: trace.comparison.grid.ok, cursor: trace.comparison.cursor.ok, modes: trace.comparison.modes.ok, width: trace.comparison.width.ok, height: trace.comparison.height.ok } })),
        reviewedDifferencePolicy: review.details,
        errors: smoke.errors,
      }
    } catch (error: any) {
      errors.push(`baseline compare/review policy failed to execute: ${String(error?.message || error)}`)
    }
  }

  const rollbackPath = ctx.rollbackManifest ?? process.env.TUI_V2_ROLLBACK_MANIFEST ?? null
  const rollback = await checkRollbackManifest(rollbackPath)
  details.rollback = rollback.details
  deferred.push(...rollback.deferred)
  errors.push(...rollback.errors)

  if (finalMode && deferred.length > 0) {
    for (const item of deferred) errors.push(`final v2-only deferred item: ${item.reason} (${item.deferredTo})`)
  }
  details.deferred = deferred
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
  ['fullscreen', () => checkFullscreen()],
  ['inline', () => checkInline()],
  ['host-capabilities', () => checkHostCapabilities()],
  ['ownership', () => checkOwnership()],
  ['ci-integration', (ctx) => checkCiIntegration(ctx)],
  ['v2-only', (ctx) => checkV2Only(ctx)],
])

function defaultOutput(check: string): string {
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', `${check}.json`)
}

function parseArgs(argv: string[]) {
  const out: {
    check: string | null
    output: string | null
    profile: string | null
    fixture: string | null
    final: boolean
    rollbackManifest: string | null
    help: boolean
  } = {
    check: null,
    output: null,
    profile: null,
    fixture: null,
    final: false,
    rollbackManifest: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // pnpm forwards a literal `--` separator; skip it.
    if (arg === '--') continue
    if (arg === '--check') out.check = argv[++i] ?? null
    else if (arg === '--output') out.output = argv[++i] ?? null
    else if (arg === '--profile') out.profile = argv[++i] ?? null
    else if (arg === '--fixture') out.fixture = argv[++i] ?? null
    else if (arg === '--final') out.final = true
    else if (arg === '--rollback-manifest') out.rollbackManifest = argv[++i] ?? null
    else if (arg === '--help') out.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!out.check && !out.help) throw new Error('--check <name> is required')
  return out
}

function verifierHelp(): string {
  return [
    'Usage: node --import tsx/esm scripts/verify-tui-v2.ts -- --check <name> [options]',
    `Checks: ${[...checks.keys()].join(', ')}`,
    'Options: --output <path> --profile <id> --fixture <path> --final',
    '         --rollback-manifest <path> --help',
    'TUI_V2_FINAL=1 enables strict v2-only semantics.',
  ].join('\n')
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
    if (args.help) {
      process.stdout.write(verifierHelp() + '\n')
      artifact.check = 'help'
      artifact.status = 'pass'
      artifact.details = { checks: [...checks.keys()] }
      outputPath = path.resolve(defaultOutput('help'))
      exitCode = 0
      return
    }
    artifact.check = args.check
    outputPath = path.resolve(args.output ?? defaultOutput(args.check!))

    const check = checks.get(args.check!)
    if (!check) {
      artifact.details = { errors: [`unknown check: ${args.check}`, `available: ${[...checks.keys()].join(', ')}`] }
      return
    }
    const result = await check({
      output: outputPath,
      profile: args.profile,
      fixture: args.fixture,
      final: args.final,
      rollbackManifest: args.rollbackManifest,
    })
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
