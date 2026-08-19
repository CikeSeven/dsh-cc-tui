/**
 * tui-v2 testkit VirtualTerminal (WP-02, plan §9.2/WP-02).
 *
 * A minimal, INDEPENDENT stateful ANSI/OSC/DEC parser — it must not wrap
 * @xterm/headless (which is only the second oracle, see xterm-oracle.ts).
 * The parser is profile-driven (§5.4): advanced protocol sequences only take
 * effect when the profile declares support; otherwise they are counted as
 * unsupported diagnostics and conservatively ignored. Unknown sequences never
 * throw and are never echoed as text.
 *
 * Semantics are aligned with the pinned @xterm/headless 6.0.0 oracle on the
 * mutually observable surface (verified by fixtures/tui-v2/conformance):
 *   - blank cell = { grapheme: '', width: 1, default style, no hyperlink }
 *   - erase is BCE: erased cells carry the current SGR style
 *   - a wide grapheme at the last column with DECAWM off is dropped
 *   - LF/IND/NEL at the bottom margin of a FULL-screen scroll region on the
 *     main screen pushes the scrolled-off line into scrollback; SU/SD and
 *     region-local scrolls never touch scrollback (xterm-verified)
 *   - entering the alternate screen (47/1047/1049h) starts from a cleared alt
 *     grid; the cursor position is preserved; 1049h/1049l save+restore it
 *   - ED 3 clears scrollback
 *   - a zero-width grapheme (e.g. a lone combining mark) attaches to the cell
 *     left of the cursor; at column 0 it occupies its own width-0 cell
 *
 * Known divergences BY CONTRACT (documented, never silently "fixed"):
 *   - TAB advances to the next multiple-of-8 stop (terminal semantics, matches
 *     the oracle). Plan §8 (line ~842) pins tabstop 3 for the logical WIDTH
 *     pipeline that measures text; that rule does not apply to byte-stream
 *     terminal emulation.
 *   - grapheme clustering uses Intl.Segmenter('und', grapheme): ZWJ emoji,
 *     regional-indicator pairs and combining sequences are never split
 *     (§9.3). xterm 6.0 ships Unicode 6 without clustering, so those cases
 *     are conformance-checked as conservative-only with reviewed goldens.
 *   - resize never reflows (plan: reflow is explicitly out of scope); rows
 *     and columns are cropped/padded with default-style blanks.
 */
import { createHash } from 'node:crypto'
import { eastAsianWidth } from 'get-east-asian-width'
import type { MouseTrackingMode, TerminalModeSnapshot } from '../renderer/frame.js'
import type { TerminalProfile } from '../terminal/profile.js'
import type {
  CanonicalCell,
  CanonicalGridV1,
  CanonicalHyperlink,
  CanonicalImagePlacement,
  CanonicalStyle,
} from './canonical.js'

export const VT_DEFAULT_SCROLLBACK_LIMIT = 1000
/** Hardware TAB stops for byte-stream emulation (see header note on tabstop 3). */
const TAB_STOP = 8

const DEFAULT_STYLE: CanonicalStyle = Object.freeze({
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
})

interface VtLink {
  readonly uri: string
  readonly params?: string
}

interface VtCell {
  readonly grapheme: string
  readonly width: 0 | 1 | 2
  readonly style: CanonicalStyle
  readonly link: VtLink | null
}

const BLANK_CELL: VtCell = Object.freeze({ grapheme: '', width: 1, style: DEFAULT_STYLE, link: null })

export interface VtDiagnostics {
  /** Total unsupported/unknown sequences ignored (conservative). */
  readonly unsupportedCount: number
  /** Per sequence-type summary, e.g. { 'decset:1337': 1, 'osc:999': 2 }. */
  readonly unsupportedByType: Readonly<Record<string, number>>
  /** OSC 52 clipboard sequences seen on a supporting profile (never in grid). */
  readonly osc52Sequences: number
  /** CSI ?u kitty keyboard queries seen on a supporting profile. */
  readonly kittyKeyboardQueries: number
  /**
   * Mouse tracking/encoding combinations the `MouseTrackingMode` enum cannot
   * express (plan line ~696), e.g. 'any-1003+sgr-1006' or 'none+sgr-1006'
   * (encoding residue without tracking). The snapshot maps them to the
   * nearest enum value; the combination is recorded here.
   */
  readonly mouseCombinations: readonly string[]
  /** Incomplete escape sequences dropped at snapshot() flush time. */
  readonly incompleteSequences: number
}

type MouseTracking = 'none' | 'x10' | 'normal' | 'button' | 'any'
type MouseEncoding = 'default' | 'sgr' | 'urxvt'

// ---------------------------------------------------------------------------
// Width pipeline (plan §8, line ~842): Intl.Segmenter graphemes +
// pinned get-east-asian-width, ambiguousWidth from the profile, C0 width 0.
// Measured per whole grapheme; Mn/Mc/Me/Cf code points are zero-width.
// ---------------------------------------------------------------------------

const ZERO_WIDTH_CATEGORY = /\p{Mn}|\p{Mc}|\p{Me}|\p{Cf}/u

/** Measure one grapheme cluster. Controls measure 0; result is 0|1|2. */
export function measureGrapheme(grapheme: string, ambiguousAsWide: boolean): 0 | 1 | 2 {
  let width = 0
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0) as number
    // C0/C1/DEL controls are width 0 (they are handled as controls upstream).
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0
    if (ZERO_WIDTH_CATEGORY.test(ch)) continue
    const w = eastAsianWidth(cp, { ambiguousAsWide })
    if (w > width) width = w
  }
  return width as 0 | 1 | 2
}

const graphemeSegmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof (Intl as Record<string, unknown>).Segmenter === 'function'
    ? new Intl.Segmenter('und', { granularity: 'grapheme' })
    : null

/** Segment text into grapheme clusters; per-code-point fallback when Intl.Segmenter is unavailable. */
export function segmentGraphemes(text: string): string[] {
  if (graphemeSegmenter === null) return Array.from(text)
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
}

