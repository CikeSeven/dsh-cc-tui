/**
 * tui-v2 inline screen backend (WP-07, plan §WP-07).
 *
 * The v2-native main-screen backend. Frame = screen invariant (§15.1 WP-07):
 * physical screen row i always mirrors frame row i; the shared pipeline
 * (selectors -> base-renderer -> buildFrame -> compositor) is mode-free, and
 * this backend owns the whole INLINE physical patch algorithm. It is an
 * independent implementation — it shares ONLY the backend contract, the pure
 * metadata half (`renderer/diff-planner.ts`) and the fixed writer encoder
 * with the fullscreen backend, and deliberately does NOT import
 * `fullscreen-backend.ts` (plan: 禁止把 fullscreen 的逻辑复制成
 * `if (mode === 'inline')` 分支). The resolved-content cell comparison below
 * implements the same §5.5 rule (frame-local ids are meaningless across
 * frames) but is maintained separately.
 *
 * Physical recipes (all byte composition via the fixed encoder):
 *
 *  - INITIAL PAINT (fullRedrawReason 'initial'): `append` ops write all H
 *    rows at the CURRENT cursor (no CUP — the starting row is wherever the
 *    shell left it; CR homes the unknown column). H-1 feeds land row 0 of
 *    the frame on screen row 0 from any start row R (the R shell lines above
 *    scroll into scrollback, exactly like printing H lines in a shell).
 *  - RE-ANCHOR ('resize'/'damage'/'resume'/'unknown-mode'/'cleanup'):
 *    atomic erase (NEXT geometry — the terminal already cropped/padded its
 *    grid on resize) + full row rewrite inside one patch. Never ED 2/3,
 *    never DECSTBM, never touches scrollback. This is also the third-party
 *    output recovery: whatever foreign bytes did to the screen, the frame is
 *    re-asserted absolutely.
 *  - APPEND (incremental, both frame hints present and followEnd): the
 *    minimal scroll count k pushes exactly the departing settled lines into
 *    scrollback (`line-feed` at the bottom row), the newly settled rows
 *    [ps-k..ns) are written once, and the live region [ns..H) is repainted
 *    row-wise in place. k is searched ascending in [max(0,ps-ns)..ps) for the
 *    first shift with next[i] == prev[i+k] over the seamless settled prefix
 *    [0..ps-k) — 宁缺勿滥: a smaller k under-scrolls (a duplicate content row
 *    stays out of scrollback), a larger one would duplicate scrollback, and
 *    k === ps (scroll everything settled) is never chosen — that is a
 *    repaint. A k that would push only blank pad rows (bottom-aligned region
 *    still filling the viewport) is refused for the same reason.
 *  - REPAINT (no hints, followEnd false — internal scrolling — or no valid
 *    k): row-granular cell diff, changed rows rewritten in place with
 *    absolute CUP. No scroll op, no scrollback growth: lines re-entering the
 *    viewport while browsing must never be re-pushed (ledger
 *    inline-scrollback-incremental: no duplicate scrollback).
 *
 * Patch invariants (§5.5/§5.6, same contract as the fullscreen backend):
 * one `resources` op first; continuation-safe full-row writes; a `cursor`
 * op whenever the patch carries cell/feed operations; `mode` ops only on
 * change and never on the first frame; `patch.bytes` computed with the
 * writer's fixed encoder.
 *
 * Frames carrying `images` placements take the explicit unsupported-image
 * fallback path — inline never emits fullscreen image protocol bytes or claims
 * image parity.  Append-only/live-region semantics remain unchanged.
 *
 * Known, documented limitation (support matrix + §15.1): scrollback receives
 * SETTLED lines only. While one streaming row is taller than the transcript
 * viewport (liveStart pinned to 0) no scroll happens, so its middle section
 * does not reach scrollback; a burst growing content by more than the
 * viewport in one frame leaves the never-visible overflow out of scrollback.
 * Both are repaint territory — never a duplicate, possibly a gap.
 */
