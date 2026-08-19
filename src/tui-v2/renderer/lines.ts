/**
 * tui-v2 unified width pipeline (WP-04b, plan §6.1).
 *
 * Every text that is measured, wrapped, truncated or positioned goes through
 * exactly this pipeline, in this order:
 *
 *   raw string
 *     -> ANSI/OSC tokenization        (`tokenizeAnsi`)
 *     -> grapheme segmentation        (`segmentGraphemes`, Intl.Segmenter)
 *     -> TerminalProfile width calc   (`graphemeWidth`, pinned get-east-asian-width)
 *     -> cell sequence                (`lineToCells`, TerminalCell-aligned)
 *     -> wrap/truncate/clip           (`wrapCells`/`truncateCells`/`padCells`)
 *     -> styled line/cell output      (`cellsToString`/`assertLineWidth`)
 *
 * Width semantics MUST stay byte-aligned with the WP-02 oracle
 * (`testkit/virtual-terminal.ts` `measureGrapheme`): max over the grapheme's
 * code points of `eastAsianWidth`, Mn/Mc/Me/Cf zero, C0/C1/DEL zero for the
 * whole cluster. Differential tests cross-check this file against the oracle.
 *
 * Fixed implementation parameters (§6.1): tabstop 3 expanded by current
 * column; C0/control width 0 and stripped from output; ZWJ/RI/VS measured as
 * one whole grapheme; RTL kept in logical order (no bidi shaping in v2);
 * `ambiguousWidth` comes from the TerminalProfile ('unknown' => narrow, the
 * conservative default of §5.4).
 *
 * Tokenizer choice (§6.1 "评估后决定用哪个"): `@alcalzone/ansi-tokenize` was
 * evaluated and rejected for this pipeline — its `tokenize()` treats
 * unrecognized CSI (cursor moves, erases) as printable `char` tokens (hostile
 * input would leak into cells), its `fullWidth` flag is not TerminalProfile
 * driven, and its grapheme segmenter is not the pinned `('und')` instance.
 * `wrap-ansi`/`strip-ansi` compose the same non-profile width semantics, so
 * they are rejected for the same reason. The scanner below is a small
 * deterministic state machine over the exact sequence classes §6.1 names
 * (SGR, OSC 8, tab, C0/DEC controls).
 *
 * Dependency rule (§4.3): renderer imports `import type` from terminal/model
 * only; the SGR replay encoder below intentionally mirrors
 * `terminal/ansi.ts` `sgrStyle` param order (0,attrs,fg,bg) because the
 * runtime builder lives behind the writer boundary and cannot be imported
 * here. WP-06 re-encodes cells through `sgrStyle` for writer output.
 */
import { eastAsianWidth } from 'get-east-asian-width'

import type { TerminalProfile } from '../terminal/profile.js'
import {
  createBoundedCache,
  detachString,
  type BoundedCache,
} from './cache.js'

// ---------------------------------------------------------------------------
// Style model (semantic mirror of renderer/frame.ts StyleDescriptor minus id;
// color strings use the pinned spellings of terminal/ansi.ts colorParams:
// named, 'ansi16:<n>', 'ansi256:<n>', '#rrggbb', 'rgb:rrggbb')
// ---------------------------------------------------------------------------

export interface LineStyle {
  readonly foreground: string | null
  readonly background: string | null
  readonly bold: boolean
  readonly dim: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly inverse: boolean
  readonly strike: boolean
}

export const DEFAULT_LINE_STYLE: LineStyle = Object.freeze({
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
})

export function lineStyle(partial: Partial<LineStyle> = {}): LineStyle {
  return { ...DEFAULT_LINE_STYLE, ...partial }
}

export function lineStyleEquals(a: LineStyle, b: LineStyle): boolean {
  return (
    a.foreground === b.foreground &&
    a.background === b.background &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.strike === b.strike
  )
}

/** Stable identity for grouping/caching; NOT serialized anywhere. */
export function lineStyleKey(style: LineStyle): string {
  return [
    style.foreground ?? '-',
    style.background ?? '-',
    style.bold ? 'B' : '',
    style.dim ? 'D' : '',
    style.italic ? 'I' : '',
    style.underline ? 'U' : '',
    style.inverse ? 'V' : '',
    style.strike ? 'S' : '',
  ].join('|')
}

