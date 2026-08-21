/**
 * Narrow host capabilities for WP-08f external actions.
 *
 * Controllers depend on these interfaces, never on DSH/Cordis or Node's
 * process streams directly.  Values crossing a controller/trace boundary are
 * bounded summaries; command lines, environments, clipboard bytes and child
 * output are deliberately not part of the serializable trace shape.
 */
import { createHash } from 'node:crypto'

import type { Clock, SerializableValue } from '../model/schema.js'

export const SHELL_OUTPUT_MAX_CHARS = 32_000
export const SHELL_OUTPUT_MAX_LINES = 256
export const CLIPBOARD_TEXT_MAX_CHARS = 1_000_000
export const ACTION_TRACE_MAX_ENTRIES = 256

export type ExternalActionKind = 'shell' | 'clipboard-copy' | 'clipboard-paste' | 'external-editor' | 'update' | 'notification' | 'preferences'
export type ExternalActionPhase = 'idle' | 'preparing' | 'working' | 'running' | 'reading' | 'checking' | 'pending-confirmation' | 'suspended' | 'completed' | 'unchanged' | 'empty' | 'nonzero' | 'success' | 'failure' | 'failed' | 'cancelled' | 'timed-out' | 'unsupported'

export interface ExternalActionSummary {
  readonly kind: ExternalActionKind
  readonly phase: ExternalActionPhase
  readonly operationId: string
  readonly generation: number
  readonly reason?: string
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly outputChars?: number
  readonly outputLines?: number
  readonly truncated?: boolean
  readonly payloadHash?: string
  readonly errorCode?: string
}

export interface ExternalActionTraceSink {
  record(summary: ExternalActionSummary): void
}

/** A bounded in-memory recorder useful for tests and diagnostic export. */
export function createExternalActionTraceRecorder(options: {
  readonly maxEntries?: number
  readonly sink?: (summary: ExternalActionSummary) => void
} = {}): ExternalActionTraceSink & { entries(): readonly ExternalActionSummary[]; clear(): void } {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? ACTION_TRACE_MAX_ENTRIES))
  const entries: ExternalActionSummary[] = []
  return {
    record(summary) {
      const safe: ExternalActionSummary = {
        kind: summary.kind,
        phase: summary.phase,
        operationId: summary.operationId,
        generation: Number.isInteger(summary.generation) ? summary.generation : 0,
        ...(summary.reason === undefined ? {} : { reason: sanitizeTraceScalar(summary.reason, 120) }),
        ...(summary.exitCode === undefined ? {} : { exitCode: summary.exitCode === null ? null : clampInt(summary.exitCode, -255, 255) }),
        ...(summary.signal === undefined ? {} : { signal: summary.signal === null ? null : sanitizeTraceScalar(summary.signal, 32) }),
        ...(summary.outputChars === undefined ? {} : { outputChars: clampInt(summary.outputChars, 0, SHELL_OUTPUT_MAX_CHARS) }),
        ...(summary.outputLines === undefined ? {} : { outputLines: clampInt(summary.outputLines, 0, SHELL_OUTPUT_MAX_LINES) }),
        ...(summary.truncated === undefined ? {} : { truncated: summary.truncated === true }),
        ...(summary.payloadHash === undefined ? {} : { payloadHash: /^[0-9a-f]{64}$/i.test(summary.payloadHash) ? summary.payloadHash.toLowerCase() : undefined }),
        ...(summary.errorCode === undefined ? {} : { errorCode: sanitizeTraceScalar(summary.errorCode, 80) }),
      }
      entries.push(safe)
      while (entries.length > maxEntries) entries.shift()
      try {
        options.sink?.(safe)
      } catch {
        // Diagnostics must never change action semantics.
      }
    },
    entries: () => entries.map((entry) => ({ ...entry })),
    clear: () => { entries.length = 0 },
  }
}

export interface ShellRequest {
  /** Host-owned command line. It is intentionally not copied into traces. */
  readonly commandLine: string
  readonly cwd: string
  /** Optional allowlisted environment overlay; secrets must be omitted. */
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs: number
  /** Local shell capability owns the actual shell selection/argv boundary. */
  readonly stdin: 'closed' | 'controlled'
}

export interface ShellOutputSink {
  stdout(text: string): void
  stderr(text: string): void
}

export interface ShellResult {
  readonly phase: 'completed' | 'failed' | 'cancelled' | 'timed-out'
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdoutChars: number
  readonly stderrChars: number
  readonly stdoutLines: number
  readonly stderrLines: number
  readonly truncated: boolean
  readonly errorCode?: string
}

export interface ShellCapability {
  run(request: ShellRequest, sink: ShellOutputSink, signal: AbortSignal): Promise<ShellResult>
}

