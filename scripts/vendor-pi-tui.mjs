#!/usr/bin/env node
/**
 * Re-vendor @earendil-works/pi-tui (pi packages/tui) into
 * src/tui-v2/vendor/pi-tui/ (WP-03a, plan docs/tui-render-v2-development-plan.md
 * §0.2 / WP-03 / §15.2-1).
 *
 * Usage:
 *   node scripts/vendor-pi-tui.mjs --source /path/to/pi           vendor mode
 *   node scripts/vendor-pi-tui.mjs --source /path/to/pi --check   check + verify
 *                                                                 upstream hashes
 *   node scripts/vendor-pi-tui.mjs --check                        repo-only check
 *
 * Vendor mode:
 *   1. Fails unless <source>/.git HEAD equals PINNED_COMMIT and the worktree
 *      is clean (the pin is fixed in docs/tui-render-v2-development-plan.md
 *      §0.2; changing it requires an ADR, not an edit here).
 *   2. Copies the transitive closure (relative import specifiers) of ROOTS
 *      from packages/tui/src into src/tui-v2/vendor/pi-tui/src/, mechanically
 *      rewriting relative `.ts` import/export specifiers to `.js` (bundler
 *      resolution in this repo; recorded in PATCH-LEDGER.md).
 *   3. Copies packages/tui/native/{darwin,win32} trees verbatim (hash-registered
 *      only; never built here) and the repo-root LICENSE.
 *   4. Writes NOTICE, PATCH-LEDGER.md (only if absent) and refreshes
 *      VENDOR-MANIFEST.json with per-file sha256 (vendored content) and
 *      upstreamSha256 (pristine upstream content).
 *
 * Check mode (`--check`): read-only. Verifies the vendor tree matches the
 * manifest exactly (hashes, no drift, no extra/missing files, excluded files
 * absent, no leftover `.ts` relative specifiers). With `--source`, additionally
 * verifies every upstreamSha256 against the upstream checkout.
 *
 * The checker is exported as `checkVendorTree` so scripts/verify-tui-v2.ts
 * (`--check fork`) runs the identical logic in-process.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

/** Pinned source snapshot — plan §0.2 / WP-03. Do not change without an ADR. */
export const PINNED_COMMIT = '086c32e74530564922d011ade23ff582c9d63116'
export const PACKAGE_VERSION = '0.84.2'
export const UPSTREAM_REPO = 'https://github.com/earendil-works/pi'
export const LICENSE_ID = 'MIT'
export const VENDOR_REL = 'src/tui-v2/vendor/pi-tui'
export const IMPORT_REWRITE_NOTE = '.ts->.js relative specifiers'
const MANIFEST_VERSION = 1

/** Ported module roots (plan WP-03); the vendored set is their transitive closure. */
const ROOTS = [
  'src/tui.ts',
  'src/tui-main-screen.ts',
  'src/tui-alt-screen.ts',
  'src/terminal.ts',
  'src/layout.ts',
  'src/layout-node.ts',
  'src/utils.ts',
  'src/keys.ts',
  'src/stdin-buffer.ts',
  'src/editor-component.ts',
  'src/components/stack.ts',
  'src/components/v-stack.ts',
  'src/components/h-stack.ts',
  'src/components/text.ts',
  'src/components/truncated-text.ts',
  'src/components/editor.ts',
  'src/components/scroll-view.ts',
  'src/components/spacer.ts',
  'src/components/box.ts',
]

/** Native trees are hash-registered, never built here (plan WP-03 native note). */
const NATIVE_DIRS = ['native/darwin', 'native/win32']

/** Human-readable reasons for closure-excluded upstream files. */
const EXCLUDED_REASONS = {
  'src/index.ts':
    'package barrel re-exports excluded modules (markdown/latex/image/loader/settings-list, marked); the fork imports concrete modules directly',
  'src/latex.ts':
    'LaTeX rendering is out of WP-03 scope and depends on marked; lands with components/media in WP-08 if needed',
  'src/components/markdown.ts':
    'Markdown component is out of WP-03a scope and depends on marked; re-implemented as v2 line component in WP-08',
  'src/components/loader.ts':
    'spinner/loader is replaced by dsh status/chrome components (WP-04+), not part of the ported root set',
  'src/components/cancellable-loader.ts':
    'same as components/loader.ts — not ported',
  'src/components/image.ts':
    'Image component deferred to WP-08 media work; terminal-image.ts primitives are vendored. Image-component tests inside terminal-image/tui-render/tui-alt-screen tests were dropped during test porting',
  'src/components/settings-list.ts':
    'settings UI is not part of the ported surface (WP-08)',
  'test/latex.test.ts': 'tests the excluded src/latex.ts module',
  'test/markdown.test.ts': 'tests the excluded src/components/markdown.ts module',
  'test/settings-list.test.ts': 'tests the excluded src/components/settings-list.ts module',
}

