/**
 * tui-v2 fullscreen screen backend (WP-06b, plan §6.4 — TuiAltScreen).
 *
 * The v2-native alt-screen backend: a ScreenBackend whose `plan()` owns the
 * FULLSCREEN physical patch algorithm (cell-level viewport diff), while the
 * metadata half (full-vs-incremental shape, mode/cursor candidates) comes
 * from the pure DiffPlanner (`renderer/diff-planner.ts`, plan line ~909).
 *
 * Capability boundary (§6.4): only the alt-screen backend may promise a
 * fixed layout root, nested overlays and scroll regions; this class declares
 * exactly that, and `supportsInlineLiveRegion: false` (inline semantics are
 * WP-07 and are never faked here).
 *
 * Responsibilities (§6.4):
 *  - alternate screen enter/exit: NOT emitted here — takeover/cleanup bytes
 *    go through `terminal/lifecycle.ts` orchestration (§5.7, single writer).
 *    `start(generation)`/`stop(generation)` are the backend's generation
 *    gate/bookkeeping on top of that orchestration. Nothing written by this
 *    backend can reach the main screen's scrollback (alt screen only).
 *  - resize transaction: a geometry change is decided as a full redraw by
 *    the DiffPlanner ('resize'); the physical recipe is an atomic
 *    erase-everything + full row rewrite INSIDE ONE PATCH (one writer batch
 *    = one atomic write), never touching main-screen scrollback.
 *  - Ctrl+L / SIGCONT / unknown terminal state / cleanup: these arrive as
 *    frames carrying fullRedraw + fullRedrawReason ('damage' / 'resume' /
 *    'unknown-mode' / 'cleanup') from the coordinator's existing trigger
 *    points; the DiffPlanner turns them into the same full recipe.
 *  - full render is the correctness reference: the full-redraw path writes
 *    every row; the incremental path is proven equal to it by the
 *    differential replay tests (test/tui-v2/fullscreen-backend.test.ts).
 *
 * Patch invariants (§5.5/§5.6):
 *  - one `resources` op always precedes cell writes (the fixed writer
 *    encoder requires it; ids are frame-local and resolvable by id);
 *  - continuation safety: an incremental run never starts with a width-0
 *    continuation cell and never ends with an unpaired wide head (the span
 *    is extended to cover the pair);
 *  - cross-frame cell comparison resolves styleId/hyperlinkId through each
 *    frame's OWN resources and compares CONTENT — frame-local ids alias
 *    across frames by construction, so raw id comparison is meaningless;
 *  - a `cursor` op is emitted whenever the patch carries cell/erase
 *    operations (cell writes leave the physical cursor at the last write
 *    position) or the cursor itself changed, so the resting cursor always
 *    matches the frame's cursor metadata;
 *  - `mode` ops are emitted only on change and never on the first frame
 *    (the lifecycle established the session modes physically);
 *  - `patch.bytes` is computed with the writer's fixed encoder
 *    (`encodePatchOperationsSync`) — the writer validates against exactly
 *    these bytes.
 *
 * Image placements are metadata-only at this layer.  Confirmed Kitty/iTerm2
 * profiles are encoded by the shared writer; invalid or unsupported metadata
 * is diagnosed and omitted rather than thrown into the user render path.
 */
import {
  changedModeOperations,
  cursorOperation,
  decidePatchShape,
} from '../renderer/diff-planner.js'
import type {
  Frame,
  ImageStore,
  PatchOperation,
  ScreenBackend,
  ScreenBackendCapabilities,
  TerminalCell,
  TerminalPatch,
} from '../renderer/frame.js'
import { planImageOperations, type UnsupportedImageDiagnostic } from '../renderer/image-placement.js'
import { unknownConservativeDefaults, type TerminalProfile } from './profile.js'
import { encodePatchOperationsSync } from './writer.js'

// ---------------------------------------------------------------------------
// frame validation (same contract boundary as terminal/screen-plan.ts)
// ---------------------------------------------------------------------------

function validateFrame(frame: Frame): void {
  if (frame === null || typeof frame !== 'object') throw new TypeError('frame must be an object')
  if (!Number.isInteger(frame.width) || frame.width < 1) throw new TypeError('frame.width must be a positive integer')
  if (!Number.isInteger(frame.height) || frame.height < 0) throw new TypeError('frame.height must be a non-negative integer')
  if (!Number.isInteger(frame.stride) || frame.stride < frame.width) {
    throw new TypeError('frame.stride must be an integer >= frame.width')
  }
  if (!Array.isArray(frame.cells) || frame.cells.length < frame.stride * frame.height) {
    throw new TypeError('frame.cells must cover stride * height')
  }
  if (!Array.isArray(frame.images)) throw new TypeError('frame.images must be an array')
}

// ---------------------------------------------------------------------------
// cross-frame cell comparison (resolved content, never raw frame-local ids)
// ---------------------------------------------------------------------------