// ---------------------------------------------------------------------------
// Cells (semantically aligned with renderer/frame.ts TerminalCell: a width-2
// grapheme occupies one cell plus a width-0 continuation cell)
// ---------------------------------------------------------------------------

export interface LineCell {
  readonly grapheme: string
  readonly width: 0 | 1 | 2
  readonly style: LineStyle
  /** OSC 8 uri while the cell is inside a hyperlink; null otherwise. */
  readonly hyperlink: string | null
}

export function cellsWidth(cells: readonly LineCell[]): number {
  let width = 0
  for (const cell of cells) width += cell.width
  return width
}

// ---------------------------------------------------------------------------
// Grapheme segmentation (§6.1: Intl.Segmenter('und', grapheme))
// ---------------------------------------------------------------------------

const graphemeSegmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof (Intl as Record<string, unknown>).Segmenter === 'function'
    ? new Intl.Segmenter('und', { granularity: 'grapheme' })
    : null

/**
 * Segment into grapheme clusters. The plan's vendored fallback (§6.1) is
 * deliberately NOT wired in WP-04: every supported runtime (engines
 * ^22.19 || >=24) ships Intl.Segmenter, so a missing segmenter is a broken
 * runtime and fails loudly here instead of silently diverging from the
 * oracle's width semantics.
 */
export function segmentGraphemes(text: string): string[] {
  if (graphemeSegmenter === null) {
    throw new Error('tui-v2 lines: Intl.Segmenter is unavailable; Node ^22.19 || >=24 is required (plan §6.1)')
  }
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
}

// ---------------------------------------------------------------------------
// Width measurement (pinned get-east-asian-width, profile-driven ambiguous)
// ---------------------------------------------------------------------------

/** §6.1: ambiguousWidth comes from the profile; 'unknown' is treated narrow (§5.4 conservative). */
export function ambiguousAsWide(profile: TerminalProfile): boolean {
  return profile.ambiguousWidth === 2
}

const ZERO_WIDTH_CATEGORY = /\p{Mn}|\p{Mc}|\p{Me}|\p{Cf}/u

/**
 * Column width of one whole grapheme cluster: 0|1|2. Controls (C0/C1/DEL)
 * anywhere in the cluster measure 0; combining/format code points contribute
 * 0; the cluster width is the max of the remaining code points' East Asian
 * widths. ZWJ sequences, regional-indicator pairs and variation-selector
 * clusters are measured whole, never split (§6.1).
 *
 * Must agree with testkit/virtual-terminal.ts measureGrapheme.
 */
export function measureGraphemeWidth(grapheme: string, wide: boolean): 0 | 1 | 2 {
  let width = 0
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0) as number
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0
    if (ZERO_WIDTH_CATEGORY.test(ch)) continue
    const w = eastAsianWidth(cp, { ambiguousAsWide: wide })
    if (w > width) width = w
  }
  return width as 0 | 1 | 2
}

export type GraphemeWidthCache = BoundedCache<string, 0 | 1 | 2>

/**
 * Grapheme -> width memo. Pure measurement cache: keyed with the ambiguous
 * flag, so a profile change can never serve a stale width; cleared on profile
 * change regardless (policy below). Keys are detached copies (§9.3).
 *
 * @cache-budget entries=4096 bytes=524288 eviction=LRU
 */
export function createGraphemeWidthCache(): GraphemeWidthCache {
  return createBoundedCache<string, 0 | 1 | 2>({
    maxEntries: 4096,
    maxBytes: 512 * 1024,
    keyToBytes: (key) => key.length * 2,
    valueToBytes: () => 8,
    detachKey: detachString,
  })
}

/** Invalidation policy for the grapheme width cache (§10.2). */
export const GRAPHEME_WIDTH_CACHE_POLICY = Object.freeze({
  clearOnWidthChange: false,
  clearOnThemeChange: false,
  clearOnProfileChange: true,
  clearOnRowRevisionChange: false,
})

/** Shared default cache so hot paths do not re-measure; explicit caches can be injected for isolation. */
export const sharedGraphemeWidthCache: GraphemeWidthCache = createGraphemeWidthCache()

export function graphemeWidth(
  grapheme: string,
  profile: TerminalProfile,
  cache: GraphemeWidthCache = sharedGraphemeWidthCache,
): 0 | 1 | 2 {
  const wide = ambiguousAsWide(profile)
  const key = (wide ? 'W' : 'N') + grapheme
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const width = measureGraphemeWidth(grapheme, wide)
  cache.set(key, width)
  return width
}