const NATIVE_NOTE =
  'native trees are hash-registered source/prebuild artifacts only: they are built solely when image/Windows-input capabilities require them; on Linux CI without native artifacts native-modifiers.ts/terminal.ts keep their conservative pure-TS fallback (helper not found -> undefined/false). The npm tarball must not carry undeclared binaries.'

const TESTS_NOTE =
  'Ported upstream tests live in test/tui-v2/pi-fork/ with a `pi fork: ` name prefix and .js specifiers into the vendor tree. Skipped: test/latex.test.ts, test/markdown.test.ts, test/settings-list.test.ts (modules excluded). Partial: Image-component cases dropped from terminal-image/tui-render/tui-alt-screen ports; terminal-colors.test.ts imports rewritten from the excluded index.ts barrel to concrete vendored modules; helper test-themes.ts trimmed to editor/select-list themes (markdown theme dropped).'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/** Relative import/export specifiers, incl. multiline blocks and side-effect imports. */
const SPECIFIER_RE =
  /(?:\bfrom\s*|^import\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\1/gm

export function parseRelativeSpecifiers(content) {
  const out = []
  for (const match of content.matchAll(SPECIFIER_RE)) out.push(match[2])
  return out
}

/** Mechanical `.ts` -> `.js` rewrite of relative specifiers (PATCH-LEDGER row 1). */
export function rewriteRelativeSpecifiers(content) {
  let rewrites = 0
  const rewritten = content.replace(
    /(\bfrom\s*|^import\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/gm,
    (whole, head, quote, spec) => {
      rewrites += 1
      return `${head}${quote}${spec}.js${quote}`
    },
  )
  return { rewritten, rewrites }
}

async function listFilesRecursive(dir, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full, base)))
    else if (entry.isFile()) out.push(toPosix(path.relative(base, full)))
  }
  return out.sort()
}

async function listTsSources(srcDir) {
  const files = (await listFilesRecursive(srcDir)).filter((f) => f.endsWith('.ts'))
  return files.map((f) => `src/${f}`).sort()
}

/** Transitive closure of relative imports over the upstream src tree. */
export async function computeClosure(upstreamSrcDir, roots) {
  const included = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const rel = queue.shift()
    if (included.has(rel)) continue
    const abs = path.join(upstreamSrcDir, '..', rel)
    if (!(await stat(abs).catch(() => null))?.isFile()) {
      throw new Error(`vendoring root/import target missing upstream: ${rel}`)
    }
    included.add(rel)
    const content = await readFile(abs, 'utf8')
    for (const spec of parseRelativeSpecifiers(content)) {
      const resolved = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)))
      queue.push(resolved)
    }
  }
  return [...included].sort()
}

async function gitIn(dir, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: dir })
  return stdout.trim()
}

async function validateSourceCheckout(sourceDir) {
  const tuiDir = path.join(sourceDir, 'packages', 'tui')
  if (!(await stat(tuiDir).catch(() => null))?.isDirectory()) {
    throw new Error(`--source ${sourceDir} does not look like the pi repo (packages/tui missing)`)
  }
  const head = await gitIn(sourceDir, ['rev-parse', 'HEAD'])
  if (head !== PINNED_COMMIT) {
    throw new Error(
      `source HEAD ${head} != pinned commit ${PINNED_COMMIT} (plan §0.2; a new pin requires an ADR)`,
    )
  }
  const dirty = await gitIn(sourceDir, ['status', '--porcelain'])
  if (dirty !== '') {
    throw new Error(`source checkout is not clean:\n${dirty}`)
  }
  const pkg = JSON.parse(await readFile(path.join(tuiDir, 'package.json'), 'utf8'))
  if (pkg.version !== PACKAGE_VERSION) {
    throw new Error(`upstream package version ${pkg.version} != expected ${PACKAGE_VERSION}`)
  }
  return tuiDir
}

// ---------------------------------------------------------------------------
// NOTICE / PATCH-LEDGER / manifest templates
// ---------------------------------------------------------------------------

