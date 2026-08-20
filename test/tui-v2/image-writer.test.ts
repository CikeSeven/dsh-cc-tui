/** WP-08e2 image operation ordering and terminal byte output. */
import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Clock } from '../../src/tui-v2/model/schema.js'
import { buildFrame } from '../../src/tui-v2/renderer/frame-builder.js'
import { createImageStore } from '../../src/tui-v2/renderer/image-store.js'
import type { PatchOperation, TerminalModeSnapshot, TerminalPatch } from '../../src/tui-v2/renderer/frame.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { FullscreenBackend } from '../../src/tui-v2/terminal/fullscreen-backend.js'
import { kittyPlacementId } from '../../src/tui-v2/terminal/image-protocol.js'
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js'
import {
  createTerminalWriter,
  encodePatchOperations,
  encodePatchOperationsSync,
} from '../../src/tui-v2/terminal/writer.js'

const clock: Clock = {
  now: () => 0,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

class CaptureStream extends Writable {
  readonly chunks: string[] = []
  _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk))
    callback()
  }
  get text(): string { return this.chunks.join('') }
}

function profile(protocol: 'kitty' | 'iterm2'): TerminalProfile {
  return {
    ...getProfile('kitty-sync'),
    id: `writer-${protocol}`,
    family: protocol,
    imageProtocol: protocol,
    columns: 20,
    rows: 8,
  }
}

