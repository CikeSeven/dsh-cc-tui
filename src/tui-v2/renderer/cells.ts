/**
 * tui-v2 cell pipeline (WP-06a, plan §5.5/§6.1).
 *
 * This module is the bridge between the line-level stage (components emit
 * styled logical-line strings, `lines.ts`) and the cell-level stage (Frame,
 * compositor, diff, writer). Everything a component produced is re-parsed
 * here — never trusted blindly:
 *
 *   logical line string
 *     -> tokenizeAnsi        (SGR + OSC 8 in; every other CSI/OSC/APC/DEC/C0
 *                             consumed and COUNTED in CellPipelineDiagnostics)
 *     -> tokensToCells       (grapheme segmentation + TerminalProfile width,
 *                             tabstop 3 expansion; lines.ts state machine)
 *     -> fitCellsToWidth     (clip to the viewport width — the §5.5
 *                             assertLineWidth hard guard — then pad with
 *                             explicitly styled blanks)
 *     -> terminalCellsFromLineCells (intern LineStyle/uri into the frame-local
 *                             ResourceTable; emit TerminalCell with styleId /
 *                             hyperlinkId)
 *
 * Trust boundary (§6.1): `trustedLineCells` accepts component output (whose
 * ANSI may only come from the trusted style builders in lines.ts);
 * `untrustedLineCells` is for user prompts, tool output, plugin text and
 * child output — it runs `sanitizeText` first, so no CSI/OSC 8/52, title or
 * image sequence can survive into a frame, and re-styles the plain text with
 * one uniform style. The `diagnostics` sink doubles as the fuzz hook: any
 * byte string may be driven through either entry point and the dropped-control
 * count observed.
 *
 * Resource identity (§5.5): styleId/hyperlinkId are FRAME-LOCAL. The
 * ResourceTable assigns ids by content hash + registration order (id 0 is
 * pinned to the default style), and `snapshot()` exports full
 * StyleDescriptor/HyperlinkDescriptor definitions keyed by their explicit
 * `id` field — consumers (encodeCells, canonicalizeFrame,
 * applyPatchToCanonicalGrid) resolve through a Map keyed by `id`, never by
 * array position. Ids must never be borrowed across frames.
 *
 * Dependency rule (§4.3): renderer imports `import type` from terminal only.
 */
import type { TerminalProfile } from '../terminal/profile.js'
import type {
  FrameResources,
  HyperlinkDescriptor,
  StyleDescriptor,
  TerminalCell,
} from './frame.js'
import {
  DEFAULT_LINE_STYLE,
  lineStyleEquals,
  lineStyleKey,
  sanitizeText,
  sharedGraphemeWidthCache,
  tokenizeAnsi,
  tokensToCells,
  type GraphemeWidthCache,
  type LineCell,
  type LineStyle,
} from './lines.js'

// ---------------------------------------------------------------------------
// Canonical color spellings (frame resources carry the testkit-canonical form)
// ---------------------------------------------------------------------------

const NAMED_TO_ANSI16: Readonly<Record<string, number>> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  'bright-black': 8,
  'bright-red': 9,
  'bright-green': 10,
  'bright-yellow': 11,
  'bright-blue': 12,
  'bright-magenta': 13,
  'bright-cyan': 14,
  'bright-white': 15,
}

/**
 * Normalize a LineStyle color string to the canonical spelling the testkit
 * canonical grid uses (`virtual-terminal.ts`): named/bright colors are the
 * ansi16 palette (`red` -> `ansi16:1`), low 256-palette entries collapse to
 * ansi16 (`ansi256:1` -> `ansi16:1`), truecolor is `rgb:rrggbb` lowercase.
 * The writer encodes identical bytes either way ('red' and 'ansi16:1' both
 * emit SGR 31); canonical spellings make frames byte-comparable to virtual
 * terminal snapshots and dedupe semantically identical styles to one id.
 */
export function canonicalizeColorSpelling(color: string): string {
  const named = NAMED_TO_ANSI16[color]
  if (named !== undefined) return `ansi16:${named}`
  const ansi256 = /^ansi256:(\d{1,3})$/.exec(color)
  if (ansi256 !== null) {
    const n = Math.min(255, Number.parseInt(ansi256[1] as string, 10))
    return n < 16 ? `ansi16:${n}` : `ansi256:${n}`
  }
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color)
  if (hex !== null) return `rgb:${(hex[1] as string).toLowerCase()}`
  return color // 'ansi16:<n>' and 'rgb:rrggbb' are already canonical
}

function canonicalizeStyle(style: LineStyle): LineStyle {
  const foreground = style.foreground === null ? null : canonicalizeColorSpelling(style.foreground)
  const background = style.background === null ? null : canonicalizeColorSpelling(style.background)
  if (foreground === style.foreground && background === style.background) return style
  return { ...style, foreground, background }
}

