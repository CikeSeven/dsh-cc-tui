/**
 * Base-renderer lines → Frame bridge (WP-04).
 *
 * The base renderer emits styled logical lines (ANSI-encoded strings, width
 * guaranteed ≤ viewport by the §6.1 pipeline). The screen backends plan
 * TerminalPatches against cell-grid Frames. This module converts one render
 * output into a Frame:
 *
 *  - every line is decoded through lineToCells (§6.1 width semantics), then
 *    truncated/padded to exactly `width` cells with default-styled blanks, so
 *    the frame is always a dense width*height grid;
 *  - LineStyle objects are interned into the frame's style pool (id 0 is
 *    always DEFAULT_LINE_STYLE); hyperlink uris into the hyperlink pool;
 *  - the mode snapshot is supplied by the caller (the terminal lifecycle's
 *    currentModeSnapshot) — this module never invents terminal state.
 *
 * This is the WP-04 walking-skeleton bridge: WP-06 replaces string lines
 * with a native cell pipeline inside the renderer, at which point this
 * conversion disappears. Until then, per-frame interning keeps the patch
 * planner's resource ops correct (the pool is rebuilt per frame; the
 * planner emits `resources` ops on pool changes).
 */

import type {
  Frame,
  FrameMetadata,
  HyperlinkDescriptor,
  StyleDescriptor,
  TerminalCell,
  TerminalModeSnapshot,
} from '../renderer/frame.js';
import {
  DEFAULT_LINE_STYLE,
  lineStyleKey,
  lineToCells,
  type LineStyle,
} from '../renderer/lines.js';
import type { TerminalProfile } from '../terminal/profile.js';

export interface LinesToFrameOptions {
  readonly profile: TerminalProfile;
  readonly width: number;
  readonly height: number;
  readonly stateRevision: number;
  readonly generation: number;
  readonly modes: TerminalModeSnapshot;
  readonly cursor: { readonly x: number; readonly y: number; readonly visible: boolean };
  readonly fullRedraw: boolean;
  readonly renderMs: number;
  readonly fullRedrawReason?: FrameMetadata['fullRedrawReason'];
  /** Monotonic frame counter source (caller-owned). */
  readonly frameSeq: number;
}

const BLANK_CELL: TerminalCell = Object.freeze({ grapheme: ' ', width: 1, styleId: 0 });

function toDescriptor(id: number, style: LineStyle): StyleDescriptor {
  return { id, ...style };
}

export function linesToFrame(lines: readonly string[], options: LinesToFrameOptions): Frame {
  const { width, height } = options;
  const styles = new Map<string, StyleDescriptor>();
  const hyperlinks = new Map<string, HyperlinkDescriptor>();
  styles.set(lineStyleKey(DEFAULT_LINE_STYLE), toDescriptor(0, DEFAULT_LINE_STYLE));

  const styleIdFor = (style: LineStyle): number => {
    const key = lineStyleKey(style);
    const known = styles.get(key);
    if (known !== undefined) return known.id;
    const id = styles.size;
    styles.set(key, toDescriptor(id, style));
    return id;
  };
  const hyperlinkIdFor = (uri: string): number => {
    const known = hyperlinks.get(uri);
    if (known !== undefined) return known.id;
    const id = hyperlinks.size;
    hyperlinks.set(uri, { id, uri });
    return id;
  };

  const cells: TerminalCell[] = [];
  const rowCount = Math.max(0, Math.min(height, lines.length));
  for (let y = 0; y < rowCount; y++) {
    const lineCells = lineToCells(lines[y] ?? '', options.profile);
    let column = 0;
    for (const cell of lineCells) {
      if (column >= width) break;
      // Never split a wide glyph at the right edge: replace it (and its
      // continuation slot) with blanks rather than emitting a torn cell.
      if (cell.width === 2 && column + 1 >= width) {
        cells.push(BLANK_CELL);
        column += 1;
        continue;
      }
      const styleId = styleIdFor(cell.style);
      const out: TerminalCell =
        cell.hyperlink === null
          ? { grapheme: cell.grapheme, width: cell.width, styleId }
          : { grapheme: cell.grapheme, width: cell.width, styleId, hyperlinkId: hyperlinkIdFor(cell.hyperlink) };
      cells.push(out);
      column += cell.width === 0 ? 0 : cell.width;
    }
    while (column < width) {
      cells.push(BLANK_CELL);
      column += 1;
    }
  }
  // Pad missing rows (the renderer normally emits exactly `height` lines).
  while (cells.length < width * Math.max(0, height)) cells.push(BLANK_CELL);

  return {
    frameId: `frame-${options.frameSeq}`,
    stateRevision: options.stateRevision,
    width,
    height: Math.max(0, height),
    stride: width,
    cells,
    cursor: options.cursor,
    modes: options.modes,
    resources: {
      styles: [...styles.values()],
      hyperlinks: [...hyperlinks.values()],
    },
    images: [],
    layers: [],
    generation: options.generation,
    fullRedraw: options.fullRedraw,
    metadata: {
      changedRows: 0,
      renderMs: options.renderMs,
      diffMs: 0,
      terminalProfileId: options.profile.id,
      ...(options.fullRedrawReason !== undefined ? { fullRedrawReason: options.fullRedrawReason } : {}),
    },
  };
}
