/**
 * tui-v2 TerminalWriter (WP-03b, plan §5.6/§5.7).
 *
 * The single writer to the tty. It accepts only schema-checked `TerminalPatch`
 * values (`write`) and typed `TerminalControlOperation`s (`writeControl`); raw
 * unsanitized ANSI strings can never reach the stream — the sequence branch of
 * `writeControl` is gated on the `ansi.ts` trust registry
 * (`isTrustedControlSequence`), so only builder output passes.
 *
 * Design notes (spec mapping):
 *
 * - Commit watermark (§5.6 line ~789): patches carry
 *   `(generation, stateRevision, patchSeq)` and must be strictly newer than
 *   the accepted watermark (lexicographic: newer generation; else newer
 *   stateRevision; else strictly increasing patchSeq). Older/equal patches
 *   return `{ status: 'stale' }` and never touch the stream. The COMMITTED
 *   watermark only advances once the whole batch containing the patch has
 *   been flushed by the stream — a partial/failed write advances nothing.
 *   A patch with a newer generation is adopted: the writer's generation and
 *   both watermark baselines reset, so the first frame of a new generation
 *   is never stale (generation pinning via quiesce/resume stays the
 *   coordinator's tool).
 *
 * - Serialization & backpressure: at most one stream write is in flight.
 *   Jobs are encoded at enqueue time (order preserved by an encode chain),
 *   then merged FIFO into one buffer per write, capped at 1 MiB (a single
 *   oversize job, e.g. an image, forms its own buffer). Queued bytes are
 *   capped at 8 MiB; a new patch that would exceed the cap is rejected as
 *   stale and counted (control/query jobs are small and lifecycle-critical,
 *   so they are never dropped). A write is settled only when the stream's
 *   write callback fired AND — when `write()` returned false — a 'drain'
 *   event was observed.
 *
 * - Writer-op timeout (§5.7): each in-flight write has a 500 ms budget on the
 *   injected Clock. Expiry, a callback error or a synchronous write throw
 *   fails the whole batch with a `WriterError`, fails the writer
 *   (`failed-before-takeover` until the first write has settled,
 *   `failed-after-takeover` afterwards) and errors every queued job; failure
 *   is terminal for this writer instance (the coordinator replaces it).
 *
 * - Query lane (§5.6): query bytes are ordinary queued jobs carrying a 20 ms
 *   slot deadline — a query job that could not START its write within 20 ms
 *   of enqueue is dropped and counted (`query-slot-timeout`); the broker's
 *   own 150 ms/300 ms response budget still applies. The response waiter
 *   never occupies a write slot and never blocks frame/input writes.
 *   `writeControl`'s query branch re-validates: broker `isRegistered(token)`
 *   (rejects forged/copy tokens), token.generation === request.generation ===
 *   the operation generation, and the token was not seen before (retries use
 *   the broker's retransmit hook, which bypasses the duplicate check on
 *   purpose). `TerminalWriter.query()` is the only public token source; the
 *   optional `queryTokenSink` option hands the token to the stdin owner
 *   (WP-03b2) so it can route `query-response` events back to the broker —
 *   this is the designated token-distribution extension point.
 *
 * - quiesce/resume (§5.6): `quiesce()` blocks new patches AND controls,
 *   drains pending encodes + queue + the in-flight write, then returns a
 *   frozen barrier `{ generation, committedPatchSeq }` (patchSeq −1 when
 *   nothing committed this generation). Only the exact barrier object passes
 *   `resume()`: resuming with the barrier's generation continues the paused
 *   generation; resuming with a GREATER generation starts a new one and
 *   resets the watermark baselines (resize/takeover shape:
 *   quiesce → invalidate → resume). `invalidate()` clears the watermark
 *   baselines and the per-patch resource context so a full-redraw patch with
 *   restarted stateRevision/patchSeq is accepted; it does not resurrect a
 *   failed/stopped writer and does not drop queued jobs (callers quiesce
 *   first when they need the queue drained).
 *
 * - stop: blocks new work (`{ status: 'stopped' }`), settles queued jobs as
 *   stopped, waits for the in-flight write up to 500 ms (then destroys the
 *   stream), sends a best-effort cleanup bundle built from ansi builders
 *   (sync-output end, SGR/hyperlink reset, paste/focus/mouse off, kitty
 *   keyboard pop, cursor show, scroll-region reset — skipped with
 *   `preserveCursor` because the reset HOMES the cursor (xterm DECSTBM
 *   semantics) and an inline session parks the cursor below the frame;
 *   alt-screen exit unless preserveScreen) with its own 500 ms budget, then
 *   transitions to `stopped`. stop is idempotent: every call returns the
 *   same promise.
 *
 * Stats are a fixed set of bounded counters (`stats()`); no stdout bytes are
 * retained. All timers run on the injected `Clock` — no real timers exist in
 * this module.
 *
 * Image operations are now controlled by the process-local ImageStore:
 * upload validates hash/protocol before bytes leave the process, Kitty place /
 * delete / clear use the allowlisted APC builders, and iTerm2 upload is the
 * one inline display operation followed by a reference-only place marker.
 * image-place without an earlier upload is rejected.  Mode ops that are not ANSI-expressible or not in the §5.6 allowlist
 * (rawInput termios, wrapPending derived state, windowsDec9001,
 * modifyOtherKeys, osc133) encode zero bytes by contract.
 */
import { createHash } from 'node:crypto'
import type { Writable } from 'node:stream'

import type { Clock, SerializableValue } from '../model/schema.js'
import type {
  FrameResources,
  ImageStore,
  PatchOperation,
  TerminalModeSnapshot,
  TerminalPatch,
} from '../renderer/frame.js'
import { isImagePayloadHash, isImageStoreKey, validateStoredImageIdentity } from '../renderer/image-store.js'
import * as ansi from './ansi.js'
import { kittyImageId, kittyPlacementId } from './image-protocol.js'
import type { TerminalProfile } from './profile.js'
import {
  expectedReportForKind,
  type QueryRequest,
  type QueryResponse,
  type QueryToken,
  type TerminalQueryBroker,
} from './query.js'

// ---------------------------------------------------------------------------
// contract types (verbatim from plan §5.6; query/input types live in query.ts)
// ---------------------------------------------------------------------------

export type TerminalLifecycleOperation =
  | { kind: 'lifecycle'; action: 'enter-raw' | 'exit-raw' | 'enter-alt' | 'exit-alt' | 'mouse' | 'paste' | 'focus' | 'sync-output' | 'cursor'; enabled: boolean }
  | { kind: 'cursor-move'; delta: number }
  | { kind: 'clear'; scope: 'line' | 'from-cursor' | 'screen' }
  | { kind: 'title'; value: string }
  | { kind: 'progress'; state: 'none' | 'normal' | 'error' | 'paused'; value?: number }

export type TerminalControlOperation =
  | { kind: 'lifecycle'; operation: TerminalLifecycleOperation }
  | { kind: 'sequence'; sequence: ansi.ControlSequence; purpose: 'pi-compatible' | 'query-write' | 'cleanup' }
  | { kind: 'query'; request: QueryRequest; token: QueryToken }

export interface WriterError {
  code: string
  message: string
  generation: number
  recoverable: boolean
  details?: SerializableValue
}

export type WriteResult =
  | { status: 'written' | 'stale' | 'stopped'; bytes?: number; frameId?: string; stateRevision?: number; patchSeq?: number }
  | { status: 'error'; error: WriterError }

export interface WriterBarrier {
  generation: number
  committedPatchSeq: number
}

export interface TerminalWriter {
  write(patch: TerminalPatch): Promise<WriteResult>
  writeControl(operation: TerminalControlOperation, generation: number): Promise<WriteResult>
  query(request: QueryRequest): Promise<QueryResponse>
  quiesce(): Promise<WriterBarrier>
  resume(barrier: WriterBarrier, generation: number): void
  flush(): Promise<void>
  invalidate(): void
  stop(options?: { preserveScreen?: boolean; preserveCursor?: boolean }): Promise<void>
}

