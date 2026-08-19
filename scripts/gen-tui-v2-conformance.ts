/**
 * WP-02 generator: ANSI/OSC/DEC conformance corpus + the five golden grids.
 *
 *   fixtures/tui-v2/conformance/<name>.jsonl  — one case per file
 *   test/tui-v2/goldens/<name>.json           — first-frame / resize /
 *                                               scrollback / overlay / cleanup
 *
 * Expected grids are produced by the PINNED @xterm/headless oracle
 * (xterm-cross-check: projected to the mutually observable surface; the five
 * goldens: full canonical snapshot). Cases the oracle cannot express
 * (grapheme clustering, ambiguous-wide, image placements, 1-column clip) are
 * conservative-only with expected grids from the local VirtualTerminal —
 * those MUST be human-reviewed after generation (plan §9.2). Run with
 * `--review` to print an ASCII rendering of every expected grid instead of
 * writing files.
 *
 * Deterministic by construction: fixed byte strings, fixed sizes, seeds 42+i.
 *
 * Run:    node --import tsx/esm scripts/gen-tui-v2-conformance.ts
 * Review: node --import tsx/esm scripts/gen-tui-v2-conformance.ts --review
 */
import { writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  writeConformance,
  evaluateConformanceCase,
  evaluateGoldenFile,
  type ConformanceBodyLine,
  type ConformanceCase,
  type ConformanceOracle,
  type GoldenStep,
} from '../src/tui-v2/testkit/conformance.js'
import type { CanonicalGridV1 } from '../src/tui-v2/testkit/canonical.js'
import { getProfile } from '../src/tui-v2/testkit/terminal-profiles.js'
import {
  replayVirtualTerminal,
  replayXtermOracle,
} from '../src/tui-v2/testkit/conformance.js'
import { projectToXtermComparable } from '../src/tui-v2/testkit/xterm-oracle.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const conformanceDir = path.join(repoRoot, 'fixtures', 'tui-v2', 'conformance')
const goldensDir = path.join(repoRoot, 'test', 'tui-v2', 'goldens')
const reviewMode = process.argv.includes('--review')

const R = (width: number, height: number): GoldenStep => ({ kind: 'resize', width, height })
const W = (data: string): GoldenStep => ({ kind: 'write', data })

interface CaseSpec {
  readonly name: string
  readonly profile: string
  readonly oracle: ConformanceOracle
  readonly ops: readonly GoldenStep[]
  /** Required when oracle is conservative-only without an expected grid. */
  readonly expectUnsupported?: number
  /** conservative-only only: store a local-VT expected grid (human-reviewed). */
  readonly withLocalExpectedGrid?: boolean
  readonly note: string
}

const P_NARROW = 'unicode-ambiguous-narrow'
const P_WIDE = 'unicode-ambiguous-wide'
const P_KITTY = 'kitty-sync'
const P_VSCODE = 'vscode-terminal'
const P_WTPS = 'windows-terminal-powershell'

// ---------------------------------------------------------------------------
// Conformance cases
// ---------------------------------------------------------------------------

