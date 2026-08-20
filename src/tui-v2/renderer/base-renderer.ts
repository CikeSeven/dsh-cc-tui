/**
 * tui-v2 base renderer (WP-04b, plan §6.2).
 *
 * Line-level skeleton of the base renderer: composes the transcript scroll
 * region (visible settled rows + streaming row + unseen indicator) and the
 * dock (notifications/activity + editor + status/footer) into one logical
 * line buffer. Frame/cell building, diffing and overlay compositing are
 * WP-06; this module already enforces the §6.2 invariants they rely on:
 *
 *  - Variable-height virtualization via an explicit `HeightIndex`
 *    (rowId/revision -> height + prefix sums). Only the model-provided
 *    window of rows is measured, hard-capped at MAX_MEASURED_ROWS rows and
 *    MAX_MEASURED_CELLS cells; older content pages in through the
 *    `canLoadOlder`/`loadOlderRange` data interface (the controller drives
 *    the actual load; this renderer never fetches).
 *  - Settled-row render cache keyed by the full §5.3 identity
 *    (sessionEpoch, rowId, revision, width, theme, profile) via
 *    `rowCacheKey`; width/theme/profile changes clear it through the
 *    declared invalidation policy (resize transaction).
 *  - Scroll anchor `{ sessionEpoch, rowId, intraRowOffset }`: follow-end
 *    moves only the tail; off-bottom viewports never jump on new rows (the
 *    unseen indicator counts them); prepend restore; unrecoverable anchors
 *    (row eviction, resize that emptied the index, session-epoch reset) fall
 *    back to the explicit `anchorFallback` top/bottom policy and increment
 *    the `anchorFallbacks` diagnostic counter (WP-06c: epoch resets with a
 *    live anchor now record the fallback instead of silently bottoming out).
 *  - When the provided row window exceeds MAX_MEASURED_ROWS the measured
 *    slice is tail-biased by default (follow-end), but centers on a live
 *    off-bottom anchor so anchor restore stays possible inside oversized
 *    windows; rows outside the slice page in via `loadOlderRange`, never by
 *    copying the full transcript into the frame (§6.2).
 *  - Every emitted line passes `assertLineWidth` (§3.3 I-06).
 *
 * Overscan (§6.2): `overscanRows(viewportHeight) = max(2*viewportHeight, 64)`
 * — the row count worth measuring/requesting beyond the visible window; it
 * is the default `loadOlderRange` page size.
 *
 * Dependency rule (§4.3): renderer imports `import type` from model and
 * renderer contracts only. Components are injected (registry/factories);
 * this module never imports a concrete component.
 */
import type { UiActivityState, UiNotification } from '../model/state.js'
import type {
  DockView,
  EditorView,
  StatusLineView,
  TranscriptView,
} from '../model/selectors.js'
import { rowCacheKey } from '../model/row-id.js'
import type { UiRowSnapshot } from '../model/schema.js'
import type { TerminalProfile } from '../terminal/profile.js'
import {
  createBoundedCache,
  detachString,
  invalidateOn,
  type BoundedCache,
  type CacheChangeSet,
  type CacheInvalidationPolicy,
} from './cache.js'
import type { Component, Focusable } from './component.js'
import {
  assertLineWidth,
  cellsToString,
  lineStyle,
  padCells,
  styledCells,
  truncateCells,
  lineToCells,
  type LineStyle,
} from './lines.js'
import { prefixSums } from './layout.js'

// ---------------------------------------------------------------------------
// Constants (§6.2)
// ---------------------------------------------------------------------------

/** §6.2 measurement caps: at most 600 rows / 2,000,000 cells are measured. */
export const MAX_MEASURED_ROWS = 600
export const MAX_MEASURED_CELLS = 2_000_000

/** §6.2 overscan in row units. */
export function overscanRows(viewportHeight: number): number {
  return Math.max(2 * Math.max(0, viewportHeight), 64)
}

