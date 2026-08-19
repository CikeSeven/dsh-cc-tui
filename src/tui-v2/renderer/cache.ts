/**
 * tui-v2 bounded caches (WP-04b, plan §10.2).
 *
 * Every cache in the renderer declares its budget at the construction site
 * with a machine-scannable annotation:
 *
 *   `@cache-budget entries=<n> bytes=<n> eviction=LRU`
 *
 * plus an invalidation policy (`CacheInvalidationPolicy`) stating which
 * environment changes (width/theme/profile/row revision) must clear it.
 * `createBoundedCache` is the only cache constructor; it enforces the entry
 * cap and (when declared) the byte budget with LRU eviction, and exposes
 * hit/miss/eviction statistics (§10.2 bullet list).
 *
 * Key safety (§9.3): keys derived by slicing large strings keep the whole
 * parent string alive in V8 (SlicedString). `detachString` copies such keys
 * into fresh flat strings; cache constructors accept `detachKey` so the
 * policy is explicit per cache.
 *
 * Dependency rule (§4.3): renderer imports nothing from node/Cordis/session.
 */

/**
 * Copy a string into a fresh flat string that shares no backing store with
 * any parent. V8 represents `bigString.slice(...)` results (length >= 13) as
 * SlicedStrings pointing at the parent; caching such keys pins the whole
 * parent (§9.3 sliced-string heap growth). Short strings are never sliced
 * representations, so they are returned as-is.
 *
 * The copy goes through code-point iteration + join, which always builds a
 * new flat string and is lossless (lone surrogates survive the round trip,
 * unlike a Buffer/UTF-8 detour).
 */
const SLICED_STRING_MIN_LENGTH = 13

export function detachString(value: string): string {
  if (value.length < SLICED_STRING_MIN_LENGTH) return value
  return Array.from(value).join('')
}

// ---------------------------------------------------------------------------
// Bounded LRU cache
// ---------------------------------------------------------------------------

export interface BoundedCacheOptions<K, V> {
  /** Hard cap on live entries (required). */
  readonly maxEntries: number
  /** Optional byte budget; entry size via `keyToBytes`/`valueToBytes`. */
  readonly maxBytes?: number
  /** Size accounting for one key (defaults to 0). */
  readonly keyToBytes?: (key: K) => number
  /** Size accounting for one value (defaults to 0). */
  readonly valueToBytes?: (value: V) => number
  /**
   * Key copy/detach hook, applied once at `set` time. Caches whose keys are
   * derived from large strings must pass `detachString` here (§9.3).
   */
  readonly detachKey?: (key: K) => K
  /** Eviction notification (LRU or budget-driven); never called on `delete`. */
  readonly onEvict?: (key: K, value: V, reason: 'lru' | 'bytes') => void
}

export interface BoundedCacheStats {
  readonly hits: number
  readonly misses: number
  readonly evictions: number
  readonly entries: number
  readonly bytes: number
  readonly maxEntries: number
  readonly maxBytes: number | null
  /** hits / (hits + misses); 0 when no lookups yet. */
  readonly hitRate: number
}

export interface BoundedCache<K, V> {
  get(key: K): V | undefined
  has(key: K): boolean
  set(key: K, value: V): void
  delete(key: K): boolean
  clear(): void
  stats(): BoundedCacheStats
}

/**
 * Map-backed LRU: `get` refreshes recency; `set` beyond either budget evicts
 * least-recently-used entries until the cache fits. An entry individually
 * larger than `maxBytes` is still stored (it is the only occupant).
 */
