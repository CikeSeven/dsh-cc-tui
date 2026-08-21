#!/usr/bin/env node
/**
 * Exact npm tarball verifier (WP-09c2).
 *
 * The verifier is intentionally release-time code.  It validates one already
 * produced tarball and one already produced npm-pack report; it never runs
 * prepare/build, downloads a package, contacts a registry, or invokes the
 * rollback launcher.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  expectedTarballBasename,
  isRegularFile,
  readRollbackManifest,
  sha1File,
  sha256File,
  sha512Integrity,
  validateRollbackLocal,
  writeJsonAtomic,
} from './tui-v2-rollback.mjs'

const execFileAsync = promisify(execFile)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const packagePath = path.join(repoRoot, 'package.json')
const VENDOR_SOURCE = path.join(repoRoot, 'src', 'tui-v2', 'vendor', 'pi-tui')
const MAX_TARBALL_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_UNPACKED_BYTES = 1 * 1024 * 1024 * 1024
const REQUIRED_VENDOR_FILES = ['LICENSE', 'NOTICE', 'PATCH-LEDGER.md', 'VENDOR-MANIFEST.json']
const REQUIRED_PRESET_FILES = [
  'presets/liangshen/agent.cordis.yml',
  'presets/liangshen/preset.yml',
  'presets/liangshen/.dsh-tui-managed.json',
  'presets/liangshen/tool-bootstrap.mjs',
]
const RETIRED_PATH_RE = /^(?:src\/|tools\/|lib\/types\/(?:ink|components|screens|renderer-v1|legacy-renderer|native-ts\/yoga-layout|ui(?:\.|\/)|force-production-react(?:\.|\/)|customTheme(?:\.|\/)|theme(?:\.|\/)|trajectoryPrefs(?:\.|\/)|bootstrap\/state(?:\.|\/)|hooks\/useBlink(?:\.|\/)|sessions\/format(?:\.|\/)|utils\/sliceAnsi(?:\.|\/)|cc\/(?:markdown|cliHighlight|hyperlink|terminal|figures|format|spinnerVerbs)(?:\.|\/)|trajectory\/(?:format|motion|query)(?:\.|\/)))/u
const RETIRED_DEPENDENCY_RE = /^(?:react|react-reconciler|yoga|yoga-layout)(?:\/|$)/u
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(|^import\s*)(["'])([^"']+)\1/gm
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.d.ts', '.json', '.yml', '.yaml', '.md'])

function normalizeSlash(value) {
  return value.split('\\').join('/')
}

function fail(message) {
  throw new Error(message)
}

export function assertSafeArchiveName(raw, where = 'tar entry') {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0') || raw.includes('\n') || raw.includes('\r')) {
    fail(`${where} has an invalid name`)
  }
  if (raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(raw)) {
    fail(`${where} has an absolute or backslash path: ${JSON.stringify(raw)}`)
  }
  const hasTrailingSlash = raw.endsWith('/')
  const probe = hasTrailingSlash ? raw.slice(0, -1) : raw
  const segments = probe.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail(`${where} contains a traversal/empty path segment: ${JSON.stringify(raw)}`)
  }
  if (raw !== 'package' && !raw.startsWith('package/')) {
    fail(`${where} is outside package/: ${JSON.stringify(raw)}`)
  }
  return raw
}

function packageRelative(raw) {
  if (raw === 'package' || raw === 'package/') return ''
  return raw.slice('package/'.length).replace(/\/$/u, '')
}

export function normalizePackFileName(raw) {
  if (typeof raw !== 'string' || raw === '') fail('npm pack files[] contains an invalid path')
  const normalized = normalizeSlash(raw)
  if (normalized.startsWith('package/')) return packageRelative(assertSafeArchiveName(normalized, 'npm pack file'))
  assertSafeArchiveName(`package/${normalized}`, 'npm pack file')
  return normalized
}

async function runTar(args, label) {
  try {
    return await execFileAsync('tar', args, { cwd: repoRoot, maxBuffer: 128 * 1024 * 1024 })
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error)
    throw new Error(`${label} failed: ${detail.slice(-2000)}`)
  }
}

async function listAndValidateArchive(tarball) {
  const listed = await runTar(['--list', '--gzip', '--file', tarball], 'tar list')
  const rawNames = String(listed.stdout).split('\n').filter(line => line !== '')
  if (rawNames.length === 0) fail('tarball contains no entries')
  if (rawNames.length > MAX_ARCHIVE_ENTRIES) fail(`tarball contains too many entries (${rawNames.length})`)
  const names = []
  const seen = new Set()
  for (const raw of rawNames) {
    const name = assertSafeArchiveName(raw)
    const normalized = name.endsWith('/') ? name.slice(0, -1) : name
    if (seen.has(normalized)) fail(`tarball contains duplicate entry: ${normalized}`)
    seen.add(normalized)
    names.push({ raw: name, path: normalized, relative: packageRelative(name) })
  }

  // Validate entry kinds before extraction.  GNU/BSD tar both put the type
  // marker in column zero of verbose listing; a count mismatch fails closed.
  const verbose = await runTar(['--list', '--verbose', '--gzip', '--file', tarball], 'tar type list')
  const typeLines = String(verbose.stdout).split('\n').filter(line => line !== '')
  if (typeLines.length !== names.length) {
    fail(`tar verbose listing count ${typeLines.length} != name listing count ${names.length}`)
  }
  const forbiddenTypes = new Set(['l', 'h', 'c', 'b', 'p', 's'])
  for (let index = 0; index < typeLines.length; index += 1) {
    const marker = typeLines[index][0]
    if (forbiddenTypes.has(marker)) fail(`tarball contains unsafe entry type ${marker} at ${names[index].path}`)
    if (!['-', 'd'].includes(marker)) fail(`tarball contains unknown entry type ${marker} at ${names[index].path}`)
  }
  return names
}

async function extractArchive(tarball, names) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-tarball-'))
  try {
    await runTar([
      '--extract', '--gzip', '--file', tarball, '--directory', directory,
      '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir',
    ], 'tar extract')
    const packageDir = path.join(directory, 'package')
    if (!(await stat(packageDir).catch(() => null))?.isDirectory()) fail('tarball has no package/ directory')
    const actual = []
    async function walk(current, relative = '') {
      const entries = await readdir(current, { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const nextRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
        assertSafeArchiveName(`package/${nextRelative}`, 'extracted path')
        const next = path.join(current, entry.name)
        const info = await lstat(next)
        if (info.isSymbolicLink()) fail(`extracted tarball contains symlink: ${nextRelative}`)
        if (info.isDirectory()) {
          actual.push({ path: nextRelative, type: 'directory', size: 0, sha256: null })
          await walk(next, nextRelative)
        } else if (info.isFile()) {
          if (info.size > MAX_UNPACKED_BYTES) fail(`single extracted file is too large: ${nextRelative}`)
          actual.push({ path: nextRelative, type: 'file', size: info.size, sha256: await sha256File(next) })
        } else {
          fail(`extracted tarball contains unsupported file type: ${nextRelative}`)
        }
      }
    }
    await walk(packageDir)
    const totalBytes = actual.reduce((sum, entry) => sum + entry.size, 0)
    if (totalBytes > MAX_UNPACKED_BYTES) fail(`extracted tarball exceeds ${MAX_UNPACKED_BYTES} bytes`)
    const regular = actual.filter(entry => entry.type === 'file')
    const listedRegular = names.filter(entry => entry.relative !== '' && !entry.raw.endsWith('/')).map(entry => entry.relative)
    const actualSet = new Set(regular.map(entry => entry.path))
    const listedSet = new Set(listedRegular)
    const missing = listedRegular.filter(entry => !actualSet.has(entry))
    const extra = regular.map(entry => entry.path).filter(entry => !listedSet.has(entry))
    if (missing.length > 0 || extra.length > 0) {
      fail(`tar extraction/list mismatch (missing=${missing.join(',')}; extra=${extra.join(',')})`)
    }
    return { directory, packageDir, entries: actual.sort((a, b) => a.path.localeCompare(b.path)), totalBytes }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function normalizePackReport(input) {
  let report
  if (Array.isArray(input)) {
    if (input.length !== 1) fail(`npm pack JSON must contain exactly one artifact (got ${input.length})`)
    report = input[0]
  } else if (input !== null && typeof input === 'object') {
    const keys = Object.keys(input)
    if (keys.length !== 1) fail(`npm pack JSON must contain exactly one keyed artifact (got ${keys.length})`)
    report = input[keys[0]]
  } else {
    fail('npm pack JSON must be an array or one-key object')
  }
  if (report === null || typeof report !== 'object' || !Array.isArray(report.files)) fail('npm pack report has no files[]')
  return report
}

async function verifyPackReport(packJsonPath, tarball, tarballSha256, sourcePackage) {
  let raw
  try {
    raw = JSON.parse(await readFile(packJsonPath, 'utf8'))
  } catch (error) {
    fail(`pack JSON unreadable: ${String(error?.message || error)}`)
  }
  const report = normalizePackReport(raw)
  const absoluteTarball = path.resolve(tarball)
  const expectedFilename = expectedTarballBasename(sourcePackage.name, sourcePackage.version)
  if (expectedFilename === null || path.basename(absoluteTarball) !== expectedFilename) {
    fail(`tarball basename ${path.basename(absoluteTarball)} does not match package identity ${sourcePackage.name}@${sourcePackage.version}`)
  }
  const reportedFilename = typeof report.filename === 'string'
    ? path.resolve(path.dirname(path.resolve(packJsonPath)), report.filename)
    : null
  if (reportedFilename === null || reportedFilename !== absoluteTarball) {
    fail(`pack filename does not identify exact tarball: ${JSON.stringify(report.filename)}`)
  }
  if (report.name !== sourcePackage.name || report.version !== sourcePackage.version) {
    fail(`pack report identity ${report.name}@${report.version} does not match package.json ${sourcePackage.name}@${sourcePackage.version}`)
  }
  const info = await lstat(absoluteTarball)
  const reportedPackageSize = report.packageSize ?? report.size
  if (!Number.isInteger(reportedPackageSize) || reportedPackageSize !== info.size) {
    fail(`pack packageSize ${reportedPackageSize} does not match tarball size ${info.size}`)
  }
  const actualSha1 = await sha1File(absoluteTarball)
  if (report.shasum !== undefined && report.shasum !== actualSha1) fail('pack shasum does not match tarball')
  const actualIntegrity = await sha512Integrity(absoluteTarball)
  if (report.integrity !== undefined && report.integrity !== actualIntegrity) fail('pack integrity does not match tarball')
  if (tarballSha256 !== undefined && (await sha256File(absoluteTarball)) !== tarballSha256) fail('tarball sha256 changed during pack verification')

  const packFiles = new Map()
  for (const file of report.files) {
    if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || !Number.isInteger(file.size) || file.size < 0) {
      fail('npm pack files[] contains an invalid file record')
    }
    const relative = normalizePackFileName(file.path)
    if (relative === '' || packFiles.has(relative)) fail(`npm pack files[] contains duplicate/empty path: ${relative}`)
    packFiles.set(relative, file.size)
  }
  const packUnpackedSize = [...packFiles.values()].reduce((sum, size) => sum + size, 0)
  if (Number.isInteger(report.unpackedSize) && report.unpackedSize !== packUnpackedSize) {
    fail(`pack unpackedSize ${report.unpackedSize} does not match files[] total ${packUnpackedSize}`)
  }
  return { report, packFiles, packJsonSha256: await sha256File(packJsonPath), tarballSize: info.size, packageSize: reportedPackageSize, sha1: actualSha1, integrity: actualIntegrity }
}

function collectTargets(value, output, prefix = 'exports') {
  if (typeof value === 'string') {
    const target = normalizeSlash(value).replace(/^\.\//u, '')
    if (target === '' || target.startsWith('/') || target.split('/').some(part => part === '..')) fail(`${prefix} has unsafe target ${value}`)
    output.add(target)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) collectTargets(nested, output, `${prefix}.${key}`)
}

function dependencyNames(packageJson) {
  const names = []
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    const value = packageJson[section]
    if (Array.isArray(value)) names.push(...value)
    else if (value !== null && typeof value === 'object') names.push(...Object.keys(value))
  }
  return names
}

async function verifyVendorMetadata(packageDir, entries) {
  const errors = []
  const required = REQUIRED_VENDOR_FILES.map(name => `lib/types/tui-v2/vendor/pi-tui/${name}`)
  for (const relative of required) {
    const entry = entries.find(item => item.path === relative && item.type === 'file')
    if (entry === undefined) errors.push(`missing vendored release metadata: ${relative}`)
  }
  const sourceBytes = new Map()
  for (const name of REQUIRED_VENDOR_FILES) {
    const source = path.join(VENDOR_SOURCE, name)
    const packaged = path.join(packageDir, 'lib', 'types', 'tui-v2', 'vendor', 'pi-tui', name)
    try {
      const [left, right] = await Promise.all([readFile(source), readFile(packaged)])
      if (!left.equals(right)) errors.push(`packaged vendor metadata differs from source: ${name}`)
      sourceBytes.set(name, left)
    } catch (error) {
      errors.push(`vendor metadata unreadable (${name}): ${String(error?.message || error)}`)
    }
  }
  try {
    const manifest = JSON.parse(sourceBytes.get('VENDOR-MANIFEST.json')?.toString('utf8') ?? '')
    if (manifest.manifestVersion !== 1 || typeof manifest.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(manifest.commit)) {
      errors.push('source VENDOR-MANIFEST.json has invalid manifestVersion/commit')
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) errors.push('source VENDOR-MANIFEST.json has no files[]')
    const seen = new Set()
    for (const item of manifest.files ?? []) {
      if (item === null || typeof item !== 'object' || typeof item.path !== 'string' || !/^[0-9a-f]{64}$/u.test(item.sha256)) {
        errors.push('source VENDOR-MANIFEST.json contains an invalid file hash record')
        continue
      }
      if (seen.has(item.path)) errors.push(`source VENDOR-MANIFEST.json duplicates ${item.path}`)
      seen.add(item.path)
      const sourcePath = path.join(repoRoot, item.path)
      if (!(await isRegularFile(sourcePath))) {
        errors.push(`vendor manifest source file missing: ${item.path}`)
      } else if (await sha256File(sourcePath) !== item.sha256) {
        errors.push(`vendor manifest source hash mismatch: ${item.path}`)
      }
    }
    if (typeof manifest.packageVersion !== 'string' || manifest.packageVersion === '') errors.push('vendor manifest packageVersion missing')
  } catch (error) {
    errors.push(`VENDOR-MANIFEST.json is invalid: ${String(error?.message || error)}`)
  }
  const ledger = sourceBytes.get('PATCH-LEDGER.md')?.toString('utf8') ?? ''
  if (!ledger.includes('re-vendor') || !ledger.includes('|')) errors.push('PATCH-LEDGER.md has no re-vendor ledger/table contract')
  return errors
}

async function verifyPackageSurface(extracted, sourcePackage, packFiles) {
  const errors = []
  const packageJsonPath = path.join(extracted.packageDir, 'package.json')
  let packedPackage
  try {
    packedPackage = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  } catch (error) {
    fail(`packed package.json unreadable: ${String(error?.message || error)}`)
  }
  if (packedPackage.name !== sourcePackage.name || packedPackage.version !== sourcePackage.version) {
    errors.push(`packed package identity ${packedPackage.name}@${packedPackage.version} differs from source ${sourcePackage.name}@${sourcePackage.version}`)
  }
  const allEntries = extracted.entries.filter(entry => entry.type === 'file')
  const filePaths = new Set(allEntries.map(entry => entry.path))
  const targetSet = new Set()
  for (const field of ['main', 'types']) if (typeof packedPackage[field] === 'string') collectTargets(packedPackage[field], targetSet, field)
  for (const value of Object.values(packedPackage.bin ?? {})) collectTargets(value, targetSet, 'bin')
  collectTargets(packedPackage.exports, targetSet)
  const missingTargets = [...targetSet].filter(target => !filePaths.has(target))
  if (missingTargets.length > 0) errors.push(`package exports/entry targets missing: ${missingTargets.join(', ')}`)

  if (!filePaths.has('LICENSE')) errors.push('package root LICENSE is missing')
  for (const relative of REQUIRED_PRESET_FILES) if (!filePaths.has(relative)) errors.push(`packaged preset file missing: ${relative}`)
  for (const entry of allEntries) {
    if (RETIRED_PATH_RE.test(entry.path) || entry.path.startsWith('tools/')) errors.push(`package contains retired/source path: ${entry.path}`)
    if (entry.path.endsWith('.node')) errors.push(`package contains undeclared native binary: ${entry.path}`)
  }
  const dependencyHits = dependencyNames(packedPackage).filter(name => typeof name === 'string' && RETIRED_DEPENDENCY_RE.test(name))
  for (const name of dependencyHits) errors.push(`package contains retired dependency: ${name}`)

  for (const entry of allEntries) {
    if (!TEXT_EXTENSIONS.has(path.extname(entry.path)) && !entry.path.endsWith('.d.ts')) continue
    const source = await readFile(path.join(extracted.packageDir, entry.path), 'utf8').catch(() => '')
    if (/DSH_TUI_RENDERER|react-reconciler|yoga-layout|(?:from|import\s*\()\s*["'](?:react|yoga)(?:\/|["'])/u.test(source)) {
      errors.push(`packed file contains retired renderer/dependency reference: ${entry.path}`)
    }
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[2]
      if (RETiredSpecifier(specifier)) errors.push(`packed file imports retired renderer: ${entry.path} -> ${specifier}`)
    }
  }

  const metadataErrors = await verifyVendorMetadata(extracted.packageDir, extracted.entries)
  errors.push(...metadataErrors)
  const packPathSet = new Set(packFiles.keys())
  const actualRegular = allEntries.map(entry => entry.path)
  const missingFromReport = actualRegular.filter(file => !packPathSet.has(file))
  const absentFromTar = [...packPathSet].filter(file => !filePaths.has(file))
  if (missingFromReport.length > 0) errors.push(`tarball files absent from npm pack report: ${missingFromReport.join(', ')}`)
  if (absentFromTar.length > 0) errors.push(`npm pack files absent from tarball: ${absentFromTar.join(', ')}`)
  for (const [file, size] of packFiles) {
    const entry = allEntries.find(item => item.path === file)
    if (entry !== undefined && entry.size !== size) errors.push(`file size mismatch for ${file}: report=${size}, tar=${entry.size}`)
  }

  return {
    packageJson: packedPackage,
    targets: [...targetSet].sort(),
    dependencyHits,
    metadataErrors,
    errors,
    fileCount: allEntries.length,
  }
}

function RETiredSpecifier(specifier) {
  return RETIRED_DEPENDENCY_RE.test(specifier) || /^(?:ink|components|screens|native-ts\/yoga-layout)(?:\/|$)/u.test(specifier)
}

async function gitValue(args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function commandVersion(command) {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], { cwd: repoRoot, maxBuffer: 1024 * 1024 })
    return String(stdout || stderr).trim().split('\n')[0] || null
  } catch {
    return null
  }
}

async function identity() {
  const lockfile = path.join(repoRoot, 'pnpm-lock.yaml')
  return {
    node: process.version,
    npm: await commandVersion('npm'),
    pnpm: await commandVersion(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
    gitHead: await gitValue(['rev-parse', 'HEAD']),
    gitDirty: (await gitValue(['status', '--porcelain'])) !== '',
    lockfileSha256: await isRegularFile(lockfile) ? await sha256File(lockfile) : null,
  }
}

function parseArgs(argv) {
  const result = { tarball: null, sha256: null, packJson: null, rollbackManifest: null, output: null, help: false }
  const allowed = new Set(['--tarball', '--sha256', '--pack-json', '--rollback-manifest', '--output'])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--help') {
      result.help = true
      continue
    }
    if (!allowed.has(arg)) throw new Error(`unknown argument: ${arg}`)
    const key = {
      '--tarball': 'tarball', '--sha256': 'sha256', '--pack-json': 'packJson',
      '--rollback-manifest': 'rollbackManifest', '--output': 'output',
    }[arg]
    if (result[key] !== null) throw new Error(`duplicate argument: ${arg}`)
    const value = argv[++index]
    if (value === undefined || value === '') throw new Error(`${arg} requires a value`)
    result[key] = value
  }
  if (!result.help) {
    for (const key of ['tarball', 'sha256', 'packJson', 'rollbackManifest']) if (result[key] === null) throw new Error(`--${key.replace(/[A-Z]/gu, m => `-${m.toLowerCase()}`)} is required`)
    if (!/^[0-9a-f]{64}$/u.test(result.sha256)) throw new Error('--sha256 must be lowercase 64-hex')
  }
  return result
}

function help() {
  return 'Usage: node scripts/verify-tui-v2-tarball.mjs --tarball <tgz> --sha256 <64hex> --pack-json <json> --rollback-manifest <json> [--output <json>]'
}

async function verifyRollbackPackageIdentity(rollbackPath, rollbackValue) {
  const names = await listAndValidateArchive(rollbackPath)
  const extracted = await extractArchive(rollbackPath, names)
  try {
    let value
    try {
      value = JSON.parse(await readFile(path.join(extracted.packageDir, 'package.json'), 'utf8'))
    } catch (error) {
      fail(`rollback tarball package.json unreadable: ${String(error?.message || error)}`)
    }
    if (value?.name !== rollbackValue.package || value?.version !== rollbackValue.version) {
      fail(`rollback tarball package identity ${value?.name}@${value?.version} does not match manifest ${rollbackValue.package}@${rollbackValue.version}`)
    }
    return { name: value.name, version: value.version, entryCount: extracted.entries.length }
  } finally {
    await rm(extracted.directory, { recursive: true, force: true })
  }
}

async function verify(args) {
  const sourcePackage = JSON.parse(await readFile(packagePath, 'utf8'))
  const tarball = path.resolve(args.tarball)
  const packJson = path.resolve(args.packJson)
  const rollbackManifest = path.resolve(args.rollbackManifest)
  for (const [label, file] of [['tarball', tarball], ['pack JSON', packJson], ['rollback manifest', rollbackManifest]]) {
    if (!(await isRegularFile(file))) fail(`${label} is not a regular file: ${file}`)
  }
  const tarballInfo = await lstat(tarball)
  if (tarballInfo.size > MAX_TARBALL_BYTES) fail(`tarball exceeds ${MAX_TARBALL_BYTES} bytes`)
  const actualSha256 = await sha256File(tarball)
  if (actualSha256 !== args.sha256) fail(`tarball sha256 ${actualSha256} does not match --sha256 ${args.sha256}`)
  const names = await listAndValidateArchive(tarball)
  const extracted = await extractArchive(tarball, names)
  try {
    const pack = await verifyPackReport(packJson, tarball, args.sha256, sourcePackage)
    const surface = await verifyPackageSurface(extracted, sourcePackage, pack.packFiles)
    if (surface.errors.length > 0) fail(surface.errors.join('; '))

    const packedPackage = surface.packageJson
    const rollbackRead = await readRollbackManifest(rollbackManifest, { expectedPackageName: sourcePackage.name, requireUnexpired: true })
    // The rollback verifier validates the manifest's own package/version and
    // exact local hash.  It does not require rollback version == current
    // release version: production explicitly points at the previous release.
    const rollback = await validateRollbackLocal(rollbackManifest, {
      expectedPackageName: sourcePackage.name,
      requireUnexpired: true,
    })
    if (rollback.errors.length > 0) fail(rollback.errors.join('; '))
    if (rollbackRead.value === null) fail('rollback manifest could not be read')
    const rollbackPackage = await verifyRollbackPackageIdentity(rollback.tarballPath, rollbackRead.value)

    const fileManifest = extracted.entries
    const fileManifestHash = createHash('sha256').update(`${JSON.stringify(fileManifest)}\n`).digest('hex')
    const releaseIdentity = await identity()
    return {
      schemaVersion: 1,
      verifier: 'tui-v2-exact-tarball-v1',
      status: 'pass',
      generatedAt: new Date().toISOString(),
      artifact: {
        tarball: path.resolve(tarball),
        sha256: actualSha256,
        size: tarballInfo.size,
        name: packedPackage.name,
        version: packedPackage.version,
      },
      pack: {
        path: path.resolve(packJson),
        sha256: pack.packJsonSha256,
        artifactCount: 1,
        filename: path.resolve(tarball),
        packageSize: pack.packageSize,
        unpackedSize: pack.report.unpackedSize ?? null,
        shasum: pack.sha1,
        integrity: pack.integrity,
      },
      packJson: { path: path.resolve(packJson), sha256: pack.packJsonSha256 },
      files: {
        count: fileManifest.length,
        manifest: fileManifest,
        sha256: fileManifestHash,
      },
      fileManifest: { count: fileManifest.length, sha256: fileManifestHash },
      surface: {
        targets: surface.targets,
        dependencyHits: surface.dependencyHits,
        legacyChecks: { sourcePaths: 0, forbiddenImports: 0, secondRenderer: false },
        requiredVendorFiles: REQUIRED_VENDOR_FILES.map(name => `lib/types/tui-v2/vendor/pi-tui/${name}`),
      },
      exports: { targets: surface.targets, missing: [] },
      dependencies: { retired: surface.dependencyHits, status: surface.dependencyHits.length === 0 ? 'pass' : 'fail' },
      rollback: {
        path: path.resolve(rollbackManifest),
        sha256: await sha256File(rollbackManifest),
        status: rollback.tarballStatus,
        tarball: rollback.tarballPath,
        tarballSha256: rollback.tarballSha256,
        tarballSize: rollback.tarballSize,
        package: rollback.summary?.package ?? null,
        version: rollback.summary?.version ?? null,
        packageIdentity: rollbackPackage,
        signature: rollback.summary?.signature ?? null,
        sessionSchema: rollback.summary?.sessionSchema ?? null,
        launcher: rollback.summary?.launcher ?? null,
        retention: rollback.summary?.retention ?? null,
      },
      rollbackValidation: {
        status: rollback.tarballStatus,
        manifest: path.resolve(rollbackManifest),
        tarball: rollback.tarballPath,
        package: rollback.summary?.package ?? null,
        version: rollback.summary?.version ?? null,
        signature: rollback.summary?.signature ?? null,
        sessionSchema: rollback.summary?.sessionSchema ?? null,
        launcher: rollback.summary?.launcher ?? null,
        retention: rollback.summary?.retention ?? null,
      },
      identity: releaseIdentity,
      git: { head: releaseIdentity.gitHead, dirty: releaseIdentity.gitDirty },
      toolchain: {
        node: releaseIdentity.node,
        npm: releaseIdentity.npm,
        pnpm: releaseIdentity.pnpm,
        lockfileSha256: releaseIdentity.lockfileSha256,
      },
      errors: [],
    }
  } finally {
    await rm(extracted.directory, { recursive: true, force: true })
  }
}

async function main() {
  const rawArgs = process.argv.slice(2)
  const outputIndex = rawArgs.indexOf('--output')
  const output = path.resolve(
    outputIndex >= 0 && rawArgs[outputIndex + 1]
      ? rawArgs[outputIndex + 1]
      : path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', 'verified-tarball.json'),
  )
  let artifact = {
    schemaVersion: 1,
    verifier: 'tui-v2-exact-tarball-v1',
    status: 'fail',
    generatedAt: new Date().toISOString(),
    artifact: null,
    pack: null,
    files: null,
    surface: null,
    rollback: null,
    identity: await identity(),
    errors: [],
  }
  let exitCode = 1
  try {
    const args = parseArgs(rawArgs)
    if (args.help) {
      console.log(help())
      artifact.status = 'pass'
      exitCode = 0
      return
    }
    artifact = await verify(args)
    exitCode = 0
  } catch (error) {
    artifact.errors = [String(error?.message || error)]
    console.error(`tarball verification failed: ${artifact.errors[0]}`)
  } finally {
    try {
      await writeJsonAtomic(output, artifact)
      console.log(`verified tarball artifact written to ${output} (status=${artifact.status})`)
    } catch (error) {
      console.error(`failed to write verified tarball artifact: ${String(error?.message || error)}`)
      exitCode = 1
    }
    process.exitCode = exitCode
  }
}

const invokedAsMain = typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsMain) await main()
