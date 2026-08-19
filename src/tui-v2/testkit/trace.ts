/**
 * tui-v2 testkit versioned JSONL trace (WP-02, plan §5.2/§9.2/WP-02).
 *
 * Line format (`traceVersion: 1`):
 *   line 1:   { kind: 'header', traceVersion: 1, generatorVersion, seed,
 *               terminalProfile: <id | TerminalProfile>, oracle,
 *               redactionVersion: 1, name, source? }
 *   then any: { kind: 'event', event: AppEvent }
 *             { kind: 'expectedState', value: SerializableValue }
 *   optional: { kind: 'expectedGrid', value: GoldenGrid }
 *             { kind: 'failure', ... }            (failure artifacts only)
 *
 * Rules: `oracle: 'golden'` requires `expectedGrid`; `differential-only`
 * traces are never a release gate (surfaced as a validation warning).
 * Redaction happens at the writer boundary (`redactTrace`) BEFORE persisting;
 * `redactionVersion: 1` is recorded in the header.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validateAppEvent, type AppEvent } from '../model/events.js'
import { isSerializableValue, type SerializableValue } from '../model/schema.js'
import type { TerminalProfile } from '../terminal/profile.js'
import { validateGoldenGrid, type GoldenGrid, type GridDiff } from './canonical.js'

export const TRACE_VERSION = 1
export const REDACTION_VERSION = 1
export const TRACE_GENERATOR_VERSION = '1.0.0'

export interface TraceHeader {
  readonly kind: 'header'
  readonly traceVersion: 1
  readonly generatorVersion: string
  readonly seed: number
  readonly terminalProfile: string | TerminalProfile
  readonly oracle: 'golden' | 'differential-only'
  readonly redactionVersion: 1
  readonly name: string
  readonly source?: string
}

export interface TraceEventLine {
  readonly kind: 'event'
  readonly event: AppEvent
}
export interface TraceExpectedStateLine {
  readonly kind: 'expectedState'
  readonly value: SerializableValue
}
export interface TraceExpectedGridLine {
  readonly kind: 'expectedGrid'
  readonly value: GoldenGrid
}
/** Failure-artifact trailer; carries only sanitized diff data (hashes/coords). */
export interface TraceFailureLine {
  readonly kind: 'failure'
  readonly traceId: string
  readonly frameId?: string
  readonly stateRevision?: number
  readonly generation?: number
  readonly diffs?: readonly GridDiff[]
}

export type TraceBodyLine = TraceEventLine | TraceExpectedStateLine | TraceExpectedGridLine | TraceFailureLine

export interface Trace {
  readonly header: TraceHeader
  readonly lines: readonly TraceBodyLine[]
}

export interface TraceValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

function fail(message: string): never {
  throw new TypeError(`invalid trace: ${message}`)
}

// ---------------------------------------------------------------------------
// Header / line shape validation
// ---------------------------------------------------------------------------