// ---------------------------------------------------------------------------
// ANSI/OSC tokenizer (SGR + OSC 8 state machine input; everything else is
// consumed and dropped so hostile CSI/OSC can never leak into cells)
// ---------------------------------------------------------------------------

export type AnsiToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'sgr'; readonly params: readonly number[] }
  /** OSC 8 open (`uri`) / close (`uri === null`). */
  | { readonly kind: 'osc8'; readonly uri: string | null }
  /** Tab character; expanded against the current column downstream. */
  | { readonly kind: 'tab' }
  /** Consumed control/escape bytes (C0/C1/DEL, DEC, unknown CSI/OSC); never rendered. */
  | { readonly kind: 'control' }

const ESC = 0x1b
const BEL = 0x07
const TAB = 0x09
const LF = 0x0a
const C1_CSI = 0x9b
const C1_OSC = 0x9d
const C1_APC = 0x90

function isC0(cp: number): boolean {
  return cp < 0x20
}
function isC1OrDel(cp: number): boolean {
  return cp >= 0x7f && cp <= 0x9f
}

/** Consume a CSI body starting after the introducer; returns end offset (exclusive). */
function scanCsi(text: string, i: number): { end: number; params: readonly number[]; final: number } {
  const start = i
  // parameter bytes 0x30-0x3f, intermediate bytes 0x20-0x2f, final 0x40-0x7e
  while (i < text.length) {
    const cp = text.charCodeAt(i)
    if (cp >= 0x40 && cp <= 0x7e) {
      const raw = text.slice(start, i)
      // Strip a private-marker prefix (?) and any trailing intermediate bytes.
      const paramPart = raw.replace(/^[?><!]*/, '').replace(/[^0-9;]*$/g, '')
      const params = paramPart === '' ? [] : paramPart.split(';').map((p) => (p === '' ? 0 : Number.parseInt(p, 10)))
      return { end: i + 1, params, final: cp }
    }
    if (cp >= 0x20 && cp <= 0x3f) {
      i += 1
      continue
    }
    break
  }
  // Unterminated or malformed CSI: consume what was scanned as control.
  return { end: Math.max(i, start), params: [], final: -1 }
}

/** Consume an OSC body starting after the introducer; returns end offset + raw content. */
function scanOsc(text: string, i: number): { end: number; content: string } {
  const start = i
  while (i < text.length) {
    const cp = text.charCodeAt(i)
    if (cp === BEL || cp === 0x9c) return { end: i + 1, content: text.slice(start, i) }
    if (cp === ESC && i + 1 < text.length && text.charCodeAt(i + 1) === 0x5c /* \ */) {
      return { end: i + 2, content: text.slice(start, i) }
    }
    i += 1
  }
  return { end: text.length, content: text.slice(start) }
}

/**
 * Split a raw string into pipeline tokens. Untrusted input is safe: every
 * escape/control byte class is consumed here; only `text` tokens reach the
 * grapheme stage, so no CSI/OSC/DEC/C0 byte can be re-emitted as text.
 */