// ---------------------------------------------------------------------------
// ResourceTable: frame-local style/hyperlink interning (§5.5)
// ---------------------------------------------------------------------------

export interface ResourceTable {
  /** Id of the interned style; identical styles share one id within the frame. */
  internStyle(style: LineStyle): number
  /** Id of the interned hyperlink; identical (uri, params) share one id. */
  internHyperlink(uri: string, params?: string): number
  /**
   * Full definitions for every id handed out so far, sorted by id. Each call
   * returns fresh descriptor copies; the ids remain stable for the lifetime of
   * the table (one table == one frame build).
   */
  snapshot(): FrameResources
}

/**
 * Content-keyed interning pool. Id 0 is ALWAYS the default style, so padding
 * blanks and unstyled text share one deterministic id and the writer's
 * reset-first SGR for id 0 is the canonical "terminal default" encoding.
 * Styles are interned under their canonical color spellings
 * (`canonicalizeColorSpelling`), so frame resources compare byte-for-byte
 * with virtual-terminal snapshots.
 */
export function createResourceTable(): ResourceTable {
  const styleIdByKey = new Map<string, number>()
  const linkIdByKey = new Map<string, number>()
  const styles: StyleDescriptor[] = []
  const hyperlinks: HyperlinkDescriptor[] = []

  const internStyle = (lineStyle: LineStyle): number => {
    const style = canonicalizeStyle(lineStyle)
    const key = lineStyleKey(style)
    const known = styleIdByKey.get(key)
    if (known !== undefined) return known
    const id = styles.length
    const descriptor: StyleDescriptor = { id, ...style }
    styles.push(descriptor)
    styleIdByKey.set(key, id)
    return id
  }
  const internHyperlink = (uri: string, params?: string): number => {
    if (typeof uri !== 'string' || uri.length === 0) {
      throw new TypeError('hyperlink uri must be a non-empty string')
    }
    const key = `${params ?? ''}\x00${uri}`
    const known = linkIdByKey.get(key)
    if (known !== undefined) return known
    const id = hyperlinks.length
    const descriptor: HyperlinkDescriptor =
      params === undefined ? { id, uri } : { id, uri, params }
    hyperlinks.push(descriptor)
    linkIdByKey.set(key, id)
    return id
  }

  internStyle(DEFAULT_LINE_STYLE)

  return {
    internStyle,
    internHyperlink,
    snapshot() {
      const stylesOut = styles.map((style) => ({ ...style }))
      const hyperlinksOut = hyperlinks.map((link) => ({ ...link }))
      // Defensive: the contract requires unique ids resolvable BY id. Ids are
      // assigned densely in registration order, so sorting is a no-op that
      // keeps the invariant explicit rather than implied by push order.
      stylesOut.sort((a, b) => a.id - b.id)
      hyperlinksOut.sort((a, b) => a.id - b.id)
      return { styles: stylesOut, hyperlinks: hyperlinksOut }
    },
  }
}

// ---------------------------------------------------------------------------
// Diagnostics (also the fuzz hook, §6.1)
// ---------------------------------------------------------------------------

export interface CellPipelineDiagnostics {
  /**
   * Escape/control sequences dropped before cells are emitted: tokenizer-level
   * drops for trusted input, plus the sequences `sanitizeText` removed from
   * untrusted input (counted by their ESC/C1 introducer).
   */
  droppedControls: number
  /** Logical lines whose content did not fit and had to be clipped. */
  clippedLines: number
  /** Wide graphemes dropped because they straddled the right edge. */
  overwideGraphemes: number
}

export function createCellPipelineDiagnostics(): CellPipelineDiagnostics {
  return { droppedControls: 0, clippedLines: 0, overwideGraphemes: 0 }
}

export interface CellPipelineOptions {
  readonly cache?: GraphemeWidthCache
  readonly diagnostics?: CellPipelineDiagnostics
}

// ---------------------------------------------------------------------------
// Trust-boundary entry points (§6.1)
// ---------------------------------------------------------------------------

/**
 * TRUSTED styled input: component output whose ANSI comes only from the
 * lines.ts style builders. SGR and OSC 8 are honored; every other escape
 * class is consumed, dropped and counted. The output carries per-cell
 * LineStyle/uri (not yet interned).
 */
export function trustedLineCells(
  raw: string,
  profile: TerminalProfile,
  options: CellPipelineOptions = {},
): LineCell[] {
  const tokens = tokenizeAnsi(raw)
  if (options.diagnostics !== undefined) {
    let dropped = 0
    for (const token of tokens) {
      if (token.kind === 'control') dropped += 1
    }
    options.diagnostics.droppedControls += dropped
  }
  return tokensToCells(tokens, profile, options.cache ?? sharedGraphemeWidthCache)
}