export type ClipboardReadValue =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'files'; readonly paths: readonly string[] }
  | { readonly kind: 'image'; readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unavailable'; readonly reason?: string }
  | { readonly kind: 'error'; readonly code: string }

export type ClipboardWriteResult =
  | { readonly status: 'copied'; readonly chars: number; readonly payloadHash: string }
  | { readonly status: 'unsupported'; readonly reason: string }
  | { readonly status: 'error'; readonly code: string }

export interface ClipboardCapability {
  read(signal?: AbortSignal): Promise<ClipboardReadValue>
  copy(text: string, generation: number): Promise<ClipboardWriteResult>
}

export interface EditorRequest {
  readonly filePath: string
  readonly cwd: string
  readonly argv: readonly string[]
  readonly timeoutMs: number
}

export interface EditorResult {
  readonly phase: 'completed' | 'nonzero' | 'cancelled' | 'timed-out' | 'failed'
  readonly exitCode: number | null
  readonly signal: string | null
  readonly errorCode?: string
}

export interface EditorRunner {
  run(request: EditorRequest, signal: AbortSignal): Promise<EditorResult>
}

export interface RestartRequest {
  readonly sessionId: string
  readonly profile: string
  readonly targetVersion?: string
}

export interface RestartResult {
  readonly phase: 'success' | 'failure' | 'cancelled'
  readonly updateCode: number
  readonly restartCode: number
  readonly signal?: string | null
  readonly errorCode?: string
}

export interface RestartRunner {
  run(request: RestartRequest, signal: AbortSignal): Promise<RestartResult>
}

export interface PreferencePersistence {
  readTheme?(): string | undefined
  writeTheme?(name: string): boolean | Promise<boolean>
  readLanguage?(): string | undefined
  writeLanguage?(language: string): boolean | Promise<boolean>
}

export interface LanguageCapability {
  readonly supported: readonly string[]
  set(language: string): Promise<{ status: 'changed' | 'unsupported' | 'failed'; language?: string; errorCode?: string }>
}

export interface TakeoverLeaseLike {
  readonly token: object
  readonly generation: number
  readonly modeBeforeTakeover: SerializableValue
}

export interface ChildTakeoverCapability {
  request(ownerKind: 'external-editor' | 'update' | 'shutdown', reason: string): Promise<TakeoverLeaseLike>
  suspend(lease: TakeoverLeaseLike): Promise<void>
  restore(token: object, reason: 'completed' | 'cancelled' | 'error' | 'teardown'): Promise<void>
  current(): { readonly token: object; readonly generation: number } | null
}

export interface ActionClock {
  readonly clock: Clock
  readonly now: () => number
}

export function sanitizeChildText(value: string, options: {
  readonly maxChars?: number
  readonly maxLines?: number
} = {}): { text: string; chars: number; lines: number; truncated: boolean } {
  const maxChars = Math.max(0, Math.floor(options.maxChars ?? SHELL_OUTPUT_MAX_CHARS))
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? SHELL_OUTPUT_MAX_LINES))
  // Drop ANSI/control sequences as data, then normalize line endings. ESC and
  // C1 controls are removed rather than copied into a frame or notification.
  const plain = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
    .replace(/\r\n?/g, '\n')
  const rawLines = plain.split('\n')
  const keptLines = rawLines.slice(0, maxLines)
  let text = keptLines.join('\n')
  let truncated = keptLines.length !== rawLines.length
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  return { text, chars: text.length, lines: text === '' ? 0 : text.split('\n').length, truncated }
}

export function sanitizeClipboardText(value: string): string {
  return sanitizeChildText(value, { maxChars: CLIPBOARD_TEXT_MAX_CHARS, maxLines: CLIPBOARD_TEXT_MAX_CHARS }).text
}

export function hashPayload(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function safeEnvironment(input: NodeJS.ProcessEnv | Readonly<Record<string, string>> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  const allow = /^(?:PATH|PATHEXT|TERM|COLORTERM|LANG|LC_[A-Z0-9_]+|TMPDIR|TEMP|TMP|COMSPEC|SHELL)$/
  for (const [key, value] of Object.entries(input)) {
    if (!allow.test(key) || typeof value !== 'string') continue
    if (/[\x00-\x1f\x7f]/.test(value)) continue
    out[key] = value
  }
  return out
}

export function sanitizeTraceScalar(value: string, max: number): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, max)
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Parse a local command prefix without interpreting shell syntax in the UI. */
export function parseLocalCommand(text: string): { commandLine: string; includeInContext: boolean } | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('!')) return undefined
  const includeInContext = trimmed.startsWith('!!')
  const commandLine = trimmed.slice(includeInContext ? 2 : 1).trim()
  if (commandLine === '') return undefined
  return { commandLine, includeInContext }
}

export function normalizeEditorText(saved: string, draft: string): { phase: 'edited' | 'unchanged' | 'empty'; text: string } {
  const normalizedSaved = saved.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const normalizedDraft = draft.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (normalizedSaved === '') return { phase: 'empty', text: '' }
  if (normalizedSaved === normalizedDraft) return { phase: 'unchanged', text: normalizedDraft }
  if (!normalizedDraft.endsWith('\n') && normalizedSaved === `${normalizedDraft}\n`) {
    return { phase: 'unchanged', text: normalizedDraft }
  }
  return { phase: 'edited', text: normalizedSaved }
}

export function asSerializableActionSummary(summary: ExternalActionSummary): SerializableValue {
  return { ...summary }
}
