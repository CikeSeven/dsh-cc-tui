/**
 * tui-v2 inline live-region hint (WP-07, plan §WP-07).
 *
 * Computes `FrameMetadata.inline` for the inline backend. The frame = screen
 * invariant (§15.1 WP-07): physical screen row i always mirrors frame row i.
 * Rows [0..liveStart) are settled transcript lines — the append-only
 * candidates that may leave the screen only INTO scrollback (a bottom-row LF
 * on a full-height main-screen region), never mutate in place. Rows
 * [liveStart..height) are the mutable live region (streaming rows, the
 * new-message indicator, the whole dock) that the backend repaints in place.
 *
 * `followEnd` gates the scroll primitive: it is true only when the transcript
 * window is pinned to the content end in THIS frame and was in the previous
 * frame too (coordinator-tracked). Growth at the end then shifts content up
 * monotonically, so the lines a scroll pushes into scrollback are always
 * departing for the first time — never duplicates. While the user browses
 * (anchor held) or on the frame that returns to follow-end, the backend must
 * repaint in place and feed nothing.
 *
 * Conservative direction: when in doubt the live region grows (more in-place
 * repaint, fewer appends). A streaming/unsettled row is never classified as
 * settled; an unknown row id is mutable.
 *
 * Pure and shared: the coordinator (renderOnce) and the inline harness use
 * this one implementation.
 */
import type { HeightIndex } from '../renderer/base-renderer.js';
import type { InlineFrameHint } from '../renderer/frame.js';

export interface InlineLiveRegionInput {
  /** Physical rows reserved for the transcript (frame rows [0..transcriptHeight)). */
  readonly transcriptHeight: number;
  /** First content line shown in the window (base-renderer diagnostics). */
  readonly scrollTopLine: number;
  /** Measured row window of THIS render (baseRenderer.heightIndex). */
  readonly heightIndex: HeightIndex;
  /**
   * Row mutability, mirroring the base-renderer's own streaming test
   * (`streamingRowId === rowId || !row.settled`). Unknown ids must answer true.
   */
  readonly isMutableRow: (rowId: string) => boolean;
  /** The new-message indicator rewrites the last transcript row live. */
  readonly showUnseenIndicator: boolean;
  /** Window pinned to the content end in this frame AND the previous one. */
  readonly followEnd: boolean;
}

export function computeInlineLiveRegion(input: InlineLiveRegionInput): InlineFrameHint {
  const { transcriptHeight, scrollTopLine, heightIndex } = input;
  if (transcriptHeight <= 0) return { liveStart: 0, followEnd: input.followEnd };
  const visibleLines = Math.max(0, Math.min(transcriptHeight, heightIndex.totalHeight - scrollTopLine));
  // Bottom-aligned region: blank pad rows sit above the first visible line.
  const pad = transcriptHeight - visibleLines;
  const windowEnd = scrollTopLine + visibleLines;
  let liveStart = transcriptHeight;
  for (let i = 0; i < heightIndex.rowIds.length; i++) {
    const rowStart = heightIndex.lineOffsets[i] as number;
    const rowEnd = rowStart + (heightIndex.heights[i] as number);
    const firstVisible = Math.max(rowStart, scrollTopLine);
    if (firstVisible >= Math.min(rowEnd, windowEnd)) continue; // row not visible
    if (input.isMutableRow(heightIndex.rowIds[i] as string)) {
      // Rows are ordered top -> bottom: the first visible mutable row is the
      // topmost one, hence the smallest physical position.
      liveStart = pad + (firstVisible - scrollTopLine);
      break;
    }
  }
  if (input.showUnseenIndicator) {
    liveStart = Math.min(liveStart, transcriptHeight - 1);
  }
  return { liveStart: Math.max(0, Math.min(transcriptHeight, liveStart)), followEnd: input.followEnd };
}
