#!/usr/bin/env node
/**
 * Deterministic rollback-manifest generator (WP-09c2).
 *
 * Every release value is explicit: a CLI flag or one of the documented
 * environment variables.  There is intentionally no production signature,
 * previous version, launcher, or registry default.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  defaultRollbackOutput,
  expectedTarballBasename,
  isRegularFile,
  parseInteger,
  parseJsonString,
  sha256File,
  validateRollbackShape,
  writeJsonAtomic,
} from './tui-v2-rollback.mjs'

const ENV = {
  registry: ['TUI_V2_ROLLBACK_REGISTRY', 'ROLLBACK_REGISTRY'],
  package: ['TUI_V2_ROLLBACK_PACKAGE', 'ROLLBACK_PACKAGE'],
  version: ['TUI_V2_ROLLBACK_VERSION', 'ROLLBACK_VERSION', 'TUI_V2_PREVIOUS_VERSION'],
  tarball: ['TUI_V2_ROLLBACK_TARBALL', 'ROLLBACK_TARBALL'],
  sha256: ['TUI_V2_ROLLBACK_SHA256', 'ROLLBACK_SHA256'],
  signatureAlgorithm: ['TUI_V2_ROLLBACK_SIGNATURE_ALGORITHM', 'ROLLBACK_SIGNATURE_ALGORITHM'],
  signatureRef: ['TUI_V2_ROLLBACK_SIGNATURE_REF', 'ROLLBACK_SIGNATURE_REF'],
  sessionMin: ['TUI_V2_ROLLBACK_SESSION_MIN', 'ROLLBACK_SESSION_MIN'],
  sessionMax: ['TUI_V2_ROLLBACK_SESSION_MAX', 'ROLLBACK_SESSION_MAX'],
  launcherCommand: ['TUI_V2_ROLLBACK_LAUNCHER_COMMAND', 'ROLLBACK_LAUNCHER_COMMAND'],
  launcherArgsJson: ['TUI_V2_ROLLBACK_LAUNCHER_ARGS_JSON', 'ROLLBACK_LAUNCHER_ARGS_JSON'],
  launcherTimeoutMs: ['TUI_V2_ROLLBACK_LAUNCHER_TIMEOUT_MS', 'ROLLBACK_LAUNCHER_TIMEOUT_MS'],
  launcherRetries: ['TUI_V2_ROLLBACK_LAUNCHER_RETRIES', 'ROLLBACK_LAUNCHER_RETRIES'],
  keepStableVersions: ['TUI_V2_ROLLBACK_KEEP_STABLE_VERSIONS', 'ROLLBACK_KEEP_STABLE_VERSIONS'],
  expiresAt: ['TUI_V2_ROLLBACK_EXPIRES_AT', 'ROLLBACK_EXPIRES_AT'],
  output: ['TUI_V2_ROLLBACK_MANIFEST_OUTPUT', 'ROLLBACK_MANIFEST_OUTPUT'],
}

const FLAG = {
  registry: '--registry',
  package: '--package',
  version: '--version',
  tarball: '--tarball',
  sha256: '--sha256',
  signatureAlgorithm: '--signature-algorithm',
  signatureRef: '--signature-ref',
  sessionMin: '--session-min',
  sessionMax: '--session-max',
  launcherCommand: '--launcher-command',
  launcherArgsJson: '--launcher-args-json',
  launcherTimeoutMs: '--launcher-timeout-ms',
  launcherRetries: '--launcher-retries',
  keepStableVersions: '--keep-stable-versions',
  expiresAt: '--expires-at',
  output: '--output',
}

function envValue(names) {
  for (const name of names) {
    if (typeof process.env[name] === 'string' && process.env[name] !== '') return process.env[name]
  }
  return undefined
}

function parseArgs(argv) {
  const values = {}
  const launcherArgs = []
  let launcherArgFlag = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--help') return { help: true }
    if (arg === '--launcher-arg') {
      const value = argv[++index]
      if (value === undefined) throw new Error('--launcher-arg requires a value')
      launcherArgFlag = true
      launcherArgs.push(value)
      continue
    }
    const entry = Object.entries(FLAG).find(([, flag]) => flag === arg)
    if (entry === undefined) throw new Error(`unknown argument: ${arg}`)
    const [key] = entry
    if (values[key] !== undefined) throw new Error(`duplicate argument: ${arg}`)
    const value = argv[++index]
    if (value === undefined || value === '') throw new Error(`${arg} requires a non-empty value`)
    values[key] = value
  }
  if (launcherArgFlag) values.launcherArgs = launcherArgs
  return { help: false, values }
}

function required(values, key) {
  const value = values[key] ?? envValue(ENV[key])
  if (value === undefined || value === '') {
    throw new Error(`${FLAG[key] ?? key} is required (CLI or environment)`)
  }
  return value
}

function optional(values, key) {
  return values[key] ?? envValue(ENV[key])
}

function help() {
  return [
    'Usage: node scripts/create-tui-v2-rollback-manifest.mjs [options]',
    'Required: --registry --package --version --tarball --sha256 --signature-algorithm --signature-ref',
    '          --session-min --session-max --launcher-command --launcher-args-json',
    '          --launcher-timeout-ms --launcher-retries --keep-stable-versions --expires-at',
    'Optional: --tarball <basename or local path> --launcher-arg <arg>... --output <path>',
    'Every release value may instead be supplied through TUI_V2_ROLLBACK_* env vars.',
  ].join('\n')
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    console.log(help())
    return
  }
  const values = parsed.values
  const packageName = required(values, 'package')
  const version = required(values, 'version')
  const tarballInput = required(values, 'tarball')
  const canonicalTarball = expectedTarballBasename(packageName, version)
  let tarballName = canonicalTarball
  let localTarballPath = null
  if (tarballInput !== undefined) {
    if (tarballInput.includes('\\0') || tarballInput.includes('\\')) throw new Error('--tarball must use a POSIX basename/path')
    const candidate = path.resolve(tarballInput)
    const candidateIsFile = await isRegularFile(candidate)
    if (candidateIsFile) {
      localTarballPath = candidate
      tarballName = path.basename(candidate)
    } else if (path.basename(tarballInput) === tarballInput) {
      tarballName = tarballInput
    } else {
      throw new Error(`--tarball is not a regular file: ${candidate}`)
    }
  }
  if (tarballName === null || tarballName === '') throw new Error('--tarball or a package/version-derived tarball name is required')
  const sha256 = required(values, 'sha256')
  const launcherArgsJson = values.launcherArgs === undefined ? optional(values, 'launcherArgsJson') : undefined
  if (values.launcherArgs === undefined && (launcherArgsJson === undefined || launcherArgsJson === '')) {
    throw new Error('--launcher-args-json or at least one --launcher-arg is required (CLI or environment)')
  }
  if (values.launcherArgs !== undefined && launcherArgsJson !== undefined) {
    throw new Error('--launcher-arg cannot be combined with --launcher-args-json or its environment value')
  }
  const launcherArgs = values.launcherArgs ?? parseJsonString(launcherArgsJson, '--launcher-args-json')
  if (!Array.isArray(launcherArgs) || !launcherArgs.every((item) => typeof item === 'string')) {
    throw new Error('--launcher-args-json must describe a string array')
  }

  const manifest = {
    schemaVersion: 1,
    registry: required(values, 'registry'),
    package: packageName,
    version,
    tarball: tarballName,
    sha256,
    signature: {
      algorithm: required(values, 'signatureAlgorithm'),
      ref: required(values, 'signatureRef'),
    },
    sessionSchema: {
      min: parseInteger(required(values, 'sessionMin'), '--session-min'),
      max: parseInteger(required(values, 'sessionMax'), '--session-max'),
    },
    launcher: {
      command: required(values, 'launcherCommand'),
      args: launcherArgs,
      timeoutMs: parseInteger(required(values, 'launcherTimeoutMs'), '--launcher-timeout-ms'),
      retries: parseInteger(required(values, 'launcherRetries'), '--launcher-retries'),
    },
    retention: {
      keepStableVersions: parseInteger(required(values, 'keepStableVersions'), '--keep-stable-versions'),
      expiresAt: required(values, 'expiresAt'),
    },
  }

  const validation = validateRollbackShape(manifest, {
    expectedPackageName: packageName,
    requireUnexpired: true,
  })
  if (validation.errors.length > 0) throw new Error(validation.errors.join('; '))

  if (localTarballPath !== null) {
    if (path.basename(localTarballPath) !== manifest.tarball) {
      throw new Error(`--tarball basename ${path.basename(localTarballPath)} does not match ${manifest.tarball}`)
    }
    const actual = await sha256File(localTarballPath)
    if (actual !== manifest.sha256) throw new Error(`--tarball sha256 ${actual} does not match supplied ${manifest.sha256}`)
  }

  const output = path.resolve(optional(values, 'output') ?? defaultRollbackOutput())
  await writeJsonAtomic(output, manifest)
  // A deterministic read-back catches partial/invalid output before the caller
  // treats this file as a release input.
  const readBack = JSON.parse(await readFile(output, 'utf8'))
  const readValidation = validateRollbackShape(readBack, {
    expectedPackageName: packageName,
    requireUnexpired: true,
  })
  if (readValidation.errors.length > 0) throw new Error(`generated manifest failed read-back: ${readValidation.errors.join('; ')}`)
  console.log(`rollback manifest written to ${output}`)
}

try {
  await main()
} catch (error) {
  console.error(`rollback manifest generation failed: ${String(error?.message || error)}`)
  process.exitCode = 1
}
