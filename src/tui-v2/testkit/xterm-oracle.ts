/**
 * tui-v2 testkit xterm oracle (WP-02, plan §9.2/WP-02).
 *
 * Adapter over the PINNED @xterm/headless 6.0.0 (devDependency, exact pin)
 * used as the second, independent terminal-semantics oracle. It is NOT a
 * product dependency: renderFull must never consume it, and the local
 * VirtualTerminal parser must stay self-sufficient.
 *
 * Capability boundary — what xterm's PUBLIC headless API cannot observe is
 * filled with contract-legal conservative values (documented per field):
 *   - cursor.visible: not exposed → always `true`
 *     (`buffer.active.cursorX/cursorY` are exposed; cursorX may equal cols
 *     while a wrap is pending, so it is clamped to cols-1)
 *   - modes.cursorStyle: DECSCUSR is applied internally but not exposed →
 *     the constructor default 'block'
 *   - modes.wrapPending: not exposed → `false`
 *   - modes.scrollRegion: DECSTBM is applied but not exposed → full screen
 *   - modes.kittyKeyboard / modifyOtherKeys / windowsDec9001 / osc133 /
 *     progress / rawInput: not exposed → `false` / { state: 'none' }
 *   - cell hyperlinks: OSC 8 links are stored by xterm but NOT exposed per
 *     cell in the public buffer API → always `null`
 *   - images: kitty APC / iTerm2 OSC 1337 are ignored by xterm → `[]`
 *   - mouse: `IModes.mouseTrackingMode` exposes the tracking level but not
 *     the 1006/1015 encoding → mapped to tracking-only canonical values
 *
 * Cross-parser comparison must therefore go through
 * `projectToXtermComparable`, which reduces a canonical grid to exactly the
 * surface both parsers can express (see its docstring).
 *
 * Unicode boundary: xterm 6.0 ships Unicode version 6 only (no grapheme
 * clustering; emoji measure narrow). Fixtures exercising ZWJ/RI/emoji width
 * are conservative-only with reviewed goldens, not xterm-cross-checked.
 *
 * `write` is async because xterm parses asynchronously and only guarantees
 * the callback fires after the chunk is fully parsed — awaiting each chunk
 * gives deterministic snapshots and natural writer backpressure (§9.2).
 */
import xtermHeadless from '@xterm/headless'
import type { IBufferCell } from '@xterm/headless'
import type { MouseTrackingMode, TerminalModeSnapshot } from '../renderer/frame.js'
import type { TerminalProfile } from '../terminal/profile.js'
import type {
  CanonicalCell,
  CanonicalGridV1,
  CanonicalImagePlacement,
  CanonicalStyle,
} from './canonical.js'
import { VT_DEFAULT_SCROLLBACK_LIMIT } from './virtual-terminal.js'

// @xterm/headless is CommonJS; the default import carries the namespace.
const { Terminal } = xtermHeadless

type XtermTerminal = InstanceType<typeof Terminal>

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

export class XtermOracle {
  private readonly term: XtermTerminal
  private title: string | null = null

  constructor(profile: TerminalProfile) {
    this.term = new Terminal({
      cols: profile.columns,
      rows: profile.rows,
      scrollback: VT_DEFAULT_SCROLLBACK_LIMIT,
      allowProposedApi: true,
    })
    this.term.onTitleChange((title: string) => {
      this.title = title
    })
  }

  /** Feed a chunk; resolves once xterm has fully parsed it. */
  write(chunk: string): Promise<void> {
    if (chunk.length === 0) return Promise.resolve()
    return new Promise((resolve) => {
      this.term.write(chunk, () => resolve())
    })
  }

  resize(width: number, height: number): void {
    this.term.resize(width, height)
  }

  reset(): void {
    this.term.reset()
    this.title = null
  }

  snapshot(): CanonicalGridV1 {
    const buffer = this.term.buffer.active
    const cols = this.term.cols
    const rows = this.term.rows

    const cells: CanonicalCell[] = []
    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(buffer.baseY + y)
      for (let x = 0; x < cols; x++) {
        cells.push(translateCell(line?.getCell(x)))
      }
    }

    // Scrollback always comes from the NORMAL buffer (it survives alt screen).
    const normal = this.term.buffer.normal
    const scrollback: CanonicalCell[][] = []
    if (normal.baseY > 0) {
      for (let y = 0; y < normal.baseY; y++) {
        const line = normal.getLine(y)
        const out: CanonicalCell[] = []
        for (let x = 0; x < cols; x++) out.push(translateCell(line?.getCell(x)))
        scrollback.push(out)
      }
    }

    const modes: TerminalModeSnapshot = {
      alternateScreen: buffer.type === 'alternate',
      rawInput: false, // termios-level state; not exposed by xterm
      mouse: mapMouse(this.term.modes.mouseTrackingMode),
      bracketedPaste: this.term.modes.bracketedPasteMode,
      syncOutput: this.term.modes.synchronizedOutputMode,
      autowrap: this.term.modes.wraparoundMode,
      wrapPending: false, // not exposed (cursorX === cols implies it)
      scrollRegion: { top: 0, bottom: rows - 1 }, // DECSTBM not exposed
      cursorStyle: 'block', // DECSCUSR not exposed; constructor default
      cursorVisible: true, // DECSET 25 not exposed
      kittyKeyboard: false, // not exposed
      modifyOtherKeys: false, // not exposed
      focusReporting: this.term.modes.sendFocusMode,
      windowsDec9001: false, // not exposed
      osc133: false, // not exposed
      title: this.title,
      progress: { state: 'none' }, // OSC 9;4 not handled/exposed by xterm
    }