// ---------------------------------------------------------------------------
// Component injection surface
// ---------------------------------------------------------------------------

/** Factory for one transcript row component (theme/profile bound by the app). */
export type RowComponentFactory = (row: UiRowSnapshot, streaming: boolean) => Component

export interface RowComponentRegistry {
  readonly componentFor: (kind: string) => RowComponentFactory | undefined
}

export interface DockComponentFactories {
  /** Stateful editor instance synced from the latest EditorView by the app. */
  readonly editor: (view: EditorView) => Component & Partial<Focusable>
  readonly status: (view: StatusLineView) => Component
  /** Activity/spinner line; return null to hide. */
  readonly activity?: (activity: UiActivityState | null) => Component | null
}

export interface BaseRendererOptions {
  readonly profile: TerminalProfile
  /** Theme identity for cache keys (the theme object itself is component-side). */
  readonly theme: string
  readonly registry: RowComponentRegistry
  readonly dock: DockComponentFactories
  /** Fallback when an anchor cannot be restored (default 'bottom'). */
  readonly anchorFallback?: 'top' | 'bottom'
  readonly heightCache?: BoundedCache<string, number>
  readonly renderCache?: BoundedCache<string, readonly string[]>
}

// ---------------------------------------------------------------------------
// HeightIndex (§6.2)
// ---------------------------------------------------------------------------

export interface HeightIndexEntry {
  readonly rowId: string
  readonly height: number
}

/** rowId/revision -> height plus prefix sums over the measured row window. */
export interface HeightIndex {
  readonly rowIds: readonly string[]
  readonly heights: readonly number[]
  /** lineOffsets[i] = lines above row i; length === rowIds.length + 1. */
  readonly lineOffsets: readonly number[]
  readonly totalHeight: number
  heightAt(index: number): number
  /** Line offset of a row's first line; undefined when the row is not measured. */
  offsetOf(rowId: string): number | undefined
  /** Row index containing line offset `line`; -1 when out of range. */
  rowAtLine(line: number): number
}

export function buildHeightIndex(entries: readonly HeightIndexEntry[]): HeightIndex {
  const rowIds = entries.map((entry) => entry.rowId)
  const heights = entries.map((entry) => entry.height)
  const lineOffsets = prefixSums(heights)
  const indexByRowId = new Map<string, number>()
  rowIds.forEach((rowId, index) => indexByRowId.set(rowId, index))
  return {
    rowIds,
    heights,
    lineOffsets,
    totalHeight: lineOffsets[lineOffsets.length - 1] as number,
    heightAt(index) {
      return heights[index] ?? 0
    },
    offsetOf(rowId) {
      const index = indexByRowId.get(rowId)
      return index === undefined ? undefined : (lineOffsets[index] as number)
    },
    rowAtLine(line) {
      if (line < 0 || line >= (lineOffsets[lineOffsets.length - 1] as number)) return -1
      // Linear scan is fine: the measured window is capped at 600 rows.
      for (let i = 0; i < heights.length; i++) {
        if (line >= (lineOffsets[i] as number) && line < (lineOffsets[i + 1] as number)) return i
      }
      return heights.length - 1
    },
  }
}

// ---------------------------------------------------------------------------
// Scroll anchor (§6.2)
// ---------------------------------------------------------------------------

export interface ScrollAnchor {
  readonly sessionEpoch: string
  readonly rowId: string
  readonly intraRowOffset: number
}

// ---------------------------------------------------------------------------
// Render input/output
// ---------------------------------------------------------------------------

export interface BaseRenderInput {
  readonly transcript: TranscriptView
  readonly dock: DockView
  readonly editor: EditorView
  readonly status: StatusLineView
  readonly width: number
  readonly height: number
  /** session.sessionEpoch; an epoch change resets every row cache. */
  readonly sessionEpoch: string
  /** viewport.sticky: follow-end mode (newest rows pinned to the bottom). */
  readonly sticky: boolean
}