import {
  changedModeOperations,
  cursorOperation,
  decidePatchShape,
} from '../renderer/diff-planner.js'
import { unknownConservativeDefaults, type TerminalProfile } from './profile.js'
import { planImageOperations, type UnsupportedImageDiagnostic } from '../renderer/image-placement.js'
import type {
  Frame,
  PatchOperation,
  ScreenBackend,
  ScreenBackendCapabilities,
  TerminalCell,
  TerminalPatch,
} from '../renderer/frame.js'
import { encodePatchOperationsSync } from './writer.js'

// ---------------------------------------------------------------------------
// frame validation (same contract boundary as fullscreen-backend.ts)
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
// cross-frame cell comparison (resolved content, never raw frame-local ids).
// Independent implementation of the §5.5 rule — see the header note.
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

/** Whole-row resolved-content equality (same geometry on both frames). */
function rowsEqual(a: Frame, aY: number, b: Frame, bY: number, aRes: ResourceKeys, bRes: ResourceKeys): boolean {
  const aBase = aY * a.stride
  const bBase = bY * b.stride
  for (let x = 0; x < a.width; x++) {
    if (!cellsEqual(a.cells[aBase + x] as TerminalCell, aRes, b.cells[bBase + x] as TerminalCell, bRes)) return false
  }
  return true
}

/** Default-styled blank: the frame-builder's pad cell is ' ' + DEFAULT_LINE_STYLE. */
const DEFAULT_STYLE_KEY = JSON.stringify({
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
})