    const images: CanonicalImagePlacement[] = [] // xterm ignores image protocols

    return {
      width: cols,
      height: rows,
      cells,
      cursor: {
        // cursorX may be cols while a wrap is pending; clamp into the grid.
        x: Math.min(buffer.cursorX, cols - 1),
        y: Math.min(buffer.cursorY, rows - 1),
        visible: true,
      },
      modes,
      scrollback,
      images,
    }
  }

  dispose(): void {
    this.term.dispose()
  }
}

function translateCell(cell: IBufferCell | undefined): CanonicalCell {
  if (!cell) {
    return { grapheme: '', width: 1, continuation: false, resolvedStyle: DEFAULT_STYLE, hyperlink: null }
  }
  const grapheme = cell.getChars()
  const width = cell.getWidth() as 0 | 1 | 2
  const style: CanonicalStyle = {
    foreground: translateColor(cell, 'fg'),
    background: translateColor(cell, 'bg'),
    bold: cell.isBold() !== 0,
    dim: cell.isDim() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    inverse: cell.isInverse() !== 0,
    strike: cell.isStrikethrough() !== 0,
  }
  return {
    grapheme,
    width,
    continuation: width === 0 && grapheme === '',
    resolvedStyle: style,
    hyperlink: null, // xterm's public buffer API does not expose OSC 8 links
  }
}

function translateColor(cell: IBufferCell, which: 'fg' | 'bg'): string | null {
  const isDefault = which === 'fg' ? cell.isFgDefault() : cell.isBgDefault()
  if (isDefault) return null
  const isRgb = which === 'fg' ? cell.isFgRGB() : cell.isBgRGB()
  if (isRgb) {
    const packed = which === 'fg' ? cell.getFgColor() : cell.getBgColor()
    return `rgb:${(packed & 0xffffff).toString(16).padStart(6, '0')}`
  }
  const isPalette = which === 'fg' ? cell.isFgPalette() : cell.isBgPalette()
  if (isPalette) {
    const n = which === 'fg' ? cell.getFgColor() : cell.getBgColor()
    return n < 16 ? `ansi16:${n}` : `ansi256:${n}`
  }
  return null
}

/**
 * Map xterm's tracking-level-only mouse mode onto the canonical enum.
 * 'x10-1000' covers xterm 'x10' (DECSET 9) and 'vt200' (DECSET 1000) — the
 * canonical enum conflates the two; the 1006/1015 encoding is not exposed.
 */
function mapMouse(mode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'): MouseTrackingMode {
  switch (mode) {
    case 'none':
      return 'off'
    case 'x10':
    case 'vt200':
      return 'x10-1000'
    case 'drag':
      return 'button-1002'
    case 'any':
      return 'any-1003'
  }
}

/**
 * Reduce a canonical grid to the surface BOTH parsers can express, so the
 * conformance corpus can compare the local VT against the xterm oracle (and
 * stored xterm-generated goldens) with `compareGrid` as the only assertion
 * entry point:
 *   - cell/scrollback hyperlinks → null (xterm cannot expose OSC 8)
 *   - cursor → { x, y, visible: true } (visibility not exposed)
 *   - modes → alternateScreen, bracketedPaste, syncOutput, autowrap,
 *     focusReporting, title; mouse coarsened to off/tracking (encoding not
 *     exposed); every other field pinned to its contract default
 *   - images → [] (xterm ignores image protocols)
 */
export function projectToXtermComparable(grid: CanonicalGridV1): CanonicalGridV1 {
  const projectCell = (cell: CanonicalCell): CanonicalCell =>
    cell.hyperlink === null ? cell : { ...cell, hyperlink: null }
  const cursor = grid.cursor as { readonly x: number; readonly y: number; readonly visible: boolean }
  return {
    width: grid.width,
    height: grid.height,
    cells: grid.cells.map(projectCell),
    cursor: {
      x: Math.min(cursor.x, grid.width - 1),
      y: cursor.y,
      visible: true,
    },
    modes: {
      alternateScreen: grid.modes.alternateScreen,
      rawInput: false,
      mouse: grid.modes.mouse === 'off' ? 'off' : 'any-1003',
      bracketedPaste: grid.modes.bracketedPaste,
      syncOutput: grid.modes.syncOutput,
      autowrap: grid.modes.autowrap,
      wrapPending: false,
      scrollRegion: { top: 0, bottom: grid.height - 1 },
      cursorStyle: 'unknown',
      cursorVisible: true,
      kittyKeyboard: false,
      modifyOtherKeys: false,
      focusReporting: grid.modes.focusReporting,
      windowsDec9001: false,
      osc133: false,
      title: grid.modes.title,
      progress: { state: 'none' },
    },
    scrollback: grid.scrollback.map((line) => line.map(projectCell)),
    images: [],
  }
}
