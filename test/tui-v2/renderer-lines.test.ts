/**
 * tui-v2 WP-04b renderer-lines tests: the §6.1 unified width pipeline.
 *
 * Coverage matrix (plan §6.1 "必须覆盖" list) -> tests below:
 *   ASCII / CJK / 全角标点 / ambiguous width (both profiles) / 组合字符 /
 *   ZWJ emoji / regional indicator / variation selector / 控制符 /
 *   ANSI style / OSC 8 hyperlink / tab / RTL (logical order) / 超宽单 grapheme
 * plus the §6.1 prohibitions (width<=0 never repeats/recurses) and the I-06
 * hard guard (`assertLineWidth` clips, never throws).
 *
 * Width expectations are cross-checked against the WP-02 oracle
 * (`measureGrapheme` in testkit/virtual-terminal.ts): the pipeline and the
 * emulator MUST agree byte-for-byte or differential frame tests are noise.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OVERWIDE_SUBSTITUTE,
  TABSTOP,
  assertLineWidth,
  cellsToString,
  cellsWidth,
  createGraphemeWidthCache,
  graphemeWidth,
  lineStyle,
  lineToCells,
  measureLineWidth,
  padCells,
  sanitizeText,
  segmentGraphemes,
  styledCells,
  styleText,
  tokenizeAnsi,
  truncateCells,
  wrapCells,
  DEFAULT_LINE_STYLE,
  type LineCell,
} from '../../src/tui-v2/renderer/lines.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { measureGrapheme } from '../../src/tui-v2/testkit/virtual-terminal.js'

const NARROW = getProfile('unicode-ambiguous-narrow')
const WIDE = getProfile('unicode-ambiguous-wide')
const KITTY = getProfile('kitty-sync')

// ---------------------------------------------------------------------------
// measurement: ASCII / CJK / fullwidth punctuation / ambiguous / combining
// ---------------------------------------------------------------------------

test('lines: ASCII measures one column per char', () => {
  assert.equal(measureLineWidth('hello world', NARROW), 11)
  const cells = lineToCells('abc', NARROW)
  assert.equal(cells.length, 3)
  assert.equal(cellsWidth(cells), 3)
})

test('lines: CJK ideographs measure 2 columns with continuation cells', () => {
  const cells = lineToCells('你好', NARROW)
  assert.equal(cellsWidth(cells), 4)
  // wide grapheme + width-0 continuation, TerminalCell semantics
  assert.deepEqual(
    cells.map((c) => [c.grapheme, c.width]),
    [
      ['你', 2],
      ['', 0],
      ['好', 2],
      ['', 0],
    ],
  )
})

test('lines: fullwidth punctuation measures 2 columns', () => {
  assert.equal(measureLineWidth('，。！', NARROW), 6)
})

test('lines: ambiguous width is TerminalProfile-driven', () => {
  // '·' (U+00B7), '—' (U+2014), 'α' (U+03B1) are East-Asian ambiguous.
  assert.equal(graphemeWidth('·', NARROW), 1)
  assert.equal(graphemeWidth('·', WIDE), 2)
  assert.equal(graphemeWidth('—', NARROW), 1)
  assert.equal(graphemeWidth('—', WIDE), 2)
  assert.equal(measureLineWidth('α·—', NARROW), 3)
  assert.equal(measureLineWidth('α·—', WIDE), 6)
})

test('lines: combining marks ride their base grapheme (width 1)', () => {
  const cells = lineToCells('éx', NARROW)
  assert.equal(cellsWidth(cells), 2)
  assert.equal(cells[0]?.grapheme, 'é')
})

test('lines: ZWJ emoji measured as one whole grapheme', () => {
  const family = '👨‍👩‍👧'
  assert.deepEqual(segmentGraphemes(family), [family])
  assert.equal(graphemeWidth(family, NARROW), measureGrapheme(family, false))
  assert.equal(graphemeWidth(family, NARROW), 2)
})

test('lines: regional-indicator pair measured whole (oracle-agreed)', () => {
  const flag = '🇨🇳'
  assert.deepEqual(segmentGraphemes(flag), [flag])
  // The v2 contract is oracle agreement (§6.1: RI pairs are measured as one
  // grapheme, max-rule); real-terminal flag width is a known simplification.
  assert.equal(graphemeWidth(flag, NARROW), measureGrapheme(flag, false))
})

test('lines: variation-selector grapheme measured whole', () => {
  const heart = '❤️' // ❤ + VS16
  assert.deepEqual(segmentGraphemes(heart), [heart])
  assert.equal(graphemeWidth(heart, NARROW), measureGrapheme(heart, false))
})

test('lines: width oracle cross-check over the §6.1 corpus', () => {
  const corpus = [
    'a', 'Z', '0', ' ', '你', '好', '世', '界', '，', '。', '！', '·', '—', '–', 'α', 'β',
    'é', '👨‍👩‍👧', '👍', '🇨🇳', '🇺🇸', '❤️', '✳', '✻', '❯', '●', '✗', '⎿', 'א', 'ב',
    'אב', '🙂', '\t',
  ]
  for (const g of corpus) {
    for (const wide of [false, true]) {
      assert.equal(
        graphemeWidth(g, wide ? WIDE : NARROW),
        measureGrapheme(g, wide),
        `width mismatch for ${JSON.stringify(g)} ambiguousAsWide=${wide}`,
      )
    }
  }
})

// ---------------------------------------------------------------------------
// controls / tab / RTL
// ---------------------------------------------------------------------------

test('lines: control chars are width 0 and stripped from output', () => {
  const cells = lineToCells('ab\x7f', NARROW)
  assert.deepEqual(cells.map((c) => c.grapheme), ['a', 'b'])
  assert.equal(cellsWidth(cells), 2)
})

test('lines: tab expands to tabstop 3 against the current column', () => {
  // 'a' at col 0-1, tab -> next multiple of 3 (2 spaces), 'b' at col 3.
  const cells = lineToCells('a\tb', NARROW)
  assert.deepEqual(cells.map((c) => c.grapheme), ['a', ' ', ' ', 'b'])
  assert.equal(cellsWidth(cells), 4)
  // Column 3 already: exactly TABSTOP spaces.
  const cells2 = lineToCells('abc\t!', NARROW)
  assert.equal(cells2.filter((c) => c.grapheme === ' ').length, TABSTOP)
})

test('lines: RTL text keeps logical order, width only (no bidi shaping)', () => {
  const cells = lineToCells('אבג', NARROW)
  assert.deepEqual(cells.map((c) => c.grapheme), ['א', 'ב', 'ג'])
  assert.equal(cellsWidth(cells), 3)
})

// ---------------------------------------------------------------------------
// ANSI style / OSC 8
// ---------------------------------------------------------------------------

test('lines: SGR styles apply and reset', () => {
  const cells = lineToCells('\x1b[31mred\x1b[0m plain', NARROW)
  const red = cells.slice(0, 3)
  const plainCells = cells.slice(3)
  assert.ok(red.every((c) => c.style.foreground === 'red'))
  assert.ok(plainCells.every((c) => c.style.foreground === null))
})

test('lines: compound SGR splits attributes (bold + 256-color)', () => {
  const cells = lineToCells('\x1b[1;38;5;209mx', NARROW)
  assert.equal(cells[0]?.style.bold, true)
  assert.equal(cells[0]?.style.foreground, 'ansi256:209')
})

test('lines: unknown CSI is consumed, never leaked as text', () => {
  // ESC[2K (erase line) must not surface 'K' or '[2' as printable cells.
  const cells = lineToCells('a\x1b[2Kb', NARROW)
  assert.deepEqual(cells.map((c) => c.grapheme), ['a', 'b'])
})

test('lines: OSC 8 hyperlinks open and close without leaking', () => {
  const cells = lineToCells('\x1b]8;;https://example.com\x07link\x1b]8;;\x07!', NARROW)
  assert.deepEqual(
    cells.map((c) => [c.grapheme, c.hyperlink]),
    [
      ['l', 'https://example.com'],
      ['i', 'https://example.com'],
      ['n', 'https://example.com'],
      ['k', 'https://example.com'],
      ['!', null],
    ],
  )
})

test('lines: replay closes style and hyperlink at line end (no leak)', () => {
  const cells = lineToCells('\x1b[31m\x1b]8;;https://x\x07ab', NARROW)
  const out = cellsToString(cells)
  assert.ok(out.includes('\x1b]8;;\x07'), 'hyperlink closed')
  assert.ok(out.endsWith('\x1b[0m'), 'style reset at end')
  // Round-trip: replay parses back to identical cell shape.
  const reparsed = lineToCells(out, NARROW)
  assert.deepEqual(
    reparsed.map((c) => [c.grapheme, c.style.foreground, c.hyperlink]),
    cells.map((c) => [c.grapheme, c.style.foreground, c.hyperlink]),
  )
})

// ---------------------------------------------------------------------------
// wrap / truncate / pad
// ---------------------------------------------------------------------------

test('lines: wrap is word-aware and never splits a wide grapheme', () => {
  const cells = lineToCells('aa bb cc', NARROW)
  const wrapped = wrapCells(cells, 5)
  assert.deepEqual(wrapped.map((line) => cellsToString(line)), ['aa bb', 'cc'])
  // CJK at an odd boundary: '你' (2 cols) cannot straddle.
  const cjk = wrapCells(lineToCells('ab你', NARROW), 3)
  assert.deepEqual(cjk.map((line) => cellsWidth(line)), [2, 2])
  assert.equal(cellsToString(cjk[1] as LineCell[]), '你')
})

test('lines: style continues across wrapped lines (per-cell styles)', () => {
  const styled = styledCells('one two three', lineStyle({ foreground: 'red' }), NARROW)
  const wrapped = wrapCells(styled, 5)
  assert.ok(wrapped.length > 1)
  for (const line of wrapped) assert.ok(line.every((c) => c.style.foreground === 'red'))
  // Replay of a continuation line opens with SGR and closes at end.
  const replay = cellsToString(wrapped[1] as LineCell[])
  assert.ok(replay.startsWith('\x1b[0;31m'))
  assert.ok(replay.endsWith('\x1b[0m'))
})

test('lines: hyperlink continues across wrapped lines and closes per line', () => {
  const cells = lineToCells('\x1b]8;;https://x\x07aaaa bbbb cccc\x1b]8;;\x07', NARROW)
  const wrapped = wrapCells(cells, 6)
  assert.ok(wrapped.length > 1)
  for (const line of wrapped) {
    const replay = cellsToString(line)
    const opens = replay.split('\x1b]8;;https://x\x07').length - 1
    const closes = replay.split('\x1b]8;;\x07').length - 1
    assert.ok(opens > 0 && closes >= opens, `link reopened and closed per line: ${JSON.stringify(replay)}`)
  }
})

test('lines: truncate clips to columns, wide grapheme never straddles', () => {
  const cells = lineToCells('ab你好', NARROW)
  const clipped = truncateCells(cells, 3)
  assert.equal(cellsWidth(clipped), 2) // 'ab'; '你' (2 cols) does not fit in 1
  assert.equal(cellsToString(clipped), 'ab')
})

test('lines: over-wide single grapheme on a width-1 viewport is substituted', () => {
  const clipped = truncateCells(lineToCells('你好', NARROW), 1)
  assert.deepEqual(clipped.map((c) => [c.grapheme, c.width]), [[OVERWIDE_SUBSTITUTE, 1]])
})

test('lines: padCells right-pads to the exact width', () => {
  const padded = padCells(lineToCells('ab', NARROW), 5)
  assert.equal(cellsWidth(padded), 5)
  assert.equal(cellsToString(padded), 'ab   ')
})

// ---------------------------------------------------------------------------
// §6.1 prohibitions: width<=0 never repeats/recurses
// ---------------------------------------------------------------------------

test('lines: width<=0 inputs return empty/clipped results without throwing', () => {
  const cells = lineToCells('hello 你好', NARROW)
  assert.deepEqual(wrapCells(cells, 0), [[]])
  assert.deepEqual(wrapCells(cells, -3), [[]])
  assert.deepEqual(truncateCells(cells, 0), [])
  assert.deepEqual(padCells(cells, 0), cells)
  assert.equal(assertLineWidth('hello', NARROW, 0), '')
  assert.equal(assertLineWidth('hello', NARROW, -1), '')
})

// ---------------------------------------------------------------------------
// sanitizeText (untrusted input boundary)
// ---------------------------------------------------------------------------

test('lines: sanitizeText strips CSI/OSC/DEC/APC/C0, keeps text and \\n\\t', () => {
  const hostile =
    'ok\x1b[2K\x1b[1;31m\x1b]52;c;Zm9v\x07\x1b]8;;https://evil\x07\x1b(0\x1b_pi:c\x07x\ny\tz'
  assert.equal(sanitizeText(hostile), 'okx\ny\tz')
})

test('lines: unterminated sequences are consumed to end of string', () => {
  assert.equal(sanitizeText('abc\x1b[31'), 'abc')
  assert.equal(sanitizeText('abc\x1b]8;;https://x'), 'abc')
})

// ---------------------------------------------------------------------------
// assertLineWidth hard guard (§3.3 I-06 / §6.1)
// ---------------------------------------------------------------------------

test('lines: assertLineWidth clips over-wide lines and never throws', () => {
  assert.equal(assertLineWidth('hello', NARROW, 10), 'hello')
  assert.equal(assertLineWidth('hello', NARROW, 3), 'hel')
  assert.equal(assertLineWidth('你好世界', NARROW, 5), '你好') // 4 cols; next wide char clipped
  const styled = assertLineWidth('\x1b[31mabcdef\x1b[0m', NARROW, 4)
  assert.equal(measureLineWidth(styled, NARROW), 4)
})

test('lines: styleText wraps with reset-first SGR and closes', () => {
  assert.equal(styleText('x', lineStyle({ bold: true, foreground: 'red' })), '\x1b[0;1;31mx\x1b[0m')
  assert.equal(styleText('x', DEFAULT_LINE_STYLE), 'x')
})

test('lines: tokenizeAnsi classifies SGR/OSC8/tab/control/text', () => {
  const kinds = tokenizeAnsi('a\x1b[31m\x1b]8;;u\x07\t\x01b').map((t) => t.kind)
  assert.deepEqual(kinds, ['text', 'sgr', 'osc8', 'tab', 'control', 'text'])
})

test('lines: grapheme width cache is bounded and profile-safe', () => {
  const cache = createGraphemeWidthCache()
  assert.equal(graphemeWidth('·', NARROW, cache), 1)
  assert.equal(graphemeWidth('·', WIDE, cache), 2) // ambiguous flag is part of the key
  const stats = cache.stats()
  assert.equal(stats.misses, 2)
  assert.equal(graphemeWidth('·', NARROW, cache), 1)
  assert.equal(cache.stats().hits, 1)
})

test('lines: kitty profile renders the same geometry', () => {
  assert.equal(measureLineWidth('a你·', KITTY), 1 + 2 + 1)
})