function isRegionalIndicator(grapheme: string): boolean {
  const cps = Array.from(grapheme, (ch) => ch.codePointAt(0) as number)
  return cps.length > 0 && cps.every((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff)
}

/**
 * A trailing grapheme that may still grow when the next chunk arrives
 * (ZWJ/VS-terminated cluster or an unpaired regional indicator) is held back
 * in the parse buffer so arbitrary chunk splits never split a cluster (§9.3).
 */
function shouldHoldBack(grapheme: string): boolean {
  if (isRegionalIndicator(grapheme)) return true
  const cps = Array.from(grapheme, (ch) => ch.codePointAt(0) as number)
  const last = cps[cps.length - 1] as number
  return last === 0x200d || last === 0xfe0f
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function blankLine(width: number, style: CanonicalStyle = DEFAULT_STYLE): VtCell[] {
  const cell: VtCell = style === DEFAULT_STYLE ? BLANK_CELL : { grapheme: '', width: 1, style, link: null }
  return Array.from({ length: width }, () => cell)
}

function cloneStyle(style: CanonicalStyle): CanonicalStyle {
  return { ...style }
}

// ---------------------------------------------------------------------------
// VirtualTerminal
// ---------------------------------------------------------------------------

export interface VirtualTerminalOptions {
  readonly scrollbackLimit?: number
}

export class VirtualTerminal {
  private readonly profile: TerminalProfile
  private readonly scrollbackLimit: number
  private readonly ambiguousAsWide: boolean

  private width: number
  private height: number
  private mainLines: VtCell[][]
  private altLines: VtCell[][]
  private active: 'main' | 'alt' = 'main'
  private scrollbackLines: VtCell[][] = []

  private cursorX = 0
  private cursorY = 0
  private cursorVisible = true
  private savedCursor: { x: number; y: number } | null = null

  private style: CanonicalStyle = DEFAULT_STYLE
  private link: VtLink | null = null

  private bracketedPaste = false
  private syncOutput = false
  private autowrap = true
  private wrapPending = false
  private scrollTop = 0
  private scrollBottom: number
  private cursorStyle: TerminalModeSnapshot['cursorStyle'] = 'block'
  private focusReporting = false
  private mouseTracking: MouseTracking = 'none'
  private mouseEncoding: MouseEncoding = 'default'
  private kittyFlagStack: number[] = []
  private kittyFlags = 0
  private modifyOtherKeys = false
  private windowsDec9001 = false
  private osc133Seen = false
  private title: string | null = null
  private progress: TerminalModeSnapshot['progress'] = { state: 'none' }

  private images: CanonicalImagePlacement[] = []
  private imageCounter = 0

  private buffer = ''

  private unsupportedCount = 0
  private unsupportedByType = new Map<string, number>()
  private osc52Count = 0
  private kittyQueries = 0
  private mouseCombos = new Set<string>()
  private incompleteSequences = 0

  constructor(profile: TerminalProfile, options: VirtualTerminalOptions = {}) {
    this.profile = profile
    this.scrollbackLimit = options.scrollbackLimit ?? VT_DEFAULT_SCROLLBACK_LIMIT
    // §5.4: ambiguousWidth 'unknown' is never treated as wide (conservative 1).
    this.ambiguousAsWide = profile.ambiguousWidth === 2
    this.width = profile.columns
    this.height = profile.rows
    this.mainLines = blankLineGrid(this.width, this.height)
    this.altLines = blankLineGrid(this.width, this.height)
    this.scrollBottom = this.height - 1
  }

  // ------------------------------------------------------------------ public

  /** Feed a chunk of terminal output; may split any sequence arbitrarily. */
  write(chunk: string): void {
    if (chunk.length === 0) return
    this.buffer += chunk
    this.consume(false)
  }

  /**
   * Conservative resize: crop/pad columns and rows with default-style blanks.
   * NO reflow (explicitly out of scope per plan); scrollback lines are
   * cropped/padded to the new width as well.
   */
  resize(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError(`VirtualTerminal.resize: invalid geometry ${width}x${height}`)
    }
    this.consumePartialAtEof()
    this.width = width
    this.height = height
    this.mainLines = resizeGrid(this.mainLines, width, height)
    this.altLines = resizeGrid(this.altLines, width, height)
    this.scrollbackLines = this.scrollbackLines.map((line) => resizeLine(line, width))
    const wasFullRegion = this.scrollTop === 0
    this.scrollTop = Math.min(this.scrollTop, height - 1)
    this.scrollBottom = wasFullRegion ? height - 1 : Math.min(this.scrollBottom, height - 1)
    if (this.scrollTop >= this.scrollBottom) {
      this.scrollTop = 0
      this.scrollBottom = height - 1
    }
    this.cursorX = Math.min(this.cursorX, width - 1)
    this.cursorY = Math.min(this.cursorY, height - 1)
    if (this.savedCursor) {
      this.savedCursor = {
        x: Math.min(this.savedCursor.x, width - 1),
        y: Math.min(this.savedCursor.y, height - 1),
      }
    }
    this.wrapPending = false
  }

  /**
   * Flush any held-back partial input (a dangling partial escape sequence is
   * conservatively dropped and counted) and return the canonical grid.
   */
  snapshot(): CanonicalGridV1 {
    this.consumePartialAtEof()
    const lines = this.activeLines()
    const cells: CanonicalCell[] = []
    for (const line of lines) {
      for (const cell of line) cells.push(toCanonicalCell(cell))
    }
    return {
      width: this.width,
      height: this.height,
      cells,
      cursor: { x: this.cursorX, y: this.cursorY, visible: this.cursorVisible },
      modes: this.modeSnapshot(),
      scrollback: this.scrollbackLines.map((line) => line.map(toCanonicalCell)),
      images: [...this.images],
    }
  }

  /** Reset to the initial state: blank screen, cursor (0,0), default modes. */
  reset(): void {
    this.consumePartialAtEof()
    this.resetState()
  }

  /**
   * State-only reset shared by the public `reset()` and RIS (ESC c). RIS is
   * handled mid-parse, so it must NOT re-enter the parser via
   * `consumePartialAtEof` (that would recurse on the same ESC c forever).
   */
  private resetState(): void {
    this.mainLines = blankLineGrid(this.width, this.height)
    this.altLines = blankLineGrid(this.width, this.height)
    this.active = 'main'
    this.scrollbackLines = []
    this.cursorX = 0
    this.cursorY = 0
    this.cursorVisible = true
    this.savedCursor = null
    this.style = DEFAULT_STYLE
    this.link = null
    this.bracketedPaste = false
    this.syncOutput = false
    this.autowrap = true
    this.wrapPending = false
    this.scrollTop = 0
    this.scrollBottom = this.height - 1
    this.cursorStyle = 'block'
    this.focusReporting = false
    this.mouseTracking = 'none'
    this.mouseEncoding = 'default'
    this.kittyFlagStack = []
    this.kittyFlags = 0
    this.modifyOtherKeys = false
    this.windowsDec9001 = false
    this.osc133Seen = false
    this.title = null
    this.progress = { state: 'none' }
    this.images = []
    this.imageCounter = 0
    this.buffer = ''
    this.unsupportedCount = 0
    this.unsupportedByType = new Map()
    this.osc52Count = 0
    this.kittyQueries = 0
    this.mouseCombos = new Set()
    this.incompleteSequences = 0
  }

  diagnostics(): VtDiagnostics {
    const byType: Record<string, number> = {}
    for (const key of [...this.unsupportedByType.keys()].sort()) {
      byType[key] = this.unsupportedByType.get(key) as number
    }
    return {
      unsupportedCount: this.unsupportedCount,
      unsupportedByType: byType,
      osc52Sequences: this.osc52Count,
      kittyKeyboardQueries: this.kittyQueries,
      mouseCombinations: [...this.mouseCombos].sort(),
      incompleteSequences: this.incompleteSequences,
    }
  }

  // ----------------------------------------------------------------- helpers

  private activeLines(): VtCell[][] {
    return this.active === 'main' ? this.mainLines : this.altLines
  }

  private cap(value: 'yes' | 'no' | 'unknown'): boolean {
    // §5.4: 'unknown' is never treated as supported.
    return value === 'yes'
  }

  private unsupported(type: string): void {
    this.unsupportedCount += 1
    this.unsupportedByType.set(type, (this.unsupportedByType.get(type) ?? 0) + 1)
  }

  private modeSnapshot(): TerminalModeSnapshot {
    return {
      alternateScreen: this.active === 'alt',
      // rawInput is a termios-level app state; no byte sequence changes it.
      rawInput: false,
      mouse: this.normalizedMouseMode(),
      bracketedPaste: this.bracketedPaste,
      syncOutput: this.syncOutput,
      autowrap: this.autowrap,
      wrapPending: this.wrapPending,
      scrollRegion: { top: this.scrollTop, bottom: this.scrollBottom },
      cursorStyle: this.cursorStyle,
      cursorVisible: this.cursorVisible,
      kittyKeyboard: this.kittyFlags !== 0,
      modifyOtherKeys: this.modifyOtherKeys,
      focusReporting: this.focusReporting,
      windowsDec9001: this.windowsDec9001,
      osc133: this.osc133Seen,
      title: this.title,
      progress: this.progress,
    }
  }

  /**
   * DECSET 1000/1002/1003 tracking and 1006/1015 encoding normalize into the
   * flat `MouseTrackingMode` enum (§5.5 line ~696). The enum cannot express
   * tracking+encoding combinations; those map to the encoding value and the
   * combination is recorded in diagnostics. Cleanup only counts as restored
   * when this returns 'off' — an encoding residue (1006 still set without a
   * tracking mode) therefore still reports 'sgr-1006', never collapses to
   * 'off' or a bare boolean.
   */
  /**
   * Record a tracking/encoding combination the flat enum cannot express
   * (called whenever mouse DECSET/DECRST changes state). 'none+sgr-1006'
   * documents an encoding residue without tracking — cleanup is NOT complete.
   */
  private noteMouseCombination(): void {
    if (this.mouseEncoding === 'default') return
    const encoding = this.mouseEncoding === 'sgr' ? 'sgr-1006' : 'urxvt-1015'
    const tracking = this.mouseTracking === 'none' ? 'none' : trackingLabel(this.mouseTracking)
    this.mouseCombos.add(`${tracking}+${encoding}`)
  }

  private normalizedMouseMode(): MouseTrackingMode {
    const tracking = this.mouseTracking
    const encoding = this.mouseEncoding
    if (encoding === 'sgr') return 'sgr-1006'
    if (encoding === 'urxvt') return 'urxvt-1015'
    switch (tracking) {
      case 'none':
        return 'off'
      case 'x10':
      case 'normal':
        // 'x10-1000' covers DECSET 1000; DECSET 9 (X10) is unsupported.
        return 'x10-1000'
      case 'button':
        // DECSET 1002 is button-event tracking; 'normal-1002' is never
        // emitted by this parser (contract superset value).
        return 'button-1002'
      case 'any':
        return 'any-1003'
    }
  }

  // ---------------------------------------------------------------- tokenizer

  /** Process as much of the buffer as possible; keep an incomplete tail. */
  private consume(eof: boolean): void {
    for (;;) {
      if (this.buffer.length === 0) return
      const cp0 = this.buffer.codePointAt(0) as number
      if (cp0 === 0x1b) {
        const consumed = this.parseEscape(eof)
        if (consumed === 0) {
          if (!eof) return
          // Dangling partial sequence at flush: drop the whole remainder
          // (never echo it as text) and count it once.
          this.incompleteSequences += 1
          this.buffer = ''
          return
        }
        this.buffer = this.buffer.slice(consumed)
        continue
      }
      if (cp0 < 0x20 || cp0 === 0x7f) {
        this.handleControl(cp0)
        this.buffer = this.buffer.slice(1)
        continue
      }
      if (cp0 >= 0x80 && cp0 <= 0x9f) {
        // C1 controls: fixtures use 7-bit ESC forms only; never echo as text.
        this.unsupported(`c1:0x${cp0.toString(16)}`)
        this.buffer = this.buffer.slice(1)
        continue
      }
      // Printable run up to the next control/ESC.
      let end = 1
      while (end < this.buffer.length) {
        const cp = this.buffer.codePointAt(end) as number
        if (cp === 0x1b || cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) break
        end += cp > 0xffff ? 2 : 1
      }
      let run = this.buffer.slice(0, end)
      let runConsumed = end
      if (!eof) {
        const graphemes = segmentGraphemes(run)
        const last = graphemes[graphemes.length - 1]
        if (graphemes.length > 0 && shouldHoldBack(last as string)) {
          // Keep the trailing cluster in the buffer; it may grow next chunk.
          const held = last as string
          run = run.slice(0, run.length - held.length)
          runConsumed -= held.length
        }
      }
      if (runConsumed === 0) return // entire run is one held-back cluster
      for (const grapheme of segmentGraphemes(run)) {
        this.printGrapheme(grapheme)
      }
      this.buffer = this.buffer.slice(runConsumed)
    }
  }

  private consumePartialAtEof(): void {
    this.consume(true)
  }

  // ------------------------------------------------------------- escape parser

  /** Parse an escape sequence at buffer[0]; returns consumed length, 0 = incomplete. */
  private parseEscape(eof: boolean): number {
    const buf = this.buffer
    if (buf.length < 2) return 0
    const c1 = buf[1]
    switch (c1) {
      case '[':
        return this.parseCsi(buf, eof)
      case ']':
        return this.parseOsc(buf, eof)
      case '_':
        return this.parseStringSequence(buf, eof, 'apc')
      case 'P':
        return this.parseStringSequence(buf, eof, 'dcs')
      case '^':
        return this.parseStringSequence(buf, eof, 'pm')
      case 'X':
        return this.parseStringSequence(buf, eof, 'sos')
      case '7':
        this.savedCursor = { x: this.cursorX, y: this.cursorY }
        this.wrapPending = false
        return 2
      case '8':
        if (this.savedCursor) {
          // DECRC here is position-only (charsets/origin are not modelled).
          this.cursorX = Math.min(this.savedCursor.x, this.width - 1)
          this.cursorY = Math.min(this.savedCursor.y, this.height - 1)
          this.wrapPending = false
        }
        return 2
      case 'c':
        this.resetState()
        return 2
      case 'D':
        this.lineFeed()
        return 2
      case 'E':
        this.lineFeed()
        this.cursorX = 0
        this.wrapPending = false
        return 2
      case 'M':
        this.reverseIndex()
        return 2
      case '=':
      case '>':
        // DECKPAM/DECPNM keypad modes: not part of the mode snapshot.
        return 2
      case '(':
      case ')':
        if (buf.length < 3) return 0
        // ESC ( B = ASCII charset: harmless no-op. DEC special graphics and
        // others are not modelled (the v2 renderer emits Unicode directly).
        if (buf[2] !== 'B') this.unsupported(`charset:${c1}${buf[2]}`)
        return 3
      case '#':
      case '%':
        if (buf.length < 3) return 0
        this.unsupported(`esc:${c1}${buf[2]}`)
        return 3
      default: {
        const code1 = buf.charCodeAt(1)
        if (code1 >= 0x20 && code1 <= 0x2f) {
          // ECMA-48 escape with intermediates: ESC I..I F — consume the
          // whole form so the final byte is never echoed as text (xterm).
          let j = 1
          while (j < buf.length && buf.charCodeAt(j) >= 0x20 && buf.charCodeAt(j) <= 0x2f) j++
          if (j >= buf.length) return 0 // incomplete
          const finalCode = buf.charCodeAt(j)
          if (finalCode >= 0x30 && finalCode <= 0x7e) {
            this.unsupported(`esc:${buf.slice(1, j + 1)}`)
            return j + 1
          }
          this.unsupported('esc:malformed')
          return j
        }
        if (code1 < 0x20 || code1 === 0x7f) {
          // ESC aborted by a control byte: drop ESC, reprocess the control.
          this.unsupported('esc:aborted')
          return 1
        }
        this.unsupported(`esc:${escapeSummary(c1)}`)
        return 2
      }
    }
  }

  /** CSI at buffer[0..]; returns consumed length or 0 when incomplete. */
  private parseCsi(buf: string, eof: boolean): number {
    let i = 2
    let paramsEnd = i
    while (paramsEnd < buf.length) {
      const code = buf.charCodeAt(paramsEnd)
      if (code >= 0x30 && code <= 0x3f) paramsEnd++
      else break
    }
    let intermediatesEnd = paramsEnd
    while (intermediatesEnd < buf.length) {
      const code = buf.charCodeAt(intermediatesEnd)
      if (code >= 0x20 && code <= 0x2f) intermediatesEnd++
      else break
    }
    if (intermediatesEnd >= buf.length) return 0 // incomplete
    const finalCode = buf.charCodeAt(intermediatesEnd)
    if (finalCode < 0x40 || finalCode > 0x7e) {
      // Malformed CSI: abort the sequence, let the byte be reprocessed.
      this.unsupported('csi:malformed')
      return Math.max(2, intermediatesEnd)
    }
    const rawParams = buf.slice(2, paramsEnd)
    const intermediates = buf.slice(paramsEnd, intermediatesEnd)
    const final = buf[intermediatesEnd]
    this.dispatchCsi(rawParams, intermediates, final)
    return intermediatesEnd + 1
  }

  /** OSC at buffer[0..]: ESC ] ... (BEL | ESC \ | ST). */
  private parseOsc(buf: string, eof: boolean): number {
    const end = findStringTerminator(buf, 2)
    if (end < 0) return 0
    const content = buf.slice(2, end)
    this.dispatchOsc(content)
    return end + terminatorLength(buf, end)
  }

  /** DCS/APC/PM/SOS at buffer[0..]. */
  private parseStringSequence(buf: string, eof: boolean, kind: 'dcs' | 'apc' | 'pm' | 'sos'): number {
    const end = findStringTerminator(buf, 2)
    if (end < 0) return 0
    const content = buf.slice(2, end)
    if (kind === 'apc' && content.startsWith('G')) {
      this.handleKittyGraphics(content)
    } else {
      this.unsupported(kind)
    }
    return end + terminatorLength(buf, end)
  }

  // --------------------------------------------------------------- CSI dispatch

  private dispatchCsi(rawParams: string, intermediates: string, final: string): void {
    let prefix = ''
    let paramText = rawParams
    if (paramText.length > 0 && paramText.charCodeAt(0) >= 0x3c && paramText.charCodeAt(0) <= 0x3f) {
      prefix = paramText[0]
      paramText = paramText.slice(1)
    }
    const params = parseParams(paramText)

    if (prefix === '?') {
      this.dispatchDecset(params, final)
      return
    }
    if (prefix === '>' || prefix === '=' || prefix === '<') {
      this.dispatchPrivatePrefix(prefix, params, final)
      return
    }
    if (prefix !== '') {
      this.unsupported(`csi:${prefix}${final}`)
      return
    }

    if (intermediates === ' ') {
      if (final === 'q') {
        // DECSCUSR cursor style: 0-2 block, 3-4 underline, 5-6 bar.
        const p = params[0] ?? 1
        if (p >= 0 && p <= 2) this.cursorStyle = 'block'
        else if (p <= 4) this.cursorStyle = 'underline'
        else if (p <= 6) this.cursorStyle = 'bar'
        else this.unsupported(`csi:decscusr:${p}`)
        return
      }
      this.unsupported(`csi:sp${final}`)
      return
    }
    if (intermediates !== '') {
      this.unsupported(`csi:${intermediates}${final}`)
      return
    }

    const n = (def = 1) => Math.max(def === 0 ? 0 : 1, params[0] ?? def)
    this.wrapPending = false
    switch (final) {
      case 'A': this.cursorY = Math.max(0, this.cursorY - n()); return
      case 'B': this.cursorY = Math.min(this.height - 1, this.cursorY + n()); return
      case 'C': this.cursorX = Math.min(this.width - 1, this.cursorX + n()); return
      case 'D': this.cursorX = Math.max(0, this.cursorX - n()); return
      case 'E': this.cursorY = Math.min(this.height - 1, this.cursorY + n()); this.cursorX = 0; return
      case 'F': this.cursorY = Math.max(0, this.cursorY - n()); this.cursorX = 0; return
      case 'G': this.cursorX = clampCol((params[0] ?? 1) - 1, this.width); return
      case 'H':
      case 'f':
        this.cursorY = clampRow((params[0] ?? 1) - 1, this.height)
        this.cursorX = clampCol((params[1] ?? 1) - 1, this.width)
        return
      case 'd': this.cursorY = clampRow((params[0] ?? 1) - 1, this.height); return
      case 'I': this.cursorX = Math.min(this.width - 1, (Math.floor(this.cursorX / TAB_STOP) + n()) * TAB_STOP); return
      case 'Z': this.cursorX = Math.max(0, (Math.ceil(this.cursorX / TAB_STOP) - n()) * TAB_STOP); return
      case 'J': this.eraseDisplay(params[0] ?? 0); return
      case 'K': this.eraseLine(params[0] ?? 0); return
      case 'L': this.insertLines(n()); return
      case 'M': this.deleteLines(n()); return
      case 'S': this.scrollRegionUp(n(), false); return
      case 'T': this.scrollRegionDown(n()); return
      case 'X': this.eraseChars(n()); return
      case 'P': this.deleteChars(n()); return
      case '@': this.insertChars(n()); return
      case 'r': this.setScrollRegion(params[0], params[1]); return
      case 's': this.savedCursor = { x: this.cursorX, y: this.cursorY }; return
      case 'u': this.restoreCursor(); return
      case 'm': this.applySgr(paramText); return
      case 'h':
      case 'l':
        // SM/RM (e.g. IRM 4): ANSI modes outside the snapshot contract.
        this.unsupported(`csi:${final}:${params.join(';')}`)
        return
      default:
        this.unsupported(`csi:${final}`)
    }
  }

  private dispatchPrivatePrefix(prefix: '>' | '=' | '<', params: number[], final: string): void {
    if (final === 'u') {
      // Kitty keyboard protocol (gate on profile; §5.4 unknown == off).
      if (!this.cap(this.profile.supportsKittyKeyboard)) {
        this.unsupported(`csi:${prefix}u`)
        return
      }
      const flags = params[0] ?? 1
      if (prefix === '>') {
        this.kittyFlagStack.push(flags)
        this.kittyFlags = flags
      } else if (prefix === '=') {
        const mode = params[1] ?? 1
        if (mode === 1) this.kittyFlags |= flags
        else if (mode === 2) this.kittyFlags = flags
        else if (mode === 3) this.kittyFlags &= ~flags
        else this.unsupported(`csi:=u:${mode}`)
      } else {
        const count = Math.max(1, params[0] ?? 1)
        for (let i = 0; i < count && this.kittyFlagStack.length > 0; i++) this.kittyFlagStack.pop()
        this.kittyFlags = this.kittyFlagStack[this.kittyFlagStack.length - 1] ?? 0
      }
      return
    }
    if (prefix === '>' && final === 'm' && (params[0] ?? 0) === 4) {
      // xterm modifyOtherKeys: CSI > 4 ; n m
      if (!this.cap(this.profile.supportsModifyOtherKeys)) {
        this.unsupported('csi:>4m')
        return
      }
      const value = params[1] ?? 0
      if (value < 0 || value > 2) {
        this.unsupported(`csi:>4m:${value}`)
        return
      }
      this.modifyOtherKeys = value > 0
      return
    }
    this.unsupported(`csi:${prefix}${final}`)
  }

  private dispatchDecset(params: number[], final: string): void {
    if (final === 'u') {
      // CSI ? u — kitty keyboard query; never changes state.
      if (!this.cap(this.profile.supportsKittyKeyboard)) this.unsupported('csi:?u')
      else this.kittyQueries += 1
      return
    }
    if (final !== 'h' && final !== 'l') {
      this.unsupported(`csi:?${final}`)
      return
    }
    const setting = final === 'h'
    for (const mode of params.length === 0 ? [0] : params) {
      this.applyDecset(mode, setting)
    }
  }

  private applyDecset(mode: number, setting: boolean): void {
    switch (mode) {
      case 7:
        this.autowrap = setting
        this.wrapPending = false
        return
      case 25:
        this.cursorVisible = setting
        return
      case 47:
      case 1047:
      case 1049:
        if (!this.cap(this.profile.supportsAlternateScreen)) {
          this.unsupported(`decset:${mode}`)
          return
        }
        if (setting) this.enterAltScreen(mode === 1049)
        else this.exitAltScreen(mode === 1049)
        return
      case 1000:
      case 1002:
      case 1003:
        if (!this.cap(this.profile.supportsMouse)) {
          if (setting) this.unsupported(`decset:${mode}`)
          return
        }
        this.mouseTracking = setting ? (mode === 1000 ? 'normal' : mode === 1002 ? 'button' : 'any') : 'none'
        this.noteMouseCombination()
        return
      case 1004:
        if (!this.cap(this.profile.supportsFocusReporting)) {
          if (setting) this.unsupported('decset:1004')
          return
        }
        this.focusReporting = setting
        return
      case 1006:
      case 1015:
        if (!this.cap(this.profile.supportsMouse)) {
          if (setting) this.unsupported(`decset:${mode}`)
          return
        }
        this.mouseEncoding = setting ? (mode === 1006 ? 'sgr' : 'urxvt') : 'default'
        this.noteMouseCombination()
        return
      case 2004:
        if (!this.cap(this.profile.supportsBracketedPaste)) {
          if (setting) this.unsupported('decset:2004')
          return
        }
        this.bracketedPaste = setting
        return
      case 2026:
        if (!this.cap(this.profile.supportsSyncOutput)) {
          if (setting) this.unsupported('decset:2026')
          return
        }
        this.syncOutput = setting
        return
      case 9001:
        if (!this.cap(this.profile.supportsWindowsDec9001)) {
          if (setting) this.unsupported('decset:9001')
          return
        }
        this.windowsDec9001 = setting
        return
      default:
        this.unsupported(`decset:${mode}`)
    }
  }

  // --------------------------------------------------------------- OSC dispatch

  private dispatchOsc(content: string): void {
    const semi = content.indexOf(';')
    const psText = semi < 0 ? content : content.slice(0, semi)
    const rest = semi < 0 ? '' : content.slice(semi + 1)
    const ps = /^\d+$/.test(psText) ? Number.parseInt(psText, 10) : Number.NaN

    if (ps === 0 || ps === 1 || ps === 2) {
      if (!this.cap(this.profile.supportsTabTitle)) {
        this.unsupported(`osc:${ps}`)
        return
      }
      // OSC 0 sets icon+title, 1 icon, 2 title; the snapshot models title.
      this.title = rest
      return
    }
    if (ps === 8) {
      if (!this.cap(this.profile.supportsOsc8Hyperlinks)) {
        this.unsupported('osc:8')
        return
      }
      const cut = rest.indexOf(';')
      const params = cut < 0 ? rest : rest.slice(0, cut)
      const uri = cut < 0 ? '' : rest.slice(cut + 1)
      this.link = uri === '' ? null : params === '' ? { uri } : { uri, params }
      return
    }
    if (ps === 9 && rest.startsWith('4;')) {
      if (!this.cap(this.profile.supportsProgress)) {
        this.unsupported('osc:9;4')
        return
      }
      const parts = rest.split(';')
      const state = Number.parseInt(parts[1] ?? '0', 10)
      const value = Number.parseInt(parts[2] ?? '', 10)
      const withValue = Number.isFinite(value) ? { value } : {}
      if (state === 1) this.progress = { state: 'normal', ...withValue }
      else if (state === 2) this.progress = { state: 'error', ...withValue }
      else if (state === 3) this.progress = { state: 'normal' } // indeterminate → value-less normal
      else if (state === 4) this.progress = { state: 'paused', ...withValue }
      else this.progress = { state: 'none' }
      return
    }
    if (ps === 52) {
      if (!this.cap(this.profile.supportsOsc52)) {
        this.unsupported('osc:52')
        return
      }
      // Registered as a diagnostic only; clipboard payloads never enter the grid.
      this.osc52Count += 1
      return
    }
    if (ps === 133) {
      if (!this.cap(this.profile.supportsOsc133)) {
        this.unsupported('osc:133')
        return
      }
      this.osc133Seen = true
      return
    }
    if (ps === 1337 && rest.startsWith('File=')) {
      this.handleIterm2Image(rest.slice('File='.length))
      return
    }
    this.unsupported(`osc:${Number.isNaN(ps) ? escapeSummary(psText) : ps}`)
  }

  private handleKittyGraphics(content: string): void {
    if (this.profile.imageProtocol !== 'kitty') {
      this.unsupported('apc:kitty')
      return
    }
    // ESC _ G key=value,... ; base64payload ST — register placement only.
    const body = content.slice(1)
    const semi = body.indexOf(';')
    const keyText = semi < 0 ? body : body.slice(0, semi)
    const payload = semi < 0 ? '' : body.slice(semi + 1)
    const keys = new Map<string, string>()
    for (const pair of keyText.split(',')) {
      const eq = pair.indexOf('=')
      if (eq > 0) keys.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    const id = keys.get('i') ?? keys.get('I')
    this.imageCounter += 1
    this.images.push({
      imageId: id === undefined ? `kitty-${this.imageCounter}` : `kitty-i${id}`,
      protocol: 'kitty',
      x: this.cursorX,
      y: this.cursorY,
      width: Number.parseInt(keys.get('c') ?? '0', 10) || 0,
      height: Number.parseInt(keys.get('r') ?? '0', 10) || 0,
      payloadHash: sha256Hex(payload),
    })
  }

  private handleIterm2Image(spec: string): void {
    if (this.profile.imageProtocol !== 'iterm2') {
      this.unsupported('osc:1337')
      return
    }
    // OSC 1337 ; File=key=value;...:base64payload — register placement only.
    const colon = spec.indexOf(':')
    const keyText = colon < 0 ? spec : spec.slice(0, colon)
    const payload = colon < 0 ? '' : spec.slice(colon + 1)
    let width = 0
    let height = 0
    for (const pair of keyText.split(';')) {
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const key = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      const cells = Number.parseInt(value, 10)
      if (key === 'width' && Number.isFinite(cells) && !value.endsWith('px')) width = cells
      if (key === 'height' && Number.isFinite(cells) && !value.endsWith('px')) height = cells
    }
    this.imageCounter += 1
    this.images.push({
      imageId: `iterm2-${this.imageCounter}`,
      protocol: 'iterm2',
      x: this.cursorX,
      y: this.cursorY,
      width,
      height,
      payloadHash: sha256Hex(payload),
    })
  }

  // ------------------------------------------------------------------ controls

  private handleControl(cp: number): void {
    switch (cp) {
      case 0x00:
      case 0x07:
        return // NUL/BEL: no grid effect (BEL terminates OSC upstream too)
      case 0x08:
        this.cursorX = Math.max(0, this.cursorX - 1)
        this.wrapPending = false
        return
      case 0x09:
        // Terminal TAB stops every 8 columns (oracle-aligned). The plan's
        // tabstop-3 rule belongs to the logical width pipeline, not to
        // byte-stream emulation.
        this.cursorX = Math.min(this.width - 1, (Math.floor(this.cursorX / TAB_STOP) + 1) * TAB_STOP)
        this.wrapPending = false
        return
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.lineFeed()
        return
      case 0x0d:
        this.cursorX = 0
        this.wrapPending = false
        return
      default:
        // SI/SO and other C0 controls: conservatively ignored, never echoed.
        this.unsupported(`c0:0x${cp.toString(16)}`)
    }
  }

  // ------------------------------------------------------------------- output

  private printGrapheme(grapheme: string): void {
    if (grapheme.length === 0) return
    let width = measureGrapheme(grapheme, this.ambiguousAsWide)
    const lines = this.activeLines()
    // xterm represents an OSC 8 hyperlink with the underline attribute in
    // the buffer; mirror that so hyperlinked cells compare equal.
    const cellStyle = this.link === null || this.style.underline ? this.style : { ...this.style, underline: true }

    if (width === 0) {
      // Zero-width grapheme (combining mark, …): attach to the cell left of
      // the cursor (or the last column when a wrap is pending); at column 0
      // it occupies its own width-0 cell (xterm-verified behavior).
      const targetX = this.wrapPending ? this.width - 1 : this.cursorX - 1
      if (targetX >= 0) {
        const target = lines[this.cursorY][targetX]
        lines[this.cursorY][targetX] = { ...target, grapheme: target.grapheme + grapheme }
      } else {
        this.healSplitAt(this.cursorY, this.cursorX)
        lines[this.cursorY][this.cursorX] = { grapheme, width: 0, style: cellStyle, link: this.link }
        this.cursorX = Math.min(this.width - 1, this.cursorX + 1)
      }
      return
    }

    if (this.wrapPending) {
      this.wrapPending = false
      this.cursorX = 0
      this.advanceRow()
    }

    if (width === 2 && this.width < 2) {
      // Plan §5.5 (line ~700): a wide grapheme that can never fit the grid
      // (1-column viewport) is clipped to a width-1 cell — never recursion,
      // never out of bounds, and the cursor keeps its invariant.
      width = 1
    }

    if (width === 2 && this.cursorX === this.width - 1) {
      if (!this.autowrap) {
        // xterm-verified: a wide grapheme that no longer fits with DECAWM off
        // is dropped; the cursor stays on the last column.
        return
      }
      this.cursorX = 0
      this.advanceRow()
    }

    const x = this.cursorX
    const y = this.cursorY
    this.healSplitAt(y, x)
    lines[y][x] = { grapheme, width, style: cellStyle, link: this.link }
    if (width === 2) {
      this.healSplitAt(y, x + 1)
      lines[y][x + 1] = { grapheme: '', width: 0, style: cellStyle, link: this.link }
      this.cursorX = x + 2
    } else {
      this.cursorX = x + 1
    }
    if (this.cursorX >= this.width) {
      if (this.autowrap) {
        // Stay on the last column with wrapPending; the NEXT printable char wraps.
        this.cursorX = this.width - 1
        this.wrapPending = true
      } else {
        this.cursorX = this.width - 1
      }
    }
  }

  /** Overwriting half of a wide char blanks the other half (never leaves orphans). */
  private healSplitAt(y: number, x: number): void {
    const lines = this.activeLines()
    const line = lines[y]
    const cell = line[x]
    if (cell === undefined) return
    if (cell.width === 0 && cell.grapheme === '' && x > 0 && line[x - 1].width === 2) {
      // About to overwrite a continuation cell: blank its head first.
      const head = line[x - 1]
      line[x - 1] = { grapheme: '', width: 1, style: head.style, link: head.link }
    }
    if (cell.width === 2 && x + 1 < this.width) {
      // About to overwrite a wide head: blank its continuation.
      const cont = line[x + 1]
      if (cont.width === 0 && cont.grapheme === '') {
        line[x + 1] = { grapheme: '', width: 1, style: cont.style, link: cont.link }
      }
    }
  }

  private advanceRow(): void {
    if (this.cursorY === this.scrollBottom) {
      this.scrollRegionUp(1, this.active === 'main' && this.scrollTop === 0 && this.scrollBottom === this.height - 1)
    } else {
      this.cursorY = Math.min(this.height - 1, this.cursorY + 1)
    }
  }

  private lineFeed(): void {
    this.wrapPending = false
    this.advanceRow()
  }

  private reverseIndex(): void {
    this.wrapPending = false
    if (this.cursorY === this.scrollTop) {
      this.scrollRegionDown(1)
    } else {
      this.cursorY = Math.max(0, this.cursorY - 1)
    }
  }

  // --------------------------------------------------------------- line ops

  private scrollRegionUp(n: number, toScrollback: boolean): void {
    const lines = this.activeLines()
    for (let i = 0; i < n; i++) {
      const removed = lines.splice(this.scrollTop, 1)[0]
      lines.splice(this.scrollBottom, 0, blankLine(this.width, this.style))
      if (toScrollback) {
        this.scrollbackLines.push(removed)
        if (this.scrollbackLines.length > this.scrollbackLimit) {
          this.scrollbackLines.splice(0, this.scrollbackLines.length - this.scrollbackLimit)
        }
      }
    }
  }

  private scrollRegionDown(n: number): void {
    const lines = this.activeLines()
    for (let i = 0; i < n; i++) {
      lines.splice(this.scrollBottom, 1)
      lines.splice(this.scrollTop, 0, blankLine(this.width, this.style))
    }
  }

  private insertLines(n: number): void {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) return
    const lines = this.activeLines()
    for (let i = 0; i < n; i++) {
      lines.splice(this.scrollBottom, 1)
      lines.splice(this.cursorY, 0, blankLine(this.width, this.style))
    }
  }

  private deleteLines(n: number): void {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) return
    const lines = this.activeLines()
    for (let i = 0; i < n; i++) {
      lines.splice(this.cursorY, 1)
      lines.splice(this.scrollBottom, 0, blankLine(this.width, this.style))
    }
  }

  private insertChars(n: number): void {
    const line = this.activeLines()[this.cursorY]
    const count = Math.min(n, this.width - this.cursorX)
    for (let i = 0; i < count; i++) {
      line.splice(this.width - 1, 1)
      line.splice(this.cursorX, 0, { grapheme: '', width: 1, style: this.style, link: null })
    }
    healRow(line)
  }

  private deleteChars(n: number): void {
    const line = this.activeLines()[this.cursorY]
    const count = Math.min(n, this.width - this.cursorX)
    for (let i = 0; i < count; i++) {
      line.splice(this.cursorX, 1)
      line.push({ grapheme: '', width: 1, style: this.style, link: null })
    }
    healRow(line)
  }

  private eraseChars(n: number): void {
    const line = this.activeLines()[this.cursorY]
    const end = Math.min(this.width, this.cursorX + n)
    for (let x = this.cursorX; x < end; x++) {
      line[x] = { grapheme: '', width: 1, style: this.style, link: null }
    }
    healRow(line)
  }

  // ------------------------------------------------------------------- erase

  private eraseLine(mode: number): void {
    const line = this.activeLines()[this.cursorY]
    const start = mode === 1 ? 0 : mode === 2 ? 0 : this.cursorX
    const end = mode === 0 ? this.width : mode === 1 ? this.cursorX + 1 : this.width
    for (let x = start; x < end; x++) {
      line[x] = { grapheme: '', width: 1, style: this.style, link: null }
    }
    healRow(line)
  }

  private eraseDisplay(mode: number): void {
    if (mode === 3) {
      // xterm-verified: ED 3 clears scrollback, screen untouched.
      this.scrollbackLines = []
      return
    }
    const lines = this.activeLines()
    if (mode === 2) {
      for (let y = 0; y < this.height; y++) this.eraseRowRange(lines[y], 0, this.width)
      return
    }
    if (mode === 0) {
      this.eraseRowRange(lines[this.cursorY], this.cursorX, this.width)
      for (let y = this.cursorY + 1; y < this.height; y++) this.eraseRowRange(lines[y], 0, this.width)
      return
    }
    if (mode === 1) {
      this.eraseRowRange(lines[this.cursorY], 0, this.cursorX + 1)
      for (let y = 0; y < this.cursorY; y++) this.eraseRowRange(lines[y], 0, this.width)
      return
    }
    this.unsupported(`csi:J:${mode}`)
  }

  /** BCE: erased cells carry the current SGR style; hyperlinks are cleared. */
  private eraseRowRange(line: VtCell[], start: number, end: number): void {
    for (let x = start; x < end; x++) {
      line[x] = { grapheme: '', width: 1, style: this.style, link: null }
    }
    healRow(line)
  }

  // ------------------------------------------------------------ scroll region

  private setScrollRegion(top: number | undefined, bottom: number | undefined): void {
    const t = (top ?? 1) - 1
    const b = (bottom ?? this.height) - 1
    if (t < 0 || b >= this.height || t >= b) return // invalid: ignored (xterm)
    this.scrollTop = t
    this.scrollBottom = b
    // DECSTBM homes the cursor (origin mode is not modelled).
    this.cursorX = 0
    this.cursorY = 0
    this.wrapPending = false
  }

  private restoreCursor(): void {
    if (!this.savedCursor) return
    this.cursorX = Math.min(this.savedCursor.x, this.width - 1)
    this.cursorY = Math.min(this.savedCursor.y, this.height - 1)
    this.wrapPending = false
  }

  // -------------------------------------------------------------- alt screen

  private enterAltScreen(saveCursor: boolean): void {
    if (this.active === 'alt') return
    if (saveCursor) this.savedCursor = { x: this.cursorX, y: this.cursorY }
    // xterm-verified: entering alt (47/1047/1049h) starts from a cleared
    // grid and PRESERVES the cursor position.
    this.altLines = blankLineGrid(this.width, this.height)
    this.active = 'alt'
    this.wrapPending = false
  }

  private exitAltScreen(restoreCursor: boolean): void {
    if (this.active === 'main') return
    this.active = 'main'
    this.wrapPending = false
    if (restoreCursor) this.restoreCursor()
  }

  // ---------------------------------------------------------------------- SGR

  private applySgr(paramText: string): void {
    if (paramText === '') {
      this.style = DEFAULT_STYLE
      return
    }
    // Split on ';'; colon sub-parameters are handled per group.
    const groups = paramText.split(';')
    let i = 0
    const next = this.style === DEFAULT_STYLE ? DEFAULT_STYLE : cloneStyle(this.style)
    let style = next === DEFAULT_STYLE ? cloneStyle(DEFAULT_STYLE) : next
    const set = (patch: Partial<CanonicalStyle>) => {
      style = { ...style, ...patch }
    }
    while (i < groups.length) {
      const group = groups[i]
      const colonParts = group.split(':')
      const code = colonParts[0] === '' ? 0 : Number.parseInt(colonParts[0], 10)
      if (colonParts.length > 1) {
        // Colon form: 4:x underline styles and 38:2../48:2.. / 38:5 / 48:5.
        if (code === 4) {
          set({ underline: true })
        } else if (code === 38 || code === 48) {
          const color = parseExtendedColor(colonParts.slice(1), groups, i)
          if (color) {
            if (code === 38) set({ foreground: color.value })
            else set({ background: color.value })
            i = color.consumed
          } else {
            this.unsupported(`sgr:${group}`)
          }
        } else {
          this.unsupported(`sgr:${group}`)
        }
        i += 1
        continue
      }
      switch (code) {
        case 0: style = cloneStyle(DEFAULT_STYLE); break
        case 1: set({ bold: true }); break
        case 2: set({ dim: true }); break
        case 3: set({ italic: true }); break
        case 4: set({ underline: true }); break
        case 7: set({ inverse: true }); break
        case 9: set({ strike: true }); break
        case 22: set({ bold: false, dim: false }); break
        case 23: set({ italic: false }); break
        case 24: set({ underline: false }); break
        case 25: case 26: break // blink off: no-op (blink is not modelled)
        case 27: set({ inverse: false }); break
        case 28: break // conceal off: no-op (conceal is not modelled)
        case 29: set({ strike: false }); break
        case 39: set({ foreground: null }); break
        case 49: set({ background: null }); break
        case 55: break // overline off: no-op
        case 59: break // default underline color: no-op
        case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37:
          set({ foreground: `ansi16:${code - 30}` })
          break
        case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
          set({ foreground: `ansi16:${code - 90 + 8}` })
          break
        case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47:
          set({ background: `ansi16:${code - 40}` })
          break
        case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
          set({ background: `ansi16:${code - 100 + 8}` })
          break
        case 38:
        case 48: {
          const color = parseExtendedColor(groups.slice(i + 1), groups, i, ';')
          if (color) {
            if (code === 38) set({ foreground: color.value })
            else set({ background: color.value })
            i = color.consumed
          } else {
            this.unsupported(`sgr:${group}`)
          }
          break
        }
        default:
          // 5/6/8/21/53/58 and unknown codes: conservatively ignored + counted.
          this.unsupported(`sgr:${code}`)
      }
      i += 1
    }
    this.style = style
  }
}