export function createBoundedCache<K, V>(options: BoundedCacheOptions<K, V>): BoundedCache<K, V> {
  if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
    throw new RangeError('createBoundedCache: maxEntries must be a positive integer')
  }
  if (options.maxBytes !== undefined && (!Number.isFinite(options.maxBytes) || options.maxBytes < 1)) {
    throw new RangeError('createBoundedCache: maxBytes must be a positive number')
  }
  const map = new Map<K, V>()
  const sizes = new Map<K, number>()
  let bytes = 0
  let hits = 0
  let misses = 0
  let evictions = 0

  const entryBytes = (key: K, value: V): number =>
    (options.keyToBytes?.(key) ?? 0) + (options.valueToBytes?.(value) ?? 0)

  const evictOldest = (reason: 'lru' | 'bytes'): void => {
    const oldest = map.keys().next()
    if (oldest.done) return
    const key = oldest.value
    const value = map.get(key) as V
    map.delete(key)
    bytes -= sizes.get(key) ?? 0
    sizes.delete(key)
    evictions += 1
    options.onEvict?.(key, value, reason)
  }

  return {
    get(key) {
      if (!map.has(key)) {
        misses += 1
        return undefined
      }
      const value = map.get(key) as V
      // Refresh recency: delete + set moves the entry to the newest slot.
      map.delete(key)
      map.set(key, value)
      hits += 1
      return value
    },
    has(key) {
      return map.has(key)
    },
    set(key, value) {
      const storedKey = options.detachKey ? options.detachKey(key) : key
      if (map.has(storedKey)) {
        bytes -= sizes.get(storedKey) ?? 0
        map.delete(storedKey)
        sizes.delete(storedKey)
      }
      map.set(storedKey, value)
      sizes.set(storedKey, entryBytes(storedKey, value))
      bytes += sizes.get(storedKey) ?? 0
      while (map.size > options.maxEntries) evictOldest('lru')
      if (options.maxBytes !== undefined) {
        while (bytes > options.maxBytes && map.size > 1) evictOldest('bytes')
      }
    },
    delete(key) {
      if (!map.has(key)) return false
      bytes -= sizes.get(key) ?? 0
      sizes.delete(key)
      return map.delete(key)
    },
    clear() {
      map.clear()
      sizes.clear()
      bytes = 0
    },
    stats() {
      const lookups = hits + misses
      return {
        hits,
        misses,
        evictions,
        entries: map.size,
        bytes,
        maxEntries: options.maxEntries,
        maxBytes: options.maxBytes ?? null,
        hitRate: lookups === 0 ? 0 : hits / lookups,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Invalidation policy (§10.2: width/theme/profile/row-revision conditions)
// ---------------------------------------------------------------------------

/** Environment changes a cache may subscribe to. */
export interface CacheChangeSet {
  readonly widthChanged?: boolean
  readonly themeChanged?: boolean
  readonly profileChanged?: boolean
  /** A specific row's revision changed (for per-row keyed caches). */
  readonly rowRevisionChanged?: boolean
}

/**
 * Which changes clear a cache entirely. Every cache declares one; the
 * scheduler's resize transaction and the base renderer apply them via
 * `clearOnChanges` instead of open-coding per-cache rules.
 */
export interface CacheInvalidationPolicy {
  readonly clearOnWidthChange: boolean
  readonly clearOnThemeChange: boolean
  readonly clearOnProfileChange: boolean
  readonly clearOnRowRevisionChange: boolean
}

export function shouldClearCache(policy: CacheInvalidationPolicy, changes: CacheChangeSet): boolean {
  return (
    (changes.widthChanged === true && policy.clearOnWidthChange) ||
    (changes.themeChanged === true && policy.clearOnThemeChange) ||
    (changes.profileChanged === true && policy.clearOnProfileChange) ||
    (changes.rowRevisionChanged === true && policy.clearOnRowRevisionChange)
  )
}

/** Apply declared invalidation semantics: clear the cache when its policy subscribes to an observed change. */
export function invalidateOn<K, V>(
  cache: BoundedCache<K, V>,
  policy: CacheInvalidationPolicy,
  changes: CacheChangeSet,
): boolean {
  if (!shouldClearCache(policy, changes)) return false
  cache.clear()
  return true
}