function validateTerminalProfileRef(value: unknown, field: string): void {
  if (typeof value === 'string') {
    if (value === '') fail(`${field} must be a non-empty profile id`)
    return
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be a profile id or TerminalProfile`)
  const p = value as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id === '') fail(`${field}.id must be a non-empty string`)
  if (!Number.isInteger(p.columns) || !Number.isInteger(p.rows)) fail(`${field} must carry integer columns/rows`)
}

function validateHeader(value: unknown): TraceHeader {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('header must be an object')
  const h = value as Record<string, unknown>
  if (h.kind !== 'header') fail("first line kind must be 'header'")
  if (h.traceVersion !== TRACE_VERSION) fail(`traceVersion must be ${TRACE_VERSION}`)
  if (typeof h.generatorVersion !== 'string' || h.generatorVersion === '') fail('generatorVersion must be a non-empty string')
  if (!Number.isInteger(h.seed)) fail('seed must be an integer (fixtures must declare a seed)')
  validateTerminalProfileRef(h.terminalProfile, 'terminalProfile')
  if (h.oracle !== 'golden' && h.oracle !== 'differential-only') fail("oracle must be 'golden'|'differential-only'")
  if (h.redactionVersion !== REDACTION_VERSION) fail(`redactionVersion must be ${REDACTION_VERSION}`)
  if (typeof h.name !== 'string' || h.name === '') fail('name must be a non-empty string')
  if (h.source !== undefined && typeof h.source !== 'string') fail('source must be a string when present')
  return h as unknown as TraceHeader
}

function validateBodyLine(value: unknown): TraceBodyLine {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('line must be an object')
  const line = value as Record<string, unknown>
  switch (line.kind) {
    case 'event':
      validateAppEvent(line.event)
      return line as unknown as TraceEventLine
    case 'expectedState':
      if (!isSerializableValue(line.value)) fail('expectedState value must be a SerializableValue')
      return line as unknown as TraceExpectedStateLine
    case 'expectedGrid':
      validateGoldenGrid(line.value)
      return line as unknown as TraceExpectedGridLine
    case 'failure': {
      if (typeof line.traceId !== 'string' || line.traceId === '') fail('failure line traceId must be a non-empty string')
      if (line.frameId !== undefined && typeof line.frameId !== 'string') fail('failure line frameId must be a string')
      if (line.stateRevision !== undefined && !Number.isInteger(line.stateRevision)) fail('failure line stateRevision must be an integer')
      if (line.generation !== undefined && !Number.isInteger(line.generation)) fail('failure line generation must be an integer')
      if (line.diffs !== undefined && !Array.isArray(line.diffs)) fail('failure line diffs must be an array')
      return line as unknown as TraceFailureLine
    }
    default:
      fail(`unknown line kind ${String(line.kind)}`)
  }
}

// ---------------------------------------------------------------------------
// validateTrace / readTrace / writeTrace
// ---------------------------------------------------------------------------

/** Structural validation; `oracle: 'golden'` requires an expectedGrid line. */
export function validateTrace(trace: Trace): TraceValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  try {
    validateHeader(trace.header)
  } catch (error) {
    errors.push(String((error as Error)?.message ?? error))
  }
  let sawExpectedGrid = false
  for (const [i, line] of trace.lines.entries()) {
    try {
      validateBodyLine(line)
      if (line.kind === 'expectedGrid') sawExpectedGrid = true
    } catch (error) {
      errors.push(`line ${i + 2}: ${String((error as Error)?.message ?? error)}`)
    }
  }
  if (trace.header.oracle === 'golden' && !sawExpectedGrid) {
    errors.push("oracle 'golden' requires an expectedGrid line")
  }
  if (trace.header.oracle === 'differential-only') {
    warnings.push("oracle 'differential-only' is exploratory and must not be used as a release gate")
  }
  return { ok: errors.length === 0, errors, warnings }
}

function serializeTrace(trace: Trace): string {
  const lines = [JSON.stringify(trace.header)]
  for (const line of trace.lines) lines.push(JSON.stringify(line))
  return `${lines.join('\n')}\n`
}

/** Atomic write: tmp file + rename in the same directory. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filePath)
}

/** Validate then persist a trace as versioned JSONL (atomic). */
export async function writeTrace(filePath: string, trace: Trace): Promise<void> {
  const result = validateTrace(trace)
  if (!result.ok) {
    fail(`refusing to write ${filePath}: ${result.errors.join('; ')}`)
  }
  await writeFileAtomic(filePath, serializeTrace(trace))
}

/** Parse and validate a trace file; bad lines report their 1-based line number. */
export async function readTrace(filePath: string): Promise<Trace> {
  const raw = await readFile(filePath, 'utf8')
  const physicalLines = raw.split('\n')
  // Tolerate exactly one trailing empty line from the final newline.
  if (physicalLines.length > 0 && physicalLines[physicalLines.length - 1] === '') {
    physicalLines.pop()
  }
  if (physicalLines.length === 0) fail(`${filePath} is empty`)

  const parseLine = (lineNo: number): Record<string, unknown> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(physicalLines[lineNo - 1])
    } catch (error) {
      fail(`${filePath}:${lineNo}: invalid JSON: ${String((error as Error)?.message ?? error)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`${filePath}:${lineNo}: line must be a JSON object`)
    }
    return parsed as Record<string, unknown>
  }

  let header: TraceHeader
  const headerLine = parseLine(1)
  try {
    header = validateHeader(headerLine)
  } catch (error) {
    fail(`${filePath}:1: ${String((error as Error)?.message ?? error)}`)
  }
  const lines: TraceBodyLine[] = []
  for (let lineNo = 2; lineNo <= physicalLines.length; lineNo++) {
    // parseLine already reports `<file>:<line>:` — only wrap shape errors.
    const parsedLine = parseLine(lineNo)
    try {
      lines.push(validateBodyLine(parsedLine))
    } catch (error) {
      fail(`${filePath}:${lineNo}: ${String((error as Error)?.message ?? error)}`)
    }
  }
  const trace: Trace = { header, lines }
  const result = validateTrace(trace)
  if (!result.ok) {
    fail(`${filePath}: ${result.errors.join('; ')}`)
  }
  return trace
}