// ---------------------------------------------------------------------------
// module helpers
// ---------------------------------------------------------------------------

function trackingLabel(tracking: Exclude<MouseTracking, 'none'>): string {
  return tracking === 'x10' || tracking === 'normal'
    ? 'x10-1000'
    : tracking === 'button'
      ? 'button-1002'
      : 'any-1003'
}

function blankLineGrid(width: number, height: number): VtCell[][] {
  return Array.from({ length: height }, () => blankLine(width))
}

function resizeGrid(lines: VtCell[][], width: number, height: number): VtCell[][] {
  const out: VtCell[][] = []
  for (let y = 0; y < height; y++) {
    out.push(y < lines.length ? resizeLine(lines[y], width) : blankLine(width))
  }
  return out
}

function resizeLine(line: VtCell[], width: number): VtCell[] {
  let out = line
  if (out.length > width) out = out.slice(0, width)
  else if (out.length < width) out = [...out, ...blankLine(width - out.length)]
  healRow(out)
  return out
}

/** After structural edits, repair wide-char splits inside one row. */
function healRow(line: VtCell[]): void {
  for (let x = 0; x < line.length; x++) {
    const cell = line[x]
    if (cell.width === 2 && x + 1 >= line.length) {
      line[x] = { grapheme: '', width: 1, style: cell.style, link: cell.link }
      continue
    }
    if (cell.width === 0 && cell.grapheme === '') {
      const prev = x > 0 ? line[x - 1] : undefined
      if (!prev || prev.width !== 2) {
        line[x] = { grapheme: '', width: 1, style: cell.style, link: cell.link }
      }
    }
  }
}

