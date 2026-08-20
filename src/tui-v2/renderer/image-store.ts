/**
 * Process-local bounded image store (WP-08e2, plan §5.5).
 *
 * Image bytes deliberately live behind this module.  The renderer/frame and
 * model/trace contracts carry only a content hash and an ephemeral store key;
 * this object is never serialised or handed to a component.  Entries are
 * content-addressed, immutable copies with an LRU policy that may evict only
 * entries which have no generation reference or explicit lease.
 *
 * The public shape is compatible with `renderer/frame.ts`'s ImageStore.  The
 * additional methods on `BoundedImageStore` are an implementation seam used by
 * the synchronous screen planner/writer; callers with only the base interface
 * can still use put/get/release/clearGeneration/stats.
 */
import type { ImageStore } from './frame.js'

export type StoredImageProtocol = 'kitty' | 'iterm2'

export const DEFAULT_IMAGE_STORE_MAX_BYTES = 32 * 1024 * 1024
export const DEFAULT_IMAGE_STORE_MAX_ENTRIES = 128
/** Leaves headroom for base64 expansion plus protocol/cell bytes below the writer's 8 MiB cap. */
export const DEFAULT_IMAGE_STORE_MAX_ENTRY_BYTES = 5 * 1024 * 1024
export const IMAGE_HASH_LENGTH = 64

const IMAGE_HASH = /^[0-9a-f]{64}$/
const IMAGE_STORE_KEY = /^image:(kitty|iterm2):([0-9a-f]{64})$/

export interface ImageStoreOptions {
  readonly maxBytes?: number
  readonly maxEntries?: number
  readonly maxEntryBytes?: number
}

export interface ImageStoreMetadata {
  readonly storeKey: string
  readonly payloadHash: string
  readonly protocol: StoredImageProtocol
  readonly bytes: number
}

export interface ImageStoreStats {
  readonly entries: number
  readonly bytes: number
  readonly maxBytes: number
  readonly maxEntries: number
  readonly maxEntryBytes: number
  readonly evictions: number
  readonly rejections: number
  readonly referencedEntries: number
}

interface Entry extends ImageStoreMetadata {
  /** Bytes are never exposed through metadata or JSON serialization. */
  readonly payload: Uint8Array
  /** Active generations pin the entry against LRU eviction. */
  readonly generations: Set<number>
  /** Base-contract put() calls without a generation hold an explicit lease. */
  leases: number
}

function assertHash(payloadHash: string): void {
  if (typeof payloadHash !== 'string' || !IMAGE_HASH.test(payloadHash)) {
    throw new TypeError('image payloadHash must be 64 lowercase hexadecimal characters')
  }
}

function assertStoreKey(storeKey: string): void {
  if (typeof storeKey !== 'string' || !IMAGE_STORE_KEY.test(storeKey)) {
    throw new TypeError('image storeKey must be image:<kitty|iterm2>:<sha256>')
  }
}

function assertProtocol(protocol: string): asserts protocol is StoredImageProtocol {
  if (protocol !== 'kitty' && protocol !== 'iterm2') {
    throw new TypeError('image protocol must be kitty|iterm2; sixel is unsupported')
  }
}

function assertBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('image payload must be a Uint8Array')
  if (bytes.byteLength < 1) throw new RangeError('image payload must not be empty')
}

function assertGeneration(generation: number): void {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new TypeError(`image generation must be a non-negative integer, got ${generation}`)
  }
}

/** SHA-256 without importing node/crypto into the renderer layer. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = bytes.slice()
  const digest = await globalThis.crypto.subtle.digest('SHA-256', source)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

function keyFor(protocol: StoredImageProtocol, payloadHash: string): string {
  // The key is intentionally opaque to consumers, but stable inside one
  // process and safe to use in diagnostics/operation metadata.
  return `image:${protocol}:${payloadHash}`
}

/**
 * A bounded ImageStore implementation.  `#entries` is a private class field,
 * so JSON.stringify(store) cannot accidentally expose payload bytes.
 */
export class BoundedImageStore implements ImageStore {
  readonly maxBytes: number
  readonly maxEntries: number
  readonly maxEntryBytes: number

  #entries = new Map<string, Entry>()
  #bytes = 0
  #evictions = 0
  #rejections = 0