// ---------------------------------------------------------------------------
// Redaction (writer boundary, plan §5.2: events must never carry credentials,
// full prompts, tool secrets or uncontrolled object references).
// ---------------------------------------------------------------------------

export interface RedactionPolicy {
  /**
   * Replacement for a payload string (row blocks, stream text, prompt/tool
   * args, overlay payload). Return undefined to keep the original.
   */
  redactPayload?(text: string): string | undefined
  /** Replacement for a credential-shaped string; checked everywhere. */
  redactCredential?(text: string): string | undefined
  /** Replacement for a string containing an OSC payload; checked everywhere. */
  redactOsc?(text: string): string | undefined
}

function sha8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)
}

// OSC: ESC ] ... (BEL|ESC\\) terminated, or C1 0x9d introducer.
const OSC_PATTERN = /(?:\x1b\]|\u009d)/
// Credential shapes: sk- live/test keys, generic token/key/secret/password assignments, bearer headers.
const CREDENTIAL_PATTERN = /(?:sk-[A-Za-z0-9_-]{4,})|(?:\b(?:token|api[-_]?key|secret|password|passwd|authorization)\b[\s]*[:=][\s]*\S+)|(?:\bBearer\s+\S+)/i

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  redactPayload: (text) => `<redacted:text ${sha8(text)}>`,
  redactCredential: (text) => `<redacted:text ${sha8(text)}>`,
  redactOsc: () => '<redacted:osc>',
}

function redactString(text: string, payload: boolean, policy: RedactionPolicy): string {
  if (OSC_PATTERN.test(text)) {
    const replacement = policy.redactOsc?.(text)
    if (replacement !== undefined) return replacement
  }
  if (CREDENTIAL_PATTERN.test(text)) {
    const replacement = policy.redactCredential?.(text)
    if (replacement !== undefined) return replacement
  }
  if (payload) {
    const replacement = policy.redactPayload?.(text)
    if (replacement !== undefined) return replacement
  }
  return text
}

function redactValue(value: unknown, payload: boolean, policy: RedactionPolicy): unknown {
  if (typeof value === 'string') return redactString(value, payload, policy)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, payload, policy))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(item, payload, policy)
    }
    return out
  }
  return value
}

function redactTool(tool: Record<string, unknown>, policy: RedactionPolicy): Record<string, unknown> {
  const out = { ...tool }
  if (out.callView !== undefined) out.callView = redactValue(out.callView, true, policy)
  if (out.resultView !== undefined) out.resultView = redactValue(out.resultView, true, policy)
  if (out.error !== undefined) out.error = redactValue(out.error, false, policy)
  return out
}

function redactRow(row: Record<string, unknown>, policy: RedactionPolicy): Record<string, unknown> {
  const out = { ...row }
  out.blocks = redactValue(row.blocks, true, policy)
  if (out.tool !== undefined && out.tool !== null && typeof out.tool === 'object') {
    out.tool = redactTool(out.tool as Record<string, unknown>, policy)
  }
  return out
}

