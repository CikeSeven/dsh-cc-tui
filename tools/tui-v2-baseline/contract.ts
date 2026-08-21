/**
 * WP-09a offline baseline contract.
 *
 * This module is deliberately below `tools/tui-v2-baseline/`: it may consume
 * v2 testkit contracts, but no production module may import this tree. The
 * committed capture is a frozen artifact replay, not a runtime renderer.
 */
import { createHash } from 'node:crypto'

import { canonicalJson } from '../../src/tui-v2/model/canonical-json.js'
import { isSerializableValue, type SerializableError, type SerializableValue, type UiSnapshot } from '../../src/tui-v2/model/schema.js'
import { validateCanonicalGrid, type CanonicalGridV1 } from '../../src/tui-v2/testkit/canonical.js'
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import type { TerminalControlOperation } from '../../src/tui-v2/terminal/writer.js'
import type { Frame } from '../../src/tui-v2/renderer/frame.js'
import type { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js'

/** The exact WP-09 contract (plan §8/WP-09). */
export interface V1CaptureRenderer {
  render(snapshot: UiSnapshot, options: {
    profile: TerminalProfile
    writer: FakeTerminalWriter
    virtualTerminal: VirtualTerminal
    traceId: string
  }): Promise<V1CaptureResult>
}

/** The only writer visible to an offline capture. */
export interface FakeTerminalWriter {
  readonly writes: readonly string[]
  write(data: string): void
  writeControl(operation: TerminalControlOperation): void
  reset(): void
}

/** Serializable result returned by a capture. */
export interface V1CaptureResult {
  frame: Frame
  grid: CanonicalGridV1
  ansiBytesHash: string
  diagnostics: readonly SerializableError[]
}

export const BASELINE_SCHEMA_VERSION = 1 as const
export const BASELINE_REDACTION_VERSION = 1 as const
export const BASELINE_KIND = 'v1-capture-artifact' as const
export const BASELINE_LICENSE = 'MIT' as const

export interface FrozenCaptureRecord {
  readonly traceId: string
  readonly profile: string
  readonly snapshotHash: string
  readonly width: number
  readonly height: number
  readonly frameCount: number
  /** ANSI bytes are kept only in the frozen artifact, never in reports. */
  readonly ansiBase64: string
  readonly ansiBytesHash: string
  readonly grid: CanonicalGridV1
  readonly diagnostics: readonly SerializableError[]
}

export interface FrozenCaptureArtifact {
  readonly schemaVersion: typeof BASELINE_SCHEMA_VERSION
  readonly kind: typeof BASELINE_KIND
  readonly redactionVersion: typeof BASELINE_REDACTION_VERSION
  readonly sourceCommit: string
  readonly sourceTreeSha256: string
  readonly license: {
    readonly spdx: typeof BASELINE_LICENSE
    readonly path: string
    readonly sha256: string
  }
  readonly captures: readonly FrozenCaptureRecord[]
}

export type SideEffectKind =
  | 'stdout'
  | 'stderr'
  | 'subscription'
  | 'timer'
  | 'command'
  | 'session-write'

export interface SideEffectPolicy {
  readonly allowed: readonly ['fake-writer']
  readonly forbidden: readonly SideEffectKind[]
  readonly zeroAfterCapture: readonly SideEffectKind[]
}

export interface FrozenBaselineManifest {
  readonly schemaVersion: typeof BASELINE_SCHEMA_VERSION
  readonly kind: 'tui-v2-baseline-manifest'
  readonly captureBackend: 'frozen-artifact'
  readonly redactionVersion: typeof BASELINE_REDACTION_VERSION
  readonly source: {
    readonly commit: string
    readonly treeSha256: string
    readonly files: readonly { readonly path: string; readonly sha256: string }[]
    readonly license: {
      readonly spdx: typeof BASELINE_LICENSE
      readonly path: string
      readonly sha256: string
    }
  }
  readonly artifact: {
    readonly path: string
    readonly sha256: string
  }
  readonly sideEffects: SideEffectPolicy
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export function assertSerializable(value: unknown, field = 'value'): asserts value is SerializableValue {
  if (!isSerializableValue(value)) {
    throw new TypeError(`${field} must be a SerializableValue`)
  }
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`)
  return value
}

function validateDiagnostics(value: unknown, field: string): readonly SerializableError[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  for (const [index, item] of value.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`${field}[${index}] must be an object`)
    }
    const error = item as Record<string, unknown>
    requiredString(error.code, `${field}[${index}].code`)
    requiredString(error.message, `${field}[${index}].message`)
    if (typeof error.recoverable !== 'boolean') {
      throw new TypeError(`${field}[${index}].recoverable must be boolean`)
    }
    if (error.details !== undefined) assertSerializable(error.details, `${field}[${index}].details`)
  }
  return value as readonly SerializableError[]
}

function validateRecord(value: unknown, index: number): FrozenCaptureRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`captures[${index}] must be an object`)
  }
  const record = value as Record<string, unknown>
  const traceId = requiredString(record.traceId, `captures[${index}].traceId`)
  const profile = requiredString(record.profile, `captures[${index}].profile`)
  const snapshotHash = requiredString(record.snapshotHash, `captures[${index}].snapshotHash`)
  for (const field of ['width', 'height', 'frameCount'] as const) {
    if (!Number.isInteger(record[field]) || (record[field] as number) < 0) {
      throw new TypeError(`captures[${index}].${field} must be a non-negative integer`)
    }
  }
  if (record.width === 0 || record.height === 0) {
    throw new TypeError(`captures[${index}] geometry must be positive`)
  }
  if (typeof record.ansiBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(record.ansiBase64)) {
    throw new TypeError(`captures[${index}].ansiBase64 must be base64`)
  }
  if (!isSha256(record.ansiBytesHash)) throw new TypeError(`captures[${index}].ansiBytesHash must be lowercase SHA-256`)
  const grid = validateCanonicalGrid(record.grid)
  if (grid.width !== record.width || grid.height !== record.height) {
    throw new TypeError(`captures[${index}] grid geometry does not match record geometry`)
  }
  const diagnostics = validateDiagnostics(record.diagnostics, `captures[${index}].diagnostics`)
  const bytes = Buffer.from(record.ansiBase64, 'base64')
  if (sha256Hex(bytes) !== record.ansiBytesHash) {
    throw new TypeError(`captures[${index}].ansiBytesHash does not match ansiBase64`)
  }
  return record as unknown as FrozenCaptureRecord
}

export function validateFrozenBaselineArtifact(value: unknown): FrozenCaptureArtifact {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('baseline artifact must be an object')
  }
  const artifact = value as Record<string, unknown>
  if (artifact.schemaVersion !== BASELINE_SCHEMA_VERSION) throw new TypeError('baseline artifact schemaVersion must be 1')
  if (artifact.kind !== BASELINE_KIND) throw new TypeError(`baseline artifact kind must be ${BASELINE_KIND}`)
  if (artifact.redactionVersion !== BASELINE_REDACTION_VERSION) throw new TypeError('baseline artifact redactionVersion must be 1')
  const sourceCommit = requiredString(artifact.sourceCommit, 'baseline artifact sourceCommit')
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new TypeError('baseline artifact sourceCommit must be a full git hash')
  if (!isSha256(artifact.sourceTreeSha256)) throw new TypeError('baseline artifact sourceTreeSha256 must be lowercase SHA-256')
  if (artifact.license === null || typeof artifact.license !== 'object' || Array.isArray(artifact.license)) {
    throw new TypeError('baseline artifact license must be an object')
  }
  const license = artifact.license as Record<string, unknown>
  if (license.spdx !== BASELINE_LICENSE) throw new TypeError('baseline artifact license.spdx must be MIT')
  requiredString(license.path, 'baseline artifact license.path')
  if (!isSha256(license.sha256)) throw new TypeError('baseline artifact license.sha256 must be lowercase SHA-256')
  if (!Array.isArray(artifact.captures) || artifact.captures.length === 0) {
    throw new TypeError('baseline artifact captures must be non-empty')
  }
  const captures = artifact.captures.map((item, index) => validateRecord(item, index))
  const keys = new Set<string>()
  for (const record of captures) {
    const key = `${record.traceId}\u0000${record.profile}\u0000${record.snapshotHash}`
    if (keys.has(key)) throw new TypeError(`duplicate baseline capture ${record.traceId}@${record.profile}`)
    keys.add(key)
  }
  return artifact as unknown as FrozenCaptureArtifact
}

function validatePolicy(value: unknown): SideEffectPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('sideEffects must be an object')
  const policy = value as Record<string, unknown>
  if (JSON.stringify(policy.allowed) !== JSON.stringify(['fake-writer'])) {
    throw new TypeError('sideEffects.allowed must be ["fake-writer"]')
  }
  const forbidden = policy.forbidden
  const zero = policy.zeroAfterCapture
  const allowedKinds: readonly SideEffectKind[] = ['stdout', 'stderr', 'subscription', 'timer', 'command', 'session-write']
  for (const [field, list] of [['forbidden', forbidden], ['zeroAfterCapture', zero]] as const) {
    if (!Array.isArray(list) || !list.every((item) => allowedKinds.includes(item as SideEffectKind))) {
      throw new TypeError(`sideEffects.${field} must contain known side-effect kinds`)
    }
  }
  return policy as unknown as SideEffectPolicy
}

export function validateFrozenBaselineManifest(value: unknown): FrozenBaselineManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('baseline manifest must be an object')
  const manifest = value as Record<string, unknown>
  if (manifest.schemaVersion !== BASELINE_SCHEMA_VERSION) throw new TypeError('baseline manifest schemaVersion must be 1')
  if (manifest.kind !== 'tui-v2-baseline-manifest') throw new TypeError('baseline manifest kind is invalid')
  if (manifest.captureBackend !== 'frozen-artifact') throw new TypeError('baseline manifest captureBackend must be frozen-artifact')
  if (manifest.redactionVersion !== BASELINE_REDACTION_VERSION) throw new TypeError('baseline manifest redactionVersion must be 1')
  if (manifest.source === null || typeof manifest.source !== 'object' || Array.isArray(manifest.source)) throw new TypeError('baseline manifest source must be an object')
  const source = manifest.source as Record<string, unknown>
  const commit = requiredString(source.commit, 'manifest.source.commit')
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new TypeError('manifest.source.commit must be a full git hash')
  if (!isSha256(source.treeSha256)) throw new TypeError('manifest.source.treeSha256 must be lowercase SHA-256')
  if (!Array.isArray(source.files) || source.files.length === 0) throw new TypeError('manifest.source.files must be non-empty')
  for (const [index, item] of source.files.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`manifest.source.files[${index}] must be an object`)
    const file = item as Record<string, unknown>
    requiredString(file.path, `manifest.source.files[${index}].path`)
    if (!isSha256(file.sha256)) throw new TypeError(`manifest.source.files[${index}].sha256 must be lowercase SHA-256`)
  }
  const treeInput = (source.files as readonly Record<string, unknown>[]).map((file) => `${String(file.path)}:${String(file.sha256)}`).join('\n') + '\n'
  if (sha256Hex(treeInput) !== source.treeSha256) throw new TypeError('manifest.source.treeSha256 does not match source file list')
  if (source.license === null || typeof source.license !== 'object' || Array.isArray(source.license)) throw new TypeError('manifest.source.license must be an object')
  const license = source.license as Record<string, unknown>
  if (license.spdx !== BASELINE_LICENSE) throw new TypeError('manifest source license must be MIT')
  requiredString(license.path, 'manifest.source.license.path')
  if (!isSha256(license.sha256)) throw new TypeError('manifest.source.license.sha256 must be lowercase SHA-256')
  if (manifest.artifact === null || typeof manifest.artifact !== 'object' || Array.isArray(manifest.artifact)) throw new TypeError('manifest.artifact must be an object')
  const artifact = manifest.artifact as Record<string, unknown>
  requiredString(artifact.path, 'manifest.artifact.path')
  if (!isSha256(artifact.sha256)) throw new TypeError('manifest.artifact.sha256 must be lowercase SHA-256')
  validatePolicy(manifest.sideEffects)
  return manifest as unknown as FrozenBaselineManifest
}

export function captureKey(traceId: string, profile: string, snapshotHash: string): string {
  return `${traceId}\u0000${profile}\u0000${snapshotHash}`
}

export function redactedDiagnostic(code: string, message: string, recoverable = true): SerializableError {
  return { code, message: message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '<control>'), recoverable }
}