const CASES: readonly CaseSpec[] = [
  {
    name: 'sgr-attributes',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(24, 4),
      W('\x1b[1mB1\x1b[22m \x1b[2mD2\x1b[22m \x1b[3mI3\x1b[23m \x1b[4mU4\x1b[24m \x1b[7mR5\x1b[27m \x1b[9mS6\x1b[29m\r\n'),
      W('\x1b[1;3;4mcombo\x1b[0m plain \x1b[7minv\x1b[0m\r\n'),
      W('end'),
    ],
    expectUnsupported: 0,
    note: 'SGR flags individually, combined, reset, per-flag reset (22/23/24/27/29)',
  },
  {
    name: 'sgr-colors',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(24, 4),
      W('\x1b[31mR\x1b[32mG\x1b[94mB\x1b[0m \x1b[41mr\x1b[104mg\x1b[0m\r\n'),
      W('\x1b[38;5;200mp200\x1b[48;5;24m+bg\x1b[0m \x1b[38;2;16;32;255mtrue\x1b[39mX\x1b[0m\r\n'),
      W('\x1b[38;5;9mp9\x1b[0m'),
    ],
    expectUnsupported: 0,
    note: 'ansi16/bright/256-palette/truecolor fg+bg, 39/49 defaults, 38;5 with n<16',
  },
  {
    name: 'cursor-moves',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(16, 5),
      W('AB\x1b[2D CD\x1b[3C EF\r\n'),
      W('\x1b[4;1Hrow4\x1b[2Aup2\x1b[1B\x1b[5Gcha5\x1b[2dvpa2\r\n'),
      W('\x1b[1;1H\x1b[3C\x1b[2Bmid\x1b[99;99HZ'),
    ],
    expectUnsupported: 0,
    note: 'CUP/CUU/CUD/CUF/CUB/CHA/VPA/HVP + clamping beyond all edges',
  },
  {
    name: 'erase-display-line',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(16, 4),
      W('aaaa\r\nbbbb\r\ncccc\r\ndddd\x1b[2;3H\x1b[1J'),
      W('\x1b[4;2H\x1b[K\x1b[3;1H\x1b[2K\x1b[1;2H\x1b[1K'),
      W('\x1b[41m\x1b[3;5H\x1b[0J\x1b[0m\x1b[3J'),
    ],
    expectUnsupported: 0,
    note: 'ED 0/1, EL 0/1/2, BCE erase with bg color, ED 3 clears (empty) scrollback',
  },
  {
    name: 'insert-delete-chars',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(12, 3),
      W('abcdefgh\r\x1b[2@\x1b[3P\x1b[1X\r\n'),
      W('xy\x1b[1;10HZ\x1b[1D\x1b[P\r\nend'),
    ],
    expectUnsupported: 0,
    note: 'ICH/DCH/ECH mid-line with shift semantics',
  },
  {
    name: 'insert-delete-lines',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(12, 4),
      W('r0\r\nr1\r\nr2\r\nr3\x1b[H\x1b[L\x1b[3;1H\x1b[2M'),
    ],
    expectUnsupported: 0,
    note: 'IL inserts at cursor row (bottom line dropped), DL deletes 2',
  },
  {
    name: 'scroll-region',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(12, 5),
      W('s0\r\ns1\r\ns2\r\ns3\r\ns4\x1b[2;4r\x1b[4;1H\n\n'),
      W('\x1b[2;1H\x1b[S\x1b[2T\x1bM'),
      W('\x1b[r\x1b[5;1Hend'),
    ],
    expectUnsupported: 0,
    note: 'DECSTBM + LF/SU/SD/RI inside region; region reset before snapshot',
  },
  {
    name: 'scrollback-lines',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(12, 3),
      W('x1\r\nx2\r\nx3\r\nx4\r\nx5'),
    ],
    expectUnsupported: 0,
    note: 'full-region LF scroll pushes 3 lines into scrollback (main screen)',
  },
  {
    name: 'autowrap-edges',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(8, 5),
      W('abcdefgh'),
      W('i'),
      W('\x1b[3;1H\x1b[?7lmnopqrst'),
      W('UV字W'),
      W('\x1b[?7h\x1b[4;1Hab字字字'),
      W('字end'),
    ],
    expectUnsupported: 0,
    note: 'wrapPending wrap, DECAWM-off overwrite of last col, wide char dropped at last col (nowrap), wide char wrap',
  },
  {
    name: 'wide-cjk',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(12, 3),
      W('中文ab\r\n'),
      W('x中\x1b[2;2HZ\x1b[2;3HQ\r\n'),
      W('1234567890字\rY'),
    ],
    expectUnsupported: 0,
    note: 'CJK cells + continuation, overwrite head/continuation healing, wide char exactly filling a row',
  },
  {
    name: 'wide-cjk-width1',
    profile: P_NARROW,
    oracle: 'conservative-only',
    withLocalExpectedGrid: true,
    ops: [R(1, 2), W('字Z')],
    expectUnsupported: 0,
    note: 'single CJK grapheme on a 1-column grid: clipped to width 1 (§5.5 line ~700), no recursion/overflow, cursor preserved — xterm writes a dangling width-2 head instead, so this is VT-semantics only',
  },
  {
    name: 'wide-ambiguous-narrow',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [R(12, 2), W('·±→⛣X\r\nok')],
    expectUnsupported: 0,
    note: 'ambiguous-width chars measure 1 under ambiguousWidth:1',
  },
  {
    name: 'wide-ambiguous-wide',
    profile: P_WIDE,
    oracle: 'conservative-only',
    withLocalExpectedGrid: true,
    ops: [R(12, 2), W('·±→⛣X\r\nok')],
    expectUnsupported: 0,
    note: 'same bytes under ambiguousWidth:2 measure 2 (xterm has no ambiguous-wide mode → locally generated, reviewed)',
  },
  {
    name: 'wide-zwj-emoji',
    profile: P_NARROW,
    oracle: 'conservative-only',
    withLocalExpectedGrid: true,
    ops: [
      R(12, 3),
      W('A👨‍👩‍👧B🇩🇪C\r\n'),
      W('éX\r\n'),
      W('́Z ❤️!'),
    ],
    expectUnsupported: 0,
    note: 'ZWJ family / RI flag / combining marks / VS16 never split (§9.3); xterm 6.0 ships Unicode 6 without clustering → locally generated, reviewed',
  },
  {
    name: 'osc8-hyperlinks',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(20, 3),
      W('\x1b]8;;https://example.com\x07LINK\x1b]8;;\x07 plain\r\n'),
      W('\x1b]8;id=foo;https://x.test\x07with-id\x1b]8;;\x07\r\nend'),
    ],
    expectUnsupported: 0,
    note: 'OSC 8 open/close, id= params, no link leak after close (cells compared; links projected away — xterm cannot expose them)',
  },
  {
    name: 'osc-title',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [R(10, 2), W('\x1b]2;first\x07t\x1b]0;second\x07x')],
    expectUnsupported: 0,
    note: 'OSC 2 then OSC 0 both set the title mode',
  },
  {
    name: 'mouse-modes',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(10, 2),
      W('\x1b[?1000h\x1b[?1000l\x1b[?1002h\x1b[?1002l'),
      W('\x1b[?1003h\x1b[?1006h\x1b[?1015h'),
      W('\x1b[?1003l'),
      W('\x1b[?1015l\x1b[?1006l'),
    ],
    expectUnsupported: 0,
    note: 'tracking switches, 1003+1006 combo, encoding swap, partial reset (encoding residue), full cleanup → off; intermediate states are asserted in virtual-terminal unit tests',
  },
  {
    name: 'bracketed-paste',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [R(10, 2), W('\x1b[?2004hP\x1b[?2004l')],
    expectUnsupported: 0,
    note: 'DECSET/DECRST 2004',
  },
  {
    name: 'sync-output',
    profile: P_KITTY,
    oracle: 'xterm-cross-check',
    ops: [R(10, 2), W('\x1b[?2026hrender\x1b[?2026l')],
    expectUnsupported: 0,
    note: 'DECSET/DECRST 2026 on a sync-capable profile',
  },
  {
    name: 'alt-screen',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(10, 3),
      W('m1\r\nm2\r\nm3\r\nm4\r\n'),
      W('\x1b[?1049h\x1b[HALT1\r\nALT2'),
      W('\x1b[?1049lZ'),
      W('\x1b[?47h47\x1b[?47l'),
      W('\x1b[2;1Hend'),
    ],
    expectUnsupported: 0,
    note: '1049h/l save+restore main grid, scrollback and cursor; 47h enters a cleared alt grid',
  },
  {
    name: 'partial-writes',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(10, 2),
      W('\x1b[3'),
      W('1;4'),
      W('2mok\x1b'),
      W('[0m\r\n'),
      W('\x1b]2;ti'),
      W('tle\x07X'),
      W('e'),
      W('́'),
    ],
    expectUnsupported: 0,
    note: 'CSI split 3 ways, ESC split from its bracket, OSC split mid-payload, combining mark in a separate chunk',
  },
  {
    name: 'unknown-sequences',
    profile: P_NARROW,
    oracle: 'conservative-only',
    ops: [
      R(10, 2),
      W('\x1b[?1337h'),
      W('\x1b[999z'),
      W('\x1b]999;bogus\x07'),
      W('\x1b$X'),
    ],
    expectUnsupported: 4,
    note: 'unknown DECSET/CSI/OSC and a fictional ESC-intermediate sequence: counted, ignored, grid unpolluted',
  },
  {
    name: 'cleanup-restore',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(12, 3),
      W('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[2;3r\x1b[1;31mmessy'),
      W('\x1b[?1049l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[r\x1b[0m\x1b[H'),
      W('clean'),
    ],
    expectUnsupported: 0,
    note: '1049l+1003l+1006l+2004l+25h+region/SGR reset → every mode back to default (§5.5 cleanup rule)',
  },
  {
    name: 'kitty-keyboard',
    profile: P_KITTY,
    oracle: 'xterm-cross-check',
    ops: [R(10, 2), W('\x1b[>1u\x1b[=3;1uK\x1b[<u\x1b[?u')],
    expectUnsupported: 0,
    note: 'CSI >u push / =u set / <u pop / ?u query on a kitty-capable profile (mode projected away in cross-check)',
  },
  {
    name: 'osc133-shell',
    profile: P_VSCODE,
    oracle: 'xterm-cross-check',
    ops: [R(10, 2), W('\x1b]133;A\x07prompt \x1b]133;B\x07')],
    expectUnsupported: 0,
    note: 'OSC 133 shell-integration marks on an osc133-capable profile',
  },
  {
    name: 'progress-osc94',
    profile: P_WTPS,
    oracle: 'xterm-cross-check',
    ops: [R(10, 2), W('\x1b]9;4;1;50\x07working\x1b]9;4;3;0\x07\x1b]9;4;0\x07')],
    expectUnsupported: 0,
    note: 'OSC 9;4 normal → indeterminate → none on a progress-capable profile',
  },
  {
    name: 'image-kitty',
    profile: P_KITTY,
    oracle: 'xterm-cross-check',
    ops: [R(10, 3), W('a\x1b_Ga=T,f=24,i=7,c=2,r=1;QUJDRA==\x1b\\b')],
    expectUnsupported: 0,
    note: 'kitty APC graphics placement registered (images projected away); xterm tolerates and ignores the bytes',
  },
  {
    name: 'image-iterm2-unsupported',
    profile: P_NARROW,
    oracle: 'conservative-only',
    ops: [R(10, 2), W('\x1b]1337;File=inline=1;width=2:QUJD\x07')],
    expectUnsupported: 1,
    note: 'iTerm2 inline image on a null-imageProtocol profile: counted unsupported, grid unpolluted',
  },
  {
    name: 'modify-other-keys',
    profile: P_KITTY,
    oracle: 'xterm-cross-check',
    ops: [R(10, 2), W('\x1b[>4;2mK\x1b[>4;0m')],
    expectUnsupported: 0,
    note: 'CSI >4;2m / >4;0m on a modifyOtherKeys-capable profile',
  },
  {
    name: 'focus-reporting',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [R(10, 2), W('\x1b[?1004hF\x1b[?1004l')],
    expectUnsupported: 0,
    note: 'DECSET/DECRST 1004 (sendFocusMode is xterm-observable)',
  },
  {
    name: 'dec9001',
    profile: P_WTPS,
    oracle: 'xterm-cross-check',
    ops: [R(10, 2), W('\x1b[?9001hW\x1b[?9001l')],
    expectUnsupported: 0,
    note: 'win32 input mode on a DEC9001-capable profile (projected away in cross-check)',
  },
  {
    name: 'cursor-style-decscusr',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [R(10, 2), W('\x1b[5 qB\x1b[2 q')],
    expectUnsupported: 0,
    note: 'DECSCUSR bar → steady block (cursorStyle projected away; mapping asserted in unit tests)',
  },
  {
    name: 'osc52-clipboard',
    profile: P_VSCODE,
    oracle: 'xterm-cross-check',
    ops: [R(10, 2), W('\x1b]52;c;aGVsbG8=\x07x')],
    expectUnsupported: 0,
    note: 'OSC 52 registered as a diagnostic, never enters the grid',
  },
  {
    name: 'resize-replay',
    profile: P_NARROW,
    oracle: 'xterm-cross-check',
    ops: [
      R(16, 4),
      W('aa\r\nbb\r\ncc'),
      R(10, 3),
      W('Z'),
      R(20, 5),
      W('\x1b[4;1HQ'),
    ],
    expectUnsupported: 0,
    note: 'resize crop/pad without reflow; cursor stays inside bounds and scrollback stays empty (xterm diverges by design when shrinking would hide the cursor or growing would pull scrollback back — those paths are VT unit-tested, not cross-checked)',
  },
]