/** Per-variant payload positions; identity/structural fields are never blanket-redacted. */
function redactEvent(event: AppEvent, policy: RedactionPolicy): AppEvent {
  const e = event as unknown as Record<string, unknown>
  switch (event.type) {
    case 'session/row-upsert':
      return { ...e, row: redactRow(e.row as Record<string, unknown>, policy) } as unknown as AppEvent
    case 'session/rows-reset':
      return {
        ...e,
        rows: (e.rows as Record<string, unknown>[]).map((row) => redactRow(row, policy)),
      } as unknown as AppEvent
    case 'stream/chunk':
      return { ...e, text: redactString(event.text, true, policy) } as unknown as AppEvent
    case 'input/command': {
      const command = e.command as Record<string, unknown>
      if (command.type === 'editor' && typeof command.text === 'string') {
        return { ...e, command: { ...command, text: redactString(command.text, true, policy) } } as unknown as AppEvent
      }
      return event
    }
    case 'overlay/open':
      return { ...e, overlay: { ...(e.overlay as Record<string, unknown>), payload: redactValue((e.overlay as Record<string, unknown>).payload, true, policy) } } as unknown as AppEvent
    case 'app/error': {
      const error = e.error as Record<string, unknown>
      return {
        ...e,
        error: {
          ...error,
          message: redactString(error.message as string, false, policy),
          details: error.details === undefined ? undefined : redactValue(error.details, true, policy),
        },
      } as unknown as AppEvent
    }
    default:
      return event
  }
}

/**
 * Return a redacted copy of the trace (input is not mutated). Redaction is
 * deterministic: identical payloads map to identical placeholders, so replay
 * comparisons stay byte-stable.
 */
export function redactTrace(trace: Trace, policy: RedactionPolicy = DEFAULT_REDACTION_POLICY): Trace {
  const lines = trace.lines.map((line): TraceBodyLine => {
    if (line.kind !== 'event') return line
    return { kind: 'event', event: redactEvent(line.event, policy) }
  })
  return { header: { ...trace.header, redactionVersion: REDACTION_VERSION }, lines }
}

// ---------------------------------------------------------------------------
// Failure artifacts (WP-02: trace id, generator version, seed, frame id,
// profile, state/generation, sanitized diff coordinates, last N events).
// ---------------------------------------------------------------------------

export const TRACE_FAILURE_RECENT_EVENTS_DEFAULT = 32
export const TRACE_FAILURE_RECENT_EVENTS_MAX = 128

export interface TraceFailureInfo {
  readonly traceId: string
  readonly generatorVersion: string
  readonly seed: number
  readonly terminalProfile: string | TerminalProfile
  readonly frameId?: string
  readonly stateRevision?: number
  readonly generation?: number
  /** Sanitized diffs only (coordinates + hashes); never raw graphemes. */
  readonly diffs?: readonly GridDiff[]
  readonly events: readonly AppEvent[]
  /** Last N events are kept; defaults to 32, hard-capped at 128. */
  readonly recentEventLimit?: number
  readonly name?: string
}

function sanitizeFileComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_')
}

/**
 * Persist a replayable failure artifact as versioned JSONL: header + the last
 * N redacted events + a failure trailer line. Returns the artifact path.
 */
export async function writeTraceFailure(dir: string, info: TraceFailureInfo): Promise<string> {
  const limit = Math.max(
    0,
    Math.min(info.recentEventLimit ?? TRACE_FAILURE_RECENT_EVENTS_DEFAULT, TRACE_FAILURE_RECENT_EVENTS_MAX),
  )
  const recent = info.events.slice(Math.max(0, info.events.length - limit))
  const failureLine: TraceFailureLine = {
    kind: 'failure',
    traceId: info.traceId,
    ...(info.frameId !== undefined ? { frameId: info.frameId } : {}),
    ...(info.stateRevision !== undefined ? { stateRevision: info.stateRevision } : {}),
    ...(info.generation !== undefined ? { generation: info.generation } : {}),
    ...(info.diffs !== undefined ? { diffs: info.diffs } : {}),
  }
  const trace = redactTrace({
    header: {
      kind: 'header',
      traceVersion: TRACE_VERSION,
      generatorVersion: info.generatorVersion,
      seed: info.seed,
      terminalProfile: info.terminalProfile,
      oracle: 'differential-only',
      redactionVersion: REDACTION_VERSION,
      name: info.name ?? `failure:${info.traceId}`,
      source: 'writeTraceFailure',
    },
    lines: [
      ...recent.map((event): TraceEventLine => ({ kind: 'event', event })),
      failureLine,
    ],
  })
  const filePath = path.join(dir, `${sanitizeFileComponent(info.traceId)}.failure.jsonl`)
  await writeTrace(filePath, trace)
  return filePath
}