/**
 * UNTRUSTED plain input: user prompts, tool output, plugin text, child
 * output. The text is stripped of every terminal control first
 * (`sanitizeText`) and then re-colored with exactly one uniform style, so
 * hostile bytes can never smuggle CSI/OSC 8/52, title or image sequences
 * into a frame.
 */
export function untrustedLineCells(
  text: string,
  style: LineStyle,
  profile: TerminalProfile,
  options: CellPipelineOptions = {},
): LineCell[] {
  if (options.diagnostics !== undefined) {
    // Count the escape introducers sanitizeText is about to remove, so the
    // diagnostic reflects what was stripped from the untrusted input (the
    // cleaned text itself tokenizes to zero drops).
    let introducers = 0
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i)
      if (cp === 0x1b || cp === 0x9b || cp === 0x9d || cp === 0x90) introducers += 1
    }
    options.diagnostics.droppedControls += introducers
  }
  const clean = sanitizeText(text)
  const cells = trustedLineCells(clean, profile, options)
  if (lineStyleEquals(style, DEFAULT_LINE_STYLE)) return cells
  return cells.map((cell) => ({ ...cell, style }))
}

// ---------------------------------------------------------------------------
// fitCellsToWidth: the frame-level §5.5 width hard guard
// ---------------------------------------------------------------------------

/**
 * Clip a cell sequence to at most `width` columns and pad with explicitly
 * styled blank cells to EXACTLY `width` columns (§5.5: blank cells carry a
 * style; every physical row ends with `assertLineWidth <= viewport.width`).
 *
 * Clipping rule: the first grapheme that does not fit ends the row (a wide
 * grapheme straddling the right edge is dropped whole — never split, never
 * half-written). This is the "裁剪" option §5.5 allows for over-wide
 * graphemes; unlike the component-side string replay, a frame row must emit
 * one terminal column per cell, so the empty-grapheme substitute
 * (lines.ts OVERWIDE_SUBSTITUTE) is never used here — padding is real
 * spaces with the default style.
 *
 * `width <= 0` yields an empty sequence (never a repeat/recursion, §6.1).
 */
export function fitCellsToWidth(
  cells: readonly LineCell[],
  width: number,
  diagnostics?: CellPipelineDiagnostics,
): LineCell[] {
  if (width <= 0) return []
  const out: LineCell[] = []
  let column = 0
  let clipped = false
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as LineCell
    if (cell.width === 0 && cell.grapheme === '') continue // continuation rides with its owner
    if (column + cell.width > width) {
      clipped = true
      if (cell.width === 2 && diagnostics !== undefined) diagnostics.overwideGraphemes += 1
      break
    }
    out.push(cell)
    column += cell.width
    if (cell.width === 2) {
      const continuation = cells[i + 1]
      if (continuation !== undefined && continuation.width === 0 && continuation.grapheme === '') {
        out.push(continuation)
      }
    }
  }
  if (clipped && diagnostics !== undefined) diagnostics.clippedLines += 1
  while (column < width) {
    out.push({ grapheme: ' ', width: 1, style: DEFAULT_LINE_STYLE, hyperlink: null })
    column += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// LineCell -> TerminalCell (resource interning)
// ---------------------------------------------------------------------------

/** Intern every cell's style/hyperlink and emit the §5.5 TerminalCell shape. */
export function terminalCellsFromLineCells(
  cells: readonly LineCell[],
  table: ResourceTable,
): TerminalCell[] {
  return cells.map((cell) => {
    const styleId = table.internStyle(cell.style)
    if (cell.hyperlink === null) {
      return { grapheme: cell.grapheme, width: cell.width, styleId }
    }
    return {
      grapheme: cell.grapheme,
      width: cell.width,
      styleId,
      hyperlinkId: table.internHyperlink(cell.hyperlink),
    }
  })
}

/** Trusted line -> interned TerminalCells, without width fitting. */
export function terminalCellsFromTrustedLine(
  raw: string,
  profile: TerminalProfile,
  table: ResourceTable,
  options: CellPipelineOptions = {},
): TerminalCell[] {
  return terminalCellsFromLineCells(trustedLineCells(raw, profile, options), table)
}

/** Untrusted text -> interned TerminalCells under one uniform style. */
export function terminalCellsFromUntrustedText(
  text: string,
  style: LineStyle,
  profile: TerminalProfile,
  table: ResourceTable,
  options: CellPipelineOptions = {},
): TerminalCell[] {
  return terminalCellsFromLineCells(untrustedLineCells(text, style, profile, options), table)
}
