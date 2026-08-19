/**
 * tui-v2 layout geometry (WP-04b, plan §5.1/§6.2).
 *
 * Pure functions only: vertical stacking, height aggregation, visible-window
 * slicing over variable-height items, and overlay anchor geometry. No
 * component, terminal or node imports — the base renderer (WP-04b) and the
 * compositor (WP-06) consume these.
 */

// ---------------------------------------------------------------------------
// Vertical stacking / heights
// ---------------------------------------------------------------------------

/** Total height of vertically stacked blocks. */
export function totalHeight(heights: readonly number[]): number {
  let sum = 0
  for (const height of heights) sum += Math.max(0, height)
  return sum
}

/** Prefix sums: result[i] = sum of heights[0..i); result.length === heights.length + 1. */
export function prefixSums(heights: readonly number[]): number[] {
  const out: number[] = [0]
  for (const height of heights) out.push(out[out.length - 1] as number + Math.max(0, height))
  return out
}

/** Concatenate already-rendered line blocks top to bottom (v-stack semantics). */
export function stackLines(blocks: readonly (readonly string[])[]): string[] {
  const out: string[] = []
  for (const block of blocks) out.push(...block)
  return out
}

// ---------------------------------------------------------------------------
// Visible window over variable-height items
// ---------------------------------------------------------------------------

export interface VisibleWindow {
  /** First item index intersecting the window; -1 when empty. */
  readonly startIndex: number
  /** One past the last intersecting item index; 0 when empty. */
  readonly endIndex: number
  /** Lines of the start item clipped above the window (>= 0). */
  readonly startClipTop: number
  /** Total content height in lines. */
  readonly contentHeight: number
}

/**
 * Slice the window `[scrollTop, scrollTop + viewportHeight)` (line units) out
 * of a variable-height item stack. Pure geometry: the caller maps the index
 * range back to rows/cells.
 */
export function sliceVisibleWindow(
  heights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
): VisibleWindow {
  const sums = prefixSums(heights)
  const contentHeight = sums[sums.length - 1] as number
  if (viewportHeight <= 0 || heights.length === 0) {
    return { startIndex: -1, endIndex: 0, startClipTop: 0, contentHeight }
  }
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, contentHeight - 1)))
  const bottom = Math.min(contentHeight, top + viewportHeight)
  let startIndex = -1
  let endIndex = 0
  let startClipTop = 0
  for (let i = 0; i < heights.length; i++) {
    const itemTop = sums[i] as number
    const itemBottom = sums[i + 1] as number
    if (itemBottom <= top || itemTop >= bottom) continue
    if (startIndex === -1) {
      startIndex = i
      startClipTop = top - itemTop
    }
    endIndex = i + 1
  }
  return { startIndex, endIndex, startClipTop, contentHeight }
}

// ---------------------------------------------------------------------------
// Overlay geometry (§5.1 options -> absolute rect; consumed by WP-06 compositor)
// ---------------------------------------------------------------------------

export interface OverlayRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** True when the resolved rect had to be clamped to the terminal bounds. */
  readonly clip: boolean
}

export interface OverlayGeometryInput {
  readonly anchor: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top-center' | 'bottom-center' | 'left-center' | 'right-center'
  readonly minWidth?: number | `${number}%`
  readonly width?: number | `${number}%`
  readonly maxHeight?: number | `${number}%`
  readonly row?: number | `${number}%`
  readonly col?: number | `${number}%`
  readonly margin?: number | { readonly top?: number; readonly right?: number; readonly bottom?: number; readonly left?: number }
  readonly offsetX?: number
  readonly offsetY?: number
  /** Measured content size; height collapses to content when no explicit size. */
  readonly contentWidth: number
  readonly contentHeight: number
}

/** Resolve a `number | '<n>%'` dimension against a total; percentages floor. */
export function resolveDimension(value: number | `${number}%` | undefined, total: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') return Math.max(0, Math.floor(value))
  const percent = Number.parseFloat(value.slice(0, -1))
  if (!Number.isFinite(percent)) return undefined
  return Math.max(0, Math.floor((percent / 100) * total))
}

function marginEdges(margin: OverlayGeometryInput['margin']): { top: number; right: number; bottom: number; left: number } {
  if (margin === undefined) return { top: 0, right: 0, bottom: 0, left: 0 }
  if (typeof margin === 'number') return { top: margin, right: margin, bottom: margin, left: margin }
  return {
    top: margin.top ?? 0,
    right: margin.right ?? 0,
    bottom: margin.bottom ?? 0,
    left: margin.left ?? 0,
  }
}

/**
 * Resolve overlay options to an absolute rect inside the terminal. Explicit
 * `row`/`col` (absolute or percent of the margined box) override the anchor;
 * otherwise the anchor pins the rect inside the margined box. Results are
 * clamped to the terminal bounds; `clip` reports that clamping happened.
 */
export function overlayGeometry(
  input: OverlayGeometryInput,
  termWidth: number,
  termHeight: number,
): OverlayRect {
  const margin = marginEdges(input.margin)
  const boxX = margin.left
  const boxY = margin.top
  const boxWidth = Math.max(0, termWidth - margin.left - margin.right)
  const boxHeight = Math.max(0, termHeight - margin.top - margin.bottom)

  const explicitWidth = resolveDimension(input.width, boxWidth)
  const minWidth = resolveDimension(input.minWidth, boxWidth) ?? 0
  const maxHeight = resolveDimension(input.maxHeight, boxHeight)
  let clip = false
  let width = explicitWidth ?? Math.max(0, input.contentWidth)
  if (minWidth > 0) width = Math.max(width, minWidth)
  if (width > boxWidth) clip = true // content/explicit size exceeds the box
  width = Math.min(width, boxWidth)
  let height = Math.max(0, input.contentHeight)
  if (maxHeight !== undefined) height = Math.min(height, maxHeight)
  if (height > boxHeight) clip = true
  height = Math.min(height, boxHeight)

  const col = resolveDimension(input.col, boxWidth)
  const row = resolveDimension(input.row, boxHeight)
  let x: number
  let y: number
  if (col !== undefined) {
    x = boxX + col
  } else {
    switch (input.anchor) {
      case 'top-left':
      case 'bottom-left':
      case 'left-center':
        x = boxX
        break
      case 'top-right':
      case 'bottom-right':
      case 'right-center':
        x = boxX + Math.max(0, boxWidth - width)
        break
      default:
        x = boxX + Math.max(0, Math.floor((boxWidth - width) / 2))
    }
  }
  if (row !== undefined) {
    y = boxY + row
  } else {
    switch (input.anchor) {
      case 'top-left':
      case 'top-right':
      case 'top-center':
        y = boxY
        break
      case 'bottom-left':
      case 'bottom-right':
      case 'bottom-center':
        y = boxY + Math.max(0, boxHeight - height)
        break
      default:
        y = boxY + Math.max(0, Math.floor((boxHeight - height) / 2))
    }
  }
  x += input.offsetX ?? 0
  y += input.offsetY ?? 0

  if (x < 0) { clip = true; x = 0 }
  if (y < 0) { clip = true; y = 0 }
  if (x + width > termWidth) { clip = true; width = Math.max(0, termWidth - x) }
  if (y + height > termHeight) { clip = true; height = Math.max(0, termHeight - y) }
  return { x, y, width, height, clip }
}
