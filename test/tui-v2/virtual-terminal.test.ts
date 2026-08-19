/**
 * tui-v2 WP-02 VirtualTerminal behavior tests — one case per behavior area
 * of the independent parser (plan §9.2/WP-02).
 *
 * Top-level test names contain "virtual terminal" so
 * `--test-name-pattern 'trace|virtual terminal|redaction'` selects this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { CanonicalGridV1 } from '../../src/tui-v2/testkit/canonical.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { measureGrapheme, VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js'

function vt(profileId = 'unicode-ambiguous-narrow', width = 10, height = 3): VirtualTerminal {
  return new VirtualTerminal({ ...getProfile(profileId), columns: width, rows: height })
}

function row(grid: CanonicalGridV1, y: number): string {
  return grid.cells
    .slice(y * grid.width, (y + 1) * grid.width)
    .map((c) => (c.continuation ? '→' : c.grapheme === '' ? '·' : c.grapheme))
    .join('')
}

function stylesAt(grid: CanonicalGridV1, y: number, xs: number[]) {
  return xs.map((x) => grid.cells[y * grid.width + x].resolvedStyle)
}

test('virtual terminal: SGR attributes, colors, reset', () => {
  const t = vt()
  t.write('\x1b[1;31mA\x1b[0m\x1b[4;38;5;200mB\x1b[0m\x1b[48;2;1;2;3mC\x1b[49mD')
  const grid = t.snapshot()
  assert.equal(row(grid, 0).slice(0, 4), 'ABCD')
  const [a, b, c, d] = stylesAt(grid, 0, [0, 1, 2, 3])
  assert.deepEqual([a.bold, a.foreground], [true, 'ansi16:1'])
  assert.deepEqual([b.underline, b.foreground], [true, 'ansi256:200'])
  assert.equal(c.background, 'rgb:010203')
  assert.deepEqual([d.background, d.foreground], [null, null])
})

test('virtual terminal: cursor movement family with clamping', () => {
  const t = vt()
  t.write('ab\x1b[1Dc\x1b[3C d\x1b[2;5He\x1b[1A\x1b[3Gf\x1b[3dg\x1b[99;99Hh')
  const grid = t.snapshot()
  assert.equal(row(grid, 0), 'acf·· d···')
  assert.equal(row(grid, 1), '····e·····')
  assert.equal(row(grid, 2), '···g·····h')
  assert.deepEqual(grid.cursor, { x: 9, y: 2, visible: true })
})

test('virtual terminal: 9.3 single CJK on a 1-column grid never recurses or overflows', () => {
  const t = vt('unicode-ambiguous-narrow', 1, 2)
  t.write('字Z')
  const grid = t.snapshot()
  // Clipped to a width-1 cell (§5.5), cursor intact, no dangling continuation.
  assert.equal(grid.cells[0].grapheme, '字')
  assert.equal(grid.cells[0].width, 1)
  assert.equal(grid.cells[1].grapheme, 'Z')
  assert.deepEqual(grid.cursor, { x: 0, y: 1, visible: true })
  assert.equal(grid.modes.wrapPending, true)
})

test('virtual terminal: 9.3 ZWJ and regional indicator clusters are never split', () => {
  const t = vt()
  // Split the cluster across three writes; hold-back must keep it whole.
  t.write('👨‍')
  t.write('👩‍')
  t.write('👧🇩')
  t.write('🇪!')
  const grid = t.snapshot()
  assert.equal(grid.cells[0].grapheme, '👨‍👩‍👧')
  assert.equal(grid.cells[0].width, 2)
  assert.equal(grid.cells[1].continuation, true)
  assert.equal(grid.cells[2].grapheme, '🇩🇪')
  assert.equal(grid.cells[3].grapheme, '!')
  assert.equal(grid.cursor.x, 4)
})

test('virtual terminal: combining marks attach; lone mark at col 0 gets a width-0 cell', () => {
  const t = vt()
  t.write('éX')
  let grid = t.snapshot()
  assert.equal(grid.cells[0].grapheme, 'é')
  assert.equal(grid.cells[0].width, 1)
  t.reset()
  t.write('́Z')
  grid = t.snapshot()
  assert.equal(grid.cells[0].grapheme, '́')
  assert.equal(grid.cells[0].width, 0)
  assert.equal(grid.cells[0].continuation, false)
  assert.equal(grid.cells[1].grapheme, 'Z')
})

test('virtual terminal: ambiguous width follows the profile (narrow vs wide)', () => {
  const narrow = vt('unicode-ambiguous-narrow', 10, 1)
  narrow.write('·→X')
  const narrowGrid = narrow.snapshot()
  assert.deepEqual(stylesAt(narrowGrid, 0, []).length, 0) // shape sanity
  assert.equal(narrowGrid.cells[0].width, 1)
  assert.equal(narrowGrid.cells[1].width, 1)
  assert.equal(narrowGrid.cursor.x, 3)

  const wide = vt('unicode-ambiguous-wide', 10, 1)
  wide.write('·→X')
  const wideGrid = wide.snapshot()
  assert.equal(wideGrid.cells[0].width, 2)
  assert.equal(wideGrid.cells[2].width, 2)
  assert.equal(wideGrid.cursor.x, 5)

  assert.equal(measureGrapheme('·', false), 1)
  assert.equal(measureGrapheme('·', true), 2)
  assert.equal(measureGrapheme('字', false), 2)
})

test('virtual terminal: wide char at last column wraps with DECAWM, dropped without', () => {
  const t = vt('unicode-ambiguous-narrow', 4, 3)
  t.write('ab字字') // second 字 wraps to row 1
  let grid = t.snapshot()
  assert.equal(row(grid, 0), 'ab字→')
  assert.equal(row(grid, 1), '字→··')
  t.reset()
  t.write('\x1b[?7l' + 'ab字') // 字 ends at last col
  t.write('字') // dropped: no room, no autowrap
  t.write('X') // overwrites the continuation at col 3: the head at col 2 heals to a blank
  grid = t.snapshot()
  assert.equal(grid.cells[2].grapheme, '')
  assert.equal(grid.cells[2].width, 1)
  assert.equal(grid.cells[3].grapheme, 'X')
  assert.equal(grid.modes.autowrap, false)
  assert.deepEqual(grid.cursor, { x: 3, y: 0, visible: true })
})

test('virtual terminal: overwriting half of a wide char heals the other half', () => {
  const t = vt()
  t.write('a中b')
  // overwrite the continuation cell (col 2): head at col 1 must blank out
  t.write('\x1b[1;3HX')
  let grid = t.snapshot()
  assert.equal(row(grid, 0), 'a·Xb······')
  // overwrite the head (col 1): continuation at col 2 must blank out
  t.reset()
  t.write('a中b')
  t.write('\x1b[1;2HY')
  grid = t.snapshot()
  assert.equal(row(grid, 0), 'aY·b······')
})

test('virtual terminal: scrollback grows on full-region LF scroll, bounded and cleared by ED 3', () => {
  const t = vt('unicode-ambiguous-narrow', 6, 2)
  t.write('l1\r\nl2\r\nl3\r\nl4')
  let grid = t.snapshot()
  assert.equal(grid.scrollback.length, 2)
  assert.equal(grid.scrollback[0][0].grapheme, 'l')
  assert.equal(row(grid, 0), 'l3····')
  t.write('\x1b[3J')
  grid = t.snapshot()
  assert.equal(grid.scrollback.length, 0)
})

test('virtual terminal: scrollback never grows from SU/SD or alt-screen scroll', () => {
  const t = vt('unicode-ambiguous-narrow', 6, 2)
  t.write('a\r\nb\x1b[10S\x1b[10T')
  assert.equal(t.snapshot().scrollback.length, 0)
  t.reset()
  t.write('x\r\ny\x1b[?1049hc\r\nd\r\ne\r\nf')
  const grid = t.snapshot()
  assert.equal(grid.modes.alternateScreen, true)
  assert.equal(grid.scrollback.length, 0) // alt-screen scroll must not touch scrollback
})

test('virtual terminal: alt screen enter/exit restores main grid and cursor (1049)', () => {
  const t = vt()
  t.write('main')
  t.write('\x1b[?1049h')
  let grid = t.snapshot()
  assert.equal(grid.modes.alternateScreen, true)
  assert.equal(row(grid, 0), '··········')
  assert.deepEqual(grid.cursor, { x: 4, y: 0, visible: true }) // preserved on entry
  t.write('\x1b[HALT')
  t.write('\x1b[?1049l')
  grid = t.snapshot()
  assert.equal(grid.modes.alternateScreen, false)
  assert.equal(row(grid, 0), 'main······')
  assert.deepEqual(grid.cursor, { x: 4, y: 0, visible: true }) // restored on exit
})

test('virtual terminal: mouse DECSET/encoding normalization (§5.5)', () => {
  const t = vt()
  const mouse = (s: string) => {
    t.write(s)
    return t.snapshot().modes.mouse
  }
  assert.equal(mouse('\x1b[?1000h'), 'x10-1000')
  assert.equal(mouse('\x1b[?1002h'), 'button-1002')
  assert.equal(mouse('\x1b[?1003h'), 'any-1003')
  assert.equal(mouse('\x1b[?1006h'), 'sgr-1006') // tracking+encoding combo → nearest enum
  assert.deepEqual(t.diagnostics().mouseCombinations, ['any-1003+sgr-1006'])
  assert.equal(mouse('\x1b[?1003l'), 'sgr-1006') // encoding residue: cleanup NOT restored
  assert.ok(t.diagnostics().mouseCombinations.includes('none+sgr-1006'))
  assert.equal(mouse('\x1b[?1006l'), 'off') // only now cleanup counts as restored
  // urxvt encoding
  assert.equal(mouse('\x1b[?1015h\x1b[?1002h'), 'urxvt-1015')
  assert.equal(mouse('\x1b[?1002l\x1b[?1015l'), 'off')
})

test('virtual terminal: OSC 8 open/close with params; no underline leak after close', () => {
  const t = vt()
  t.write('\x1b]8;id=a;https://x.test\x07L\x1b]8;;\x07N')
  const grid = t.snapshot()
  assert.deepEqual(grid.cells[0].hyperlink, { uri: 'https://x.test', params: 'id=a' })
  assert.equal(grid.cells[0].resolvedStyle.underline, true) // xterm buffer semantics
  assert.equal(grid.cells[1].hyperlink, null)
  assert.equal(grid.cells[1].resolvedStyle.underline, false)
})

test('virtual terminal: OSC 0/2 set title mode', () => {
  const t = vt()
  t.write('\x1b]2;first\x07\x1b]0;second\x1b\\')
  assert.equal(t.snapshot().modes.title, 'second')
})

test('virtual terminal: ED 0/1/2 and EL 0/1/2', () => {
  const t = vt()
  t.write('aaaa\r\nbbbb\r\ncccc')
  t.write('\x1b[2;2H\x1b[1K') // EL1: row1 cols 0..1 erased
  let grid = t.snapshot()
  assert.equal(row(grid, 1), '··bb······')
  t.write('\x1b[2K') // EL2: whole row
  grid = t.snapshot()
  assert.equal(row(grid, 1), '··········')
  t.write('\x1b[1;1H\x1b[J') // ED0 from (0,0)
  grid = t.snapshot()
  assert.equal(row(grid, 0), '··········')
  assert.equal(row(grid, 2), '··········')
  t.reset()
  t.write('aaaa\r\nbbbb\x1b[H\x1b[1J') // ED1 up to home: only row0 col0
  grid = t.snapshot()
  assert.equal(row(grid, 0), '·aaa······')
  assert.equal(row(grid, 1), 'bbbb······')
  t.write('\x1b[2J')
  assert.equal(row(t.snapshot(), 1), '··········')
})

test('virtual terminal: BCE erase uses the current background style', () => {
  const t = vt()
  t.write('\x1b[41m\x1b[2K')
  const grid = t.snapshot()
  assert.equal(grid.cells[0].resolvedStyle.background, 'ansi16:1')
  assert.equal(grid.cells[0].grapheme, '')
})

test('virtual terminal: IL/DL inside the scroll region', () => {
  const t = vt()
  t.write('r0\r\nr1\r\nr2\x1b[H\x1b[L') // insert at top; r2 drops off the bottom
  let grid = t.snapshot()
  assert.deepEqual([row(grid, 0), row(grid, 1), row(grid, 2)], ['··········', 'r0········', 'r1········'])
  t.write('\x1b[2;1H\x1b[M') // delete row 1 → r0 gone, blank inserted at bottom
  grid = t.snapshot()
  assert.deepEqual([row(grid, 0), row(grid, 1), row(grid, 2)], ['··········', 'r1········', '··········'])
})

test('virtual terminal: DECSTBM region scroll and reset', () => {
  const t = vt('unicode-ambiguous-narrow', 6, 4)
  t.write('0\r\n1\r\n2\r\n3')
  t.write('\x1b[2;3r')
  let grid = t.snapshot()
  assert.deepEqual(grid.modes.scrollRegion, { top: 1, bottom: 2 })
  t.write('\x1b[3;1H\n') // LF at region bottom scrolls only the region
  grid = t.snapshot()
  assert.deepEqual([row(grid, 0), row(grid, 1), row(grid, 2), row(grid, 3)], ['0·····', '2·····', '······', '3·····'])
  assert.equal(grid.scrollback.length, 0) // region scroll must not touch scrollback
  t.write('\x1b[r')
  grid = t.snapshot()
  assert.deepEqual(grid.modes.scrollRegion, { top: 0, bottom: 3 })
})

test('virtual terminal: resize crops/pads without reflow and heals split wide chars', () => {
  const t = vt('unicode-ambiguous-narrow', 8, 3)
  t.write('abcdefgh\r\nxy字z')
  t.resize(4, 2)
  let grid = t.snapshot()
  assert.equal(grid.width, 4)
  assert.equal(grid.height, 2)
  assert.equal(row(grid, 0), 'abcd')
  // 'xy字z' cropped to 4 cols; no split since 字 ends exactly at col 3
  assert.equal(row(grid, 1), 'xy字→')
  t.resize(3, 2) // now crop splits 字: head at last col is blanked
  grid = t.snapshot()
  assert.equal(row(grid, 1), 'xy·')
  t.resize(10, 4) // grow pads default blanks
  grid = t.snapshot()
  assert.equal(row(grid, 3), '··········')
  assert.deepEqual(grid.cursor, { x: 2, y: 1, visible: true })
})

test('virtual terminal: partial writes — CSI split 3 ways, OSC split mid-payload', () => {
  const t = vt()
  t.write('\x1b[3')
  t.write('1;4')
  t.write('2mA\x1b')
  t.write('[0m\x1b]2;ti')
  t.write('tle\x07B')
  const grid = t.snapshot()
  assert.equal(row(grid, 0), 'AB········')
  assert.equal(grid.cells[0].resolvedStyle.foreground, 'ansi16:1')
  assert.equal(grid.cells[0].resolvedStyle.background, 'ansi16:2')
  assert.equal(grid.cells[1].resolvedStyle.foreground, null)
  assert.equal(grid.modes.title, 'title')
  assert.equal(t.diagnostics().incompleteSequences, 0)
})

test('virtual terminal: unknown sequences never throw, never echo, are counted', () => {
  const t = vt()
  t.write('\x1b[?1337h\x1b[999z\x1b]999;bogus\x07\x1b$X\x1bPq\x1b\\ok')
  const grid = t.snapshot()
  const diagnostics = t.diagnostics()
  assert.equal(diagnostics.unsupportedCount, 5)
  assert.deepEqual(diagnostics.unsupportedByType, {
    'csi:z': 1,
    'decset:1337': 1,
    'esc:$X': 1,
    dcs: 1,
    'osc:999': 1,
  })
  assert.equal(row(grid, 0), 'ok········')
})

test('virtual terminal: reset() restores the initial clean state', () => {
  const t = vt()
  t.write('\x1b[?1049h\x1b[?1003h\x1b[?2004h\x1b[31mxx\x1b]2;t\x07\r\nyy')
  t.snapshot()
  t.reset()
  const grid = t.snapshot()
  assert.equal(row(grid, 0), '··········')
  assert.deepEqual(grid.cursor, { x: 0, y: 0, visible: true })
  assert.equal(grid.modes.alternateScreen, false)
  assert.equal(grid.modes.mouse, 'off')
  assert.equal(grid.modes.bracketedPaste, false)
  assert.equal(grid.modes.title, null)
  assert.equal(grid.scrollback.length, 0)
  assert.equal(t.diagnostics().unsupportedCount, 0)
})

test('virtual terminal: profile gating — kitty/sync/dec9001/osc8/osc52/progress/osc133', () => {
  // kitty-sync supports kitty keyboard + sync + osc133 (not progress).
  const kitty = vt('kitty-sync')
  kitty.write('\x1b[>1u\x1b[?2026h\x1b]133;A\x07\x1b]9;4;1;50\x07')
  let modes = kitty.snapshot().modes
  assert.equal(modes.kittyKeyboard, true)
  assert.equal(modes.syncOutput, true)
  assert.equal(modes.osc133, true)
  assert.deepEqual(modes.progress, { state: 'none' })
  assert.equal(kitty.diagnostics().unsupportedByType['osc:9;4'], 1)
  kitty.write('\x1b[?u')
  assert.equal(kitty.diagnostics().kittyKeyboardQueries, 1)
  kitty.write('\x1b[<u')
  assert.equal(kitty.snapshot().modes.kittyKeyboard, false)

  // unicode-ambiguous-narrow: no kitty, no sync, no osc133 — counted, ignored.
  const plain = vt('unicode-ambiguous-narrow')
  plain.write('\x1b[>1u\x1b[?2026h\x1b]133;A\x07\x1b[>4;2m')
  modes = plain.snapshot().modes
  assert.equal(modes.kittyKeyboard, false)
  assert.equal(modes.syncOutput, false)
  assert.equal(modes.osc133, false)
  assert.equal(modes.modifyOtherKeys, false)
  assert.equal(plain.diagnostics().unsupportedCount, 4)

  // vscode-terminal: osc52 registered as diagnostic, never enters the grid.
  const code = vt('vscode-terminal')
  code.write('\x1b]52;c;aGVsbG8=\x07x')
  assert.equal(code.diagnostics().osc52Sequences, 1)
  assert.equal(code.diagnostics().unsupportedCount, 0)
  assert.equal(row(code.snapshot(), 0), 'x·········')

  // windows-terminal-powershell: dec9001 + progress.
  const wt = vt('windows-terminal-powershell')
  wt.write('\x1b[?9001h\x1b]9;4;2;75\x07')
  modes = wt.snapshot().modes
  assert.equal(modes.windowsDec9001, true)
  assert.deepEqual(modes.progress, { state: 'error', value: 75 })
})

test('virtual terminal: DECSCUSR cursor style and focus reporting', () => {
  const t = vt()
  t.write('\x1b[5 q')
  assert.equal(t.snapshot().modes.cursorStyle, 'bar')
  t.write('\x1b[3 q')
  assert.equal(t.snapshot().modes.cursorStyle, 'underline')
  t.write('\x1b[2 q')
  assert.equal(t.snapshot().modes.cursorStyle, 'block')
  t.write('\x1b[?1004h')
  assert.equal(t.snapshot().modes.focusReporting, true)
  t.write('\x1b[?1004l')
  assert.equal(t.snapshot().modes.focusReporting, false)
})

test('virtual terminal: unsupported profiles count instead of applying (ascii-narrow)', () => {
  const t = vt('ascii-narrow')
  t.write('\x1b]8;;https://x.test\x07L\x1b]8;;\x07\x1b[?2004h\x1b[?1003h\x1b]2;t\x07')
  const grid = t.snapshot()
  assert.equal(grid.cells[0].hyperlink, null)
  assert.equal(grid.modes.bracketedPaste, false)
  assert.equal(grid.modes.mouse, 'off')
  assert.equal(grid.modes.title, null)
  const byType = t.diagnostics().unsupportedByType
  assert.equal(byType['osc:8'], 2)
  assert.equal(byType['decset:2004'], 1)
  assert.equal(byType['decset:1003'], 1)
  assert.equal(byType['osc:2'], 1)
})

test('virtual terminal: image placements recorded with hashes, gated by profile', () => {
  const kitty = vt('kitty-sync')
  kitty.write('\x1b_Ga=T,f=24,i=7,c=2,r=1;QUJDRA==\x1b\\')
  let images = kitty.snapshot().images
  assert.equal(images.length, 1)
  assert.deepEqual(images[0], {
    imageId: 'kitty-i7',
    protocol: 'kitty',
    x: 0,
    y: 0,
    width: 2,
    height: 1,
    payloadHash: images[0].payloadHash,
  })
  assert.match(images[0].payloadHash, /^[0-9a-f]{64}$/)

  const plain = vt('unicode-ambiguous-narrow')
  plain.write('\x1b_Ga=T;AAAA\x1b\\\x1b]1337;File=inline=1:AAAA\x07')
  assert.equal(plain.snapshot().images.length, 0)
  assert.equal(plain.diagnostics().unsupportedCount, 2)
})

test('virtual terminal: scrollback is bounded', () => {
  const t = new VirtualTerminal(
    { ...getProfile('unicode-ambiguous-narrow'), columns: 5, rows: 2 },
    { scrollbackLimit: 3 },
  )
  t.write('1\r\n2\r\n3\r\n4\r\n5\r\n6')
  const grid = t.snapshot()
  assert.equal(grid.scrollback.length, 3)
  assert.equal(grid.scrollback[0][0].grapheme, '2') // oldest lines evicted
})

test('virtual terminal: RIS performs a full reset, DECSC/DECRC round-trip the cursor', () => {
  const t = vt()
  t.write('ab\x1b7cd\x1b8e') // save at (2,0), write cd, restore, e overwrites
  assert.equal(row(t.snapshot(), 0), 'abed······')
  t.write('\x1b[?1003h\x1b[31m\x1bc')
  const grid = t.snapshot()
  assert.equal(grid.modes.mouse, 'off')
  assert.equal(grid.cells[0].resolvedStyle.foreground, null)
})