// ---------------------------------------------------------------------------
// implementation constants + types
// ---------------------------------------------------------------------------

export const WRITER_MAX_BATCH_BYTES = 1024 * 1024
export const WRITER_MAX_PENDING_BYTES = 8 * 1024 * 1024
export const WRITER_OP_TIMEOUT_MS = 500
export const WRITER_QUERY_SLOT_MS = 20
export const WRITER_STOP_SETTLE_MS = 500

export type TerminalLifecycleState =
  | 'created'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'stopped'
  | 'failed-before-takeover'
  | 'failed-after-takeover'

export interface TerminalWriterStats {
  readonly bytesWritten: number
  readonly framesWritten: number
  readonly controlsWritten: number
  readonly queriesWritten: number
  readonly writesCompleted: number
  readonly writesFailed: number
  readonly stalePatches: number
  readonly staleControls: number
  /** Patches rejected because the 8 MiB pending-bytes cap would be exceeded. */
  readonly droppedPatches: number
  readonly querySlotTimeouts: number
  readonly untrustedSequences: number
  readonly encodeErrors: number
  readonly totalWriteMs: number
  readonly maxBatchBytes: number
}

export interface TerminalWriterOptions {
  readonly stream: Writable
  readonly clock: Clock
  readonly profile: TerminalProfile
  readonly queryBroker?: TerminalQueryBroker
  readonly imageStore?: ImageStore
  /**
   * Token distribution hook (WP-03b2 input layer): called synchronously from
   * `query()` with the freshly registered token so the stdin owner can route
   * matching `query-response` events to `broker.accept(token, input)`.
   */
  readonly queryTokenSink?: (token: QueryToken, request: QueryRequest) => void
}

interface Watermark {
  generation: number
  stateRevision: number
  patchSeq: number
}

interface Job {
  readonly generation: number
  readonly encoded: string
  readonly bytes: number
  readonly patch?: TerminalPatch
  /** Clock time after which a queued query job must be dropped (§5.6 20 ms). */
  readonly queryDeadlineAt?: number
  /** Complete accepted image state after this patch, in deterministic order. */
  readonly imageReferences?: readonly string[]
  readonly resolve: (result: WriteResult) => void
}

/**
 * Outcome of the encode+enqueue phase: either an immediately-known result
 * (validation/cap rejection — nothing queued) or an enqueued job whose
 * promise settles when the write is flushed. The encode chain advances at
 * ENQUEUE time so later calls pipeline behind in-flight writes; only the
 * caller-visible promise waits for settlement.
 */
type EnqueueOutcome = { readonly inline: WriteResult; readonly settled?: undefined } | { readonly inline?: undefined; readonly settled: Promise<WriteResult> }

interface InFlight {
  readonly epoch: number
  readonly jobs: readonly Job[]
  readonly bytes: number
  readonly startedAt: number
  readonly timer: unknown
  needsDrain: boolean
  callbackSeen: boolean
  drainSeen: boolean
  settled: boolean
}

// ---------------------------------------------------------------------------
// validation helpers
// ---------------------------------------------------------------------------