function payload(text = 'PNG\x1b]52;c;attack\x07'): Uint8Array {
  return new TextEncoder().encode(text)
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function imageFixture(protocol: 'kitty' | 'iterm2') {
  const store = createImageStore({ maxBytes: 1024, maxEntries: 4 })
  const data = payload()
  const payloadHash = hash(data)
  const saved = await store.put(payloadHash, data, protocol)
  const placement = {
    imageId: 'image-1', protocol, x: 2, y: 1, width: 3, height: 2,
    payloadHash, storeKey: saved.storeKey,
  } as const
  const operations: PatchOperation[] = [
    ...(protocol === 'iterm2' ? [{ kind: 'cursor', x: 2, y: 1, visible: false } as const] : []),
    { kind: 'image-upload', storeKey: saved.storeKey, protocol, payloadHash },
    { kind: 'image-place', placement },
  ]
  return { store, data, payloadHash, saved, placement, operations }
}

function patch(operations: readonly PatchOperation[], bytes: number): TerminalPatch {
  return {
    frameId: 'image-frame', stateRevision: 0, patchSeq: 0, generation: 0,
    operations, bytes, fullRedraw: false,
  }
}

function modes(height: number): TerminalModeSnapshot {
  return {
    alternateScreen: false, rawInput: false, mouse: 'off', bracketedPaste: false,
    syncOutput: false, autowrap: true, wrapPending: false,
    scrollRegion: { top: 0, bottom: height - 1 }, cursorStyle: 'block', cursorVisible: false,
    kittyKeyboard: false, modifyOtherKeys: false, focusReporting: false,
    windowsDec9001: false, osc133: false, title: null, progress: { state: 'none' },
  }
}

test('image writer Kitty output is upload before reference-only placement and raw controls stay base64', async () => {
  const fixture = await imageFixture('kitty')
  const encoded = encodePatchOperationsSync(fixture.operations, {
    imageStore: fixture.store,
    profile: profile('kitty'),
  })
  const upload = encoded.encoded.indexOf('\x1b_Ga=t')
  const place = encoded.encoded.indexOf('\x1b_Ga=p')
  assert.ok(upload >= 0 && place > upload)
  assert.ok(encoded.encoded.includes('\x1b[2;3H'), 'placement is positioned by a bounded CUP')
  assert.ok(!encoded.encoded.includes('\x1b]52;c;attack'), 'payload controls are never injected raw')
  assert.ok(encoded.encoded.includes(Buffer.from(fixture.data).toString('base64')))

  const stream = new CaptureStream()
  const writer = createTerminalWriter({ stream, clock, profile: profile('kitty'), imageStore: fixture.store })
  const result = await writer.write(patch(fixture.operations, encoded.bytes))
  assert.equal(result.status, 'written')
  assert.equal(stream.text, encoded.encoded)
  await writer.stop({ preserveScreen: true })
  assert.ok(stream.text.includes('\x1b_Ga=d,d=A'), 'stop clears Kitty image data')
})

test('image writer Kitty chunks payloads and preserves hash-only placement identity', async () => {
  const store = createImageStore({ maxBytes: 16 * 1024, maxEntries: 4 })
  const data = Uint8Array.from({ length: 4096 }, (_, index) => index % 251)
  const payloadHash = hash(data)
  const saved = await store.put(payloadHash, data, 'kitty')
  const placement = {
    imageId: 'chunked-image', protocol: 'kitty' as const, x: 1, y: 2, width: 4, height: 3,
    payloadHash, storeKey: saved.storeKey,
  }
  const operations: PatchOperation[] = [
    { kind: 'image-upload', storeKey: saved.storeKey, protocol: 'kitty', payloadHash },
    { kind: 'image-place', placement },
  ]
  const encoded = encodePatchOperationsSync(operations, { imageStore: store, profile: profile('kitty') })
  const apcs = encoded.encoded.split('\x1b_G').length - 1
  assert.equal(apcs, 3, 'two upload chunks plus one placement command')
  assert.match(encoded.encoded, /a=t[^;]*m=1;/)
  assert.match(encoded.encoded, /\x1b_Gm=0;/)
  const vt = new VirtualTerminal(profile('kitty'))
  vt.write(encoded.encoded)
  const image = vt.snapshot().images[0]
  assert.equal(image?.imageId, `kitty-p${kittyPlacementId(placement.imageId)}`)
  assert.equal(image?.payloadHash, payloadHash)
})

test('image writer iTerm2 emits one controlled OSC 1337 at the requested cursor', async () => {
  const fixture = await imageFixture('iterm2')
  const encoded = await encodePatchOperations(fixture.operations, {
    imageStore: fixture.store,
    profile: profile('iterm2'),
  })
  assert.ok(encoded.encoded.startsWith('\x1b[2;3H'))
  assert.equal(encoded.encoded.split('\x1b]1337;File=').length - 1, 1)
  assert.ok(encoded.encoded.includes('inline=1;size='))
  assert.ok(encoded.encoded.endsWith('\x07'))
  assert.ok(!encoded.encoded.includes('\x1b]52;c;attack'))
})

test('image writer rejects place-before-upload, missing store, hash and profile mismatches', async () => {
  const fixture = await imageFixture('kitty')
  await assert.rejects(
    encodePatchOperations([{ kind: 'image-place', placement: fixture.placement }], {
      imageStore: fixture.store,
      profile: profile('kitty'),
    }),
    /before image-upload/,
  )
  await assert.rejects(
    encodePatchOperations(fixture.operations, { profile: profile('kitty') }),
    /configured ImageStore/,
  )
  const badHashOps = fixture.operations.map((operation) =>
    operation.kind === 'image-upload' ? { ...operation, payloadHash: '0'.repeat(64) } : operation)
  await assert.rejects(
    encodePatchOperations(badHashOps, { imageStore: fixture.store, profile: profile('kitty') }),
    /identity mismatch|metadata mismatch|hash mismatch/,
  )
  await assert.rejects(
    encodePatchOperations(fixture.operations, { imageStore: fixture.store, profile: profile('iterm2') }),
    /unsupported-image/,
  )
  await assert.rejects(
    encodePatchOperations([{ kind: 'image-delete', storeKey: 'not-a-store-key' }]),
    /image-delete\.storeKey/,
  )
})

test('image writer delete/clear bytes are Kitty-only and canonical operations contain hash not payload', async () => {
  const fixture = await imageFixture('kitty')
  const operations: PatchOperation[] = [
    ...fixture.operations,
    { kind: 'image-delete', storeKey: fixture.saved.storeKey },
    ...fixture.operations.slice(0, 1),
    { kind: 'image-clear' },
  ]
  const encoded = encodePatchOperationsSync(operations, {
    imageStore: fixture.store,
    profile: profile('kitty'),
  })
  assert.ok(encoded.encoded.includes('\x1b_Ga=d,d=I'))
  assert.ok(encoded.encoded.includes('\x1b_Ga=d,d=A'))
  const canonical = JSON.stringify(operations)
  assert.ok(canonical.includes(fixture.payloadHash))
  assert.ok(!canonical.includes(Buffer.from(fixture.data).toString('base64')))
})

test('image cleanup is fail-closed for unknown profiles', async () => {
  const fixture = await imageFixture('kitty')
  const unknown = getProfile('unknown-conservative')
  const encoded = encodePatchOperationsSync([
    { kind: 'image-delete', storeKey: fixture.saved.storeKey },
    { kind: 'image-clear' },
  ], { imageStore: fixture.store, profile: unknown })
  assert.equal(encoded.encoded, '')
  assert.deepEqual(encoded.imageReferences, [])
})

test('fullscreen backend emits deterministic upload-before-place and omits unchanged placements', async () => {
  const fixture = await imageFixture('kitty')
  const kitty = profile('kitty')
  const diagnostics: string[] = []
  const backend = new FullscreenBackend({
    profile: kitty,
    imageStore: fixture.store,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.reason),
  })
  await backend.start(0)
  const first = buildFrame({
    frameId: 'backend-image-1', stateRevision: 0, width: 20, height: 8,
    lines: ['image'], profile: kitty, modes: modes(8), generation: 0,
    fullRedraw: true, fullRedrawReason: 'initial', images: [fixture.placement],
  })
  const firstPatch = backend.plan(null, first)
  const kinds = firstPatch.operations.map((operation) => operation.kind)
  assert.ok(kinds.indexOf('image-upload') >= 0)
  assert.ok(kinds.indexOf('image-place') > kinds.indexOf('image-upload'))
  assert.equal(
    firstPatch.bytes,
    encodePatchOperationsSync(firstPatch.operations, { imageStore: fixture.store, profile: kitty }).bytes,
  )

  const second = buildFrame({
    frameId: 'backend-image-2', stateRevision: 1, width: 20, height: 8,
    lines: ['image'], profile: kitty, modes: modes(8), generation: 0,
    images: [fixture.placement],
  })
  const secondPatch = backend.plan(first, second)
  assert.equal(secondPatch.operations.some((operation) => operation.kind.startsWith('image-')), false)
  assert.deepEqual(diagnostics, [])
})