export function tokenizeAnsi(raw: string): AnsiToken[] {
  const tokens: AnsiToken[] = []
  let textRun = ''
  const flushText = (): void => {
    if (textRun !== '') {
      tokens.push({ kind: 'text', text: textRun })
      textRun = ''
    }
  }

  let i = 0
  while (i < raw.length) {
    const cp = raw.charCodeAt(i)
    if (cp === ESC || cp === C1_CSI || cp === C1_OSC || cp === C1_APC) {
      // '[' CSI / ']' OSC / '_' APC (APC is OSC-like: consumed to BEL/ST and
      // dropped — e.g. the pi CURSOR_MARKER APC must never leak as text).
      const next = cp === ESC ? raw.charCodeAt(i + 1) : cp === C1_CSI ? 0x5b : cp === C1_OSC ? 0x5d : 0x5f
      if (next === 0x5b /* [ */) {
        flushText()
        const body = scanCsi(raw, cp === ESC ? i + 2 : i + 1)
        if (body.final === 0x6d /* m */) {
          tokens.push({ kind: 'sgr', params: body.params.length === 0 ? [0] : body.params })
        } else {
          tokens.push({ kind: 'control' })
        }
        i = Math.max(body.end, i + 1)
        continue
      }
      if (next === 0x5d /* ] */ || next === 0x5f /* _ */) {
        flushText()
        const body = scanOsc(raw, cp === ESC ? i + 2 : i + 1)
        // OSC 8 ; params ; uri  — empty uri closes the hyperlink.
        const osc8 = next === 0x5d ? /^8;[^;]*;(.*)$/.exec(body.content) : null
        if (osc8) {
          const uri = osc8[1] as string
          tokens.push({ kind: 'osc8', uri: uri === '' ? null : uri })
        } else {
          tokens.push({ kind: 'control' })
        }
        i = Math.max(body.end, i + 1)
        continue
      }
      // ESC + intermediates (0x20-0x2f) + final (0x30-0x7e): DEC/charset/etc.
      flushText()
      let j = i + 1
      while (j < raw.length) {
        const c = raw.charCodeAt(j)
        if (c >= 0x20 && c <= 0x2f) {
          j += 1
          continue
        }
        if (c >= 0x30 && c <= 0x7e) {
          j += 1
        }
        break
      }
      tokens.push({ kind: 'control' })
      i = Math.max(j, i + 1)
      continue
    }
    if (cp === TAB) {
      flushText()
      tokens.push({ kind: 'tab' })
      i += 1
      continue
    }
    if (isC0(cp) || isC1OrDel(cp)) {
      // C0 (incl. LF — input must be one logical line), C1, DEL: stripped.
      flushText()
      tokens.push({ kind: 'control' })
      i += 1
      continue
    }
    textRun += raw[i]
    i += 1
  }
  flushText()
  return tokens
}

// ---------------------------------------------------------------------------
// SGR application (style state machine)
// ---------------------------------------------------------------------------

const SGR_NAMED_FG: readonly string[] = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

/** Apply one SGR parameter list to a style; mirrors terminal/ansi.ts spellings. */
export function applySgr(style: LineStyle, params: readonly number[]): LineStyle {
  let next = style
  const set = (partial: Partial<LineStyle>): void => {
    next = { ...next, ...partial }
  }
  if (params.length === 0) return DEFAULT_LINE_STYLE
  for (let i = 0; i < params.length; i++) {
    const p = params[i] as number
    if (p === 0) next = DEFAULT_LINE_STYLE
    else if (p === 1) set({ bold: true })
    else if (p === 2) set({ dim: true })
    else if (p === 3) set({ italic: true })
    else if (p === 4) set({ underline: true })
    else if (p === 7) set({ inverse: true })
    else if (p === 9) set({ strike: true })
    else if (p === 22) set({ bold: false, dim: false })
    else if (p === 23) set({ italic: false })
    else if (p === 24) set({ underline: false })
    else if (p === 27) set({ inverse: false })
    else if (p === 29) set({ strike: false })
    else if (p >= 30 && p <= 37) set({ foreground: SGR_NAMED_FG[p - 30] as string })
    else if (p === 39) set({ foreground: null })
    else if (p >= 40 && p <= 47) set({ background: SGR_NAMED_FG[p - 40] as string })
    else if (p === 49) set({ background: null })
    else if (p >= 90 && p <= 97) set({ foreground: `bright-${SGR_NAMED_FG[p - 90]}` })
    else if (p >= 100 && p <= 107) set({ background: `bright-${SGR_NAMED_FG[p - 100]}` })
    else if (p === 38 || p === 48) {
      const foreground = p === 38
      const mode = params[i + 1]
      if (mode === 5 && typeof params[i + 2] === 'number') {
        set(foreground ? { foreground: `ansi256:${params[i + 2]}` } : { background: `ansi256:${params[i + 2]}` })
        i += 2
      } else if (mode === 2 && typeof params[i + 4] === 'number') {
        const hex = [params[i + 2], params[i + 3], params[i + 4]]
          .map((n) => Math.max(0, Math.min(255, n as number)).toString(16).padStart(2, '0'))
          .join('')
        set(foreground ? { foreground: `#${hex}` } : { background: `#${hex}` })
        i += 4
      }
      // Malformed 38/48 without a recognized mode: ignore the parameter.
    }
    // Unknown SGR parameters are ignored (conservative).
  }
  return next
}

// ---------------------------------------------------------------------------
// lineToCells: tokenize -> grapheme segment -> profile width -> cells
// ---------------------------------------------------------------------------

/** §6.1 fixed tabstop: 3, expanded against the current column. */
export const TABSTOP = 3

