/**
 * tui-v2 WP-04b renderer-cache tests: bounded LRU caches (plan §10.2) —
 * entry/byte budgets, eviction order, stats accounting, detachString heap
 * safety (§9.3 sliced strings) and the invalidation-policy wrapper.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createBoundedCache,
  detachString,
  invalidateOn,
  shouldClearCache,
  type CacheChangeSet,
} from '../../src/tui-v2/renderer/cache.js'

test('cache: maxEntries evicts least-recently-used first', () => {
  const evicted: string[] = []
  const cache = createBoundedCache<string, number>({
    maxEntries: 2,
    onEvict: (key) => evicted.push(key),
  })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3) // evicts 'a'
  assert.deepEqual(evicted, ['a'])
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), 2)
  // get() refreshes recency: 'b' is now newer than 'c'.
  cache.set('d', 4) // evicts 'c'
  assert.deepEqual(evicted, ['a', 'c'])
  assert.equal(cache.get('b'), 2)
  assert.equal(cache.stats().evictions, 2)
})

test('cache: maxBytes budget evicts until the cache fits', () => {
  const cache = createBoundedCache<string, string>({
    maxEntries: 100,
    maxBytes: 20,
    keyToBytes: (key) => key.length,
    valueToBytes: (value) => value.length,
  })
  cache.set('aaaaa', 'aaaaa') // 10
  cache.set('bbbbb', 'bbbbb') // 20
  cache.set('cc', 'cc') // 24 -> evicts 'aaaaa' (10) -> 14
  assert.equal(cache.get('aaaaa'), undefined)
  assert.equal(cache.get('bbbbb'), 'bbbbb')
  assert.equal(cache.stats().bytes, 14)
})

test('cache: byte accounting is exact', () => {
  const cache = createBoundedCache<string, string>({
    maxEntries: 10,
    maxBytes: 12,
    keyToBytes: (key) => key.length,
    valueToBytes: (value) => value.length,
  })
  cache.set('aa', 'aa') // 4
  cache.set('bb', 'bb') // 8
  cache.set('cc', 'cc') // 12
  cache.set('dd', 'dd') // 16 -> evict 'aa' (12 fits, not over)
  assert.equal(cache.stats().bytes, 12)
  assert.equal(cache.stats().entries, 3)
  assert.equal(cache.get('aa'), undefined)
  assert.equal(cache.get('dd'), 'dd')
})

test('cache: stats() reports hits/misses/hitRate/entries/bytes', () => {
  const cache = createBoundedCache<string, number>({ maxEntries: 4 })
  cache.set('a', 1)
  cache.get('a')
  cache.get('nope')
  const stats = cache.stats()
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
  assert.equal(stats.hitRate, 0.5)
  assert.equal(stats.entries, 1)
  assert.equal(stats.maxEntries, 4)
  assert.equal(stats.maxBytes, null)
})

test('cache: set() with an existing key replaces without double counting', () => {
  const cache = createBoundedCache<string, string>({
    maxEntries: 4,
    maxBytes: 100,
    keyToBytes: (k) => k.length,
    valueToBytes: (v) => v.length,
  })
  cache.set('a', 'aaaa')
  cache.set('a', 'bb')
  assert.equal(cache.stats().entries, 1)
  assert.equal(cache.stats().bytes, 1 + 2)
  assert.equal(cache.get('a'), 'bb')
})

test('cache: detachKey is applied once at set time', () => {
  const seen: string[] = []
  const cache = createBoundedCache<string, number>({
    maxEntries: 4,
    detachKey: (key) => {
      const detached = detachString(key)
      seen.push(detached)
      return detached
    },
  })
  const big = 'x'.repeat(4096)
  const sliced = big.slice(100, 130) // SlicedString pinning `big`
  cache.set(sliced, 1)
  assert.equal(cache.get('x'.repeat(30)), 1) // equal content hits
  assert.equal(seen.length, 1)
})

test('cache: detachString copies sliced strings out of their parent', () => {
  const parent = 'p'.repeat(100_000)
  const slice = parent.slice(10, 10_000)
  const detached = detachString(slice)
  assert.equal(detached, slice)
  assert.equal(detached.length, slice.length)
  // Short strings are never SlicedStrings; returned as-is.
  assert.equal(detachString('short'), 'short')
  // Lone surrogates survive the copy (a Buffer detour would corrupt them).
  const lone = 'lone-𝌆-edge'
  assert.equal(detachString(lone), lone)
})

test('cache: invalidateOn clears only when the policy subscribes', () => {
  const cache = createBoundedCache<string, number>({ maxEntries: 4 })
  cache.set('a', 1)
  const policy = {
    clearOnWidthChange: true,
    clearOnThemeChange: false,
    clearOnProfileChange: true,
    clearOnRowRevisionChange: false,
  }
  const themeOnly: CacheChangeSet = { themeChanged: true }
  assert.equal(invalidateOn(cache, policy, themeOnly), false)
  assert.equal(cache.get('a'), 1)
  assert.equal(invalidateOn(cache, policy, { widthChanged: true }), true)
  assert.equal(cache.get('a'), undefined)
  assert.equal(shouldClearCache(policy, { profileChanged: true }), true)
  assert.equal(shouldClearCache(policy, { rowRevisionChanged: true }), false)
})

test('cache: clear() resets size accounting', () => {
  const cache = createBoundedCache<string, string>({
    maxEntries: 4,
    maxBytes: 100,
    keyToBytes: (k) => k.length,
    valueToBytes: (v) => v.length,
  })
  cache.set('a', 'b')
  cache.clear()
  assert.equal(cache.stats().entries, 0)
  assert.equal(cache.stats().bytes, 0)
})

test('cache: constructor rejects degenerate budgets', () => {
  assert.throws(() => createBoundedCache({ maxEntries: 0 }), RangeError)
  assert.throws(() => createBoundedCache({ maxEntries: 2, maxBytes: 0 }), RangeError)
})