interface ResourceKeys {
  readonly styles: readonly (string | undefined)[]
  readonly links: readonly (string | undefined)[]
}

/** Id-indexed content keys; ids are dense per frame (ResourceTable). */
function resourceKeys(frame: Frame): ResourceKeys {
  const styles: (string | undefined)[] = []
  for (const style of frame.resources.styles) {
    const { id, ...content } = style
    styles[id] = JSON.stringify(content)
  }
  const links: (string | undefined)[] = []
  for (const link of frame.resources.hyperlinks) {
    links[link.id] = JSON.stringify({ uri: link.uri, params: link.params ?? null })
  }
  return { styles, links }
}

function cellsEqual(a: TerminalCell, aRes: ResourceKeys, b: TerminalCell, bRes: ResourceKeys): boolean {
  if (a.grapheme !== b.grapheme || a.width !== b.width) return false
  const aStyle = aRes.styles[a.styleId]
  const bStyle = bRes.styles[b.styleId]
  if (aStyle === undefined || bStyle === undefined) {
    throw new TypeError(`unresolvable styleId in frame resources (${a.styleId}/${b.styleId})`)
  }
  if (aStyle !== bStyle) return false
  const aLink = a.hyperlinkId === undefined ? null : (aRes.links[a.hyperlinkId] ?? null)
  const bLink = b.hyperlinkId === undefined ? null : (bRes.links[b.hyperlinkId] ?? null)
  if (a.hyperlinkId !== undefined && aLink === null) {
    throw new TypeError(`unresolvable hyperlinkId ${a.hyperlinkId} in frame resources`)
  }
  if (b.hyperlinkId !== undefined && bLink === null) {
    throw new TypeError(`unresolvable hyperlinkId ${b.hyperlinkId} in frame resources`)
  }
  return aLink === bLink
}

// ---------------------------------------------------------------------------
// physical algorithms (owned by this backend, plan line ~909)
// ---------------------------------------------------------------------------

/** Full recipe: (erase when repainting over a live screen) + every row. */
function planFullRedraw(previous: Frame | null, next: Frame, operations: PatchOperation[]): void {
  if (previous !== null) {
    // Atomic clear+redraw inside one patch: erase the whole (new) viewport
    // first, then rewrite every row. Bounds are the NEXT geometry — after a
    // resize the terminal has already cropped/padded its grid (no reflow),
    // and the replay harness resizes the canonical grid the same way.
    operations.push({ kind: 'erase', x: 0, y: 0, width: next.width, height: next.height })
  }
  for (let y = 0; y < next.height; y++) {
    operations.push({
      kind: 'write-cells',
      x: 0,
      y,
      cells: next.cells.slice(y * next.stride, y * next.stride + next.width),
    })
  }
}

/**
 * Incremental recipe: per row, rewrite the [first..last] changed span with
 * the next frame's cells. Span ends are extended for continuation safety
 * (§5.5): a span starting on a continuation grows left to include its wide
 * head; a span ending on a wide head grows right to include its
 * continuation. Overwriting half of a previous-frame wide pair is
 * impossible: the pair partner differs from the next frame exactly when the
 * pair broke, which puts it inside the span.
 */
function planIncremental(previous: Frame, next: Frame, operations: PatchOperation[]): void {
  const prevRes = resourceKeys(previous)
  const nextRes = resourceKeys(next)
  const width = next.width
  for (let y = 0; y < next.height; y++) {
    const rowBase = y * next.stride
    const prevRowBase = y * previous.stride
    let first = -1
    let last = -1
    for (let x = 0; x < width; x++) {
      const a = previous.cells[prevRowBase + x] as TerminalCell
      const b = next.cells[rowBase + x] as TerminalCell
      if (!cellsEqual(a, prevRes, b, nextRes)) {
        if (first < 0) first = x
        last = x
      }
    }
    if (first < 0) continue
    if ((next.cells[rowBase + first] as TerminalCell).width === 0 && first > 0) first -= 1
    if ((next.cells[rowBase + last] as TerminalCell).width === 2 && last + 1 < width) last += 1
    operations.push({
      kind: 'write-cells',
      x: first,
      y,
      cells: next.cells.slice(rowBase + first, rowBase + last + 1),
    })
  }
}

// ---------------------------------------------------------------------------
// FullscreenBackend
// ---------------------------------------------------------------------------

export const FULLSCREEN_CAPABILITIES: ScreenBackendCapabilities = Object.freeze({
  supportsViewportLayout: true,
  supportsNestedOverlay: true,
  supportsScrollRegion: true,
  supportsInlineLiveRegion: false,
})

export interface FullscreenBackendOptions {
  readonly profile?: TerminalProfile
  readonly imageStore?: ImageStore
  readonly onDiagnostic?: (diagnostic: UnsupportedImageDiagnostic) => void
}