/**
 * Convert one logical line (no `\n`) into the cell sequence. Wide graphemes
 * emit a trailing width-0 continuation cell; tabs expand to tabstop 3;
 * control bytes never appear in the output (tokenizer stripped them).
 * Graphemes measuring 0 columns are dropped — a width-0 cell is continuation
 * semantics only, never a standalone glyph.
 */
export function lineToCells(
  raw: string,
  profile: TerminalProfile,
  cache: GraphemeWidthCache = sharedGraphemeWidthCache,
): LineCell[] {
  const cells: LineCell[] = []
  let style: LineStyle = DEFAULT_LINE_STYLE
  let hyperlink: string | null = null
  let column = 0
  for (const token of tokenizeAnsi(raw)) {
    switch (token.kind) {
      case 'text': {
        for (const grapheme of segmentGraphemes(token.text)) {
          const width = graphemeWidth(grapheme, profile, cache)
          if (width === 0) continue
          cells.push({ grapheme, width, style, hyperlink })
          if (width === 2) cells.push({ grapheme: '', width: 0, style, hyperlink })
          column += width
        }
        break
      }
      case 'sgr':
        style = applySgr(style, token.params)
        break
      case 'osc8':
        hyperlink = token.uri
        break
      case 'tab': {
        const spaces = TABSTOP - (column % TABSTOP)
        for (let s = 0; s < spaces; s++) cells.push({ grapheme: ' ', width: 1, style, hyperlink })
        column += spaces
        break
      }
      case 'control':
        break
    }
  }
  return cells
}

export function measureLineWidth(
  raw: string,
  profile: TerminalProfile,
  cache: GraphemeWidthCache = sharedGraphemeWidthCache,
): number {
  return cellsWidth(lineToCells(raw, profile, cache))
}

// ---------------------------------------------------------------------------
// Sanitization (§6.1: untrusted text is stripped before components re-style)
// ---------------------------------------------------------------------------

/**
 * Strip every terminal control from untrusted text (user prompts, tool
 * output, plugin text, child output): CSI/OSC/DEC escape sequences, C1
 * controls, DEL and C0 controls. `\n` and `\t` survive (line splitting and
 * tabstop expansion are pipeline jobs). The output is plain text safe to
 * re-style with trusted builders — it can never smuggle CSI/OSC 8/52, title
 * or image sequences into a frame.
 */
