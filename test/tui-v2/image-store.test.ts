/** WP-08e2 bounded process-local ImageStore contracts. */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BoundedImageStore,
  DEFAULT_IMAGE_STORE_MAX_BYTES,
  DEFAULT_IMAGE_STORE_MAX_ENTRIES,
  DEFAULT_IMAGE_STORE_MAX_ENTRY_BYTES,
  createImageStore,
} from '../../src/tui-v2/renderer/image-store.js'

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function hash(payload: Uint8Array): string {
  return createHash('sha256').update(payload).digest('hex')
}

async function put(store: BoundedImageStore, text: string, generation?: number, protocol: 'kitty' | 'iterm2' = 'kitty') {
  const payload = bytes(text)
  const result = await store.put(hash(payload), payload, protocol, generation)
  return { ...result, payload, hash: hash(payload) }
}

test('image store defaults are 32 MiB and 128 entries', () => {
  const store = createImageStore()
  assert.deepEqual(store.stats(), {
    entries: 0,
    bytes: 0,
    maxBytes: DEFAULT_IMAGE_STORE_MAX_BYTES,
    maxEntries: DEFAULT_IMAGE_STORE_MAX_ENTRIES,
    maxEntryBytes: DEFAULT_IMAGE_STORE_MAX_ENTRY_BYTES,
    evictions: 0,
    rejections: 0,
    referencedEntries: 0,
  })
})

test('image store validates hash, bytes and protocol including explicit sixel rejection', async () => {
  const store = createImageStore({ maxBytes: 16, maxEntries: 2 })
  const payload = bytes('abc')
  await assert.rejects(store.put('bad', payload, 'kitty'), /64 lowercase/)
  await assert.rejects(store.put(hash(payload), new Uint8Array(), 'kitty'), /empty/)
  await assert.rejects(store.put(hash(payload), payload, 'sixel' as 'kitty'), /sixel is unsupported/)
  await assert.rejects(store.put('0'.repeat(64), payload, 'kitty'), /does not match/)
  await assert.rejects(store.put(hash(bytes('0123456789abcdefg')), bytes('0123456789abcdefg'), 'kitty'), /store budget/)
  assert.equal(store.stats().rejections, 5)
})

test('image store makes immutable copies and exposes metadata without payload', async () => {
  const store = createImageStore({ maxBytes: 64, maxEntries: 4 })
  const source = bytes('immutable')
  const payloadHash = hash(source)
  const saved = await store.put(payloadHash, source, 'iterm2', 1)
  source[0] = 0
  const first = await store.get(saved.storeKey)
  assert.equal(new TextDecoder().decode(first!), 'immutable')
  first![0] = 0
  assert.equal(new TextDecoder().decode(await store.get(saved.storeKey) ?? new Uint8Array()), 'immutable')
  assert.deepEqual(store.metadata(saved.storeKey), {
    storeKey: saved.storeKey,
    payloadHash,
    protocol: 'iterm2',
    bytes: 9,
  })
  const serialized = JSON.stringify({ store, metadata: store.metadata(saved.storeKey) })
  assert.ok(!serialized.includes('immutable'), 'raw image bytes cannot serialize through the store')
})

test('image store generation references are idempotent and clear independently', async () => {
  const store = createImageStore({ maxBytes: 64, maxEntries: 4 })
  const saved = await put(store, 'same', 1)
  store.retain(saved.storeKey, 1)
  store.retain(saved.storeKey, 2)
  assert.equal(store.stats().referencedEntries, 1)
  store.clearGeneration(1)
  assert.ok(await store.get(saved.storeKey), 'generation 2 keeps the image alive')
  store.clearGeneration(2)
  assert.equal(await store.get(saved.storeKey), null)
  assert.equal(store.stats().entries, 0)
})

test('image store evicts only the oldest unreferenced entry by entry and byte budgets', async () => {
  const store = createImageStore({ maxBytes: 6, maxEntries: 2 })
  const a = await put(store, 'aa')
  const b = await put(store, 'bb')
  store.release(a.storeKey)
  store.release(b.storeKey)
  // Both are now eligible. Touch b to make a the oldest victim.
  await store.get(b.storeKey)
  const c = await put(store, 'cccc', 3)
  assert.equal(await store.get(a.storeKey), null)
  assert.ok(await store.get(b.storeKey))
  assert.ok(await store.get(c.storeKey))
  assert.equal(store.stats().evictions, 1)
  assert.equal(store.stats().bytes, 6)
})

test('image store refuses capacity overflow when every victim is generation-pinned', async () => {
  const store = createImageStore({ maxBytes: 4, maxEntries: 2 })
  await put(store, 'aa', 1)
  await put(store, 'bb', 2)
  await assert.rejects(put(store, 'c', 3), /referenced entries/)
  assert.deepEqual({ entries: store.stats().entries, bytes: store.stats().bytes }, { entries: 2, bytes: 4 })
})

test('image store concurrent duplicate puts converge on one content-addressed entry', async () => {
  const store = createImageStore({ maxBytes: 64, maxEntries: 4 })
  const payload = bytes('parallel')
  const payloadHash = hash(payload)
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, generation) => store.put(payloadHash, payload, 'kitty', generation)),
  )
  assert.equal(new Set(results.map((result) => result.storeKey)).size, 1)
  assert.equal(store.stats().entries, 1)
  assert.equal(store.stats().bytes, payload.byteLength)
  for (let generation = 0; generation < 16; generation++) store.clearGeneration(generation)
  assert.equal(store.stats().entries, 0)
})

test('image store replaces generation references atomically across clear and re-upload', async () => {
  const store = createImageStore({ maxBytes: 16, maxEntries: 4 })
  const oldImage = await put(store, 'old', 7)
  store.setGenerationReferences(7, [oldImage.storeKey])
  const nextImage = await put(store, 'next', 7)
  store.setGenerationReferences(7, [nextImage.storeKey])
  assert.equal(await store.get(oldImage.storeKey), null)
  assert.ok(await store.get(nextImage.storeKey))
  assert.deepEqual(store.stats().referencedEntries, 1)
})