function noticeText() {
  return `pi-tui vendored fork — attribution notice
===========================================

This directory contains a vendored fork of @earendil-works/pi-tui
(package version ${PACKAGE_VERSION}), part of the pi monorepo.

  Upstream repository : ${UPSTREAM_REPO}
  Upstream directory  : packages/tui
  Pinned commit       : ${PINNED_COMMIT}
  License             : ${LICENSE_ID} (see LICENSE in this directory)

The upstream project is copyright its authors (Mario Zechner and
contributors) and distributed under the MIT license, reproduced in
LICENSE.

This fork is maintained by the dsh-TUI project. Local differences from
the pinned upstream snapshot are recorded in PATCH-LEDGER.md; the file
list and per-file hashes are recorded in VENDOR-MANIFEST.json. Re-vendor
with:

  node scripts/vendor-pi-tui.mjs --source /path/to/pi
`
}

const LEDGER_HEADER = `# pi-tui fork patch ledger (WP-03)

Every non-mechanical local difference from the pinned upstream snapshot
(\`${PINNED_COMMIT}\`, \`@earendil-works/pi-tui\` ${PACKAGE_VERSION}) must be a row
in the table below. Mechanical transformations performed by
\`scripts/vendor-pi-tui.mjs\` are recorded as row(s) with kind = mechanical.
Re-vendor steps column names the exact command that reapplies the fork state.

| 文件 | 上游行为 | DSH 改动 | 原因 | 回归测试 | re-vendor 步骤 |
| --- | --- | --- | --- | --- | --- |
`

const LEDGER_MECHANICAL_ROW =
  '| mechanical: `src/tui-v2/vendor/pi-tui/src/**/*.ts` | ' +
  '上游相对路径 import/export specifier 带 `.ts` 后缀（strip-types 风格） | ' +
  '机械改写为 `.js` 后缀（bundler resolution；内容由 `scripts/vendor-pi-tui.mjs` 在复制时转换） | ' +
  '本仓库 tsconfig 用 bundler resolution + `tsc` 输出，运行 import 必须 `.js`；不计行为 patch | ' +
  '`pnpm compile` + `node scripts/test-tui-v2.mjs`（`test/tui-v2/pi-fork/` 全部上游移植测试） | ' +
  '`node scripts/vendor-pi-tui.mjs --source <pi checkout>`（重写自动应用，无需手工步骤） |\n'

function ledgerText() {
  return `${LEDGER_HEADER}${LEDGER_MECHANICAL_ROW}`
}

function manifestSkeleton({ vendoredAt, files, excluded }) {
  return {
    manifestVersion: MANIFEST_VERSION,
    repo: UPSTREAM_REPO,
    commit: PINNED_COMMIT,
    packageVersion: PACKAGE_VERSION,
    license: LICENSE_ID,
    vendoredAt,
    files,
    excluded,
    importRewrite: IMPORT_REWRITE_NOTE,
    notes: { native: NATIVE_NOTE, tests: TESTS_NOTE },
  }
}

// ---------------------------------------------------------------------------
// vendor mode
// ---------------------------------------------------------------------------