export interface BaseRenderDiagnostics {
  readonly transcriptHeight: number
  readonly dockHeight: number
  readonly measuredRows: number
  readonly measuredCells: number
  /** Rows not measured because the §6.2 caps stopped measurement. */
  readonly unmeasuredRows: number
  readonly scrollTopLine: number
  readonly anchorFallbacks: number
  readonly fullRedraw: boolean
}

export interface BaseRenderOutput {
  readonly lines: readonly string[]
  readonly cursor?: { readonly x: number; readonly y: number; readonly visible: boolean }
  readonly diagnostics: BaseRenderDiagnostics
}

export interface LoadOlderRange {
  /** First row index (into the full transcript) to load. */
  readonly start: number
  /** Number of rows to load (prepended before the current window). */
  readonly count: number
}

export interface BaseRenderer {
  render(input: BaseRenderInput): BaseRenderOutput
  /**
   * Resize/profile/theme transaction hook (registered with the scheduler):
   * clears width-keyed caches per the declared invalidation policy and forces
   * the next render to be a full redraw.
   */
  applyEnvironmentChange(changes: CacheChangeSet): void
  /** Capture the anchor for the row containing `lineOffset` of the last render. */
  captureAnchorAt(lineOffset: number): void
  /** Return to follow-end mode (drops the anchor). */
  clearAnchor(): void
  readonly anchor: ScrollAnchor | null
  readonly heightIndex: HeightIndex
  /** Older rows exist beyond the loaded window (controller drives the load). */
  canLoadOlder(view: TranscriptView): boolean
  /** Page of older rows to request, one overscan deep (§6.2). */
  loadOlderRange(view: TranscriptView): LoadOlderRange
  readonly diagnostics: { readonly anchorFallbacks: number }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const NOTIFICATION_STYLES: Record<string, LineStyle> = {
  error: lineStyle({ foreground: 'red' }),
  warning: lineStyle({ foreground: 'yellow' }),
  success: lineStyle({ foreground: 'green' }),
}
const NOTIFICATION_DEFAULT_STYLE = lineStyle({ foreground: 'bright-black' })
const UNSEEN_STYLE = lineStyle({ foreground: 'bright-black' })

/** Serialize the §5.3 row cache identity into one cache key string. */
function rowRenderCacheKey(
  row: UiRowSnapshot,
  width: number,
  theme: string,
  profileId: string,
): string {
  const key = rowCacheKey(row, { width, themeId: theme, terminalProfileId: profileId })
  return [
    key.sessionEpoch,
    key.rowId,
    String(key.revision),
    String(key.width),
    key.themeId,
    key.terminalProfileId,
  ].join('|')
}

const RENDER_CACHE_POLICY: CacheInvalidationPolicy = Object.freeze({
  clearOnWidthChange: true,
  clearOnThemeChange: true,
  clearOnProfileChange: true,
  clearOnRowRevisionChange: false, // per-row staleness is keyed, not cleared
})

export function createBaseRenderer(options: BaseRendererOptions): BaseRenderer {
  const anchorFallback = options.anchorFallback ?? 'bottom'

  // @cache-budget entries=600 bytes=4194304 eviction=LRU
  const renderCache: BoundedCache<string, readonly string[]> =
    options.renderCache ??
    createBoundedCache<string, readonly string[]>({
      maxEntries: MAX_MEASURED_ROWS,
      maxBytes: 4 * 1024 * 1024,
      keyToBytes: (key) => key.length * 2,
      valueToBytes: (lines) => lines.reduce((sum, line) => sum + line.length * 2, 64),
      detachKey: detachString,
    })
  // @cache-budget entries=600 bytes=196608 eviction=LRU
  const heightCache: BoundedCache<string, number> =
    options.heightCache ??
    createBoundedCache<string, number>({
      maxEntries: MAX_MEASURED_ROWS,
      maxBytes: 192 * 1024,
      keyToBytes: (key) => key.length * 2,
      valueToBytes: () => 8,
      detachKey: detachString,
    })

  /** Component pool, bounded by the measured window; purged on epoch change. */
  const componentPool = new Map<string, { key: string; component: Component }>()
  let anchor: ScrollAnchor | null = null
  let heightIndex: HeightIndex = buildHeightIndex([])
  let lastEpoch = ''
  let anchorFallbacks = 0
  let forceFullRedraw = true
  /** Set when an epoch reset dropped a live anchor; consumed by the next scroll computation. */
  let pendingAnchorFallback = false
  /** Transcript region height of the last render; the loadOlder page-size basis (§6.2 overscan). */
  let lastTranscriptHeight = 0

  const profile = options.profile

  const renderRow = (row: UiRowSnapshot, streaming: boolean, width: number): readonly string[] => {
    const key = rowRenderCacheKey(row, width, options.theme, profile.id)
    if (!streaming) {
      const cached = renderCache.get(key)
      if (cached !== undefined) return cached
    }
    let pooled = componentPool.get(row.rowId)
    if (pooled !== undefined && pooled.key !== key) {
      pooled.component.invalidate()
      componentPool.delete(row.rowId)
      pooled = undefined
    }
    if (pooled === undefined) {
      const factory = options.registry.componentFor(row.kind)
      const component = factory !== undefined ? factory(row, streaming) : fallbackRowComponent(row, profile)
      pooled = { key, component }
      componentPool.set(row.rowId, pooled)
    }
    const lines = pooled.component.render(width)
    if (!streaming) {
      renderCache.set(key, lines)
      heightCache.set(key, lines.length)
    }
    return lines
  }

  const renderNotification = (notification: UiNotification, width: number): string => {
    const style = NOTIFICATION_STYLES[notification.color ?? ''] ?? NOTIFICATION_DEFAULT_STYLE
    const cells = styledCells(`! ${notification.text}`, style, profile)
    return cellsToString(truncateCells(cells, width))
  }

  const renderer: BaseRenderer = {
    get anchor() {
      return anchor
    },
    get heightIndex() {
      return heightIndex
    },
    get diagnostics() {
      return { anchorFallbacks }
    },

    applyEnvironmentChange(changes) {
      invalidateOn(renderCache, RENDER_CACHE_POLICY, changes)
      invalidateOn(heightCache, RENDER_CACHE_POLICY, changes)
      if (changes.widthChanged === true || changes.profileChanged === true || changes.themeChanged === true) {
        componentPool.clear()
        heightIndex = buildHeightIndex([])
        forceFullRedraw = true
      }
    },

    captureAnchorAt(lineOffset) {
      const index = heightIndex.rowAtLine(Math.max(0, lineOffset))
      if (index < 0) return
      const rowId = heightIndex.rowIds[index]
      if (rowId === undefined) return
      anchor = {
        sessionEpoch: lastEpoch,
        rowId,
        intraRowOffset: Math.max(0, lineOffset - (heightIndex.lineOffsets[index] as number)),
      }
    },

    clearAnchor() {
      anchor = null
    },

    canLoadOlder(view) {
      return view.windowStart > 0
    },

    loadOlderRange(view) {
      // §6.2 overscan is viewport-keyed: max(2 * transcriptViewportHeight, 64).
      // Before the first render (or after a degenerate one) fall back to the
      // provided window length so the page size stays deterministic.
      const basis = lastTranscriptHeight > 0 ? lastTranscriptHeight : view.visibleRows.length
      const count = Math.min(view.windowStart, overscanRows(basis))
      return { start: Math.max(0, view.windowStart - count), count }
    },

    render(input) {
      const { width, height } = input
      const fullRedraw = forceFullRedraw
      forceFullRedraw = false
      if (input.sessionEpoch !== lastEpoch) {
        // Epoch change: every old row identity is unreachable (§5.3). A live
        // anchor cannot survive it — when the viewport is off-bottom (the
        // anchor was driving the scroll) fall back to the explicit top/bottom
        // policy on this very render and record the diagnostic (§6.2). In
        // sticky follow-end mode the anchor was inactive: drop it silently.
        componentPool.clear()
        renderCache.clear()
        heightCache.clear()
        if (anchor !== null) {
          anchor = null
          if (!input.sticky) {
            anchorFallbacks += 1
            pendingAnchorFallback = true
          }
        }
        lastEpoch = input.sessionEpoch
      }
      if (width <= 0 || height <= 0) {
        heightIndex = buildHeightIndex([])
        lastTranscriptHeight = 0
        return {
          lines: [],
          diagnostics: {
            transcriptHeight: 0,
            dockHeight: 0,
            measuredRows: 0,
            measuredCells: 0,
            unmeasuredRows: 0,
            scrollTopLine: 0,
            anchorFallbacks,
            fullRedraw,
          },
        }
      }

      // ---- dock ------------------------------------------------------------
      const dockBlocks: string[][] = []
      for (const notification of input.dock.notifications) {
        dockBlocks.push([renderNotification(notification, width)])
      }
      const activityComponent = options.dock.activity?.(input.dock.activity) ?? null
      if (activityComponent !== null) {
        const activityLines = activityComponent
          .render(width)
          .map((line) => assertLineWidth(line, profile, width))
        if (activityLines.length > 0) {
          dockBlocks.push(activityLines.map((line) => line))
        }
      }
      const editorComponent = options.dock.editor(input.editor)
      const editorLines = editorComponent.render(width).map((line) => assertLineWidth(line, profile, width))
      dockBlocks.push(editorLines)
      const statusLines = options.dock
        .status(input.status)
        .render(width)
        .map((line) => assertLineWidth(line, profile, width))
      dockBlocks.push(statusLines)
      let dockLines = dockBlocks.flat()
      if (dockLines.length > height) dockLines = dockLines.slice(dockLines.length - height)
      const dockHeight = dockLines.length
      const transcriptHeight = Math.max(0, height - dockHeight)
      lastTranscriptHeight = transcriptHeight

      // ---- transcript rows (measurement bounded by §6.2 caps) --------------
      const allRows = input.transcript.visibleRows
      let rows = allRows
      if (rows.length > MAX_MEASURED_ROWS) {
        // Tail-biased by default (follow-end renders the newest rows); with a
        // live off-bottom anchor center the measured slice on the anchor row
        // so an oversized provided window cannot make it unrecoverable. Rows
        // outside the slice stay pageable through loadOlderRange (§6.2).
        let sliceStart = rows.length - MAX_MEASURED_ROWS
        if (!input.sticky && anchor !== null && anchor.sessionEpoch === input.sessionEpoch) {
          const anchorIndex = rows.findIndex((candidate) => candidate.rowId === anchor?.rowId)
          if (anchorIndex >= 0) {
            sliceStart = Math.min(
              Math.max(0, anchorIndex - (MAX_MEASURED_ROWS >> 1)),
              rows.length - MAX_MEASURED_ROWS,
            )
          }
        }
        rows = rows.slice(sliceStart, sliceStart + MAX_MEASURED_ROWS)
      }
      const entries: HeightIndexEntry[] = []
      const renderedBlocks: Array<readonly string[]> = []
      let measuredCells = 0
      let measuredRows = 0
      for (const row of rows) {
        if (measuredCells >= MAX_MEASURED_CELLS) break
        const streaming = input.transcript.streamingRowId === row.rowId || !row.settled
        const lines = renderRow(row, streaming, width)
        let rowCells = 0
        for (const line of lines) rowCells += lineToCells(line, profile).length
        if (measuredCells + rowCells > MAX_MEASURED_CELLS && entries.length > 0) break
        measuredCells += rowCells
        measuredRows += 1
        entries.push({ rowId: row.rowId, height: lines.length })
        renderedBlocks.push(lines)
      }
      heightIndex = buildHeightIndex(entries)
      const unmeasuredRows = allRows.length - measuredRows

      // ---- scroll window ----------------------------------------------------
      const contentHeight = heightIndex.totalHeight
      const maxScroll = Math.max(0, contentHeight - transcriptHeight)
      let scrollTopLine: number
      if (pendingAnchorFallback) {
        // The epoch reset above dropped a live anchor: explicit policy (§6.2).
        pendingAnchorFallback = false
        scrollTopLine = anchorFallback === 'top' ? 0 : maxScroll
      } else if (input.sticky || anchor === null) {
        scrollTopLine = maxScroll
      } else {
        // Invariant: a live anchor always carries the current epoch (the
        // epoch-reset branch above clears it otherwise).
        const base = heightIndex.offsetOf(anchor.rowId)
        if (base === undefined) {
          // Row evicted from the measured window: explicit fallback + diagnostic.
          anchorFallbacks += 1
          scrollTopLine = anchorFallback === 'top' ? 0 : maxScroll
        } else {
          scrollTopLine = Math.min(Math.max(0, base + anchor.intraRowOffset), maxScroll)
        }
      }

      const transcriptLines: string[] = []
      const allLines = renderedBlocks.flat()
      const windowLines = allLines.slice(scrollTopLine, scrollTopLine + transcriptHeight)
      // Bottom-align content inside the region (fullscreen dock sits at the bottom).
      for (let i = windowLines.length; i < transcriptHeight; i++) transcriptLines.push('')
      for (const line of windowLines) transcriptLines.push(line)
      if (input.transcript.showUnseenIndicator && transcriptHeight > 0) {
        const indicator = cellsToString(
          padCells(
            styledCells(`↓ ${input.transcript.unseenCount} new message${input.transcript.unseenCount === 1 ? '' : 's'}`, UNSEEN_STYLE, profile),
            width,
          ),
        )
        transcriptLines[transcriptHeight - 1] = assertLineWidth(indicator, profile, width)
      }

      const outLines = [...transcriptLines, ...dockLines].map((line) => assertLineWidth(line, profile, width))

      // ---- cursor (editor-owned, mapped into dock coordinates) --------------
      let cursor: BaseRenderOutput['cursor']
      const focusable = editorComponent as Partial<Focusable>
      if (focusable.focused === true && focusable.cursor !== undefined && focusable.cursor.visible) {
        // Editor block starts after notifications/activity; status lines sit below it.
        const editorTop = transcriptHeight + (dockLines.length - editorLines.length - statusLines.length)
        cursor = {
          x: Math.min(Math.max(0, focusable.cursor.x), Math.max(0, width - 1)),
          y: editorTop + focusable.cursor.y,
          visible: true,
        }
      }

      return {
        lines: outLines,
        ...(cursor !== undefined ? { cursor } : {}),
        diagnostics: {
          transcriptHeight,
          dockHeight,
          measuredRows,
          measuredCells,
          unmeasuredRows,
          scrollTopLine,
          anchorFallbacks,
          fullRedraw,
        },
      }
    },
  }
  return renderer
}

/**
 * Last-resort row rendering when the registry has no component for a kind:
 * sanitized plain text, dimmed, piped through the width pipeline like every
 * other line (untrusted block text must never bypass sanitizeText).
 *
 * Exported for the coordinator's plugin-row factory (WP-08a): a plugin row
 * without a registered renderer — or a renderer that threw — renders exactly
 * this fallback.
 */
export function fallbackRowComponent(row: UiRowSnapshot, profile: TerminalProfile): Component {
  const style = lineStyle({ dim: true })
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const text = row.blocks
        .map((block) =>
          typeof block === 'object' && block !== null && !Array.isArray(block) && 'text' in block
            ? String((block as { text: unknown }).text)
            : '',
        )
        .join('\n')
      return text.split('\n').map((line) => {
        const cells = styledCells(line, style, profile)
        return cellsToString(truncateCells(cells, width))
      })
    },
    invalidate() {},
  }
}