test('fullscreen backend reasserts the resting cursor after an image-only patch', async () => {
  const fixture = await imageFixture('kitty')
  const kitty = profile('kitty')
  const backend = new FullscreenBackend({ profile: kitty, imageStore: fixture.store })
  const first = buildFrame({
    frameId: 'cursor-image-1', stateRevision: 0, width: 20, height: 8,
    lines: [], profile: kitty, modes: modes(8), generation: 0, images: [fixture.placement],
    cursor: { x: 17, y: 6, visible: true },
  })
  const moved = { ...fixture.placement, x: 4 }
  const next = buildFrame({
    frameId: 'cursor-image-2', stateRevision: 1, width: 20, height: 8,
    lines: [], profile: kitty, modes: modes(8), generation: 0, images: [moved],
    cursor: { x: 17, y: 6, visible: true },
  })
  const patch = backend.plan(first, next)
  const cursorOps = patch.operations.filter((operation) => operation.kind === 'cursor')
  assert.equal(cursorOps.length, 1)
  assert.deepEqual(cursorOps[0], { kind: 'cursor', x: 17, y: 6, visible: true })
})

test('fullscreen backend missing store/profile falls back with unsupported-image diagnostic, not throw', () => {
  const kitty = profile('kitty')
  const diagnostics: string[] = []
  const frame = buildFrame({
    frameId: 'missing-store', stateRevision: 0, width: 20, height: 8,
    lines: ['[Image unavailable]'], profile: kitty, modes: modes(8), generation: 0,
    images: [{
      imageId: 'missing', protocol: 'kitty', x: 0, y: 0, width: 1, height: 1,
      payloadHash: '2'.repeat(64), storeKey: `image:kitty:${'2'.repeat(64)}`,
    }],
  })
  const backend = new FullscreenBackend({
    profile: kitty,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.reason),
  })
  assert.doesNotThrow(() => backend.plan(null, frame))
  assert.deepEqual(diagnostics, ['missing-store'])
})