function requireInt(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer in [${min}, ${max}]`)
  }
  return value
}

const MAX_COORD = 9999

// ---------------------------------------------------------------------------
// patch/control encoding (single fixed composition shared with DiffPlanner —
// patch.bytes MUST equal what this encoder produces)
// ---------------------------------------------------------------------------

export interface EncodeOperationsOptions {
  readonly imageStore?: ImageStore
  /** Profile is optional for legacy pure encoder callers; the writer supplies it. */
  readonly profile?: TerminalProfile
  readonly generation?: number
  /** Store keys already uploaded in the current writer generation. */
  readonly uploadedStoreKeys?: ReadonlySet<string>
}

export interface EncodedOperations {
  readonly encoded: string
  readonly bytes: number
  /** Complete image state after this operation list. */
  readonly imageReferences: readonly string[]
}

function encodeModeOperation(name: keyof TerminalModeSnapshot, value: unknown): string {
  const bool = (what: string): boolean => {
    if (typeof value !== 'boolean') throw new TypeError(`mode '${what}' expects a boolean value`)
    return value
  }
  switch (name) {
    case 'alternateScreen':
      return bool(name) ? ansi.decset(1049) : ansi.decrst(1049)
    case 'bracketedPaste':
      return bool(name) ? ansi.decset(2004) : ansi.decrst(2004)
    case 'syncOutput':
      return bool(name) ? ansi.syncOutputBegin() : ansi.syncOutputEnd()
    case 'autowrap':
      return bool(name) ? ansi.decset(7) : ansi.decrst(7)
    case 'cursorVisible':
      return bool(name) ? ansi.cursorShow() : ansi.cursorHide()
    case 'focusReporting':
      return bool(name) ? ansi.decset(1004) : ansi.decrst(1004)
    case 'kittyKeyboard':
      // Enable: push disambiguate (flags 1). Disable: pop every pushed entry
      // (pop beyond the stack depth is harmless per the protocol/VT oracle).
      return bool(name) ? ansi.kittyKeyboardPush(1) : ansi.kittyKeyboardPop(99)
    case 'mouse': {
      // Reset every tracking/encoding mode, then set the requested one:
      // deterministic for any transition (§5.5 mouse is not a boolean).
      const tracking: Record<string, number> = {
        'x10-1000': 1000,
        'normal-1002': 1002,
        'button-1002': 1002,
        'any-1003': 1003,
        'sgr-1006': 1006,
        'urxvt-1015': 1015,
      }
      if (typeof value !== 'string' || !(value === 'off' || value in tracking)) {
        throw new TypeError(`mode 'mouse' expects a MouseTrackingMode, got ${JSON.stringify(value)}`)
      }
      let out = ansi.decrst(1000) + ansi.decrst(1002) + ansi.decrst(1003) + ansi.decrst(1006) + ansi.decrst(1015)
      if (value !== 'off') out += ansi.decset(tracking[value] as number)
      return out
    }
    case 'cursorStyle':
      if (value === 'unknown') return '' // nothing safe to emit
      if (value !== 'block' && value !== 'underline' && value !== 'bar') {
        throw new TypeError(`mode 'cursorStyle' expects block|underline|bar|unknown`)
      }
      return ansi.cursorStyleShape(value)
    case 'scrollRegion': {
      const region = value as TerminalModeSnapshot['scrollRegion'] | null
      if (region === null || typeof region !== 'object') throw new TypeError(`mode 'scrollRegion' expects an object`)
      requireInt('scrollRegion.top', region.top, 0, MAX_COORD)
      requireInt('scrollRegion.bottom', region.bottom, 0, MAX_COORD)
      // 0-based frame rows → 1-based DECSTBM margins; a degenerate region
      // means "no region" (reset).
      if (region.top >= region.bottom) return ansi.resetScrollRegion()
      return ansi.setScrollRegion(region.top + 1, region.bottom + 1)
    }
    case 'title':
      if (value !== null && typeof value !== 'string') throw new TypeError(`mode 'title' expects a string|null`)
      return ansi.setTitle(value ?? '')
    case 'progress': {
      const p = value as TerminalModeSnapshot['progress'] | null
      if (p === null || typeof p !== 'object') throw new TypeError(`mode 'progress' expects an object`)
      if (p.value !== undefined) requireInt('progress.value', p.value, 0, 100)
      return ansi.progress(p.state, p.value)
    }
    case 'rawInput':
    case 'wrapPending':
    case 'windowsDec9001':
    case 'modifyOtherKeys':
    case 'osc133':
      // Not ANSI-expressible through the §5.6 builder allowlist: rawInput is
      // termios (input layer, WP-03b2), wrapPending is derived terminal
      // state, 9001/modifyOtherKeys/OSC 133 are not in the DEC allowlist.
      // These snapshot fields are compared by the VT oracle instead (§5.5).
      return ''
    default:
      throw new TypeError(`unsupported mode operation '${String(name)}'`)
  }
}

function validateImageUploadShape(op: Extract<PatchOperation, { kind: 'image-upload' }>): void {
  if (op.protocol !== 'kitty' && op.protocol !== 'iterm2') throw new TypeError('image-upload.protocol must be kitty|iterm2')
  if (!isImagePayloadHash(op.payloadHash)) throw new TypeError('image-upload.payloadHash must be a SHA-256 hex hash')
  validateStoredImageIdentity(op.storeKey, op.payloadHash, op.protocol)
}

function validateImageProfile(protocol: 'kitty' | 'iterm2', profile: TerminalProfile | undefined): void {
  if (profile !== undefined && profile.imageProtocol !== protocol) {
    throw new TypeError(`unsupported-image: profile imageProtocol '${String(profile.imageProtocol)}' cannot send ${protocol}`)
  }
}

function validateImagePlacementShape(placement: Extract<PatchOperation, { kind: 'image-place' }>['placement']): void {
  if (placement === null || typeof placement !== 'object') throw new TypeError('image-place.placement required')
  if (typeof placement.imageId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(placement.imageId)) {
    throw new TypeError('image-place.imageId must be 1-128 safe ASCII characters')
  }
  if (placement.protocol !== 'kitty' && placement.protocol !== 'iterm2') throw new TypeError('image-place.protocol must be kitty|iterm2')
  if (!isImagePayloadHash(placement.payloadHash)) throw new TypeError('image-place.payloadHash must be a SHA-256 hex hash')
  validateStoredImageIdentity(placement.storeKey, placement.payloadHash, placement.protocol)
  requireInt('image-place.x', placement.x, 0, MAX_COORD - 1)
  requireInt('image-place.y', placement.y, 0, MAX_COORD - 1)
  requireInt('image-place.width', placement.width, 1, MAX_COORD)
  requireInt('image-place.height', placement.height, 1, MAX_COORD)
}

function validateImageDeleteShape(op: Extract<PatchOperation, { kind: 'image-delete' }>): 'kitty' | 'iterm2' {
  if (!isImageStoreKey(op.storeKey)) throw new TypeError('image-delete.storeKey must be image:<kitty|iterm2>:<sha256>')
  const protocol = op.storeKey.split(':')[1]
  if (protocol !== 'kitty' && protocol !== 'iterm2') throw new TypeError('image-delete.storeKey protocol invalid')
  return protocol
}

/** Encode one operation list to bytes. Throws TypeError/RangeError on invalid input. */
export async function encodePatchOperations(
  operations: readonly PatchOperation[],
  options: EncodeOperationsOptions = {},
): Promise<EncodedOperations> {
  if (!Array.isArray(operations)) throw new TypeError('operations must be an array')
  const resolvedImages = new Map<number, string>()
  const uploaded = new Set(options.uploadedStoreKeys ?? [])
  const initialUploaded = new Set(uploaded)
  const store = options.imageStore

  for (let index = 0; index < operations.length; index++) {
    const op = operations[index] as PatchOperation
    if (op === null || typeof op !== 'object') throw new TypeError('operation must be an object')
    if (op.kind === 'image-upload') {
      validateImageUploadShape(op)
      validateImageProfile(op.protocol, options.profile)
      if (store === undefined) throw new TypeError('image-upload requires a configured ImageStore')
      const metadata = store.metadata?.(op.storeKey)
      if (metadata !== undefined && metadata !== null) {
        if (metadata.payloadHash !== op.payloadHash || metadata.protocol !== op.protocol) {
          throw new TypeError('image-upload: store metadata mismatch')
        }
      }
      const payload = await store.get(op.storeKey)
      if (payload === null) throw new TypeError(`image-upload: unknown storeKey '${op.storeKey}'`)
      const actualHash = createHash('sha256').update(payload).digest('hex')
      if (actualHash !== op.payloadHash) throw new TypeError('image-upload: payload hash mismatch')
      resolvedImages.set(index, Buffer.from(payload).toString('base64'))
      uploaded.add(op.storeKey)
    } else if (op.kind === 'image-place') {
      validateImagePlacementShape(op.placement)
      validateImageProfile(op.placement.protocol, options.profile)
      if (!uploaded.has(op.placement.storeKey)) {
        throw new TypeError(`image-place references storeKey before image-upload: '${op.placement.storeKey}'`)
      }
      const metadata = store?.metadata?.(op.placement.storeKey)
      if (
        metadata !== undefined && metadata !== null &&
        (metadata.protocol !== op.placement.protocol || metadata.payloadHash !== op.placement.payloadHash)
      ) throw new TypeError('image-place: store metadata mismatch')
    } else if (op.kind === 'image-delete') {
      validateImageDeleteShape(op)
      uploaded.delete(op.storeKey)
    } else if (op.kind === 'image-clear') {
      uploaded.clear()
    }
  }

  return encodePatchOperationsSync(operations, {
    resolvedImages,
    imageStore: store,
    profile: options.profile,
    uploadedStoreKeys: initialUploaded,
    generation: options.generation,
  })
}

export interface EncodeOperationsSyncOptions {
  /** Operation-index → base64 payload, pre-resolved by encodePatchOperations. */
  readonly resolvedImages?: ReadonlyMap<number, string>
  /** Optional process-local store for synchronous backend byte planning. */
  readonly imageStore?: ImageStore
  readonly profile?: TerminalProfile
  readonly uploadedStoreKeys?: ReadonlySet<string>
  readonly generation?: number
}

/**
 * Synchronous byte composition of an operation list — the single fixed
 * composition shared by the writer, DiffPlanner and the WP-03c screen
 * backends (whose `plan()` contract is synchronous). `image-upload` requires
 * a pre-resolved payload (otherwise it throws); every other operation encodes
 * inline. `patch.bytes` MUST equal what this encoder produces.
 */
export function encodePatchOperationsSync(
  operations: readonly PatchOperation[],
  options: EncodeOperationsSyncOptions = {},
): EncodedOperations {
  if (!Array.isArray(operations)) throw new TypeError('operations must be an array')
  let resources: FrameResources | null = null
  let out = ''
  const uploaded = new Set(options.uploadedStoreKeys ?? [])
  const placementByUploadIndex = new Map<number, Extract<PatchOperation, { kind: 'image-place' }>['placement']>()
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index] as PatchOperation
    if (operation.kind !== 'image-upload') continue
    for (let next = index + 1; next < operations.length; next++) {
      const candidate = operations[next] as PatchOperation
      if (candidate.kind === 'image-place' && candidate.placement.storeKey === operation.storeKey) {
        placementByUploadIndex.set(index, candidate.placement)
        break
      }
      if (candidate.kind === 'image-upload' || candidate.kind === 'image-delete' || candidate.kind === 'image-clear') break
    }
  }
  const kittyPlacementIds = new Map<number, string>()

  for (let opIndex = 0; opIndex < operations.length; opIndex++) {
    const op = operations[opIndex] as PatchOperation
    if (op === null || typeof op !== 'object') throw new TypeError('operation must be an object')
    switch (op.kind) {
      case 'resources': {
        const r = op.resources
        if (r === null || typeof r !== 'object' || !Array.isArray(r.styles) || !Array.isArray(r.hyperlinks)) {
          throw new TypeError('resources operation requires { styles: [], hyperlinks: [] }')
        }
        // Uniqueness/id validation happens inside encodeCells' indexById.
        ansi.encodeCells([], r)
        resources = r
        break
      }
      case 'write-cells': {
        requireInt('write-cells.x', op.x, 0, MAX_COORD - 1)
        requireInt('write-cells.y', op.y, 0, MAX_COORD - 1)
        if (!Array.isArray(op.cells)) throw new TypeError('write-cells.cells must be an array')
        if (resources === null) throw new TypeError('write-cells requires a preceding resources operation')
        if (op.cells.length === 0) break
        // A run must never start with (or consist only of) continuation
        // cells: no patch may update a continuation cell alone (§5.5).
        if ((op.cells[0] as { width: number }).width === 0) {
          throw new TypeError('write-cells run must not start with a width-0 continuation cell')
        }
        const encoded = ansi.encodeCells(op.cells, resources)
        out += ansi.cursorTo(op.y + 1, op.x + 1)
        out += encoded.sequence
        break
      }
      case 'erase': {
        requireInt('erase.x', op.x, 0, MAX_COORD - 1)
        requireInt('erase.y', op.y, 0, MAX_COORD - 1)
        requireInt('erase.width', op.width, 0, MAX_COORD)
        requireInt('erase.height', op.height, 0, MAX_COORD)
        for (let row = 0; row < op.height; row++) {
          out += ansi.cursorTo(op.y + row + 1, op.x + 1)
          out += ansi.eraseCharacters(op.width)
        }
        break
      }
      case 'scroll': {
        requireInt('scroll.top', op.top, 0, MAX_COORD - 1)
        requireInt('scroll.bottom', op.bottom, 0, MAX_COORD)
        requireInt('scroll.delta', op.delta, -MAX_COORD, MAX_COORD)
        if (op.top >= op.bottom) throw new RangeError('scroll requires top < bottom')
        if (op.delta === 0) break
        out += ansi.setScrollRegion(op.top + 1, op.bottom + 1)
        out += op.delta > 0 ? ansi.scrollUp(op.delta) : ansi.scrollDown(-op.delta)
        out += ansi.resetScrollRegion()
        break
      }
      case 'append': {
        // WP-07 inline initial paint: write at the CURRENT cursor row. CR
        // homes the column (and clears any pending wrap) because the shell's
        // cursor column at session start is unknown; the optional LF is the
        // append-only feed (at a full-height main-screen region bottom it
        // pushes the top line into scrollback — the only scroll primitive
        // inline mode uses).
        if (!Array.isArray(op.cells)) throw new TypeError('append.cells must be an array')
        if (resources === null) throw new TypeError('append requires a preceding resources operation')
        if (typeof op.feed !== 'boolean') throw new TypeError('append.feed must be boolean')
        if (op.cells.length === 0) throw new TypeError('append.cells must be a non-empty full row')
        if ((op.cells[0] as { width: number }).width === 0) {
          throw new TypeError('append row must not start with a width-0 continuation cell')
        }
        out += '\r'
        out += ansi.encodeCells(op.cells, resources).sequence
        if (op.feed) out += '\n'
        break
      }
      case 'line-feed': {
        // WP-07 inline scroll primitive: home to (y, col 1), then raw LFs.
        // Never DECSTBM/SU/SD (those never reach scrollback) and never ED 3.
        requireInt('line-feed.y', op.y, 0, MAX_COORD - 1)
        requireInt('line-feed.count', op.count, 0, MAX_COORD)
        if (op.count === 0) break
        out += ansi.cursorTo(op.y + 1, 1)
        out += '\n'.repeat(op.count)
        break
      }
      case 'cursor': {
        requireInt('cursor.x', op.x, 0, MAX_COORD - 1)
        requireInt('cursor.y', op.y, 0, MAX_COORD - 1)
        if (typeof op.visible !== 'boolean') throw new TypeError('cursor.visible must be boolean')
        out += ansi.cursorTo(op.y + 1, op.x + 1)
        out += op.visible ? ansi.cursorShow() : ansi.cursorHide()
        break
      }
      case 'mode':
        out += encodeModeOperation(op.name, op.value)
        break
      case 'image-upload': {
        validateImageUploadShape(op)
        validateImageProfile(op.protocol, options.profile)
        let base64 = options.resolvedImages?.get(opIndex)
        if (base64 === undefined && options.imageStore?.getSync !== undefined) {
          const payload = options.imageStore.getSync(op.storeKey)
          if (payload !== null) {
            const actualHash = createHash('sha256').update(payload).digest('hex')
            if (actualHash !== op.payloadHash) throw new TypeError('image-upload: payload hash mismatch')
            base64 = Buffer.from(payload).toString('base64')
          }
        }
        if (base64 === undefined) {
          throw new TypeError('image-upload requires a pre-resolved payload (use async encodePatchOperations)')
        }
        const metadata = options.imageStore?.metadata?.(op.storeKey)
        if (metadata !== undefined && metadata !== null && (metadata.payloadHash !== op.payloadHash || metadata.protocol !== op.protocol)) {
          throw new TypeError('image-upload: store metadata mismatch')
        }
        const placement = placementByUploadIndex.get(opIndex)
        out +=
          op.protocol === 'kitty'
            ? ansi.kittyImageUpload(kittyImageId(op.storeKey), base64)
            : ansi.iterm2Image({
                size: Buffer.byteLength(base64, 'base64'),
                ...(placement === undefined ? {} : {
                  width: placement.width,
                  height: placement.height,
                  name: Buffer.from(placement.imageId, 'utf8').toString('base64'),
                }),
                ...(placement === undefined ? { name: Buffer.from(op.storeKey, 'utf8').toString('base64') } : {}),
              }, base64)
        uploaded.add(op.storeKey)
        break
      }
      case 'image-place': {
        const p = op.placement
        validateImagePlacementShape(p)
        validateImageProfile(p.protocol, options.profile)
        if (!uploaded.has(p.storeKey)) {
          throw new TypeError(`image-place references storeKey before image-upload: '${p.storeKey}'`)
        }
        if (p.protocol === 'kitty') {
          // Kitty placement is reference-only: `i` owns the payload while `p`
          // is a stable placement identity recoverable by the byte oracle.
          const placementId = kittyPlacementId(p.imageId)
          const owner = kittyPlacementIds.get(placementId)
          if (owner !== undefined && owner !== p.imageId) {
            throw new TypeError(`Kitty placement id collision between '${owner}' and '${p.imageId}'`)
          }
          kittyPlacementIds.set(placementId, p.imageId)
          out += ansi.cursorTo(p.y + 1, p.x + 1)
          out += ansi.kittyImagePlacement(kittyImageId(p.storeKey), placementId, p.width, p.height)
        }
        // iTerm2 inline images are displayed at the cursor during upload; it
        // has no portable persistent placement reference. The planner places
        // the cursor before image-upload and this op remains a validated
        // reference-only marker (zero additional bytes).
        break
      }
      case 'image-delete': {
        const imageProtocol = validateImageDeleteShape(op)
        const canSendKittyDelete = imageProtocol === 'kitty' &&
          (options.profile?.imageProtocol === 'kitty' || options.profile === undefined)
        if (canSendKittyDelete) out += ansi.kittyImageDelete(kittyImageId(op.storeKey))
        uploaded.delete(op.storeKey)
        break
      }
      case 'image-clear':
        if (options.profile?.imageProtocol === 'kitty' || options.profile === undefined) out += ansi.kittyImageClear()
        uploaded.clear()
        break
      default:
        throw new TypeError(`unsupported patch operation '${String((op as { kind?: unknown }).kind)}'`)
    }
  }

  return {
    encoded: out,
    bytes: Buffer.byteLength(out, 'utf8'),
    imageReferences: [...uploaded],
  }
}

/** Encode a TerminalLifecycleOperation (fixed mapping, ansi builders only). */
export function encodeLifecycleOperation(operation: TerminalLifecycleOperation): string {
  if (operation === null || typeof operation !== 'object') throw new TypeError('lifecycle operation must be an object')
  switch (operation.kind) {
    case 'lifecycle': {
      if (typeof operation.enabled !== 'boolean') throw new TypeError('lifecycle.enabled must be boolean')
      switch (operation.action) {
        case 'enter-raw':
        case 'exit-raw':
          // termios state, not ANSI; the WP-03b2 input layer owns it.
          return ''
        case 'enter-alt':
          return operation.enabled ? ansi.decset(1049) : ansi.decrst(1049)
        case 'exit-alt':
          return operation.enabled ? ansi.decrst(1049) : ''
        case 'mouse':
          return operation.enabled
            ? ansi.decset(1002) + ansi.decset(1006)
            : ansi.decrst(1000) + ansi.decrst(1002) + ansi.decrst(1003) + ansi.decrst(1006) + ansi.decrst(1015)
        case 'paste':
          return operation.enabled ? ansi.decset(2004) : ansi.decrst(2004)
        case 'focus':
          return operation.enabled ? ansi.decset(1004) : ansi.decrst(1004)
        case 'sync-output':
          return operation.enabled ? ansi.syncOutputBegin() : ansi.syncOutputEnd()
        case 'cursor':
          return operation.enabled ? ansi.cursorShow() : ansi.cursorHide()
        default:
          throw new TypeError(`unsupported lifecycle action '${String((operation as { action?: unknown }).action)}'`)
      }
    }
    case 'cursor-move': {
      requireInt('cursor-move.delta', operation.delta, -MAX_COORD, MAX_COORD)
      // Positive delta moves DOWN (CSI B), negative moves UP (CSI A).
      if (operation.delta > 0) return ansi.cursorDown(operation.delta)
      if (operation.delta < 0) return ansi.cursorUp(-operation.delta)
      return ''
    }
    case 'clear':
      switch (operation.scope) {
        case 'line':
          return ansi.eraseInLine(2)
        case 'from-cursor':
          return ansi.eraseInDisplay(0)
        case 'screen':
          return ansi.eraseInDisplay(2)
        default:
          throw new TypeError(`unsupported clear scope '${String((operation as { scope?: unknown }).scope)}'`)
      }
    case 'title':
      if (typeof operation.value !== 'string') throw new TypeError('title.value must be a string')
      return ansi.setTitle(operation.value)
    case 'progress': {
      if (operation.value !== undefined) requireInt('progress.value', operation.value, 0, 100)
      return ansi.progress(operation.state, operation.value)
    }
    default:
      throw new TypeError(`unsupported lifecycle operation '${String((operation as { kind?: unknown }).kind)}'`)
  }
}

/** Fixed query-write bytes per QueryKind (ansi.ts builders, one per kind). */
function queryBytesForKind(kind: QueryRequest['kind']): ansi.ControlSequence {
  switch (kind) {
    case 'cursor':
      return ansi.queryCursorReport()
    case 'size':
      return ansi.queryTextAreaSize()
    case 'cell-size':
      return ansi.queryCellSize()
    case 'version':
      return ansi.queryXtVersion()
    case 'capability':
      return ansi.queryDeviceAttributes()
    case 'color':
      return ansi.queryBackgroundColor()
    case 'kitty-keyboard':
      return ansi.queryKittyKeyboard()
    case 'focus':
      return ansi.queryFocusReportingMode()
  }
}

// ---------------------------------------------------------------------------
// writer implementation
// ---------------------------------------------------------------------------

class TerminalWriterImpl implements TerminalWriter {
  private readonly stream: Writable
  private readonly clock: Clock
  private readonly profile: TerminalProfile
  private readonly broker: TerminalQueryBroker | undefined
  private readonly imageStore: ImageStore | undefined
  /** Store keys known to be uploaded by accepted (queued or flushed) patches. */
  private readonly uploadedImages = new Set<string>()
  /** Store keys referenced by the last successfully flushed patch. */
  private readonly committedImageReferences = new Set<string>()
  private readonly queryTokenSink: TerminalWriterOptions['queryTokenSink']

  private state: TerminalLifecycleState = 'created'
  private currentGeneration = 0
  /** Last successfully flushed patch triple. */
  private committed: Watermark = { generation: 0, stateRevision: -1, patchSeq: -1 }
  /** Max of committed + queued (and reserved-encoding) patch triples. */
  private accepted: Watermark = { generation: 0, stateRevision: -1, patchSeq: -1 }

  private queue: Job[] = []
  private pendingBytes = 0
  private inFlight: InFlight | null = null
  private writeEpoch = 0
  private quiesced = false
  private stopPromise: Promise<void> | null = null
  private readonly issuedBarriers = new WeakSet<object>()
  private latestBarrier: WriterBarrier | null = null
  private readonly seenQueryTokens = new WeakSet<object>()
  private quiescenceWaiters: Array<() => void> = []
  private encodeChain: Promise<unknown> = Promise.resolve()
  /** Set once the first write has settled — the tty has been taken over. */
  private hasTakenOver = false

  private readonly counters = {
    bytesWritten: 0,
    framesWritten: 0,
    controlsWritten: 0,
    queriesWritten: 0,
    writesCompleted: 0,
    writesFailed: 0,
    stalePatches: 0,
    staleControls: 0,
    droppedPatches: 0,
    querySlotTimeouts: 0,
    untrustedSequences: 0,
    encodeErrors: 0,
    totalWriteMs: 0,
    maxBatchBytes: 0,
  }

  constructor(options: TerminalWriterOptions) {
    this.stream = options.stream
    this.clock = options.clock
    this.profile = options.profile
    this.broker = options.queryBroker
    this.imageStore = options.imageStore
    this.queryTokenSink = options.queryTokenSink
    // The writer owns the stream's error surface: a stream 'error' without a
    // listener would crash the process. Both the write callback and this
    // handler may observe the same failure; settlement is guarded.
    this.stream.on('error', (error: Error) => this.onStreamError(error))
  }

  // ------------------------------------------------------------------ state

  lifecycleState(): TerminalLifecycleState {
    return this.state
  }

  stats(): TerminalWriterStats {
    return { ...this.counters }
  }

  private errorResult(code: string, message: string, generation: number, recoverable: boolean): WriteResult {
    return { status: 'error', error: { code, message, generation, recoverable } }
  }

  private blockedResult(): WriteResult | null {
    if (this.state === 'stopping' || this.state === 'stopped') return { status: 'stopped' }
    if (this.state === 'failed-before-takeover' || this.state === 'failed-after-takeover') {
      return this.errorResult('writer-failed', `writer is in terminal state ${this.state}`, this.currentGeneration, false)
    }
    return null
  }

  private adoptGeneration(generation: number): void {
    if (generation > this.currentGeneration) {
      // A newer generation resets both watermark baselines: revision/seq
      // lineage restarts per generation (§5.6).
      this.currentGeneration = generation
      this.committed = { generation, stateRevision: -1, patchSeq: -1 }
      this.accepted = { generation, stateRevision: -1, patchSeq: -1 }
      this.uploadedImages.clear()
      this.committedImageReferences.clear()
      this.imageStore?.clearGeneration(generation - 1)
    }
  }

  // ------------------------------------------------------------------ write

  write(patch: TerminalPatch): Promise<WriteResult> {
    const blocked = this.blockedResult()
    if (blocked !== null) return Promise.resolve(blocked)
    if (this.quiesced) {
      this.counters.stalePatches += 1
      return Promise.resolve({ status: 'stale' })
    }

    // --- synchronous shape + watermark validation (rejects never burn seq) ---
    if (patch === null || typeof patch !== 'object') {
      return Promise.resolve(this.errorResult('invalid-patch', 'patch must be an object', this.currentGeneration, false))
    }
    const generation = patch.generation
    if (typeof patch.frameId !== 'string' || patch.frameId === '') {
      return Promise.resolve(this.errorResult('invalid-patch', 'patch.frameId must be a non-empty string', this.currentGeneration, false))
    }
    if (
      !Number.isInteger(generation) ||
      (generation as number) < 0 ||
      !Number.isInteger(patch.stateRevision) ||
      patch.stateRevision < 0 ||
      !Number.isInteger(patch.patchSeq) ||
      patch.patchSeq < 0 ||
      !Number.isInteger(patch.bytes) ||
      patch.bytes < 0 ||
      typeof patch.fullRedraw !== 'boolean'
    ) {
      return Promise.resolve(this.errorResult('invalid-patch', 'patch scalar fields failed validation', this.currentGeneration, false))
    }
    if ((generation as number) < this.currentGeneration) {
      this.counters.stalePatches += 1
      return Promise.resolve({ status: 'stale' })
    }
    this.adoptGeneration(generation as number)
    const triple: Watermark = { generation: generation as number, stateRevision: patch.stateRevision, patchSeq: patch.patchSeq }
    if (!isNewerWatermark(triple, this.accepted)) {
      // Older stateRevision, or non-increasing patchSeq within one revision.
      this.counters.stalePatches += 1
      return Promise.resolve({ status: 'stale' })
    }
    // Reserve the watermark slot synchronously so concurrent write() calls
    // stay ordered; a failed encode burns the slot (callers resend with a
    // new revision/seq, matching the DiffPlanner contract).
    this.accepted = triple

    return this.enqueueSerialized(async (): Promise<EnqueueOutcome> => {
      let encoded: EncodedOperations
      try {
        encoded = await encodePatchOperations(patch.operations, {
          imageStore: this.imageStore,
          profile: this.profile,
          generation: triple.generation,
          uploadedStoreKeys: this.uploadedImages,
        })
      } catch (error) {
        this.counters.encodeErrors += 1
        return { inline: this.errorResult('invalid-patch', `patch encoding failed: ${messageOf(error)}`, triple.generation, false) }
      }
      if (encoded.bytes !== patch.bytes) {
        this.counters.encodeErrors += 1
        return {
          inline: this.errorResult(
            'patch-bytes-mismatch',
            `patch.bytes ${patch.bytes} !== encoded bytes ${encoded.bytes}`,
            triple.generation,
            false,
          ),
        }
      }
      if (this.pendingBytes + encoded.bytes > WRITER_MAX_PENDING_BYTES) {
        // Backpressure overflow: the patch is droppable by contract (a newer
        // frame supersedes it); counted, never written.
        this.counters.droppedPatches += 1
        return { inline: { status: 'stale' } }
      }
      // Reserve the complete logical image state while the job is queued;
      // process-local generation references are committed only after flush.
      this.uploadedImages.clear()
      for (const storeKey of encoded.imageReferences) this.uploadedImages.add(storeKey)
      return this.enqueueJob({
        generation: triple.generation,
        encoded: encoded.encoded,
        bytes: encoded.bytes,
        patch,
        imageReferences: encoded.imageReferences,
      })
    })
  }

  // ------------------------------------------------------------ writeControl

  writeControl(operation: TerminalControlOperation, generation: number): Promise<WriteResult> {
    const blocked = this.blockedResult()
    if (blocked !== null) return Promise.resolve(blocked)
    if (this.quiesced) {
      this.counters.staleControls += 1
      return Promise.resolve({ status: 'stale' })
    }
    if (operation === null || typeof operation !== 'object' || !Number.isInteger(generation) || generation < 0) {
      return Promise.resolve(this.errorResult('invalid-control-operation', 'malformed control operation', this.currentGeneration, false))
    }
    if (generation < this.currentGeneration) {
      this.counters.staleControls += 1
      return Promise.resolve({ status: 'stale' })
    }
    this.adoptGeneration(generation)

    let jobSpec: { encoded: string; bytes: number; queryDeadlineAt?: number }
    switch (operation.kind) {
      case 'lifecycle': {
        let encoded: string
        try {
          encoded = encodeLifecycleOperation(operation.operation)
        } catch (error) {
          this.counters.encodeErrors += 1
          return Promise.resolve(this.errorResult('invalid-control-operation', messageOf(error), generation, false))
        }
        jobSpec = { encoded, bytes: Buffer.byteLength(encoded, 'utf8') }
        this.counters.controlsWritten += 1
        break
      }
      case 'sequence': {
        const sequence: unknown = operation.sequence
        if (typeof sequence !== 'string' || !ansi.isTrustedControlSequence(sequence)) {
          // The brand is compile-time only; the ansi.ts trust registry is the
          // runtime gate. Forged/raw strings end here (§5.6).
          this.counters.untrustedSequences += 1
          return Promise.resolve(this.errorResult('untrusted-sequence', 'sequence did not come from terminal/ansi.ts builders', generation, false))
        }
        if (operation.purpose !== 'pi-compatible' && operation.purpose !== 'query-write' && operation.purpose !== 'cleanup') {
          return Promise.resolve(this.errorResult('invalid-control-operation', `unknown sequence purpose '${String(operation.purpose)}'`, generation, false))
        }
        jobSpec = { encoded: sequence, bytes: Buffer.byteLength(sequence, 'utf8') }
        this.counters.controlsWritten += 1
        break
      }
      case 'query': {
        const check = this.validateQueryBranch(operation, generation)
        if (check !== null) return Promise.resolve(check)
        const encoded = queryBytesForKind(operation.request.kind)
        jobSpec = { encoded, bytes: Buffer.byteLength(encoded, 'utf8'), queryDeadlineAt: this.clock.now() + WRITER_QUERY_SLOT_MS }
        this.seenQueryTokens.add(operation.token)
        this.counters.queriesWritten += 1
        break
      }
      default:
        return Promise.resolve(this.errorResult('invalid-control-operation', `unknown control operation kind '${String((operation as { kind?: unknown }).kind)}'`, generation, false))
    }

    return this.enqueueSerialized(() =>
      this.enqueueJob({
        generation,
        encoded: jobSpec.encoded,
        bytes: jobSpec.bytes,
        queryDeadlineAt: jobSpec.queryDeadlineAt,
      }),
    )
  }

  /** Returns null when the query branch is valid, else the rejection result. */
  private validateQueryBranch(operation: { request: QueryRequest; token: QueryToken }, generation: number): WriteResult | null {
    if (this.broker === undefined) {
      return this.errorResult('query-disabled', 'no QueryBroker configured', generation, false)
    }
    const { request, token } = operation
    if (request === null || typeof request !== 'object' || token === null || typeof token !== 'object') {
      return this.errorResult('invalid-control-operation', 'query branch requires { request, token }', generation, false)
    }
    if (!this.broker.isRegistered(token)) {
      // Unregistered, cancelled, settled — or a forged field-copy object.
      return this.errorResult('unregistered-query-token', 'query token is not registered with the broker', generation, false)
    }
    if (token.generation !== request.generation || request.generation !== generation || token.kind !== request.kind) {
      // Same-generation mismatch (§5.6): never send.
      this.counters.staleControls += 1
      return { status: 'stale' }
    }
    if (this.seenQueryTokens.has(token)) {
      // Duplicate request for one token. Broker retries bypass this check.
      this.counters.staleControls += 1
      return { status: 'stale' }
    }
    if (request.expected !== expectedReportForKind(request.kind)) {
      return this.errorResult('invalid-control-operation', 'query kind/expected mismatch', generation, false)
    }
    return null
  }

  // ------------------------------------------------------------------ query

  query(request: QueryRequest): Promise<QueryResponse> {
    if (this.broker === undefined) {
      return Promise.reject(new Error('query disabled: no QueryBroker configured'))
    }
    const broker = this.broker
    const hooks = {
      retransmit: (token: QueryToken, req: QueryRequest): void => {
        // Broker-driven retry: bypasses the duplicate-token check, still a
        // bounded 20 ms slot job; dropped silently when the writer is down
        // (the broker's own deadline settles the waiter).
        if (this.state !== 'created' && this.state !== 'starting' && this.state !== 'active') return
        void this.enqueueSerialized(() =>
          this.enqueueJob({
            generation: req.generation,
            encoded: queryBytesForKind(req.kind),
            bytes: Buffer.byteLength(queryBytesForKind(req.kind), 'utf8'),
            queryDeadlineAt: this.clock.now() + WRITER_QUERY_SLOT_MS,
          }),
        ).then(() => undefined, () => undefined)
      },
    }
    const { token, response } = broker.begin(request, hooks)
    this.queryTokenSink?.(token, request)
    void this.writeControl({ kind: 'query', request, token }, request.generation).then((result) => {
      if (result.status !== 'written') broker.cancel(token)
    })
    return response
  }

  // ------------------------------------------------------- quiesce/resume/…

  async quiesce(): Promise<WriterBarrier> {
    this.quiesced = true
    // Drain encodes submitted before this call, then the queue + in-flight.
    const chain = this.encodeChain
    await chain.then(undefined, () => undefined)
    await this.waitQuiescent()
    const barrier: WriterBarrier = Object.freeze({
      generation: this.currentGeneration,
      committedPatchSeq: this.committed.patchSeq,
    })
    this.issuedBarriers.add(barrier)
    this.latestBarrier = barrier
    return barrier
  }

  resume(barrier: WriterBarrier, generation: number): void {
    if (!this.issuedBarriers.has(barrier) || barrier !== this.latestBarrier) {
      throw new TypeError('resume: barrier was not issued by the latest quiesce()')
    }
    if (!Number.isInteger(generation) || generation < barrier.generation) {
      // Rule (§5.6 "generation 必须匹配或递增"): resuming with the barrier's
      // generation continues the paused generation; a greater generation
      // starts a new one and resets the watermark baselines.
      throw new RangeError(`resume: generation ${generation} < barrier generation ${barrier.generation}`)
    }
    if (generation > this.currentGeneration) this.adoptGeneration(generation)
    this.quiesced = false
    this.pump()
  }

  async flush(): Promise<void> {
    const chain = this.encodeChain
    await chain.then(undefined, () => undefined)
    await this.waitQuiescent()
  }

  invalidate(): void {
    // Called between quiesce and resume on resize/takeover: the next patch
    // is a full redraw whose stateRevision/patchSeq restart from scratch, so
    // the watermark baselines must reset or it would be rejected as stale.
    // Does not touch the queue, in-flight writes, stats or the terminal
    // failure state (a failed writer is replaced, not invalidated).
    this.committed = { generation: this.currentGeneration, stateRevision: -1, patchSeq: -1 }
    this.accepted = { generation: this.currentGeneration, stateRevision: -1, patchSeq: -1 }
  }

  stop(options: { preserveScreen?: boolean; preserveCursor?: boolean } = {}): Promise<void> {
    // Idempotent: repeated stop/signal converges on the same promise (§5.7).
    if (this.stopPromise !== null) return this.stopPromise
    this.stopPromise = this.doStop(options)
    return this.stopPromise
  }

  private async doStop(options: { preserveScreen?: boolean; preserveCursor?: boolean }): Promise<void> {
    if (this.state !== 'failed-before-takeover' && this.state !== 'failed-after-takeover') {
      this.state = 'stopping'
    }
    this.quiesced = true
    // New work is blocked by blockedResult(); queued jobs can never run now.
    const queued = this.queue
    this.queue = []
    this.pendingBytes = 0
    for (const job of queued) job.resolve({ status: 'stopped' })
    // Wait for the in-flight write to settle; on timeout destroy the stream
    // (§5.7: stop blocks new patches, then waits or destroys by deadline).
    if (this.inFlight !== null) {
      await this.withTimeout(WRITER_STOP_SETTLE_MS, () => this.inFlight === null)
      if (this.inFlight !== null) {
        this.failInFlight('write-timeout', 'stop: in-flight write did not settle before the deadline')
        this.destroyStream()
      }
    }
    // Best-effort cleanup bundle from ansi builders only (§5.6 cleanup goes
    // through the same writer; the coordinator may send richer cleanup first).
    await this.writeCleanupBundle(options.preserveScreen === true, options.preserveCursor === true)
    if (this.state !== 'failed-before-takeover' && this.state !== 'failed-after-takeover') {
      this.state = 'stopped'
    }
    this.notifyQuiescence()
  }

  // -------------------------------------------------------------- internals

  /** Serialize encode+enqueue so job order always matches call order. */
  private enqueueSerialized(prepare: () => EnqueueOutcome | Promise<EnqueueOutcome>): Promise<WriteResult> {
    // The chain advances once the job is ENQUEUED (or rejected inline); the
    // caller-visible promise settles only when the write has been flushed.
    const step: Promise<EnqueueOutcome> = this.encodeChain.then(prepare, prepare)
    this.encodeChain = step.then(
      () => undefined,
      () => undefined,
    )
    return step.then((outcome) => (outcome.settled !== undefined ? outcome.settled : outcome.inline as WriteResult))
  }

  private enqueueJob(job: Omit<Job, 'resolve'>): EnqueueOutcome {
    if (this.state === 'stopping' || this.state === 'stopped') return { inline: { status: 'stopped' } }
    const settled = new Promise<WriteResult>((resolve) => {
      this.queue.push({ ...job, resolve })
      this.pendingBytes += job.bytes
      this.pump()
    })
    return { settled }
  }

  private pump(): void {
    if (this.inFlight !== null) return
    if (this.state === 'stopping' || this.state === 'stopped') return
    if (this.state === 'failed-before-takeover' || this.state === 'failed-after-takeover') {
      const queued = this.queue
      this.queue = []
      this.pendingBytes = 0
      for (const job of queued) {
        job.resolve(this.errorResult('writer-failed', `writer is in terminal state ${this.state}`, job.generation, false))
      }
      this.notifyQuiescence()
      return
    }

    // Query slot sweep: a query that could not start its write within 20 ms
    // of enqueue is dropped; the response waiter is unaffected (§5.6).
    const now = this.clock.now()
    const survivors: Job[] = []
    for (const job of this.queue) {
      if (job.queryDeadlineAt !== undefined && job.queryDeadlineAt <= now) {
        this.counters.querySlotTimeouts += 1
        job.resolve(this.errorResult('query-slot-timeout', `query write slot exceeded ${WRITER_QUERY_SLOT_MS} ms`, job.generation, true))
      } else {
        survivors.push(job)
      }
    }
    if (survivors.length !== this.queue.length) {
      this.queue = survivors
      this.pendingBytes = survivors.reduce((sum, job) => sum + job.bytes, 0)
    }

    if (this.queue.length === 0) {
      this.notifyQuiescence()
      return
    }

    // Merge FIFO into one bounded buffer; a single oversize job stands alone.
    const jobs: Job[] = []
    let bytes = 0
    while (this.queue.length > 0) {
      const head = this.queue[0] as Job
      if (jobs.length > 0 && bytes + head.bytes > WRITER_MAX_BATCH_BYTES) break
      jobs.push(head)
      bytes += head.bytes
      this.queue.shift()
    }
    this.pendingBytes -= bytes
    if (bytes > this.counters.maxBatchBytes) this.counters.maxBatchBytes = bytes
    const buffer = jobs.map((job) => job.encoded).join('')
    this.startWrite(jobs, buffer, bytes)
  }

  private startWrite(jobs: readonly Job[], buffer: string, bytes: number): void {
    if (this.state === 'created') this.state = 'starting'
    this.writeEpoch += 1
    const epoch = this.writeEpoch
    const flight: InFlight = {
      epoch,
      jobs,
      bytes,
      startedAt: this.clock.now(),
      timer: this.clock.setTimeout(() => this.onWriteTimeout(epoch), WRITER_OP_TIMEOUT_MS),
      needsDrain: false,
      callbackSeen: false,
      drainSeen: false,
      settled: false,
    }
    this.inFlight = flight
    let ok = true
    try {
      ok = this.stream.write(buffer, (error?: Error | null) => this.onWriteCallback(epoch, error ?? null))
    } catch (error) {
      this.onWriteCallback(epoch, error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (!ok) {
      // Backpressure: settle requires the write callback AND a drain event.
      flight.needsDrain = true
      this.stream.once('drain', () => {
        if (this.inFlight?.epoch === epoch) {
          flight.drainSeen = true
          this.checkSettled(flight)
        }
      })
    }
  }

  private onWriteCallback(epoch: number, error: Error | null): void {
    const flight = this.inFlight
    if (flight === null || flight.epoch !== epoch || flight.settled) return
    if (error !== null) {
      this.failInFlight('write-failed', `stream write failed: ${error.message}`)
      return
    }
    flight.callbackSeen = true
    this.checkSettled(flight)
  }

  private onWriteTimeout(epoch: number): void {
    const flight = this.inFlight
    if (flight === null || flight.epoch !== epoch || flight.settled) return
    this.failInFlight('write-timeout', `write callback did not arrive within ${WRITER_OP_TIMEOUT_MS} ms`)
    this.destroyStream()
  }

  private checkSettled(flight: InFlight): void {
    if (flight.settled) return
    if (!flight.callbackSeen) return
    if (flight.needsDrain && !flight.drainSeen) return
    flight.settled = true
    this.clock.clearTimeout(flight.timer)
    this.counters.writesCompleted += 1
    this.counters.bytesWritten += flight.bytes
    this.counters.totalWriteMs += Math.max(0, this.clock.now() - flight.startedAt)
    this.inFlight = null
    // A merged write may contain several image patches. Apply only the final
    // reference snapshot per generation after the complete batch is flushed;
    // clearing an intermediate snapshot must never evict a key needed by a
    // later clear+re-upload in the same write.
    const finalImageReferences = new Map<number, readonly string[]>()
    for (const job of flight.jobs) {
      if (job.patch !== undefined && job.imageReferences !== undefined) {
        finalImageReferences.set(job.generation, job.imageReferences)
      }
    }
    for (const generation of [...finalImageReferences.keys()].sort((a, b) => b - a)) {
      const references = finalImageReferences.get(generation) as readonly string[]
      if (this.imageStore?.setGenerationReferences !== undefined) {
        this.imageStore.setGenerationReferences(generation, references)
      } else {
        this.imageStore?.clearGeneration(generation)
        for (const storeKey of references) this.imageStore?.retain?.(storeKey, generation)
      }
      if (generation === this.currentGeneration) {
        this.committedImageReferences.clear()
        for (const storeKey of references) this.committedImageReferences.add(storeKey)
      }
    }
    for (const job of flight.jobs) {
      if (job.patch !== undefined) {
        // Watermark advances only now: the whole batch containing the patch
        // has been flushed (§5.6 partial-write rule).
        this.committed = {
          generation: job.generation,
          stateRevision: job.patch.stateRevision,
          patchSeq: job.patch.patchSeq,
        }
        this.counters.framesWritten += 1
        job.resolve({
          status: 'written',
          bytes: job.bytes,
          frameId: job.patch.frameId,
          stateRevision: job.patch.stateRevision,
          patchSeq: job.patch.patchSeq,
        })
      } else {
        job.resolve({ status: 'written', bytes: job.bytes })
      }
    }
    if (this.state === 'starting') this.state = 'active'
    this.hasTakenOver = true
    this.notifyQuiescence()
    // Re-pump on a microtask so synchronous fake streams cannot build stack.
    queueMicrotask(() => this.pump())
  }

  /** Stream 'error' events (the write callback may also observe the failure). */
  private onStreamError(error: Error): void {
    if (this.state === 'stopped' || this.state === 'stopping') return
    if (this.state === 'failed-before-takeover' || this.state === 'failed-after-takeover') return
    if (this.inFlight !== null) {
      this.failInFlight('write-failed', `stream error: ${error.message}`)
      return
    }
    // No write in flight: the stream is still broken — fail the writer.
    this.counters.writesFailed += 1
    this.state = this.hasTakenOver ? 'failed-after-takeover' : 'failed-before-takeover'
    const queued = this.queue
    this.queue = []
    this.pendingBytes = 0
    for (const job of queued) {
      job.resolve(this.errorResult('writer-failed', `writer is in terminal state ${this.state}`, job.generation, false))
    }
    this.notifyQuiescence()
  }

  private failInFlight(code: string, message: string): void {
    const flight = this.inFlight
    if (flight === null || flight.settled) return
    flight.settled = true
    this.clock.clearTimeout(flight.timer)
    this.inFlight = null
    this.counters.writesFailed += 1
    this.state = this.hasTakenOver ? 'failed-after-takeover' : 'failed-before-takeover'
    for (const job of flight.jobs) {
      job.resolve(this.errorResult(code, message, job.generation, false))
    }
    // The watermark stays put; queued jobs can never run on a broken stream.
    const queued = this.queue
    this.queue = []
    this.pendingBytes = 0
    for (const job of queued) {
      job.resolve(this.errorResult('writer-failed', `writer is in terminal state ${this.state}`, job.generation, false))
    }
    this.notifyQuiescence()
  }

  private async writeCleanupBundle(preserveScreen: boolean, preserveCursor: boolean): Promise<void> {
    if ((this.stream as { destroyed?: boolean }).destroyed === true) return
    let bundle =
      (this.uploadedImages.size > 0 && this.profile.imageProtocol === 'kitty' ? ansi.kittyImageClear() : '') +
      ansi.syncOutputEnd() +
      ansi.sgrReset() +
      ansi.hyperlinkClose() +
      ansi.decrst(2004) +
      ansi.decrst(1004) +
      ansi.decrst(1000) +
      ansi.decrst(1002) +
      ansi.decrst(1003) +
      ansi.decrst(1006) +
      ansi.decrst(1015) +
      ansi.kittyKeyboardPop(99) +
      ansi.cursorShow()
    // The scroll-region reset HOMES the cursor (xterm DECSTBM semantics). A
    // main-screen (inline) session parks the cursor below the frame for the
    // returning shell prompt and must not be homed afterwards; alt-screen
    // sessions restore the saved main-screen cursor on 1049 exit anyway.
    if (!preserveCursor) bundle += ansi.resetScrollRegion()
    if (!preserveScreen) bundle += ansi.decrst(1049)
    const bytes = Buffer.byteLength(bundle, 'utf8')
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (counted: boolean): void => {
        if (done) return
        done = true
        this.clock.clearTimeout(timer)
        if (counted) this.counters.bytesWritten += bytes
        resolve()
      }
      const timer = this.clock.setTimeout(() => {
        this.destroyStream()
        finish(false)
      }, WRITER_STOP_SETTLE_MS)
      try {
        this.stream.write(bundle, (error?: Error | null) => finish(error == null))
      } catch {
        finish(false)
      }
    })
    this.uploadedImages.clear()
    this.committedImageReferences.clear()
    this.imageStore?.clearGeneration(this.currentGeneration)
  }

  private destroyStream(): void {
    try {
      this.stream.destroy()
    } catch {
      // best effort only
    }
  }

  private waitQuiescent(): Promise<void> {
    if (this.inFlight === null && this.queue.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.quiescenceWaiters.push(resolve))
  }

  private notifyQuiescence(): void {
    if (this.inFlight !== null || this.queue.length !== 0) return
    const waiters = this.quiescenceWaiters
    this.quiescenceWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** Resolve `predicate()` or time out after `ms` on the injected clock. */
  private withTimeout(ms: number, predicate: () => boolean): Promise<boolean> {
    if (predicate()) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const poll = (): void => {
        if (predicate()) {
          this.clock.clearTimeout(timer)
          resolve(true)
        } else {
          // Still pending: re-register for the next settle notification.
          this.quiescenceWaiters.push(poll)
        }
      }
      const timer = this.clock.setTimeout(() => resolve(false), ms)
      this.quiescenceWaiters.push(poll)
    })
  }
}

function isNewerWatermark(candidate: Watermark, current: Watermark): boolean {
  if (candidate.generation !== current.generation) return candidate.generation > current.generation
  if (candidate.stateRevision !== current.stateRevision) return candidate.stateRevision > current.stateRevision
  return candidate.patchSeq > current.patchSeq
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createTerminalWriter(options: TerminalWriterOptions): TerminalWriter & {
  lifecycleState(): TerminalLifecycleState
  stats(): TerminalWriterStats
} {
  return new TerminalWriterImpl(options)
}