// ---------------------------------------------------------------------------
// Five golden grids (§9.2 second class): full canonical snapshots generated
// by the pinned xterm oracle, human-reviewed. Inputs stay on the mutually
// observable surface so the local VT must match them byte for byte.
// ---------------------------------------------------------------------------

interface GoldenSpec {
  readonly name: string
  readonly profile: string
  readonly ops: readonly GoldenStep[]
  readonly note: string
}

const GOLDENS: readonly GoldenSpec[] = [
  {
    name: 'first-frame',
    profile: P_NARROW,
    ops: [
      R(24, 6),
      W('\x1b[1mDeepSeek Harness TUI\x1b[0m\r\n'),
      W('\x1b[38;5;39mready for input\x1b[0m\r\n'),
      W('\x1b[2msession abc123\x1b[0m\r\n'),
      W('\x1b[7m status: idle \x1b[0m\r\n'),
      W('> '),
    ],
    note: 'styled first frame: bold, 256-color, dim, inverse; cursor at prompt',
  },
  {
    name: 'resize',
    profile: P_NARROW,
    ops: [
      R(20, 5),
      W('alpha\r\nbeta\r\ngamma'),
      R(12, 3),
      W('\rdelta'),
      R(24, 5),
      W('\x1b[4;1Hafter-resize'),
    ],
    note: 'shrink 20x5 → 12x3 → grow 24x5: conservative crop/pad, no reflow; cursor stays in bounds, scrollback empty so xterm agrees',
  },
  {
    name: 'scrollback',
    profile: P_NARROW,
    ops: [
      R(16, 4),
      W('line-01\r\nline-02\r\nline-03\r\nline-04\r\n'),
      W('line-05\r\nline-06\r\nline-07\r\nline-08\r\n'),
      W('prompt> '),
    ],
    note: '5 lines in scrollback, 3 content rows + live prompt row',
  },
  {
    name: 'overlay',
    profile: P_NARROW,
    ops: [
      R(20, 5),
      W('row0: base content\r\nrow1: base content\r\nrow2: base content\r\nrow3: base content\r\n'),
      W('\x1b[7m\x1b[2;5H+--------+\x1b[3;5H| MODAL  |\x1b[4;5H+--------+\x1b[0m'),
      W('\x1b[2;5H: base con\x1b[3;5H: base con\x1b[4;5H: base con'),
      W('\x1b[5;1Hdone'),
    ],
    note: 'inverse modal block covers rows 1-3 cols 4-13, then base is repainted: base cells fully restored, no style leak',
  },
  {
    name: 'cleanup',
    profile: P_KITTY,
    ops: [
      R(16, 4),
      W('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?2026h\x1b[?25l\x1b[2;3r\x1b[1;35mALT\x1b]2;dirty\x07'),
      W('\x1b[?1049l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?2026l\x1b[?25h\x1b[r\x1b[0m\x1b]2;\x07\x1b[H'),
      W('clean'),
    ],
    note: 'alt screen + mouse + paste + sync + hidden cursor + region + SGR + title all restored to defaults',
  },
]

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, filePath)
}