export class FullscreenBackend implements ScreenBackend {
  readonly mode = 'fullscreen' as const
  readonly capabilities: ScreenBackendCapabilities = FULLSCREEN_CAPABILITIES

  private readonly profile: TerminalProfile | undefined
  private readonly imageStore: ImageStore | undefined
  private readonly onDiagnostic: ((diagnostic: UnsupportedImageDiagnostic) => void) | undefined
  private started = false
  private activeGeneration: number | null = null
  private plannedGeneration = -1
  private patchSeq = 0
  private readonly plannedUploaded = new Set<string>()

  constructor(options: FullscreenBackendOptions = {}) {
    this.profile = options.profile
    this.imageStore = options.imageStore
    this.onDiagnostic = options.onDiagnostic
  }

  /**
   * Generation gate only — the physical alt-screen entry is the terminal
   * lifecycle's orchestration (§5.7/§6.4), never this module.
   */
  start(generation: number): Promise<void> {
    requireGeneration('start generation', generation)
    if (this.activeGeneration !== null && generation < this.activeGeneration) {
      throw new RangeError(`start generation ${generation} goes backwards (active: ${this.activeGeneration})`)
    }
    this.activeGeneration = generation
    this.patchSeq = 0
    this.plannedUploaded.clear()
    this.started = true
    return Promise.resolve()
  }

  plan(previous: Frame | null, next: Frame): TerminalPatch {
    validateFrame(next)
    if (previous !== null) validateFrame(previous)
    if (this.activeGeneration !== null && next.generation < this.activeGeneration) {
      throw new RangeError(
        `frame generation ${next.generation} is older than the active generation ${this.activeGeneration}`,
      )
    }
    if (next.generation !== this.plannedGeneration) {
      // patchSeq lineage restarts per generation (the writer adopts a newer
      // generation and resets its watermark baselines, §5.6).
      this.patchSeq = 0
      this.plannedGeneration = next.generation
      this.plannedUploaded.clear()
    }

    const shape = decidePatchShape(previous, next)
    const operations: PatchOperation[] = [{ kind: 'resources', resources: next.resources }]

    let hasCellOps = false
    if (shape.fullRedraw) {
      planFullRedraw(previous, next, operations)
      hasCellOps = next.height > 0
    } else if (previous !== null) {
      const before = operations.length
      planIncremental(previous, next, operations)
      hasCellOps = operations.length > before
    }

    // Images are planned from metadata only. Missing payload bytes suppress
    // new uploads with a diagnostic, but removals from the previous frame must
    // still reach the terminal (notably Kitty delete/clear).
    let hasImageOps = false
    if (next.images.length > 0 || (previous?.images.length ?? 0) > 0) {
      const imageOps = planImageOperations(previous, next, {
        profile: this.profile ?? unknownConservativeDefaults(),
        store: this.imageStore,
        requireStore: true,
        forceFull: shape.fullRedraw,
        onDiagnostic: this.onDiagnostic,
      })
      operations.push(...imageOps)
      hasImageOps = imageOps.length > 0
      for (const op of imageOps) {
        if (op.kind === 'image-upload') this.plannedUploaded.add(op.storeKey)
        else if (op.kind === 'image-delete') this.plannedUploaded.delete(op.storeKey)
        else if (op.kind === 'image-clear') this.plannedUploaded.clear()
      }
    }

    // The cursor op comes after cell and image writes: both may move the
    // physical cursor, so re-assert the frame's resting cursor after either.
    const cursor = cursorOperation(previous, next)
    if (cursor !== null || hasCellOps || hasImageOps) {
      operations.push(
        cursor ?? { kind: 'cursor', x: next.cursor.x, y: next.cursor.y, visible: next.cursor.visible },
      )
    }

    // Mode transition (never on the first frame: the lifecycle owns it).
    if (previous !== null) {
      operations.push(...changedModeOperations(previous, next))
    }

    const { bytes } = encodePatchOperationsSync(operations, {
      imageStore: this.imageStore,
      profile: this.profile,
      uploadedStoreKeys: this.plannedUploaded,
      generation: next.generation,
    })
    return {
      frameId: next.frameId,
      stateRevision: next.stateRevision,
      patchSeq: this.patchSeq++,
      generation: next.generation,
      operations,
      bytes,
      fullRedraw: shape.fullRedraw,
    }
  }

  /** Generation gate only; teardown bytes belong to the lifecycle. */
  stop(generation: number): Promise<void> {
    requireGeneration('stop generation', generation)
    if (this.activeGeneration !== null && generation < this.activeGeneration) {
      return Promise.resolve() // stale: an older backend never gates a newer session
    }
    this.started = false
    this.plannedUploaded.clear()
    this.imageStore?.clearGeneration(generation)
    return Promise.resolve()
  }
}

function requireGeneration(name: string, generation: number): void {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${generation}`)
  }
}
