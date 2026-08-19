/**
 * tui-v2 terminal ANSI/OSC/DEC control-sequence builders (WP-03b, plan §5.6).
 *
 * This module is the ONLY source of `ControlSequence` values. The brand is a
 * compile-time marker; the runtime guarantee is the module-private trust
 * registry: `brand()` registers every produced string and
 * `isTrustedControlSequence()` is the only way to test membership. The writer
 * (`writer.ts`) rejects sequence-branch operations whose string is not in the
 * registry, so callers can never pass arbitrary CSI/OSC strings to the tty.
 *
 * NOTE on the registry data structure: the plan text says "WeakSet<string>",
 * but JS WeakSets cannot hold primitives. A module-private `Set<string>` is
 * used instead; it stores each distinct sequence once (string equality
 * dedupes repeated identical sequences). All payloads are length-capped
 * (OSC 8 uri ≤ 2083, title ≤ 256, image payload ≤ 8 MiB), so registry growth
 * is bounded by the number of distinct sequences the app actually produces.
 *
 * Every builder validates its action against an allowlist, its numeric
 * parameters against fixed ranges and its OSC payloads against charset/length
 * rules, and throws `RangeError`/`TypeError` on violation — builders never
 * emit caller-controlled raw bytes. `brand()` is module-private on purpose.
 *
 * Dependency rule (§4.3): `import type` from renderer/model only, plus node
 * globals (Buffer). No vendor, no controllers/app imports.
 */
import type {
  FrameResources,
  HyperlinkDescriptor,
  StyleDescriptor,
  TerminalCell,
} from '../renderer/frame.js'

export type ControlSequence = string & { readonly __terminalControlSequence: unique symbol }

// ---------------------------------------------------------------------------
// trust registry (module-private; see header note on Set vs WeakSet)
// ---------------------------------------------------------------------------

const trustedSequences = new Set<string>()

/** Runtime trust check used by TerminalWriter.writeControl (§5.6). */
export function isTrustedControlSequence(value: unknown): value is ControlSequence {
  return typeof value === 'string' && trustedSequences.has(value)
}

/** The single private branding point. Never exported (§5.6). */
function brand(raw: string): ControlSequence {
  trustedSequences.add(raw)
  return raw as ControlSequence
}

// ---------------------------------------------------------------------------
// numeric bounds
// ---------------------------------------------------------------------------

const MAX_CURSOR_PARAM = 9999
const MAX_IMAGE_PAYLOAD_BYTES = 8 * 1024 * 1024
const MAX_OSC8_URI_LENGTH = 2083
const MAX_TITLE_LENGTH = 256

function requireBoundedInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`)
  }
  return value
}

const ESC = '\x1b'
const BEL = '\x07'
const ST = '\x1b\\'

/** C0/C1/DEL must never appear inside OSC string payloads. */
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/

// ---------------------------------------------------------------------------
// SGR (styles)
// ---------------------------------------------------------------------------

const NAMED_COLORS: Readonly<Record<string, number>> = {
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
  default: -1,
}

/**
 * Parse the pinned color string forms into SGR parameters:
 *   named ('red', 'bright-blue', 'default'), 'ansi16:<0-15>',
 *   'ansi256:<0-255>', '#rrggbb' / 'rgb:rrggbb' (truecolor).
 * These are the same canonical spellings the testkit canonical grid uses.
 */
function colorParams(color: string, foreground: boolean): number[] {
  const named = NAMED_COLORS[color]
  if (named !== undefined) {
    if (named === -1) return [foreground ? 39 : 49]
    const base = foreground ? 30 : 40
    const brightBase = foreground ? 90 : 100
    return [named < 8 ? base + named : brightBase + (named - 8)]
  }
  const ansi16 = /^ansi16:(\d{1,2})$/.exec(color)
  if (ansi16) {
    const n = Number.parseInt(ansi16[1] as string, 10)
    if (n > 15) throw new RangeError(`ansi16 color out of range: ${color}`)
    const base = foreground ? 30 : 40
    const brightBase = foreground ? 90 : 100
    return [n < 8 ? base + n : brightBase + (n - 8)]
  }
  const ansi256 = /^ansi256:(\d{1,3})$/.exec(color)
  if (ansi256) {
    const n = Number.parseInt(ansi256[1] as string, 10)
    if (n > 255) throw new RangeError(`ansi256 color out of range: ${color}`)
    return [foreground ? 38 : 48, 5, n]
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
  throw new TypeError(`unsupported color string: ${JSON.stringify(color)}`)
}

function isDefaultStyle(style: StyleDescriptor): boolean {
  return (
    style.foreground === null &&
    style.background === null &&
    !style.bold &&
    !style.dim &&
    !style.italic &&
    !style.underline &&
    !style.inverse &&
    !style.strike
  )
}

/** Full SGR for a style: reset first, then every attribute (deterministic). */
export function sgrStyle(style: StyleDescriptor): ControlSequence {
  if (isDefaultStyle(style)) return sgrReset()
  const params: number[] = [0]
  if (style.bold) params.push(1)
  if (style.dim) params.push(2)
  if (style.italic) params.push(3)
  if (style.underline) params.push(4)
  if (style.inverse) params.push(7)
  if (style.strike) params.push(9)
  if (style.foreground !== null) params.push(...colorParams(style.foreground, true))
  if (style.background !== null) params.push(...colorParams(style.background, false))
  return brand(`${ESC}[${params.join(';')}m`)
}

export function sgrReset(): ControlSequence {
  return brand(`${ESC}[0m`)
}

// ---------------------------------------------------------------------------
// cursor
// ---------------------------------------------------------------------------

function relativeCursor(final: string, n: number): ControlSequence {
  requireBoundedInteger('cursor count', n, 0, MAX_CURSOR_PARAM)
  // n === 0 is a defined no-op: emitting CSI 0 <final> would MOVE by one cell
  // (terminals clamp 0 to 1), so the no-op is the empty branded string.
  if (n === 0) return brand('')
  return brand(`${ESC}[${n}${final}`)
}

export const cursorUp = (n: number): ControlSequence => relativeCursor('A', n)
export const cursorDown = (n: number): ControlSequence => relativeCursor('B', n)
export const cursorForward = (n: number): ControlSequence => relativeCursor('C', n)
export const cursorBack = (n: number): ControlSequence => relativeCursor('D', n)

/** Absolute position, 1-based row/column (CUP). */
export function cursorTo(row: number, column: number): ControlSequence {
  requireBoundedInteger('cursor row', row, 1, MAX_CURSOR_PARAM)
  requireBoundedInteger('cursor column', column, 1, MAX_CURSOR_PARAM)
  return brand(`${ESC}[${row};${column}H`)
}

export function cursorShow(): ControlSequence {
  return brand(`${ESC}[?25h`)
}
export function cursorHide(): ControlSequence {
  return brand(`${ESC}[?25l`)
}

/** CHA — absolute column, 1-based (pi main-screen hardware cursor positioning). */
export function cursorColumn(column: number): ControlSequence {
  requireBoundedInteger('cursor column', column, 1, MAX_CURSOR_PARAM)
  return brand(`${ESC}[${column}G`)
}

const CURSOR_STYLE_PARAMS = { block: 2, underline: 4, bar: 6 } as const

/** DECSCUSR (steady shapes only: 2 block, 4 underline, 6 bar). */
export function cursorStyleShape(shape: keyof typeof CURSOR_STYLE_PARAMS): ControlSequence {
  const param = CURSOR_STYLE_PARAMS[shape]
  if (param === undefined) throw new TypeError(`unsupported cursor style: ${String(shape)}`)
  return brand(`${ESC}[${param} q`)
}

// ---------------------------------------------------------------------------
// erase (ED/EL 0/1/2) + ECH
// ---------------------------------------------------------------------------

/**
 * ED — erase in display. Modes 0/1/2 erase viewport regions; mode 3 clears
 * the scrollback buffer (xterm; the VT oracle implements it). The vendored pi
 * main-screen emits `CSI 3 J` on full-redraw-with-clear.
 */
export function eraseInDisplay(mode: 0 | 1 | 2 | 3): ControlSequence {
  if (mode !== 0 && mode !== 1 && mode !== 2 && mode !== 3) throw new RangeError(`ED mode must be 0|1|2|3, got ${mode}`)
  return brand(`${ESC}[${mode}J`)
}

export function eraseInLine(mode: 0 | 1 | 2): ControlSequence {
  if (mode !== 0 && mode !== 1 && mode !== 2) throw new RangeError(`EL mode must be 0|1|2, got ${mode}`)
  return brand(`${ESC}[${mode}K`)
}

/**
 * ECH — erase `n` character cells at the cursor (BCE: erased cells carry the
 * current SGR style). Needed to encode PatchOperation 'erase' rectangles; the
 * VirtualTerminal oracle implements CSI X.
 */
export function eraseCharacters(n: number): ControlSequence {
  requireBoundedInteger('erase count', n, 0, MAX_CURSOR_PARAM)
  if (n === 0) return brand('')
  return brand(`${ESC}[${n}X`)
}

// ---------------------------------------------------------------------------
// scrolling (DECSTBM + SU/SD)
// ---------------------------------------------------------------------------

/** DECSTBM, 1-based inclusive margins; requires top < bottom. */
export function setScrollRegion(top: number, bottom: number): ControlSequence {
  requireBoundedInteger('scroll region top', top, 1, MAX_CURSOR_PARAM)
  requireBoundedInteger('scroll region bottom', bottom, 1, MAX_CURSOR_PARAM)
  if (top >= bottom) throw new RangeError(`scroll region requires top < bottom, got ${top};${bottom}`)
  return brand(`${ESC}[${top};${bottom}r`)
}

export function resetScrollRegion(): ControlSequence {
  return brand(`${ESC}[r`)
}

export function scrollUp(n: number): ControlSequence {
  requireBoundedInteger('scroll count', n, 0, MAX_CURSOR_PARAM)
  if (n === 0) return brand('')
  return brand(`${ESC}[${n}S`)
}

export function scrollDown(n: number): ControlSequence {
  requireBoundedInteger('scroll count', n, 0, MAX_CURSOR_PARAM)
  if (n === 0) return brand('')
  return brand(`${ESC}[${n}T`)
}

// ---------------------------------------------------------------------------
// modes (DECSET/DECRST allowlist) + synchronized output
// ---------------------------------------------------------------------------

const DEC_MODE_ALLOWLIST: ReadonlySet<number> = new Set([
  7, 25, 47, 1000, 1002, 1003, 1004, 1006, 1015, 1047, 1049, 2004, 2026,
  // 2031: color-scheme change notifications (pi `CSI ? 2031 h/l`, WP-03c fork
  // call sites in tui.ts; not part of the original §5.6 enumeration — the
  // vendored TUI negotiates it through the compat write path).
  2031,
])

function requireAllowedMode(mode: number): number {
  if (!DEC_MODE_ALLOWLIST.has(mode)) {
    throw new RangeError(`DEC mode ${mode} is not in the allowlist`)
  }
  return mode
}

export function decset(mode: number): ControlSequence {
  return brand(`${ESC}[?${requireAllowedMode(mode)}h`)
}

export function decrst(mode: number): ControlSequence {
  return brand(`${ESC}[?${requireAllowedMode(mode)}l`)
}

/** Sync output (DECSET 2026) is only ever emitted in these two fixed forms. */
export function syncOutputBegin(): ControlSequence {
  return brand(`${ESC}[?2026h`)
}
export function syncOutputEnd(): ControlSequence {
  return brand(`${ESC}[?2026l`)
}

// ---------------------------------------------------------------------------
// OSC 8 hyperlinks
// ---------------------------------------------------------------------------

export function hyperlink(uri: string, params?: string): ControlSequence {
  if (typeof uri !== 'string' || uri.length === 0) throw new TypeError('hyperlink uri must be a non-empty string')
  if (uri.length > MAX_OSC8_URI_LENGTH) {
    throw new RangeError(`hyperlink uri exceeds ${MAX_OSC8_URI_LENGTH} chars`)
  }
  if (CONTROL_CHARS.test(uri)) throw new TypeError('hyperlink uri must not contain control characters')
  if (params !== undefined) {
    if (CONTROL_CHARS.test(params) || params.includes(';')) {
      throw new TypeError('hyperlink params must not contain control characters or ";"')
    }
    if (params.length > MAX_OSC8_URI_LENGTH) throw new RangeError('hyperlink params too long')
  }
  return brand(`${ESC}]8;${params ?? ''};${uri}${BEL}`)
}

export function hyperlinkClose(): ControlSequence {
  return brand(`${ESC}]8;;${BEL}`)
}

// ---------------------------------------------------------------------------
// OSC 0/2 title
// ---------------------------------------------------------------------------

/** Strip every control character (C0/C1/DEL, which includes ESC and BEL). */
function sanitizeOscText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, '')
}

export function setTitle(value: string, scope: 0 | 2 = 2): ControlSequence {
  if (typeof value !== 'string') throw new TypeError('title must be a string')
  const clean = sanitizeOscText(value)
  if (clean.length > MAX_TITLE_LENGTH) {
    throw new RangeError(`title exceeds ${MAX_TITLE_LENGTH} chars after sanitization`)
  }
  if (scope !== 0 && scope !== 2) throw new RangeError(`title scope must be 0|2, got ${scope}`)
  return brand(`${ESC}]${scope};${clean}${BEL}`)
}

// ---------------------------------------------------------------------------
// OSC 9;4 progress
// ---------------------------------------------------------------------------

// 'indeterminate' (3) exists for the pi compat path (pi `setProgress(true)`
// emits OSC 9;4;3); the pinned §5.6 lifecycle progress op does not include it,
// so the adapter uses the sequence lane for that one state.
const PROGRESS_STATE_PARAMS = { none: 0, normal: 1, error: 2, indeterminate: 3, paused: 4 } as const

export function progress(
  state: keyof typeof PROGRESS_STATE_PARAMS,
  value?: number,
): ControlSequence {
  const param = PROGRESS_STATE_PARAMS[state]
  if (param === undefined) throw new TypeError(`unsupported progress state: ${String(state)}`)
  if (value !== undefined) requireBoundedInteger('progress value', value, 0, 100)
  const suffix = value === undefined ? '' : `;${value}`
  return brand(`${ESC}]9;4;${param}${suffix}${BEL}`)
}

// ---------------------------------------------------------------------------
// kitty keyboard protocol
// ---------------------------------------------------------------------------

export function kittyKeyboardPush(flags: number): ControlSequence {
  requireBoundedInteger('kitty keyboard flags', flags, 0, 15)
  return brand(`${ESC}[>${flags}u`)
}

export function kittyKeyboardSet(flags: number, mode: 1 | 2 | 3): ControlSequence {
  requireBoundedInteger('kitty keyboard flags', flags, 0, 15)
  if (mode !== 1 && mode !== 2 && mode !== 3) throw new RangeError(`kitty set mode must be 1|2|3, got ${mode}`)
  return brand(`${ESC}[=${flags};${mode}u`)
}

export function kittyKeyboardPop(count: number): ControlSequence {
  requireBoundedInteger('kitty keyboard pop count', count, 1, 99)
  return brand(`${ESC}[<${count}u`)
}

// ---------------------------------------------------------------------------
// images: kitty APC + iTerm2 OSC 1337
// ---------------------------------------------------------------------------

function requireBase64Payload(payload: string): string {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new TypeError('payload must be a non-empty base64 string')
  }
  if (!BASE64_CHARS.test(payload)) throw new TypeError('payload must use the base64 character set only')
  if (Buffer.byteLength(payload, 'utf8') > MAX_IMAGE_PAYLOAD_BYTES) {
    throw new RangeError(`payload exceeds ${MAX_IMAGE_PAYLOAD_BYTES} bytes`)
  }
  return payload
}

const KITTY_KEY = /^[a-zA-Z][a-zA-Z0-9]*$/

/**
 * Kitty graphics protocol: ESC _ G key=value,... ; payload ST.
 * `keys` values must be printable ASCII without ',', ';' or control chars
 * (they would corrupt the key/value grammar). The payload may be empty ONLY
 * for payload-free commands (a=d delete / a=p placement) — the pi fork's
 * declared markers use exactly those forms.
 */
export function kittyImage(keys: Readonly<Record<string, string | number>>, payloadBase64: string): ControlSequence {
  const pairs: string[] = []
  for (const [key, value] of Object.entries(keys)) {
    if (!KITTY_KEY.test(key)) throw new TypeError(`invalid kitty key: ${JSON.stringify(key)}`)
    const text = String(value)
    if (!/^[A-Za-z0-9_+.:/-]*$/.test(text)) {
      throw new TypeError(`invalid kitty value for ${key}: ${JSON.stringify(text)}`)
    }
    pairs.push(`${key}=${text}`)
  }
  if (payloadBase64 === '') {
    const action = keys.a
    if (action !== 'd' && action !== 'p') {
      throw new TypeError('kitty payload may be empty only for delete (a=d) / placement (a=p) commands')
    }
    // Payload-free commands omit the ';' separator entirely (pi marker form).
    return brand(`${ESC}_G${pairs.join(',')}${ST}`)
  }
  return brand(`${ESC}_G${pairs.join(',')};${requireBase64Payload(payloadBase64)}${ST}`)
}

const ITERM2_DIMENSION = /^\d+(?:px|%)?$|^auto$/

/**
 * iTerm2 inline image: OSC 1337 ; File=key=value;...:payload BEL.
 * Parameter order matches the pinned pi `encodeITerm2` form:
 * inline, size (decoded bytes), width, height, name, preserveAspectRatio.
 * width/height accept cell counts, 'Npx', 'N%' or 'auto' (protocol forms).
 */
export function iterm2Image(
  options: {
    readonly width?: number | string
    readonly height?: number | string
    readonly name?: string
    readonly size?: number
    readonly preserveAspectRatio?: boolean
    readonly inline?: boolean
  },
  payloadBase64: string,
): ControlSequence {
  const dimension = (name: string, value: number | string): string => {
    if (typeof value === 'number') return String(requireBoundedInteger(`iterm2 ${name}`, value, 1, MAX_CURSOR_PARAM * 100))
    if (!ITERM2_DIMENSION.test(value)) throw new TypeError(`iterm2 ${name} must be N, Npx, N% or auto, got ${JSON.stringify(value)}`)
    return value
  }
  const parts: string[] = [`inline=${options.inline === false ? 0 : 1}`]
  if (options.size !== undefined) parts.push(`size=${requireBoundedInteger('iterm2 size', options.size, 0, MAX_IMAGE_PAYLOAD_BYTES)}`)
  if (options.width !== undefined) parts.push(`width=${dimension('width', options.width)}`)
  if (options.height !== undefined) parts.push(`height=${dimension('height', options.height)}`)
  if (options.name !== undefined) {
    if (!BASE64_CHARS.test(options.name)) throw new TypeError('iterm2 name must be base64 (per protocol)')
    parts.push(`name=${options.name}`)
  }
  if (options.preserveAspectRatio === false) parts.push('preserveAspectRatio=0')
  return brand(`${ESC}]1337;File=${parts.join(';')}:${requireBase64Payload(payloadBase64)}${BEL}`)
}

// ---------------------------------------------------------------------------
// terminal queries (fixed forms, one builder each; responses parsed in query.ts)
// ---------------------------------------------------------------------------

export const queryCursorReport = (): ControlSequence => brand(`${ESC}[6n`)
export const queryXtVersion = (): ControlSequence => brand(`${ESC}[>0q`)
export const queryDeviceAttributes = (): ControlSequence => brand(`${ESC}[c`)
export const queryKittyKeyboard = (): ControlSequence => brand(`${ESC}[?u`)
/** Cell geometry in pixels (CSI 16 t). */
export const queryCellSize = (): ControlSequence => brand(`${ESC}[16t`)
/** Text-area size in pixels (CSI 14 t). */
export const queryWindowSizePixels = (): ControlSequence => brand(`${ESC}[14t`)
/** Text-area size in character cells (CSI 18 t). */
export const queryTextAreaSize = (): ControlSequence => brand(`${ESC}[18t`)
/** OSC 11 background color query. */
export const queryBackgroundColor = (): ControlSequence => brand(`${ESC}]11;?${BEL}`)
/** DECRQM for focus reporting mode 1004. */
export const queryFocusReportingMode = (): ControlSequence => brand(`${ESC}[?1004$p`)
/** DSR 996 — terminal color-scheme preference query (pi fork query, WP-03c). */
export const queryColorScheme = (): ControlSequence => brand(`${ESC}[?996n`)

// ---------------------------------------------------------------------------
// OSC 52 clipboard (pi compat path; payload is already-base64 clipboard text)
// ---------------------------------------------------------------------------

export function osc52Clipboard(payloadBase64: string): ControlSequence {
  return brand(`${ESC}]52;c;${requireBase64Payload(payloadBase64)}${BEL}`)
}

// ---------------------------------------------------------------------------
// piCellDataRun — validated pi data-plane runs (WP-03c compat boundary)
// ---------------------------------------------------------------------------

/**
 * Brand a pre-parsed pi data-plane run. This is the ONE compat-boundary
 * builder whose input is caller text: the PiTerminalAdapter's strict parser
 * (`parsePiTerminalString`) segments fork `write(string)` buffers and hands
 * only the data-plane spans here. The builder RE-VALIDATES the pinned
 * data grammar itself (defense in depth — the trust registry must never
 * brand an unchecked string):
 *
 *   run       := ( printable | CR | LF | sgr | osc8 )*
 *   printable := code point ≥ U+0020, excluding U+007F–U+009F and ESC
 *   sgr       := CSI [0-9;:]* 'm'
 *   osc8      := ESC ']' '8;' params ';' uri (BEL | ST)   (printable payload)
 *
 * Anything else (other CSI, other OSC, APC, C0/C1/DEL controls, unterminated
 * sequences) throws TypeError. Runs longer than 8 MiB throw RangeError.
 */
export function piCellDataRun(raw: string): ControlSequence {
  if (typeof raw !== 'string') throw new TypeError('pi cell data run must be a string')
  if (Buffer.byteLength(raw, 'utf8') > MAX_IMAGE_PAYLOAD_BYTES) {
    throw new RangeError(`pi cell data run exceeds ${MAX_IMAGE_PAYLOAD_BYTES} bytes`)
  }
  let i = 0
  while (i < raw.length) {
    const cp = raw.codePointAt(i) as number
    if (cp === 0x1b) {
      // SGR or OSC 8 — nothing else is data plane.
      if (raw.startsWith('[', i + 1)) {
        const match = /^\x1b\[([0-9;:]*)m/.exec(raw.slice(i, i + 64))
        if (match === null) throw new TypeError(`pi cell data run: non-SGR CSI at offset ${i}`)
        i += match[0].length
        continue
      }
      if (raw.startsWith(']8;', i + 1)) {
        const end = findOsc8End(raw, i)
        i = end
        continue
      }
      throw new TypeError(`pi cell data run: disallowed escape sequence at offset ${i}`)
    }
    if (cp === 0x0d || cp === 0x0a) {
      i += 1
      continue
    }
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
      throw new TypeError(`pi cell data run: control character U+${cp.toString(16)} at offset ${i}`)
    }
    i += cp > 0xffff ? 2 : 1
  }
  return brand(raw)
}

/** Validate one OSC 8 sequence starting at `start`; return the end offset. */
function findOsc8End(raw: string, start: number): number {
  // raw.startsWith(']8;', start + 1) is guaranteed by the caller. The grammar
  // is `8 ; params ; uri` — the uri may itself contain ';' (URLs), so only the
  // SECOND ';' is structural; everything after it is uri payload.
  let i = start + 4 // past ESC ] 8 ;
  let paramsClosed = false
  for (;;) {
    if (i >= raw.length) throw new TypeError(`pi cell data run: unterminated OSC 8 at offset ${start}`)
    const cp = raw.charCodeAt(i)
    if (cp === 0x07 || (cp === 0x1b && raw.charCodeAt(i + 1) === 0x5c)) {
      if (!paramsClosed) throw new TypeError(`pi cell data run: OSC 8 without params/uri separator at offset ${start}`)
      return cp === 0x07 ? i + 1 : i + 2
    }
    if (cp === 0x1b) throw new TypeError(`pi cell data run: malformed OSC 8 terminator at offset ${i}`)
    if (cp === 0x3b) paramsClosed = true
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      throw new TypeError(`pi cell data run: control character in OSC 8 at offset ${i}`)
    }
    i += 1
  }
}

// ---------------------------------------------------------------------------
// encodeCells — the single fixed SGR/OSC 8 cell encoder (§5.5/§5.6)
// ---------------------------------------------------------------------------

export interface EncodedCells {
  readonly sequence: ControlSequence
  /** Buffer.byteLength(sequence, 'utf8') — used to validate TerminalPatch.bytes. */
  readonly bytes: number
  /** width-0 continuation cells skipped (the caller guarantees runs are legal). */
  readonly skippedContinuations: number
}

function indexById<T extends { readonly id: number }>(items: readonly T[], what: string): Map<number, T> {
  const map = new Map<number, T>()
  for (const item of items) {
    if (!Number.isInteger(item.id) || item.id < 0) throw new TypeError(`${what} id must be a non-negative integer`)
    if (map.has(item.id)) throw new TypeError(`duplicate ${what} id ${item.id}`)
    map.set(item.id, item)
  }
  return map
}

/**
 * Encode a run of cells with their frame resources into text + SGR + OSC 8.
 * Style/hyperlink ids must resolve in `resources`; unresolved ids throw (the
 * writer turns that into a WriterError). State changes are emitted as full
 * re-specification (SGR reset + all attributes, OSC 8 close + open) so the
 * encoding is deterministic and shared byte-for-byte with DiffPlanner.
 */
export function encodeCells(cells: readonly TerminalCell[], resources: FrameResources): EncodedCells {
  const styles = indexById(resources.styles, 'style')
  const hyperlinks = indexById(resources.hyperlinks, 'hyperlink')

  let out = ''
  let currentStyleId: number | null = null // null = terminal default style
  let currentLinkId: number | null = null
  let skipped = 0

  for (const cell of cells) {
    if (cell.width === 0) {
      skipped += 1
      continue
    }
    if (cell.width !== 1 && cell.width !== 2) {
      throw new TypeError(`cell width must be 0|1|2, got ${cell.width}`)
    }
    if (typeof cell.grapheme !== 'string') throw new TypeError('cell grapheme must be a string')
    const style = styles.get(cell.styleId)
    if (style === undefined) throw new TypeError(`unresolvable styleId ${cell.styleId}`)
    let link: HyperlinkDescriptor | null = null
    if (cell.hyperlinkId !== undefined) {
      link = hyperlinks.get(cell.hyperlinkId) ?? null
      if (link === null) throw new TypeError(`unresolvable hyperlinkId ${cell.hyperlinkId}`)
    }

    const linkId = link === null ? null : link.id
    if (linkId !== currentLinkId) {
      if (currentLinkId !== null) out += hyperlinkClose()
      if (link !== null) out += hyperlink(link.uri, link.params)
      currentLinkId = linkId
    }
    if (cell.styleId !== currentStyleId) {
      out += sgrStyle(style)
      currentStyleId = cell.styleId
    }
    out += cell.grapheme
  }

  // Never leak SGR/OSC 8 state past the end of a run.
  if (currentLinkId !== null) out += hyperlinkClose()
  if (currentStyleId !== null) out += sgrReset()

  const sequence = brand(out)
  return { sequence, bytes: Buffer.byteLength(out, 'utf8'), skippedContinuations: skipped }
}
