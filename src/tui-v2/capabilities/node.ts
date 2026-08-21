/** Node host bindings for the v2 external-action capabilities.
 *
 * This module is the host boundary; components/controllers still depend only
 * on the narrow interfaces in `external-actions.ts`.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

import { readClipboard } from '../../utils/clipboard.js'
import { updateTuiAndRestart } from '../../update.js'
import {
  safeEnvironment,
  type ClipboardCapability,
  type ClipboardReadValue,
  type ClipboardWriteResult,
  type EditorRequest,
  type EditorResult,
  type EditorRunner,
  type RestartRunner,
  type ShellCapability,
  type ShellRequest,
} from './external-actions.js'

function abortError(): Error {
  return Object.assign(new Error('operation cancelled'), { code: 'cancelled' })
}

export function createNodeShellCapability(): ShellCapability {
  return {
    run(request: ShellRequest, sink, signal): Promise<import('./external-actions.js').ShellResult> {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          resolve({ phase: 'cancelled', exitCode: null, signal: null, stdoutChars: 0, stderrChars: 0, stdoutLines: 0, stderrLines: 0, truncated: false })
          return
        }
        const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh')
        const args = process.platform === 'win32' ? ['/d', '/s', '/c', request.commandLine] : ['-c', request.commandLine]
        let stdoutChars = 0
        let stderrChars = 0
        let stdoutLines = 0
        let stderrLines = 0
        let timedOut = false
        let settled = false
        const child = spawn(command, args, {
          cwd: request.cwd,
          env: { ...safeEnvironment(), ...safeEnvironment(request.env ?? {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        const finish = (result: import('./external-actions.js').ShellResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          signal.removeEventListener('abort', onAbort)
          resolve(result)
        }
        const onAbort = (): void => {
          child.kill('SIGINT')
          setTimeout(() => { if (!settled) child.kill('SIGTERM') }, 150)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', (text: string) => {
          stdoutChars += text.length
          stdoutLines += text === '' ? 0 : text.split(/\r\n|\r|\n/u).length
          sink.stdout(text)
        })
        child.stderr?.on('data', (text: string) => {
          stderrChars += text.length
          stderrLines += text === '' ? 0 : text.split(/\r\n|\r|\n/u).length
          sink.stderr(text)
        })
        child.once('error', (error) => {
          if (signal.aborted) finish({ phase: 'cancelled', exitCode: null, signal: null, stdoutChars, stderrChars, stdoutLines, stderrLines, truncated: false })
          else finish({ phase: 'failed', exitCode: null, signal: null, stdoutChars, stderrChars, stdoutLines, stderrLines, truncated: false, errorCode: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'shell-not-found' : 'shell-spawn-error' })
        })
        child.once('close', (code, closeSignal) => {
          if (signal.aborted) finish({ phase: 'cancelled', exitCode: code, signal: closeSignal, stdoutChars, stderrChars, stdoutLines, stderrLines, truncated: false })
          else if (timedOut) finish({ phase: 'timed-out', exitCode: code, signal: closeSignal, stdoutChars, stderrChars, stdoutLines, stderrLines, truncated: false, errorCode: 'shell-timeout' })
          else finish({ phase: code === 0 ? 'completed' : 'failed', exitCode: code, signal: closeSignal, stdoutChars, stderrChars, stdoutLines, stderrLines, truncated: false, ...(code === 0 ? {} : { errorCode: 'shell-exit' }) })
        })
        const timeout = setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
        }, Math.max(1, request.timeoutMs))
      })
    },
  }
}

export function createNodeClipboardCapability(): ClipboardCapability {
  return {
    async read(signal): Promise<ClipboardReadValue> {
      if (signal?.aborted) return { kind: 'error', code: 'cancelled' }
      try {
        const result = await readClipboard()
        if (result === null) return { kind: 'empty' }
        if (result.kind === 'unavailable') return { kind: 'unavailable', reason: 'no-host-backend' }
        if (result.kind === 'text') return { kind: 'text', text: result.text }
        if (result.kind === 'files') return { kind: 'files', paths: result.paths }
        const data = await readFile(result.path)
        const mediaType = result.path.toLowerCase().endsWith('.png') ? 'image/png' : 'application/octet-stream'
        return { kind: 'image', data, mediaType, name: result.path }
      } catch {
        return { kind: 'error', code: 'clipboard-read-failed' }
      }
    },
    async copy(_text, _generation): Promise<ClipboardWriteResult> {
      // OSC52 is emitted by ClipboardController through the v2 writer. Native
      // host writes are intentionally not duplicated here.
      return { status: 'unsupported', reason: 'writer-osc52-path' }
    },
  }
}

function runChild(request: EditorRequest, signal: AbortSignal): Promise<EditorResult> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(request.argv[0] as string, [...request.argv.slice(1), request.filePath], {
      cwd: request.cwd,
      stdio: 'inherit',
      env: safeEnvironment(),
      windowsHide: false,
    })
    const finish = (result: EditorResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = (): void => {
      child.kill('SIGINT')
      setTimeout(() => { if (!settled) child.kill('SIGTERM') }, 150)
    }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ phase: 'timed-out', exitCode: null, signal: 'SIGTERM', errorCode: 'editor-timeout' })
    }, Math.max(1, request.timeoutMs))
    child.once('error', (error) => finish({ phase: signal.aborted ? 'cancelled' : 'failed', exitCode: null, signal: null, errorCode: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'editor-not-found' : 'editor-spawn-error' }))
    child.once('close', (code, closeSignal) => finish(signal.aborted ? { phase: 'cancelled', exitCode: code, signal: closeSignal } : code === 0 ? { phase: 'completed', exitCode: code, signal: closeSignal } : { phase: 'nonzero', exitCode: code, signal: closeSignal }))
  })
}

export function createNodeEditorRunner(): EditorRunner {
  return { run: runChild }
}

export function createNodeRestartRunner(): RestartRunner {
  return {
    async run(request, signal) {
      if (signal.aborted) return { phase: 'cancelled', updateCode: 1, restartCode: 1, signal: 'SIGINT', errorCode: 'cancelled' }
      try {
        const result = await updateTuiAndRestart(request.sessionId, request.profile, request.targetVersion)
        return result.updateCode === 0 && result.restartCode === 0
          ? { phase: 'success', ...result }
          : { phase: 'failure', ...result, errorCode: 'update-failed' }
      } catch {
        return { phase: 'failure', updateCode: 1, restartCode: 1, errorCode: 'update-error' }
      }
    },
  }
}
