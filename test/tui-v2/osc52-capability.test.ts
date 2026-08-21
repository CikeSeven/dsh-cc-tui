import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createHash } from 'node:crypto'

import { createExternalActionTraceRecorder } from '../../src/tui-v2/capabilities/external-actions.js'
import { createClipboardController } from '../../src/tui-v2/controllers/clipboard.js'
import * as ansi from '../../src/tui-v2/terminal/ansi.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'

class CaptureStream extends Writable {
  readonly chunks: string[] = []
  _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk))
    callback()
  }
  get text(): string { return this.chunks.join('') }
}

test('OSC52: confirmed profile emits exact trusted bytes and trace stores only hash', async () => {
  const stream = new CaptureStream()
  const trace = createExternalActionTraceRecorder()
  const controller = createClipboardController({
    capability: { read: async () => ({ kind: 'empty' as const }), copy: async () => ({ status: 'unsupported' as const, reason: 'host' }) },
    generation: () => 3,
    profileSupportsOsc52: () => getProfile('vscode-terminal').supportsOsc52 === 'yes',
    writer: { writeControl: async (operation) => {
      if (operation.kind !== 'sequence') return { status: 'error' as const, error: { code: 'bad-op', message: 'bad', generation: 3, recoverable: true } }
      stream.write(operation.sequence)
      return { status: 'written' as const, bytes: Buffer.byteLength(operation.sequence, 'utf8') }
    } },
    insertText: () => {},
    notify: () => {},
    trace,
  })
  const result = await controller.copy('hello')
  assert.equal(result.status, 'copied')
  assert.equal(stream.text, '\x1b]52;c;aGVsbG8=\x07')
  assert.equal(stream.text, ansi.osc52Clipboard('aGVsbG8='))
  const hash = createHash('sha256').update('hello').digest('hex')
  assert.ok(trace.entries().every((entry) => !JSON.stringify(entry).includes('hello')))
  assert.ok(trace.entries().some((entry) => entry.payloadHash === hash))
})

test('OSC52: unknown/denied capability falls back without writer bytes', async () => {
  const stream = new CaptureStream()
  const controller = createClipboardController({
    capability: { read: async () => ({ kind: 'empty' as const }), copy: async () => ({ status: 'unsupported' as const, reason: 'host' }) },
    generation: () => 0,
    profileSupportsOsc52: () => false,
    writer: { writeControl: async () => { stream.write('must-not-write'); return { status: 'written' as const } } },
    insertText: () => {},
    notify: () => {},
  })
  assert.deepEqual(await controller.copy('secret'), { status: 'unsupported', reason: 'osc52-not-confirmed' })
  assert.equal(stream.text, '')
})

test('OSC52: builder rejects malformed and oversized base64 payloads', () => {
  assert.throws(() => ansi.osc52Clipboard('not base64!'), TypeError)
  assert.throws(() => ansi.osc52Clipboard('A'.repeat(8 * 1024 * 1024 + 1)), RangeError)
})