function renderGridText(grid: CanonicalGridV1): string {
  const out: string[] = []
  const text = (cells: readonly { grapheme: string; width: number; continuation: boolean }[]) =>
    cells.map((c) => (c.continuation ? '▸' : c.grapheme === '' ? '·' : c.grapheme)).join('')
  grid.scrollback.forEach((line, i) => out.push(`  sb[${i}] ${text(line)}`))
  for (let y = 0; y < grid.height; y++) {
    out.push(`  [${y}] ${text(grid.cells.slice(y * grid.width, (y + 1) * grid.width))}`)
  }
  const modes = grid.modes
  const nonDefault: string[] = []
  if (modes.alternateScreen) nonDefault.push('alternateScreen')
  if (modes.mouse !== 'off') nonDefault.push(`mouse=${modes.mouse}`)
  if (modes.bracketedPaste) nonDefault.push('bracketedPaste')
  if (modes.syncOutput) nonDefault.push('syncOutput')
  if (!modes.autowrap) nonDefault.push('autowrap=false')
  if (modes.wrapPending) nonDefault.push('wrapPending')
  if (modes.scrollRegion.top !== 0 || modes.scrollRegion.bottom !== grid.height - 1) {
    nonDefault.push(`scrollRegion=${modes.scrollRegion.top}..${modes.scrollRegion.bottom}`)
  }
  if (modes.cursorStyle !== 'block') nonDefault.push(`cursorStyle=${modes.cursorStyle}`)
  if (!modes.cursorVisible) nonDefault.push('cursorVisible=false')
  if (modes.kittyKeyboard) nonDefault.push('kittyKeyboard')
  if (modes.modifyOtherKeys) nonDefault.push('modifyOtherKeys')
  if (modes.focusReporting) nonDefault.push('focusReporting')
  if (modes.windowsDec9001) nonDefault.push('windowsDec9001')
  if (modes.osc133) nonDefault.push('osc133')
  if (modes.title !== null) nonDefault.push(`title=${JSON.stringify(modes.title)}`)
  if (modes.progress.state !== 'none') nonDefault.push(`progress=${modes.progress.state}`)
  out.push(`  cursor=${JSON.stringify(grid.cursor)} images=${grid.images.length} modes: ${nonDefault.join(' ') || '(defaults)'}`)
  // style summary: distinct non-default styles with example coordinates
  const seen = new Map<string, string>()
  grid.cells.forEach((cell, i) => {
    const s = cell.resolvedStyle
    if (s.foreground === null && s.background === null && !s.bold && !s.dim && !s.italic && !s.underline && !s.inverse && !s.strike) return
    const key = JSON.stringify(s)
    if (!seen.has(key)) seen.set(key, `x${i % grid.width}y${Math.floor(i / grid.width)}`)
  })
  for (const [style, at] of seen) out.push(`  style@${at}: ${style}`)
  const linked = grid.cells.filter((c) => c.hyperlink !== null)
  if (linked.length > 0) out.push(`  hyperlinks: ${linked.length} cell(s), first=${JSON.stringify(linked[0].hyperlink)}`)
  return out.join('\n')
}