  constructor(options: ImageStoreOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_IMAGE_STORE_MAX_BYTES
    const maxEntries = options.maxEntries ?? DEFAULT_IMAGE_STORE_MAX_ENTRIES
    const maxEntryBytes = options.maxEntryBytes ?? Math.min(DEFAULT_IMAGE_STORE_MAX_ENTRY_BYTES, maxBytes)
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('image store maxBytes must be a positive integer')
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('image store maxEntries must be a positive integer')
    }
    if (!Number.isInteger(maxEntryBytes) || maxEntryBytes < 1 || maxEntryBytes > maxBytes) {
      throw new RangeError('image store maxEntryBytes must be a positive integer <= maxBytes')
    }
    this.maxBytes = maxBytes
    this.maxEntries = maxEntries
    this.maxEntryBytes = maxEntryBytes
  }

  /**
   * Store a defensive copy.  The optional generation is an additive runtime
   * seam: when present the put is retained by that generation; otherwise it
   * remains an unreferenced LRU cache entry until retained or evicted.
   */
  async put(
    payloadHash: string,
    bytes: Uint8Array,
    protocol: StoredImageProtocol,
    generation?: number,
  ): Promise<{ storeKey: string; bytes: number }> {
    try {
      assertHash(payloadHash)
      assertProtocol(protocol)
      assertBytes(bytes)
      if (generation !== undefined) assertGeneration(generation)
      const copy = bytes.slice()
      const actualHash = await sha256Hex(copy)
      if (actualHash !== payloadHash) throw new TypeError('image payload hash does not match payloadHash')
      if (copy.byteLength > this.maxEntryBytes) throw new RangeError('image payload exceeds per-entry image store budget')

      const storeKey = keyFor(protocol, payloadHash)
      const existing = this.#entries.get(storeKey)
      if (existing !== undefined) {
        if (existing.protocol !== protocol || existing.payloadHash !== payloadHash || existing.bytes !== copy.byteLength) {
          throw new TypeError('image store key metadata mismatch')
        }
        // Content-addressing makes the key collision-safe; compare the bytes
        // before accepting a malformed fake-store replacement.
        const existingHash = await sha256Hex(existing.payload)
        if (existingHash !== actualHash) throw new TypeError('image store entry hash mismatch')
        this.#touch(storeKey, existing)
        this.#retainEntry(existing, generation)
        return { storeKey, bytes: existing.bytes }
      }

      this.#ensureCapacity(copy.byteLength)
      const entry: Entry = {
        storeKey,
        payloadHash,
        protocol,
        bytes: copy.byteLength,
        payload: copy,
        generations: new Set<number>(),
        leases: 0,
      }
      this.#entries.set(storeKey, entry)
      this.#bytes += entry.bytes
      this.#retainEntry(entry, generation)
      return { storeKey, bytes: entry.bytes }
    } catch (error) {
      this.#rejections += 1
      throw error
    }
  }

  async get(storeKey: string): Promise<Uint8Array | null> {
    const entry = this.#entries.get(storeKey)
    if (entry === undefined) return null
    this.#touch(storeKey, entry)
    return entry.payload.slice()
  }

  /** Synchronous process-local peek used by patch byte planning. */
  getSync(storeKey: string): Uint8Array | null {
    const entry = this.#entries.get(storeKey)
    if (entry === undefined) return null
    this.#touch(storeKey, entry)
    return entry.payload.slice()
  }

  metadata(storeKey: string): ImageStoreMetadata | null {
    const entry = this.#entries.get(storeKey)
    if (entry === undefined) return null
    this.#touch(storeKey, entry)
    return {
      storeKey: entry.storeKey,
      payloadHash: entry.payloadHash,
      protocol: entry.protocol,
      bytes: entry.bytes,
    }
  }

  has(storeKey: string): boolean {
    return this.#entries.has(storeKey)
  }

  /** Retain one store key for a generation; repeated calls are idempotent. */
  retain(storeKey: string, generation: number): void {
    assertGeneration(generation)
    const entry = this.#entries.get(storeKey)
    if (entry === undefined) throw new RangeError(`unknown image storeKey '${storeKey}'`)
    if (!entry.generations.has(generation)) entry.generations.add(generation)
    this.#touch(storeKey, entry)
  }

  /** Release one unscoped lease; the entry becomes an LRU eviction candidate. */
  release(storeKey: string): void {
    const entry = this.#entries.get(storeKey)
    if (entry === undefined) return
    if (entry.leases > 0) entry.leases -= 1
  }

  /** Release one key's reference in one generation, leaving other keys intact. */
  releaseReference(storeKey: string, generation: number): void {
    assertGeneration(generation)
    const entry = this.#entries.get(storeKey)
    if (entry === undefined) return
    entry.generations.delete(generation)
    this.#evictIfUnreferenced(entry)
  }

  /**
   * Atomically replace one generation's complete reference set. Every desired
   * key is validated and retained before obsolete references can be evicted,
   * so a clear+re-upload transaction cannot lose generation-only payloads.
   */
  setGenerationReferences(generation: number, storeKeys: readonly string[]): void {
    assertGeneration(generation)
    if (!Array.isArray(storeKeys)) throw new TypeError('image generation storeKeys must be an array')
    const desired = new Map<string, Entry>()
    for (const storeKey of storeKeys) {
      assertStoreKey(storeKey)
      const entry = this.#entries.get(storeKey)
      if (entry === undefined) throw new RangeError(`unknown image storeKey '${storeKey}'`)
      desired.set(storeKey, entry)
    }
    for (const [storeKey, entry] of desired) {
      entry.generations.add(generation)
      this.#touch(storeKey, entry)
    }
    for (const entry of [...this.#entries.values()]) {
      if (desired.has(entry.storeKey)) continue
      entry.generations.delete(generation)
      this.#evictIfUnreferenced(entry)
    }
  }

  /**
   * Release a generation reference without disturbing other generations.
   * Entries with no remaining generation are evicted immediately.
   */
  releaseGeneration(generation: number): void {
    assertGeneration(generation)
    for (const entry of [...this.#entries.values()]) {
      entry.generations.delete(generation)
      this.#evictIfUnreferenced(entry)
    }
  }

  clearGeneration(generation: number): void {
    this.releaseGeneration(generation)
  }

  clear(): void {
    this.#entries.clear()
    this.#bytes = 0
  }

  stats(): ImageStoreStats {
    let referencedEntries = 0
    for (const entry of this.#entries.values()) {
      if (entry.leases > 0 || entry.generations.size > 0) referencedEntries += 1
    }
    return {
      entries: this.#entries.size,
      bytes: this.#bytes,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
      maxEntryBytes: this.maxEntryBytes,
      evictions: this.#evictions,
      rejections: this.#rejections,
      referencedEntries,
    }
  }

  #retainEntry(entry: Entry, generation: number | undefined): void {
    if (generation === undefined) entry.leases += 1
    else entry.generations.add(generation)
  }

  #touch(storeKey: string, entry: Entry): void {
    this.#entries.delete(storeKey)
    this.#entries.set(storeKey, entry)
  }

  #ensureCapacity(incomingBytes: number): void {
    while (
      (this.#entries.size >= this.maxEntries || this.#bytes + incomingBytes > this.maxBytes) &&
      this.#evictOldestUnreferenced()
    ) {
      // Keep evicting until both budgets fit or no safe victim remains.
    }
    if (this.#entries.size >= this.maxEntries || this.#bytes + incomingBytes > this.maxBytes) {
      throw new RangeError('image store capacity exceeded by referenced entries')
    }
  }

  #evictOldestUnreferenced(): boolean {
    for (const [storeKey, entry] of this.#entries) {
      if (entry.leases > 0 || entry.generations.size > 0) continue
      this.#entries.delete(storeKey)
      this.#bytes -= entry.bytes
      this.#evictions += 1
      return true
    }
    return false
  }

  #evictIfUnreferenced(entry: Entry): void {
    if (entry.leases > 0 || entry.generations.size > 0) return
    if (this.#entries.get(entry.storeKey) !== entry) return
    this.#entries.delete(entry.storeKey)
    this.#bytes -= entry.bytes
    this.#evictions += 1
  }
}

export function createImageStore(options: ImageStoreOptions = {}): BoundedImageStore {
  return new BoundedImageStore(options)
}

export function isImagePayloadHash(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_HASH.test(value)
}

export function isImageStoreKey(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_STORE_KEY.test(value)
}

export function validateStoredImageIdentity(
  storeKey: string,
  payloadHash: string,
  protocol: StoredImageProtocol,
): void {
  assertStoreKey(storeKey)
  assertHash(payloadHash)
  assertProtocol(protocol)
  const match = IMAGE_STORE_KEY.exec(storeKey) as RegExpExecArray
  if (match[1] !== protocol || match[2] !== payloadHash) {
    throw new TypeError('image storeKey/hash/protocol identity mismatch')
  }
}

export function validateImageProtocol(value: unknown): value is StoredImageProtocol {
  return value === 'kitty' || value === 'iterm2'
}