async function vendor(sourceDir) {
  const tuiDir = await validateSourceCheckout(sourceDir)
  const upstreamSrcDir = path.join(tuiDir, 'src')

  const closure = await computeClosure(upstreamSrcDir, ROOTS)
  const allSrc = await listTsSources(upstreamSrcDir)
  const excludedSrc = allSrc.filter((f) => !closure.includes(f))

  const vendorDir = path.join(repoRoot, VENDOR_REL)
  // Clean only the directories this script owns; top-level metadata files are
  // (re)written individually below.
  await rm(path.join(vendorDir, 'src'), { recursive: true, force: true })
  await rm(path.join(vendorDir, 'native'), { recursive: true, force: true })
  await mkdir(vendorDir, { recursive: true })

  const files = []
  const excluded = []
  let totalRewrites = 0

  // 1. src closure with the mechanical .ts -> .js specifier rewrite.
  for (const rel of closure) {
    const upstreamAbs = path.join(tuiDir, rel)
    const original = await readFile(upstreamAbs, 'utf8')
    const { rewritten, rewrites } = rewriteRelativeSpecifiers(original)
    totalRewrites += rewrites
    const targetAbs = path.join(vendorDir, rel)
    await mkdir(path.dirname(targetAbs), { recursive: true })
    await writeFile(targetAbs, rewritten, 'utf8')
    files.push({
      path: `${VENDOR_REL}/${rel}`,
      sha256: sha256Hex(Buffer.from(rewritten, 'utf8')),
      upstreamSha256: sha256Hex(Buffer.from(original, 'utf8')),
    })
  }
  for (const rel of excludedSrc) {
    excluded.push({ path: rel, reason: EXCLUDED_REASONS[rel] ?? 'not reachable from the ported root set' })
  }

  // 2. native trees verbatim (hash-registered, never built here).
  for (const nativeRel of NATIVE_DIRS) {
    const srcNative = path.join(tuiDir, nativeRel)
    if (!(await stat(srcNative).catch(() => null))?.isDirectory()) continue
    await cp(srcNative, path.join(vendorDir, nativeRel), { recursive: true })
    for (const file of await listFilesRecursive(srcNative)) {
      const buf = await readFile(path.join(srcNative, file))
      const hash = sha256Hex(buf)
      files.push({ path: `${VENDOR_REL}/${nativeRel}/${file}`, sha256: hash, upstreamSha256: hash })
    }
  }

  // 3. LICENSE from the upstream repo root (packages/tui has none).
  const licenseBuf = await readFile(path.join(sourceDir, 'LICENSE'))
  await writeFile(path.join(vendorDir, 'LICENSE'), licenseBuf)
  files.push({
    path: `${VENDOR_REL}/LICENSE`,
    sha256: sha256Hex(licenseBuf),
    upstreamSha256: sha256Hex(licenseBuf),
  })

  // 4. NOTICE (fork attribution; upstream ships none).
  const noticeBuf = Buffer.from(noticeText(), 'utf8')
  await writeFile(path.join(vendorDir, 'NOTICE'), noticeBuf)
  files.push({ path: `${VENDOR_REL}/NOTICE`, sha256: sha256Hex(noticeBuf), upstreamSha256: null })

  // 5. PATCH-LEDGER.md is maintained by hand; seed it when absent so the
  //    mechanical rewrite row is never lost on a fresh checkout.
  const ledgerAbs = path.join(vendorDir, 'PATCH-LEDGER.md')
  if (!(await stat(ledgerAbs).catch(() => null))?.isFile()) {
    await writeFile(ledgerAbs, ledgerText(), 'utf8')
  }
  files.push({
    path: `${VENDOR_REL}/PATCH-LEDGER.md`,
    sha256: sha256Hex(await readFile(ledgerAbs)),
    upstreamSha256: null,
  })

  // 6. Test-port exclusions (documented in the manifest per WP-03a spec).
  for (const key of Object.keys(EXCLUDED_REASONS)) {
    if (key.startsWith('test/')) excluded.push({ path: key, reason: EXCLUDED_REASONS[key] })
  }

  const manifest = manifestSkeleton({
    vendoredAt: new Date().toISOString(),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    excluded: excluded.sort((a, b) => a.path.localeCompare(b.path)),
  })
  await writeFile(
    path.join(vendorDir, 'VENDOR-MANIFEST.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  )

  return { manifest, closure, excludedSrc, totalRewrites }
}

// ---------------------------------------------------------------------------
// check mode (also used by scripts/verify-tui-v2.ts --check fork)
// ---------------------------------------------------------------------------

export async function checkVendorTree({ sourceDir = null } = {}) {
  const errors = []
  const vendorDir = path.join(repoRoot, VENDOR_REL)
  const manifestAbs = path.join(vendorDir, 'VENDOR-MANIFEST.json')

  let manifest = null
  try {
    manifest = JSON.parse(await readFile(manifestAbs, 'utf8'))
  } catch (error) {
    return { ok: false, errors: [`VENDOR-MANIFEST.json unreadable: ${String(error?.message || error)}`], manifest: null }
  }

  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    errors.push(`manifestVersion ${manifest.manifestVersion} != ${MANIFEST_VERSION}`)
  }
  for (const [field, expected] of [
    ['repo', UPSTREAM_REPO],
    ['commit', PINNED_COMMIT],
    ['packageVersion', PACKAGE_VERSION],
    ['license', LICENSE_ID],
    ['importRewrite', IMPORT_REWRITE_NOTE],
  ]) {
    if (manifest[field] !== expected) {
      errors.push(`manifest ${field} ${JSON.stringify(manifest[field])} != ${JSON.stringify(expected)}`)
    }
  }
  if (typeof manifest.vendoredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(manifest.vendoredAt)) {
    errors.push('manifest vendoredAt must be a UTC ISO timestamp')
  }

  const entries = Array.isArray(manifest.files) ? manifest.files : []
  const listed = new Set()
  for (const entry of entries) {
    const rel = entry?.path
    if (typeof rel !== 'string' || !rel.startsWith(`${VENDOR_REL}/`)) {
      errors.push(`manifest file entry with bad path: ${JSON.stringify(rel)}`)
      continue
    }
    if (listed.has(rel)) errors.push(`manifest lists ${rel} twice`)
    listed.add(rel)
    const abs = path.join(repoRoot, rel)
    const buf = await readFile(abs).catch(() => null)
    if (buf === null) {
      errors.push(`manifest file missing from vendor tree: ${rel}`)
      continue
    }
    if (sha256Hex(buf) !== entry.sha256) {
      errors.push(`sha256 mismatch (vendor tree drift, re-vendor or revert): ${rel}`)
    }
    if (sourceDir && entry.upstreamSha256 !== null) {
      // Map vendored path back to the upstream location.
      const relInVendor = rel.slice(VENDOR_REL.length + 1)
      const upstreamAbs =
        relInVendor === 'LICENSE'
          ? path.join(sourceDir, 'LICENSE')
          : path.join(sourceDir, 'packages', 'tui', relInVendor)
      const upstreamBuf = await readFile(upstreamAbs).catch(() => null)
      if (upstreamBuf === null) {
        errors.push(`upstream file missing for ${rel}: ${upstreamAbs}`)
      } else if (sha256Hex(upstreamBuf) !== entry.upstreamSha256) {
        errors.push(`upstreamSha256 mismatch for ${rel}`)
      }
    }
  }

  // No drift in the other direction: every vendored file must be listed
  // (VENDOR-MANIFEST.json is the checker itself and is exempt).
  const onDisk = (await listFilesRecursive(vendorDir).catch(() => [])).map(
    (f) => `${VENDOR_REL}/${f}`,
  )
  for (const rel of onDisk) {
    if (rel === `${VENDOR_REL}/VENDOR-MANIFEST.json`) continue
    if (!listed.has(rel)) errors.push(`unlisted file in vendor tree (not in manifest): ${rel}`)
  }

  for (const excluded of Array.isArray(manifest.excluded) ? manifest.excluded : []) {
    if (typeof excluded?.path !== 'string' || typeof excluded?.reason !== 'string' || excluded.reason === '') {
      errors.push(`excluded entry without path/reason: ${JSON.stringify(excluded)}`)
      continue
    }
    if (
      (await stat(path.join(vendorDir, excluded.path)).catch(() => null)) !== null ||
      (await stat(path.join(vendorDir, 'src', excluded.path)).catch(() => null)) !== null
    ) {
      errors.push(`excluded file present in vendor tree: ${excluded.path}`)
    }
  }

  // The mechanical rewrite must be complete: no relative `.ts` specifier left.
  const srcDir = path.join(vendorDir, 'src')
  const vendoredTs = (await listFilesRecursive(srcDir).catch(() => [])).filter((f) => f.endsWith('.ts'))
  for (const file of vendoredTs) {
    const content = await readFile(path.join(srcDir, file), 'utf8')
    for (const match of content.matchAll(
      /(?:\bfrom\s*|^import\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"']+\.ts)\1/gm,
    )) {
      errors.push(`leftover .ts specifier in vendored file src/${file}: ${match[2]}`)
    }
  }

  if (sourceDir) {
    try {
      await validateSourceCheckout(sourceDir)
    } catch (error) {
      errors.push(String(error?.message || error))
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    manifest,
    counts: { files: entries.length, onDisk: onDisk.length, vendoredTs: vendoredTs.length },
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { source: null, check: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--source') {
      out.source = argv[++i]
      if (!out.source) throw new Error('--source requires a path')
    } else if (arg === '--check') {
      out.check = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.check) {
    const result = await checkVendorTree({ sourceDir: args.source ? path.resolve(args.source) : null })
    if (!result.ok) {
      console.error(`vendor check FAILED (${result.errors.length} error(s)):`)
      for (const error of result.errors) console.error(`  - ${error}`)
      process.exitCode = 1
      return
    }
    console.log(
      `vendor check OK: ${result.counts?.files ?? '?'} manifest files, ${result.counts?.vendoredTs ?? '?'} vendored TS sources` +
        (args.source ? ' (upstream hashes verified)' : ''),
    )
    return
  }
  if (!args.source) throw new Error('--source <pi checkout> is required in vendor mode')
  const { manifest, closure, excludedSrc, totalRewrites } = await vendor(path.resolve(args.source))
  console.log(`vendored ${closure.length} src files (closure of ${ROOTS.length} roots), ${totalRewrites} specifier rewrites`)
  console.log(`excluded ${excludedSrc.length} src files: ${excludedSrc.join(', ')}`)
  console.log(`manifest: ${manifest.files.length} files -> ${VENDOR_REL}/VENDOR-MANIFEST.json`)
  const recheck = await checkVendorTree({})
  if (!recheck.ok) {
    console.error('post-vendor self-check FAILED:')
    for (const error of recheck.errors) console.error(`  - ${error}`)
    process.exitCode = 1
  }
}

const invokedAsMain =
  typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsMain) {
  main().catch((error) => {
    console.error(error?.message || error)
    process.exitCode = 1
  })
}
