/** Clipboard controller (WP-08f).
 *
 * OSC52 bytes are produced only by the trusted v2 ANSI builder and submitted
 * through the single writer. Reading is a host capability; pasted images cross
 * the existing stageImage/ImageStore boundary and never enter AppEvent/trace.
 */
import { Buffer } from 'node:buffer'

import * as ansi from '../terminal/ansi.js'
import type { TerminalWriter, WriteResult } from '../terminal/writer.js'
import {
  CLIPBOARD_TEXT_MAX_CHARS,
  hashPayload,
  sanitizeClipboardText,
  type ClipboardCapability,
  type ClipboardReadValue,
  type ClipboardWriteResult,
  type ExternalActionTraceSink,
} from '../capabilities/external-actions.js'

export interface ClipboardStageImageInput {
  readonly data: Uint8Array
  readonly mediaType: string
  readonly name?: string
}

export type ClipboardPasteResult =
  | { readonly status: 'inserted-text'; readonly chars: number }
  | { readonly status: 'staged-image'; readonly token: string }
  | { readonly status: 'inserted-files'; readonly count: number }
  | { readonly status: 'empty' | 'unavailable' | 'error' | 'unsupported'; readonly reason?: string }

export interface ClipboardControllerOptions {
  readonly capability: ClipboardCapability
  readonly generation: () => number
  readonly profileSupportsOsc52?: () => boolean
  readonly writer?: Pick<TerminalWriter, 'writeControl'>
  readonly insertText: (text: string) => void
  readonly stageImage?: (input: ClipboardStageImageInput) => Promise<{ token?: string; placeholder?: string }>
  readonly notify: (text: string, options?: { color?: 'error' | 'warning' | 'success' }) => void
  readonly trace?: ExternalActionTraceSink
}

export interface ClipboardControllerDiagnostics {
  readonly copies: number
  readonly copyUnsupported: number
  readonly copyErrors: number
  readonly pastes: number
  readonly textPastes: number
  readonly imagePastes: number
  readonly filePastes: number
  readonly emptyPastes: number
  readonly unavailablePastes: number
  readonly errors: number
  readonly busy: number
  readonly late: number
}

export interface ClipboardController {
  copy(text: string): Promise<ClipboardWriteResult>
  paste(): Promise<ClipboardPasteResult>
  isBusy(): boolean
  diagnostics(): ClipboardControllerDiagnostics
  stop(): void
}