function toCanonicalCell(cell: VtCell): CanonicalCell {
  return {
    grapheme: cell.grapheme,
    width: cell.width,
    continuation: cell.width === 0 && cell.grapheme === '',
    resolvedStyle: cell.style,
    hyperlink: cell.link,
  }
}

function clampCol(x: number, width: number): number {
  return Math.max(0, Math.min(width - 1, x))
}
function clampRow(y: number, height: number): number {
  return Math.max(0, Math.min(height - 1, y))
}

function parseParams(text: string): number[] {
  if (text === '') return []
  return text.split(';').map((part) => {
    if (part === '' || !/^\d+$/.test(part)) return 0
    return Number.parseInt(part, 10)
  })
}

/** Find a BEL/ST string terminator at or after `from`; returns index or -1. */
function findStringTerminator(buf: string, from: number): number {
  for (let i = from; i < buf.length; i++) {
    const code = buf.charCodeAt(i)
    if (code === 0x07 || code === 0x9c) return i
    if (code === 0x1b && buf.charCodeAt(i + 1) === 0x5c) return i
  }
  return -1
}

function terminatorLength(buf: string, at: number): number {
  return buf.charCodeAt(at) === 0x1b ? 2 : 1
}

function escapeSummary(value: string): string {
  const cp = value.codePointAt(0)
  if (cp === undefined) return 'empty'
  return `0x${cp.toString(16)}`
}

