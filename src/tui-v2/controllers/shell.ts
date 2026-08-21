/** Local `!`/`!!` shell command controller (WP-08f).
 *
 * The controller owns only operation state.  A ShellCapability owns process
 * creation and stdin/stdout/stderr; output is sanitized before it reaches the
 * transcript/notification seam and no command/env/output bytes enter traces.
 */
import { randomUUID } from 'node:crypto'

import {
  parseLocalCommand,
  sanitizeChildText,
  type ExternalActionTraceSink,
  type ShellCapability,
  type ShellResult,
} from '../capabilities/external-actions.js'

export type ShellControllerPhase = 'idle' | 'working' | 'completed' | 'failed' | 'cancelled' | 'timed-out'

export interface ShellOutputView {
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
  readonly truncated: boolean
}

export interface ShellControllerOptions {
  readonly capability: ShellCapability
  readonly cwd: () => string
  readonly notify: (text: string, options?: { color?: 'error' | 'warning' | 'success' }) => void
  readonly appendTranscript?: (title: string, lines: readonly string[]) => void
  readonly includeInContext?: (text: string) => void
  readonly timeoutMs?: number
  readonly trace?: ExternalActionTraceSink
  readonly operationId?: () => string
}

export interface ShellControllerDiagnostics {
  readonly started: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
  readonly timedOut: number
  readonly ignored: number
  readonly superseded: number
  readonly outputChunks: number
  readonly outputChars: number
  readonly truncatedOutput: number
}

export interface ShellController {
  run(text: string): boolean
  cancel(): boolean
  phase(): ShellControllerPhase
  activeOperationId(): string | null
  diagnostics(): ShellControllerDiagnostics
}

interface ActiveRun {
  readonly operationId: string
  readonly commandLine: string
  readonly includeInContext: boolean
  readonly controller: AbortController
  readonly stdout: string[]
  readonly stderr: string[]
  stdoutChars: number
  stderrChars: number
  outputLines: number
  truncated: boolean
}

const MAX_OUTPUT_CHARS = 32_000
const MAX_OUTPUT_LINES = 256

export function createShellController(options: ShellControllerOptions): ShellController {
  let active: ActiveRun | null = null
  let currentPhase: ShellControllerPhase = 'idle'
  let serial = 0
  const counts = {
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    ignored: 0,
    superseded: 0,
    outputChunks: 0,
    outputChars: 0,
    truncatedOutput: 0,
  }

  const id = (): string => {
    try {
      return options.operationId?.() ?? `shell-${++serial}-${randomUUID()}`
    } catch {
      return `shell-${++serial}`
    }
  }

  const trace = (run: ActiveRun, phase: 'working' | 'completed' | 'failed' | 'cancelled' | 'timed-out', result?: ShellResult): void => {
    try {
      options.trace?.record({
        kind: 'shell',
        phase,
        operationId: run.operationId,
        generation: 0,
        ...(result === undefined ? {} : {
          exitCode: result.exitCode,
          signal: result.signal,
          outputChars: Math.min(MAX_OUTPUT_CHARS, result.stdoutChars + result.stderrChars),
          outputLines: Math.min(MAX_OUTPUT_LINES, result.stdoutLines + result.stderrLines),
          truncated: result.truncated,
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        }),
      })
    } catch {
      // Tracing cannot affect the child lifecycle.
    }
  }

  const appendOutput = (run: ActiveRun, stream: 'stdout' | 'stderr', chunk: string): void => {
    if (active !== run) return
    const clean = sanitizeChildText(chunk, { maxChars: MAX_OUTPUT_CHARS, maxLines: MAX_OUTPUT_LINES })
    if (clean.text === '') return
    counts.outputChunks += 1
    counts.outputChars += clean.chars
    if (clean.truncated) {
      run.truncated = true
      counts.truncatedOutput += 1
    }
    run.outputLines += clean.lines
    if (stream === 'stdout') {
      run.stdoutChars += clean.chars
      run.stdout.push(clean.text)
    } else {
      run.stderrChars += clean.chars
      run.stderr.push(clean.text)
    }
  }

  const finish = (run: ActiveRun, result: ShellResult): void => {
    if (active !== run) {
      counts.superseded += 1
      return
    }
    active = null
    currentPhase = result.phase
    const stdout = run.stdout.join('\n').trim()
    const stderr = run.stderr.join('\n').trim()
    const output = [stdout, stderr].filter(Boolean).join('\n')
    const lines = output === '' ? ['(no output)'] : output.split('\n').slice(0, MAX_OUTPUT_LINES)
    if (result.phase === 'completed') {
      counts.completed += 1
      options.appendTranscript?.(`! ${run.commandLine.startsWith('!') ? '' : 'local command'}`.trim(), lines)
      if (run.includeInContext) options.includeInContext?.(output)
      if (output !== '') options.notify(output, { })
    } else if (result.phase === 'cancelled') {
      counts.cancelled += 1
      options.notify('Local command cancelled', { color: 'warning' })
    } else if (result.phase === 'timed-out') {
      counts.timedOut += 1
      options.notify('Local command timed out', { color: 'warning' })
      options.appendTranscript?.('! local command', [...lines, '(timed out)'])
    } else {
      counts.failed += 1
      const suffix = result.signal === null ? `exit ${result.exitCode ?? 1}` : result.signal
      options.notify(`Local command failed (${suffix})`, { color: 'error' })
      options.appendTranscript?.('! local command', [...lines, `(${suffix})`])
    }
    trace(run, result.phase === 'completed' ? 'completed' : result.phase, result)
  }

  const run = (text: string): boolean => {
    const parsed = parseLocalCommand(text)
    if (parsed === undefined) return false
    if (active !== null) {
      counts.ignored += 1
      options.notify('A local command is already running', { color: 'warning' })
      return true
    }
    const commandLine = parsed.commandLine
    const runState: ActiveRun = {
      operationId: id(),
      commandLine,
      includeInContext: parsed.includeInContext,
      controller: new AbortController(),
      stdout: [],
      stderr: [],
      stdoutChars: 0,
      stderrChars: 0,
      outputLines: 0,
      truncated: false,
    }
    active = runState
    currentPhase = 'working'
    counts.started += 1
    trace(runState, 'working')
    options.notify('Running local command…')
    const request = {
      commandLine,
      cwd: options.cwd(),
      timeoutMs: Math.max(1, Math.floor(options.timeoutMs ?? 30_000)),
      stdin: 'closed' as const,
    }
    void options.capability.run(request, {
      stdout: (chunk) => appendOutput(runState, 'stdout', chunk),
      stderr: (chunk) => appendOutput(runState, 'stderr', chunk),
    }, runState.controller.signal).then(
      (result) => finish(runState, result),
      (error: unknown) => finish(runState, {
        phase: runState.controller.signal.aborted ? 'cancelled' : 'failed',
        exitCode: null,
        signal: null,
        stdoutChars: runState.stdoutChars,
        stderrChars: runState.stderrChars,
        stdoutLines: runState.outputLines,
        stderrLines: 0,
        truncated: runState.truncated,
        errorCode: error instanceof Error ? 'shell-error' : 'shell-rejected',
      }),
    )
    return true
  }

  return {
    run,
    cancel() {
      if (active === null) return false
      active.controller.abort()
      currentPhase = 'cancelled'
      return true
    },
    phase: () => currentPhase,
    activeOperationId: () => active?.operationId ?? null,
    diagnostics: () => ({ ...counts }),
  }
}