export function createClipboardController(options: ClipboardControllerOptions): ClipboardController {
  let busy = false
  let stopped = false
  let operation = 0
  const counts = {
    copies: 0,
    copyUnsupported: 0,
    copyErrors: 0,
    pastes: 0,
    textPastes: 0,
    imagePastes: 0,
    filePastes: 0,
    emptyPastes: 0,
    unavailablePastes: 0,
    errors: 0,
    busy: 0,
    late: 0,
  }

  const trace = (phase: 'working' | 'completed' | 'failed' | 'unsupported', id: number, payloadHash?: string): void => {
    try {
      options.trace?.record({
        kind: phase === 'unsupported' || phase === 'failed' ? 'clipboard-paste' : 'clipboard-copy',
        phase,
        operationId: `clipboard-${id}`,
        generation: options.generation(),
        ...(payloadHash === undefined ? {} : { payloadHash }),
      })
    } catch {
      // Best effort.
    }
  }

  const copy = async (text: string): Promise<ClipboardWriteResult> => {
    if (stopped) return { status: 'error', code: 'stopped' }
    const clean = sanitizeClipboardText(text)
    if (clean === '') {
      counts.copyErrors += 1
      options.notify('Nothing selected to copy', { color: 'warning' })
      return { status: 'error', code: 'empty' }
    }
    if (clean.length > CLIPBOARD_TEXT_MAX_CHARS) {
      counts.copyErrors += 1
      options.notify('Clipboard text is too large', { color: 'warning' })
      return { status: 'error', code: 'too-large' }
    }
    const id = ++operation
    counts.copies += 1
    trace('working', id, hashPayload(clean))
    if (options.profileSupportsOsc52 !== undefined && !options.profileSupportsOsc52()) {
      counts.copyUnsupported += 1
      trace('unsupported', id, hashPayload(clean))
      options.notify('Clipboard copy is unsupported by this terminal', { color: 'warning' })
      return { status: 'unsupported', reason: 'osc52-not-confirmed' }
    }
    if (options.writer !== undefined) {
      let result: WriteResult
      try {
        const payload = Buffer.from(clean, 'utf8').toString('base64')
        result = await options.writer.writeControl({
          kind: 'sequence',
          sequence: ansi.osc52Clipboard(payload),
          purpose: 'pi-compatible',
        }, options.generation())
      } catch {
        result = { status: 'error', error: { code: 'clipboard-writer-error', message: 'clipboard writer failed', generation: options.generation(), recoverable: true } }
      }
      if (result.status !== 'written') {
        counts.copyErrors += 1
        trace('failed', id, hashPayload(clean))
        options.notify('Clipboard copy failed', { color: 'warning' })
        return { status: 'error', code: result.status === 'error' ? result.error.code : 'writer-not-written' }
      }
    }
    let hostResult: ClipboardWriteResult
    try {
      hostResult = await options.capability.copy(clean, options.generation())
    } catch {
      hostResult = { status: 'error', code: 'clipboard-host-error' }
    }
    if (hostResult.status === 'unsupported') {
      // A writer-only OSC52 path is still a valid copy when explicitly
      // confirmed. A host-side failure must not be reported as success if no
      // writer was provided.
      if (options.writer === undefined) {
        counts.copyUnsupported += 1
        trace('unsupported', id, hashPayload(clean))
        options.notify('Clipboard copy is unsupported', { color: 'warning' })
        return hostResult
      }
    }
    if (hostResult.status === 'error' && options.writer === undefined) {
      counts.copyErrors += 1
      trace('failed', id, hashPayload(clean))
      options.notify('Clipboard copy failed', { color: 'warning' })
      return hostResult
    }
    const result: ClipboardWriteResult = { status: 'copied', chars: clean.length, payloadHash: hashPayload(clean) }
    trace('completed', id, result.payloadHash)
    options.notify(`Copied ${clean.length} characters`)
    return result
  }

  const formatFiles = (paths: readonly string[]): string => paths
    .filter((path) => path !== '' && !/[\x00-\x1f\x7f]/.test(path))
    .slice(0, 64)
    .map((path) => /\s/u.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path)
    .join(' ')

  const handleRead = async (value: ClipboardReadValue, id: number): Promise<ClipboardPasteResult> => {
    if (value.kind === 'empty') {
      counts.emptyPastes += 1
      options.notify('Clipboard is empty', { color: 'warning' })
      return { status: 'empty' }
    }
    if (value.kind === 'unavailable') {
      counts.unavailablePastes += 1
      options.notify('Clipboard is unavailable', { color: 'warning' })
      return { status: 'unavailable', ...(value.reason === undefined ? {} : { reason: value.reason }) }
    }
    if (value.kind === 'error') {
      counts.errors += 1
      options.notify('Failed to read the clipboard', { color: 'warning' })
      return { status: 'error', reason: value.code }
    }
    if (value.kind === 'text') {
      const text = sanitizeClipboardText(value.text)
      if (text === '') return { status: 'empty' }
      options.insertText(text)
      counts.textPastes += 1
      trace('completed', id, hashPayload(text))
      return { status: 'inserted-text', chars: text.length }
    }
    if (value.kind === 'files') {
      const text = formatFiles(value.paths)
      if (text === '') return { status: 'empty' }
      options.insertText(text)
      counts.filePastes += 1
      trace('completed', id, hashPayload(text))
      return { status: 'inserted-files', count: value.paths.length }
    }
    if (options.stageImage === undefined) {
      counts.errors += 1
      options.notify('Image paste is unsupported here', { color: 'warning' })
      trace('unsupported', id)
      return { status: 'unsupported', reason: 'stage-image-missing' }
    }
    try {
      const staged = await options.stageImage({ data: value.data.slice(), mediaType: value.mediaType, ...(value.name === undefined ? {} : { name: value.name }) })
      if (staged.placeholder !== undefined) options.insertText(staged.placeholder)
      else if (staged.token !== undefined) options.insertText(`${staged.token} `)
      else return { status: 'error', reason: 'stage-image-empty-result' }
      counts.imagePastes += 1
      trace('completed', id, hashPayload(value.data))
      return { status: 'staged-image', token: staged.token ?? staged.placeholder ?? '' }
    } catch {
      counts.errors += 1
      options.notify('Image paste failed', { color: 'warning' })
      trace('failed', id)
      return { status: 'error', reason: 'stage-image-failed' }
    }
  }

  return {
    copy,
    async paste() {
      if (stopped) return { status: 'error', reason: 'stopped' }
      if (busy) {
        counts.busy += 1
        return { status: 'error', reason: 'busy' }
      }
      busy = true
      const id = ++operation
      counts.pastes += 1
      trace('working', id)
      try {
        const value = await options.capability.read()
        if (stopped) {
          counts.late += 1
          return { status: 'error', reason: 'stopped' }
        }
        return await handleRead(value, id)
      } catch {
        counts.errors += 1
        options.notify('Failed to read the clipboard', { color: 'warning' })
        trace('failed', id)
        return { status: 'error', reason: 'clipboard-read-failed' }
      } finally {
        busy = false
      }
    },
    isBusy: () => busy,
    diagnostics: () => ({ ...counts }),
    stop() {
      stopped = true
    },
  }
}