async function main(): Promise<void> {
  let wrote = 0
  let failures = 0
  for (const [i, spec] of CASES.entries()) {
    const profile = getProfile(spec.profile)
    let expectedGrid: CanonicalGridV1 | undefined
    if (spec.oracle === 'xterm-cross-check') {
      const oracle = await replayXtermOracle(profile, spec.ops)
      expectedGrid = projectToXtermComparable(oracle.snapshot())
      oracle.dispose()
    } else if (spec.withLocalExpectedGrid === true) {
      expectedGrid = replayVirtualTerminal(profile, [...spec.ops]).snapshot()
    }
    const lines: ConformanceBodyLine[] = [...spec.ops]
    if (spec.expectUnsupported !== undefined) {
      lines.push({ kind: 'expectUnsupported', count: spec.expectUnsupported })
    }
    if (expectedGrid !== undefined) {
      lines.push({ kind: 'expectedGrid', value: { gridEncoding: 'readable', value: expectedGrid } })
    }
    const kase: ConformanceCase = {
      header: {
        kind: 'header',
        conformanceVersion: 1,
        name: spec.name,
        profile: spec.profile,
        oracle: spec.oracle,
        seed: 42 + i,
      },
      lines,
    }
    if (reviewMode) {
      console.log(`=== ${spec.name} [${spec.oracle}] profile=${spec.profile} seed=${42 + i}`)
      console.log(`    ${spec.note}`)
      if (expectedGrid) console.log(renderGridText(expectedGrid))
      continue
    }
    // Self-check at generation time: the VT must already agree with what we
    // are about to persist (live xterm cross-check for cross-check cases).
    const evaluation = await evaluateConformanceCase(kase)
    if (!evaluation.ok) {
      console.error(`SELF-CHECK FAILED ${spec.name}: ${evaluation.errors.join('; ')}`)
      failures += 1
      continue
    }
    await writeConformance(path.join(conformanceDir, `${spec.name}.jsonl`), kase)
    wrote += 1
  }

  for (const spec of GOLDENS) {
    const profile = getProfile(spec.profile)
    const oracle = await replayXtermOracle(profile, spec.ops)
    const expected = oracle.snapshot()
    oracle.dispose()
    const golden = {
      name: spec.name,
      profile: spec.profile,
      input: spec.ops,
      expected: { gridEncoding: 'readable', value: expected } as const,
    }
    if (reviewMode) {
      console.log(`=== golden:${spec.name} profile=${spec.profile}`)
      console.log(`    ${spec.note}`)
      console.log(renderGridText(expected))
      continue
    }
    const evaluation = evaluateGoldenFile(golden)
    if (!evaluation.ok) {
      console.error(`SELF-CHECK FAILED golden:${spec.name}: ${evaluation.errors.join('; ')}`)
      failures += 1
      continue
    }
    await writeJsonAtomic(path.join(goldensDir, `${spec.name}.json`), golden)
    wrote += 1
  }
  if (failures > 0) {
    console.error(`${failures} case(s) failed self-check; their files were NOT written`)
    process.exitCode = 1
    return
  }
  if (!reviewMode) console.log(`wrote ${wrote} files (${CASES.length} conformance + ${GOLDENS.length} goldens)`)
}

await main()
