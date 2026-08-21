/** External editor controller (WP-08f).
 *
 * Filesystem and child-process work is isolated behind the runner/takeover
 * seams. The saved file is read before input restoration, and every exit path
 * runs the same cleanup/restore funnel.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ScreenTakeover, TakeoverLease, TakeoverToken } from '../terminal/lifecycle.js'
import {
  normalizeEditorText,
  sanitizeTraceScalar,
  type EditorRequest,
  type EditorResult,
  type EditorRunner,
  type ExternalActionPhase,
  type ExternalActionTraceSink,
} from '../capabilities/external-actions.js'

export type ExternalEditorPhase =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'reading'
  | 'completed'
  | 'unchanged'
  | 'empty'
  | 'nonzero'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'unsupported'

export interface ExternalEditorOptions {
  readonly runner: EditorRunner
  readonly takeover?: ScreenTakeover
  readonly cwd: () => string
  readonly draft: () => string
  readonly setDraft: (text: string) => void
  readonly resolveArgv: () => readonly string[] | undefined
  readonly notify: (text: string, options?: { color?: 'error' | 'warning' | 'success' }) => void
  readonly trace?: ExternalActionTraceSink
  readonly timeoutMs?: number
  readonly clock?: {
    now(): number
    setTimeout(callback: () => void, delayMs: number): unknown
    clearTimeout(handle: unknown): void
  }
}

export interface ExternalEditorDiagnostics {
  readonly started: number
  readonly completed: number
  readonly unchanged: number
  readonly empty: number
  readonly nonzero: number
  readonly failed: number
  readonly cancelled: number
  readonly timedOut: number
  readonly unsupported: number
  readonly busy: number
  readonly late: number
  readonly restoreErrors: number
}

export interface ExternalEditorController {
  open(): boolean
  cancel(): boolean
  phase(): ExternalEditorPhase
  activeOperationId(): string | null
  diagnostics(): ExternalEditorDiagnostics
}

const DEFAULT_TIMEOUT_MS = 120_000

function safeArgv(argv: readonly string[] | undefined): string[] | undefined {
  if (argv === undefined || argv.length === 0) return undefined
  if (argv.length > 16) return undefined
  if (argv.some((arg) => typeof arg !== 'string' || arg === '' || /[\x00\r\n]/.test(arg))) return undefined
  return [...argv]
}

function errorCode(error: unknown): string {
  return error instanceof Error ? 'editor-error' : 'editor-rejected'
}

export function createExternalEditorController(options: ExternalEditorOptions): ExternalEditorController {
  let current: { id: string; abort: AbortController; lease: TakeoverLease | null } | null = null
  let currentPhase: ExternalEditorPhase = 'idle'
  let serial = 0
  const counts = {
    started: 0,
    completed: 0,
    unchanged: 0,
    empty: 0,
    nonzero: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    unsupported: 0,
    busy: 0,
    late: 0,
    restoreErrors: 0,
  }

  const trace = (phase: ExternalActionPhase, id: string, generation: number, reason?: string): void => {
    try {
      options.trace?.record({
        kind: 'external-editor',
        phase,
        operationId: id,
        generation,
        ...(reason === undefined ? {} : { reason: sanitizeTraceScalar(reason, 80) }),
      })
    } catch {
      // Best effort diagnostics.
    }
  }

  const restore = async (lease: TakeoverLease | null, reason: 'completed' | 'cancelled' | 'error' | 'teardown'): Promise<void> => {
    if (lease === null || options.takeover === undefined) return
    try {
      await options.takeover.restore(lease.token, { reason })
    } catch {
      counts.restoreErrors += 1
      options.notify('Terminal restore after external editor failed', { color: 'error' })
    }
  }

  const runWithTimeout = async (request: EditorRequest, signal: AbortSignal): Promise<EditorResult> => {
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    if (options.clock === undefined) return options.runner.run(request, signal)
    let timer: unknown = null
    let settled = false
    const child = Promise.resolve().then(() => options.runner.run(request, signal))
    return await new Promise<EditorResult>((resolve) => {
      const finish = (result: EditorResult): void => {
        if (settled) return
        settled = true
        if (timer !== null) options.clock?.clearTimeout(timer)
        resolve(result)
      }
      timer = options.clock?.setTimeout(() => {
        finish(signal.aborted
          ? { phase: 'cancelled', exitCode: null, signal: 'SIGINT', errorCode: 'cancelled' }
          : { phase: 'timed-out', exitCode: null, signal: 'SIGTERM', errorCode: 'editor-timeout' })
      }, timeoutMs) ?? null
      child.then(finish, () => finish({ phase: signal.aborted ? 'cancelled' : 'failed', exitCode: null, signal: null, errorCode: errorCode(undefined) }))
    })
  }

  const open = (): boolean => {
    if (current !== null) {
      counts.busy += 1
      options.notify('External editor is already running', { color: 'warning' })
      return true
    }
    const argv = safeArgv(options.resolveArgv())
    if (argv === undefined) {
      counts.unsupported += 1
      currentPhase = 'unsupported'
      options.notify('No safe external editor is configured', { color: 'warning' })
      return true
    }
    const id = `editor-${++serial}-${randomUUID()}`
    const abort = new AbortController()
    const runState = { id, abort, lease: null as TakeoverLease | null }
    current = runState
    currentPhase = 'preparing'
    counts.started += 1
    void execute(runState, argv)
    return true
  }

  const execute = async (runState: { id: string; abort: AbortController; lease: TakeoverLease | null }, argv: readonly string[]): Promise<void> => {
    let directory: string | null = null
    let outcome: ExternalEditorPhase = 'failed'
    let restoreReason: 'completed' | 'cancelled' | 'error' | 'teardown' = 'error'
    let generation = 0
    try {
      const cwd = options.cwd()
      if (cwd === '' || /[\x00\r\n]/.test(cwd)) throw new Error('unsafe editor cwd')
      const draft = options.draft()
      directory = await mkdtemp(join(tmpdir(), 'dsh-tui-editor-'))
      await chmod(directory, 0o700).catch(() => undefined)
      const filePath = join(directory, 'input.md')
      await writeFile(filePath, draft, { encoding: 'utf8', mode: 0o600, flag: 'w' })
      if (options.takeover !== undefined) {
        runState.lease = await options.takeover.request('external-editor', 'prompt editor')
        generation = runState.lease.generation
      }
      if (current !== runState) {
        counts.late += 1
        return
      }
      currentPhase = 'running'
      trace('suspended', runState.id, generation)
      const result = await runWithTimeout({ filePath, cwd, argv, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS }, runState.abort.signal)
      if (current !== runState) {
        counts.late += 1
        return
      }
      if (result.phase === 'cancelled' || runState.abort.signal.aborted) {
        outcome = 'cancelled'
        counts.cancelled += 1
        currentPhase = outcome
        options.notify('External editor cancelled', { color: 'warning' })
        restoreReason = 'cancelled'
      } else if (result.phase === 'timed-out') {
        outcome = 'timed-out'
        counts.timedOut += 1
        currentPhase = outcome
        options.notify('External editor timed out', { color: 'warning' })
        restoreReason = 'error'
      } else if (result.phase !== 'completed') {
        outcome = 'nonzero'
        counts.nonzero += 1
        currentPhase = outcome
        options.notify('External editor exited without saving', { color: 'warning' })
        restoreReason = 'completed'
      } else {
        currentPhase = 'reading'
        const saved = await readFile(filePath, 'utf8').catch(() => '')
        const normalized = normalizeEditorText(saved, draft)
        outcome = normalized.phase === 'edited' ? 'completed' : normalized.phase
        currentPhase = outcome
        if (normalized.phase === 'edited') {
          counts.completed += 1
          options.setDraft(normalized.text)
          options.notify('Draft updated from external editor', { color: 'success' })
        } else if (normalized.phase === 'empty') {
          counts.empty += 1
          options.notify('External editor returned an empty draft', { color: 'warning' })
        } else {
          counts.unchanged += 1
          options.notify('Draft unchanged')
        }
        restoreReason = 'completed'
      }
      trace(outcome, runState.id, generation)
    } catch (error) {
      if (current !== runState) {
        counts.late += 1
        return
      }
      counts.failed += 1
      currentPhase = 'failed'
      options.notify(`External editor failed (${errorCode(error)})`, { color: 'error' })
      trace('failed', runState.id, generation, errorCode(error))
      restoreReason = runState.abort.signal.aborted ? 'cancelled' : 'error'
    } finally {
      if (directory !== null) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      await restore(runState.lease, restoreReason)
      if (current === runState) current = null
      if (currentPhase === 'preparing' || currentPhase === 'running' || currentPhase === 'reading') currentPhase = outcome
    }
  }

  return {
    open,
    cancel() {
      if (current === null) return false
      current.abort.abort()
      currentPhase = 'cancelled'
      return true
    },
    phase: () => currentPhase,
    activeOperationId: () => current?.id ?? null,
    diagnostics: () => ({ ...counts }),
  }
}
