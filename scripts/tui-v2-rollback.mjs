#!/usr/bin/env node
/**
 * Shared rollback-manifest contract for WP-09c2.
 *
 * This module is deliberately kept under scripts/: it is a release-time
 * verifier, never a runtime/imported package surface.  It performs local
 * validation only.  It never contacts a registry and never invokes a
 * launcher.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, rename, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROLLBACK_SCHEMA_VERSION = 1
export const CURRENT_SESSION_SCHEMA = 1
export const ROLLBACK_ENV_PREFIX = 'TUI_V2_ROLLBACK_'

const SHA256_RE = /^[0-9a-f]{64}$/u
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const UTC_RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'registry', 'package', 'version', 'tarball', 'sha256',
  'signature', 'sessionSchema', 'launcher', 'retention',
])
const SIGNATURE_KEYS = new Set(['algorithm', 'ref'])
const SESSION_KEYS = new Set(['min', 'max'])
const LAUNCHER_KEYS = new Set(['command', 'args', 'timeoutMs', 'retries'])
const RETENTION_KEYS = new Set(['keepStableVersions', 'expiresAt'])

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownKeys(value, allowed, where, errors) {
  if (!object(value)) return
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${where} contains unknown field ${key}`)
  }
}

export function expectedTarballBasename(packageName, version) {
  if (typeof packageName !== 'string' || typeof version !== 'string') return null
  if (!/^@[^/]+\/[^/]+$/u.test(packageName)) return null
  return `${packageName.slice(1).replace('/', '-')}-${version}.tgz`
}

export function validateRollbackShape(value, options = {}) {
  const errors = []
  const expectedPackage = options.expectedPackageName ?? null
  if (!object(value)) {
    return { errors: ['rollback manifest must be a JSON object'], value: null }
  }
  unknownKeys(value, TOP_LEVEL_KEYS, 'rollback manifest', errors)
  if (value.schemaVersion !== ROLLBACK_SCHEMA_VERSION) {
    errors.push(`rollback manifest schemaVersion must be ${ROLLBACK_SCHEMA_VERSION}`)
  }

  const requiredString = (field) => {
    if (typeof value[field] !== 'string' || value[field] === '') {
      errors.push(`rollback manifest missing ${field}`)
      return ''
    }
    return value[field]
  }
  const registry = requiredString('registry')
  const packageName = requiredString('package')
  const version = requiredString('version')
  const tarball = requiredString('tarball')
  const sha256 = requiredString('sha256')

  if (registry !== '') {
    try {
      const parsed = new URL(registry)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname === '') throw new Error('not registry URL')
    } catch {
      errors.push('rollback manifest registry must be an absolute URL')
    }
  }
  if (packageName !== '' && !/^@[^/]+\/[^/]+$/u.test(packageName)) {
    errors.push('rollback manifest package must be scoped')
  }
  if (expectedPackage !== null && packageName !== '' && packageName !== expectedPackage) {
    errors.push(`rollback manifest package ${packageName} does not match current package ${expectedPackage}`)
  }
  if (version !== '' && !SEMVER_RE.test(version)) {
    errors.push('rollback manifest version must be exact semver')
  }
  if (tarball !== '') {
    if (path.basename(tarball) !== tarball || tarball.includes('\\') || tarball.includes('\0')) {
      errors.push('rollback manifest tarball must be a safe basename')
    }
    if (!tarball.endsWith('.tgz')) errors.push('rollback manifest tarball must end in .tgz')
    // npm's canonical scoped form is `<scope>-<name>-<version>.tgz`. Older
    // immutable fixtures in this repository use the unscoped package-name
    // form; accept only those two exact package/version-derived basenames.
    const canonical = expectedTarballBasename(packageName, version)
    const shortName = packageName.includes('/') ? packageName.slice(packageName.indexOf('/') + 1) : packageName
    const legacy = `${shortName}-${version}.tgz`
    if (canonical !== null && tarball !== canonical && tarball !== legacy) {
      errors.push(`rollback manifest tarball must be ${canonical} or legacy ${legacy}`)
    }
  }
  if (sha256 !== '' && !SHA256_RE.test(sha256)) {
    errors.push('rollback manifest sha256 must be lowercase 64-hex')
  }

  const signature = value.signature
  if (!object(signature)) {
    errors.push('rollback manifest signature is required')
  } else {
    unknownKeys(signature, SIGNATURE_KEYS, 'rollback manifest signature', errors)
    if (!['sigstore', 'gpg'].includes(signature.algorithm)) {
      errors.push('rollback manifest signature.algorithm must be sigstore|gpg')
    }
    if (typeof signature.ref !== 'string' || signature.ref === '') {
      errors.push('rollback manifest signature.ref is required')
    }
  }

  const session = value.sessionSchema
  if (!object(session)) {
    errors.push('rollback manifest sessionSchema is required')
  } else {
    unknownKeys(session, SESSION_KEYS, 'rollback manifest sessionSchema', errors)
    if (!Number.isInteger(session.min) || !Number.isInteger(session.max) || session.min < 1 || session.max < session.min) {
      errors.push('rollback manifest sessionSchema min/max are invalid')
    } else if (session.min > CURRENT_SESSION_SCHEMA || session.max < CURRENT_SESSION_SCHEMA) {
      errors.push(`rollback manifest sessionSchema must include current schema ${CURRENT_SESSION_SCHEMA}`)
    }
  }

  const launcher = value.launcher
  if (!object(launcher)) {
    errors.push('rollback manifest launcher is required')
  } else {
    unknownKeys(launcher, LAUNCHER_KEYS, 'rollback manifest launcher', errors)
    if (typeof launcher.command !== 'string' || launcher.command === '') {
      errors.push('rollback manifest launcher.command is required')
    }
    if (!Array.isArray(launcher.args) || !launcher.args.every((item) => typeof item === 'string')) {
      errors.push('rollback manifest launcher.args must be a string array')
    }
    if (!Number.isInteger(launcher.timeoutMs) || launcher.timeoutMs <= 0) {
      errors.push('rollback manifest launcher.timeoutMs must be a positive integer')
    }
    if (!Number.isInteger(launcher.retries) || launcher.retries < 0) {
      errors.push('rollback manifest launcher.retries must be a non-negative integer')
    }
  }

  const retention = value.retention
  if (!object(retention)) {
    errors.push('rollback manifest retention is required')
  } else {
    unknownKeys(retention, RETENTION_KEYS, 'rollback manifest retention', errors)
    if (!Number.isInteger(retention.keepStableVersions) || retention.keepStableVersions < 1) {
      errors.push('rollback manifest retention.keepStableVersions must be a positive integer')
    }
    if (typeof retention.expiresAt !== 'string' || !UTC_RFC3339_RE.test(retention.expiresAt)) {
      errors.push('rollback manifest retention.expiresAt must be UTC RFC3339')
    } else if (!Number.isFinite(Date.parse(retention.expiresAt))) {
      errors.push('rollback manifest retention.expiresAt is not a valid timestamp')
    } else if (options.requireUnexpired === true && Date.parse(retention.expiresAt) <= Date.now()) {
      errors.push('rollback manifest retention.expiresAt is expired')
    }
  }

  return {
    errors,
    value: errors.length === 0 ? value : value,
    summary: {
      schemaVersion: value.schemaVersion ?? null,
      package: packageName || null,
      version: version || null,
      tarball: tarball || null,
      signature: object(signature)
        ? { algorithm: signature.algorithm ?? null, refPresent: typeof signature.ref === 'string' && signature.ref !== '' }
        : null,
      sessionSchema: object(session) ? { min: session.min ?? null, max: session.max ?? null } : null,
      launcher: object(launcher)
        ? { commandPresent: typeof launcher.command === 'string' && launcher.command !== '', timeoutMs: launcher.timeoutMs ?? null, retries: launcher.retries ?? null }
        : null,
      retention: object(retention)
        ? { keepStableVersions: retention.keepStableVersions ?? null, expiresAt: retention.expiresAt ?? null }
        : null,
    },
  }
}

export async function readRollbackManifest(manifestPath, options = {}) {
  const absolute = path.resolve(manifestPath)
  let value
  try {
    value = JSON.parse(await readFile(absolute, 'utf8'))
  } catch (error) {
    return {
      path: absolute,
      value: null,
      errors: [`rollback manifest unreadable: ${String(error?.message || error)}`],
    }
  }
  const validation = validateRollbackShape(value, options)
  return { path: absolute, value, ...validation }
}

export async function isRegularFile(file) {
  try {
    return (await lstat(file)).isFile()
  } catch {
    return false
  }
}

export async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function sha1File(file) {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function sha512Integrity(file) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return `sha512-${hash.digest('base64')}`
}

export async function validateRollbackLocal(manifestPath, options = {}) {
  const result = await readRollbackManifest(manifestPath, {
    expectedPackageName: options.expectedPackageName,
    requireUnexpired: options.requireUnexpired === true,
  })
  const errors = [...result.errors]
  let tarballPath = null
  let tarballStatus = 'not-checked'
  let tarballSha256 = null
  let tarballSize = null
  if (result.value !== null && errors.length === 0) {
    const configured = options.tarballPath === undefined || options.tarballPath === null
      ? path.join(path.dirname(result.path), result.value.tarball)
      : path.resolve(options.tarballPath)
    tarballPath = configured
    if (path.basename(configured) !== result.value.tarball) {
      errors.push('rollback tarball path basename does not match manifest')
    } else if (!(await isRegularFile(configured))) {
      tarballStatus = 'missing'
      errors.push(`rollback tarball is missing or not a regular file: ${configured}`)
    } else {
      tarballSha256 = await sha256File(configured)
      const info = await lstat(configured)
      tarballSize = info.size
      tarballStatus = tarballSha256 === result.value.sha256 ? 'verified' : 'tampered'
      if (tarballStatus !== 'verified') errors.push('rollback tarball sha256 does not match manifest')
    }
  }
  return {
    ...result,
    errors,
    tarballPath,
    tarballStatus,
    tarballSha256,
    tarballSize,
    summary: result.summary ?? null,
  }
}

export function defaultRollbackOutput(name = 'rollback-manifest.json') {
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', name)
}

export async function writeJsonAtomic(file, value) {
  const absolute = path.resolve(file)
  await mkdir(path.dirname(absolute), { recursive: true })
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`,
  )
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, absolute)
  return absolute
}

export function parseInteger(value, field) {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value)
  throw new Error(`${field} must be an integer`)
}

export function parseJsonString(value, field) {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${field} must be valid JSON: ${String(error?.message || error)}`)
  }
}

export function repoRootFromModule(metaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..')
}