export function sanitizeText(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const cp = text.charCodeAt(i)
    if (cp === ESC || cp === C1_CSI || cp === C1_OSC || cp === C1_APC) {
      const next = cp === ESC ? text.charCodeAt(i + 1) : cp === C1_CSI ? 0x5b : cp === C1_OSC ? 0x5d : 0x5f
      if (next === 0x5b) {
        i = Math.max(scanCsi(text, cp === ESC ? i + 2 : i + 1).end, i + 1)
        continue
      }
      if (next === 0x5d || next === 0x5f) {
        i = Math.max(scanOsc(text, cp === ESC ? i + 2 : i + 1).end, i + 1)
        continue
      }
      let j = i + 1
      while (j < text.length) {
        const c = text.charCodeAt(j)
        if (c >= 0x20 && c <= 0x2f) {
          j += 1
          continue
        }
        if (c >= 0x30 && c <= 0x7e) j += 1
        break
      }
      i = Math.max(j, i + 1)
      continue
    }
    if (cp === TAB || cp === LF) {
      out += text[i]
      i += 1
      continue
    }
    if (isC0(cp) || isC1OrDel(cp)) {
      i += 1
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// wrap / truncate / pad (column geometry; never split a wide grapheme)
// ---------------------------------------------------------------------------

/** Substitute shown when a lone wide grapheme cannot fit the viewport at all. */
export const OVERWIDE_SUBSTITUTE = ''

function pushFitted(
  line: LineCell[],
  cell: LineCell,
  continuation: LineCell | null,
  width: number,
  column: number,
): { fitted: boolean; column: number } {
  if (column + cell.width <= width) {
    line.push(cell)
    if (continuation !== null) line.push(continuation)
    return { fitted: true, column: column + cell.width }
  }
  if (cell.width === 2 && width === 1 && line.length === 0) {
    // A single grapheme wider than the whole viewport: substitute, never split.
    line.push({ grapheme: OVERWIDE_SUBSTITUTE, width: 1, style: cell.style, hyperlink: cell.hyperlink })
    return { fitted: true, column: 1 }
  }
  return { fitted: false, column }
}

/**
 * Fold a cell sequence to `width` columns. Word-aware: breaks at the last
 * space on the overflowing line when one exists (the space is dropped),
 * otherwise hard-breaks; a wide grapheme is never split across lines. Styles
 * and hyperlinks ride on each cell, so continuation lines re-emit them —
 * nothing leaks across the break. `width <= 0` yields one empty line (never
 * a repeat/recursion on a non-positive width, §6.1).
 */
export function wrapCells(cells: readonly LineCell[], width: number): LineCell[][] {
  if (width <= 0) return [[]]
  const lines: LineCell[][] = []
  let line: LineCell[] = []
  let column = 0
  let lastSpace = -1 // index into `line` of the last breakable space cell

  const hardBreak = (): void => {
    lines.push(line)
    line = []
    column = 0
    lastSpace = -1
  }

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as LineCell
    if (cell.width === 0 && cell.grapheme === '') continue // continuation rides with its owner
    const continuation = cell.width === 2 ? (cells[i + 1] ?? null) : null
    if (column + cell.width > width) {
      if (cell.width === 1 && cell.grapheme === ' ') {
        // An overflowing break space simply ends the line (it is dropped).
        if (line.length > 0) hardBreak()
        continue
      }
      if (line.length > 0 && lastSpace >= 0) {
        // Word-aware break: everything after the last space moves down.
        const tail = line.splice(lastSpace + 1)
        line.splice(lastSpace, 1) // the break space is dropped
        lines.push(line)
        line = tail
        column = cellsWidth(tail)
        lastSpace = tail.findLastIndex((c) => c.width === 1 && c.grapheme === ' ')
        if (column + cell.width > width) hardBreak()
      } else if (line.length > 0) {
        hardBreak()
      }
      // line empty + still overflowing: only a wide grapheme on a too-narrow
      // viewport; pushFitted applies the substitute rule below.
    }
    const fitted = pushFitted(line, cell, continuation, width, column)
    column = fitted.column
    if (cell.width === 1 && cell.grapheme === ' ') lastSpace = line.length - 1
  }
  lines.push(line)
  return lines
}

/**
 * Clip a cell sequence to at most `width` columns. A wide grapheme that
 * straddles the boundary is dropped (line ends one column short); a lone
 * wide grapheme on a width-1 viewport becomes the substitute char
 * (§6.1 over-wide single grapheme). `width <= 0` returns an empty sequence.
 */
export function truncateCells(cells: readonly LineCell[], width: number): LineCell[] {
  if (width <= 0) return []
  const out: LineCell[] = []
  let column = 0
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as LineCell
    if (cell.width === 0 && cell.grapheme === '') continue
    if (column + cell.width > width) {
      if (cell.width === 2 && width === 1 && out.length === 0) {
        out.push({ grapheme: OVERWIDE_SUBSTITUTE, width: 1, style: cell.style, hyperlink: cell.hyperlink })
      }
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
  return out
}

/** Right-pad with blank cells to exactly `width` columns; no-op when already >= width or width <= 0. */
export function padCells(
  cells: readonly LineCell[],
  width: number,
  style: LineStyle = DEFAULT_LINE_STYLE,
): LineCell[] {
  if (width <= 0) return [...cells]
  const out = [...cells]
  let column = cellsWidth(out)
  while (column < width) {
    out.push({ grapheme: ' ', width: 1, style, hyperlink: null })
    column += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// Replay (cells -> styled ANSI string)
// ---------------------------------------------------------------------------

const NAMED_COLOR_INDEX: Readonly<Record<string, number>> = {
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

/** Color spelling -> SGR params; mirrors terminal/ansi.ts colorParams. */
function lineColorParams(color: string, foreground: boolean): number[] {
  const named = NAMED_COLOR_INDEX[color]
  if (named !== undefined) {
    if (foreground) return [named < 8 ? 30 + named : 90 + (named - 8)]
    return [named < 8 ? 40 + named : 100 + (named - 8)]
  }
  const ansi256 = /^ansi256:(\d{1,3})$/.exec(color)
  if (ansi256) return [foreground ? 38 : 48, 5, Math.min(255, Number.parseInt(ansi256[1] as string, 10))]
  const ansi16 = /^ansi16:(\d{1,2})$/.exec(color)
  if (ansi16) {
    const n = Math.min(15, Number.parseInt(ansi16[1] as string, 10))
    if (foreground) return [n < 8 ? 30 + n : 90 + (n - 8)]
    return [n < 8 ? 40 + n : 100 + (n - 8)]
  }
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color) ?? /^rgb:([0-9a-fA-F]{6})$/.exec(color)
  if (hex) {
    const h = hex[1] as string
    return [
      foreground ? 38 : 48,
      2,
      Number.parseInt(h.slice(0, 2), 16),
      Number.parseInt(h.slice(2, 4), 16),
      Number.parseInt(h.slice(4, 6), 16),
    ]
  }
  throw new TypeError(`unsupported line color string: ${JSON.stringify(color)}`)
}

function isDefaultLineStyle(style: LineStyle): boolean {
  return lineStyleEquals(style, DEFAULT_LINE_STYLE)
}

/** Full reset-first SGR for a style; identical param order to terminal/ansi.ts sgrStyle. */
export function sgrForLineStyle(style: LineStyle): string {
  if (isDefaultLineStyle(style)) return '\x1b[0m'
  const params: number[] = [0]
  if (style.bold) params.push(1)
  if (style.dim) params.push(2)
  if (style.italic) params.push(3)
  if (style.underline) params.push(4)
  if (style.inverse) params.push(7)
  if (style.strike) params.push(9)
  if (style.foreground !== null) params.push(...lineColorParams(style.foreground, true))
  if (style.background !== null) params.push(...lineColorParams(style.background, false))
  return `\x1b[${params.join(';')}m`
}

const OSC8_CLOSE = '\x1b]8;;\x07'

/**
 * Replay a cell sequence as a styled ANSI string. Every styled run opens with
 * a reset-first SGR and every hyperlink run closes immediately after its
 * text, so style/link state can never leak past the run or the line end —
 * the hard protection §6.1/§3.3 I-06 requires of component output.
 * Continuation cells emit nothing (their owner already did).
 */
export function cellsToString(cells: readonly LineCell[]): string {
  let out = ''
  let currentStyle: LineStyle = DEFAULT_LINE_STYLE
  let currentLink: string | null = null
  let styledOpen = false
  for (const cell of cells) {
    if (cell.width === 0 && cell.grapheme === '') continue
    if (currentLink !== null && cell.hyperlink !== currentLink) {
      out += OSC8_CLOSE
      currentLink = null
    }
    if (!lineStyleEquals(cell.style, currentStyle)) {
      out += sgrForLineStyle(cell.style)
      currentStyle = cell.style
      styledOpen = !isDefaultLineStyle(cell.style)
    }
    if (cell.hyperlink !== null && cell.hyperlink !== currentLink) {
      out += `\x1b]8;;${cell.hyperlink}\x07`
      currentLink = cell.hyperlink
    }
    out += cell.grapheme
  }
  if (currentLink !== null) out += OSC8_CLOSE
  if (styledOpen) out += '\x1b[0m'
  return out
}

// ---------------------------------------------------------------------------
// Trusted component builders (§6.1: component ANSI comes only from here)
// ---------------------------------------------------------------------------

/** Wrap plain (already sanitized) text in a style; default style returns the text unchanged. */
export function styleText(text: string, style: LineStyle): string {
  if (text === '' || isDefaultLineStyle(style)) return text
  return `${sgrForLineStyle(style)}${text}\x1b[0m`
}

/** Sanitize + cells with one uniform style: the standard component entry point. */
export function styledCells(
  text: string,
  style: LineStyle,
  profile: TerminalProfile,
  cache: GraphemeWidthCache = sharedGraphemeWidthCache,
): LineCell[] {
  const clean = sanitizeText(text)
  const cells = lineToCells(clean, profile, cache)
  if (isDefaultLineStyle(style)) return cells
  return cells.map((cell) => ({ ...cell, style }))
}

/**
 * §3.3 I-06 / §6.1 hard guard: a rendered line must never exceed `width`
 * columns. Over-wide lines are clipped (never thrown); `width <= 0` yields
 * the empty string (never `repeat(width)`). Returns a string safe to emit.
 */
export function assertLineWidth(
  line: string,
  profile: TerminalProfile,
  width: number,
  cache: GraphemeWidthCache = sharedGraphemeWidthCache,
): string {
  if (width <= 0) return ''
  const cells = lineToCells(line, profile, cache)
  if (cellsWidth(cells) <= width) return line
  return cellsToString(truncateCells(cells, width))
}