function rowIsBlank(frame: Frame, y: number, res: ResourceKeys): boolean {
  const base = y * frame.stride
  for (let x = 0; x < frame.width; x++) {
    const cell = frame.cells[base + x] as TerminalCell
    if (cell.grapheme !== ' ' && cell.grapheme !== '') return false
    if (cell.width !== 1) return false
    if (cell.hyperlinkId !== undefined) return false
    if (res.styles[cell.styleId] !== DEFAULT_STYLE_KEY) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// physical recipes (owned by this backend)
// ---------------------------------------------------------------------------

/** Initial paint: append every row at the current cursor (no absolute CUP). */
function planInitialPaint(next: Frame, operations: PatchOperation[]): boolean {
  for (let y = 0; y < next.height; y++) {
    operations.push({
      kind: 'append',
      cells: next.cells.slice(y * next.stride, y * next.stride + next.width),
      feed: y < next.height - 1,
    })
  }
  return next.height > 0
}

/** Re-anchor: atomic erase (NEXT geometry) + full absolute rewrite. */
function planReanchor(next: Frame, operations: PatchOperation[]): boolean {
  operations.push({ kind: 'erase', x: 0, y: 0, width: next.width, height: next.height })
  for (let y = 0; y < next.height; y++) {
    operations.push({
      kind: 'write-cells',
      x: 0,
      y,
      cells: next.cells.slice(y * next.stride, y * next.stride + next.width),
    })
  }
  return next.height > 0
}

function writeRow(next: Frame, y: number, operations: PatchOperation[]): void {
  operations.push({
    kind: 'write-cells',
    x: 0,
    y,
    cells: next.cells.slice(y * next.stride, y * next.stride + next.width),
  })
}

interface InlineHints {
  readonly ps: number
  readonly ns: number
}

/** Validated hint pair; null when either frame lacks a usable hint. */
function hintPair(previous: Frame, next: Frame): InlineHints | null {
  const ps = previous.metadata.inline?.liveStart
  const ns = next.metadata.inline?.liveStart
  if (ps === undefined || ns === undefined) return null
  if (!Number.isInteger(ps) || !Number.isInteger(ns) || ps < 0 || ns < 0 || ps > next.height || ns > next.height) {
    return null
  }
  return { ps, ns }
}

/**
 * Minimal valid scroll count, or null for repaint. Searched ascending in
 * [max(0,ps-ns)..ps): the first k whose seamless settled prefix matches
 * (next[i] == prev[i+k] for i in [0..ps-k)). k === ps is excluded on purpose:
 * scrolling the entire settled region and rewriting it is never better than
 * an in-place repaint (and risks scrollback churn on mutated content).
 */
function findScrollCount(
  previous: Frame,
  next: Frame,
  hints: InlineHints,
  prevRes: ResourceKeys,
  nextRes: ResourceKeys,
): number | null {
  const { ps, ns } = hints
  const lo = Math.max(0, ps - ns)
  for (let k = lo; k < ps; k++) {
    let seamless = true
    for (let i = 0; i < ps - k; i++) {
      if (!rowsEqual(next, i, previous, i + k, nextRes, prevRes)) {
        seamless = false
        break
      }
    }
    if (seamless) return k
  }
  return null
}

/**
 * Incremental recipe. Returns true when the patch carries cell/feed ops.
 * Row-granular in-place writes everywhere; the append recipe adds at most one
 * `line-feed` (the only scrollback-producing primitive inline mode uses).
 */
function planIncrementalInline(previous: Frame, next: Frame, operations: PatchOperation[]): boolean {
  const prevRes = resourceKeys(previous)
  const nextRes = resourceKeys(next)
  const height = next.height
  const hints = hintPair(previous, next)
  const followEnd =
    hints !== null &&
    previous.metadata.inline?.followEnd === true &&
    next.metadata.inline?.followEnd === true

  if (hints !== null && followEnd) {
    let k = findScrollCount(previous, next, hints, prevRes, nextRes)
    if (k !== null && k > 0) {
      // Scrolling only blank pad rows into scrollback is pure noise: the
      // bottom-aligned region is still filling the viewport and a repaint
      // produces the identical screen without touching scrollback.
      let onlyBlank = true
      for (let y = 0; y < k; y++) {
        if (!rowIsBlank(previous, y, prevRes)) {
          onlyBlank = false
          break
        }
      }
      if (onlyBlank) k = null
    }
    if (k !== null) {
      const { ps, ns } = hints
      let hasCellOps = false
      if (k > 0) {
        operations.push({ kind: 'line-feed', y: height - 1, count: k })
        hasCellOps = true
      }
      // Newly settled rows: their screen rows hold stale live-region content
      // (prev rows [ps..ns) were mutable), so they are always rewritten.
      for (let y = ps - k; y < ns; y++) writeRow(next, y, operations)
      if (ns > ps - k) hasCellOps = true
      // Live region: row-granular in-place repaint. After the k-line scroll,
      // physical row y holds prev row y+k (or a scrolled-in blank once
      // y+k >= height), so the diff source is prev[y+k], never prev[y].
      for (let y = ns; y < height; y++) {
        const shifted = y + k
        if (shifted >= previous.height || !rowsEqual(next, y, previous, shifted, nextRes, prevRes)) {
          writeRow(next, y, operations)
          hasCellOps = true
        }
      }
      return hasCellOps
    }
  }

  // Repaint fallback: whole-frame row diff, absolute CUP, never a scroll.
  let hasCellOps = false
  for (let y = 0; y < height; y++) {
    if (!rowsEqual(next, y, previous, y, nextRes, prevRes)) {
      writeRow(next, y, operations)
      hasCellOps = true
    }
  }
  return hasCellOps
}

// ---------------------------------------------------------------------------
// InlineBackend
// ---------------------------------------------------------------------------

export const INLINE_CAPABILITIES: ScreenBackendCapabilities = Object.freeze({
  supportsViewportLayout: false,
  supportsNestedOverlay: false,
  supportsScrollRegion: false,
  supportsInlineLiveRegion: true,
})

/**
 * Inline-specific surface beyond the ScreenBackend contract: the exit park.
 * Stopping leaves the frame on the main screen; parking feeds one line and
 * rests a visible cursor on the blank bottom row so the returning shell
 * prompt lands BELOW the frame instead of overwriting the dock.
 */
export interface InlineScreenBackend extends ScreenBackend {
  planExitPark(generation: number): TerminalPatch | null
}

export interface InlineBackendOptions {
  readonly profile?: TerminalProfile
  readonly onDiagnostic?: (diagnostic: UnsupportedImageDiagnostic) => void
}

export class InlineBackend implements InlineScreenBackend {
  readonly mode = 'inline' as const
  readonly capabilities: ScreenBackendCapabilities = INLINE_CAPABILITIES

  private readonly profile: TerminalProfile | undefined
  private readonly onDiagnostic: ((diagnostic: UnsupportedImageDiagnostic) => void) | undefined
  private started = false
  private activeGeneration: number | null = null
  private plannedGeneration = -1
  private patchSeq = 0
  private lastPlanned: { readonly height: number; readonly stateRevision: number; readonly generation: number } | null =
    null

  constructor(options: InlineBackendOptions = {}) {
    this.profile = options.profile
    this.onDiagnostic = options.onDiagnostic
  }

  /**
   * Generation gate only — inline mode never enters the alternate screen, so
   * there are no takeover bytes to emit here or anywhere (§6.4).
   */
  start(generation: number): Promise<void> {
    requireGeneration('start generation', generation)
    if (this.activeGeneration !== null && generation < this.activeGeneration) {
      throw new RangeError(`start generation ${generation} goes backwards (active: ${this.activeGeneration})`)
    }
    this.activeGeneration = generation
    this.patchSeq = 0
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
    }

    const shape = decidePatchShape(previous, next)
    const operations: PatchOperation[] = [{ kind: 'resources', resources: next.resources }]

    let hasCellOps = false
    if (shape.fullRedraw) {
      // previous === null is ambiguous (session start vs coordinator reset);
      // the frame's own reason disambiguates: only a genuine first frame
      // appends — every reset re-anchors absolutely over a dirty screen.
      hasCellOps =
        shape.fullRedrawReason === 'initial' ? planInitialPaint(next, operations) : planReanchor(next, operations)
    } else if (previous !== null) {
      hasCellOps = planIncrementalInline(previous, next, operations)
    }

    // The cursor op comes after cell writes/feeds: those leave the physical
    // cursor at the last write position, so any patch carrying them re-asserts
    // the frame's resting cursor (not only cursor changes).
    const cursor = cursorOperation(previous, next)
    if (cursor !== null || hasCellOps) {
      operations.push(
        cursor ?? { kind: 'cursor', x: next.cursor.x, y: next.cursor.y, visible: next.cursor.visible },
      )
    }

    // Mode transition (never on the first frame: the lifecycle owns it).
    if (previous !== null) {
      operations.push(...changedModeOperations(previous, next))
    }

    // Inline deliberately keeps the append-only cell recipe and reports an
    // unsupported image instead of emitting fullscreen protocol bytes.
    if (next.images.length > 0 || (previous?.images.length ?? 0) > 0) {
      operations.push(...planImageOperations(previous, next, {
        profile: this.profile ?? unknownConservativeDefaults(),
        inline: true,
        forceFull: shape.fullRedraw,
        onDiagnostic: this.onDiagnostic,
      }))
    }

    const { bytes } = encodePatchOperationsSync(operations)
    this.lastPlanned = { height: next.height, stateRevision: next.stateRevision, generation: next.generation }
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

  /**
   * Park the cursor below the frame for a clean return to the shell. Null
   * when no frame was ever planned (nothing on screen to park under). Best
   * effort: one feed opens a blank bottom row (the top frame line moves into
   * scrollback, where append-only history already lives), then a visible
   * cursor rests on it.
   */
  planExitPark(generation: number): TerminalPatch | null {
    requireGeneration('exit park generation', generation)
    if (this.lastPlanned === null || this.lastPlanned.height === 0) return null
    if (this.activeGeneration !== null && generation < this.activeGeneration) {
      return null // stale: an older backend never writes into a newer session
    }
    if (generation !== this.plannedGeneration) {
      this.patchSeq = 0
      this.plannedGeneration = generation
    }
    const operations: PatchOperation[] = [
      { kind: 'line-feed', y: this.lastPlanned.height - 1, count: 1 },
      { kind: 'cursor', x: 0, y: this.lastPlanned.height - 1, visible: true },
    ]
    const { bytes } = encodePatchOperationsSync(operations)
    return {
      frameId: `exit-park-${this.plannedGeneration}-${this.patchSeq}`,
      stateRevision: this.lastPlanned.stateRevision,
      patchSeq: this.patchSeq++,
      generation,
      operations,
      bytes,
      fullRedraw: false,
    }
  }

  /** Generation gate only; teardown bytes belong to the lifecycle. */
  stop(generation: number): Promise<void> {
    requireGeneration('stop generation', generation)
    if (this.activeGeneration !== null && generation < this.activeGeneration) {
      return Promise.resolve() // stale: an older backend never gates a newer session
    }
    this.started = false
    return Promise.resolve()
  }
}

function requireGeneration(name: string, generation: number): void {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${generation}`)
  }
}