interface ParsedColor {
  readonly value: string
  /** Index of the last consumed group (absolute, in the original array). */
  readonly consumed: number
}

/**
 * Parse 38/48 extended colors. Semicolon form consumes following params
 * (`5;n`, `2;r;g;b`); colon form stays inside one group (`2:r:g:b`, `5;n`,
 * both may carry a colorspace id prefix which is skipped).
 */
function parseExtendedColor(parts: string[], groups: string[], index: number, separator?: ';'): ParsedColor | null {
  if (separator === ';') {
    // `parts` are the groups AFTER the 38/48 group.
    if (parts.length === 0) return null
    const mode = Number.parseInt(parts[0], 10)
    if (mode === 5 && parts.length >= 2) {
      const n = Number.parseInt(parts[1], 10)
      if (!Number.isInteger(n) || n < 0 || n > 255) return null
      return { value: n < 16 ? `ansi16:${n}` : `ansi256:${n}`, consumed: index + 2 }
    }
    if (mode === 2 && parts.length >= 4) {
      const r = Number.parseInt(parts[1], 10)
      const g = Number.parseInt(parts[2], 10)
      const b = Number.parseInt(parts[3], 10)
      if ([r, g, b].some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return null
      return { value: rgbHex(r, g, b), consumed: index + 4 }
    }
    return null
  }
  // Colon form: parts are the sub-parameters after `38`/`48`.
  const mode = Number.parseInt(parts[0] ?? '', 10)
  if (mode === 5 && parts.length >= 2) {
    const n = Number.parseInt(parts[1], 10)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    return { value: n < 16 ? `ansi16:${n}` : `ansi256:${n}`, consumed: index }
  }
  if (mode === 2 && parts.length >= 3) {
    // Optional colorspace id: 2:<space>:r:g:b OR 2:r:g:b.
    const offset = parts.length >= 4 ? 1 : 0
    const r = Number.parseInt(parts[offset], 10)
    const g = Number.parseInt(parts[offset + 1], 10)
    const b = Number.parseInt(parts[offset + 2], 10)
    if ([r, g, b].some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return null
    return { value: rgbHex(r, g, b), consumed: index }
  }
  return null
}

function rgbHex(r: number, g: number, b: number): string {
  return `rgb:${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}
