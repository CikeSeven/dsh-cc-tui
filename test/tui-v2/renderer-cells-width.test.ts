/**
 * tui-v2 WP-06a cells tests: the §6.1 width pipeline at the cell level.
 *
 * Covers the plan §6.1 "必须覆盖" matrix as TerminalCell output (ASCII / CJK /
 * 全角标点 / ambiguous width / 组合字符 / ZWJ emoji / regional indicator /
 * variation selector / 控制符 / ANSI style / OSC 8 hyperlink / tab / RTL /
 * 超宽单 grapheme), plus the WP-06a additions on top of lines.ts:
 *
 *   - resource interning (styleId/hyperlinkId frame-local, content-keyed,
 *     id 0 pinned to the default style, full descriptor snapshot);
 *   - the trusted/untrusted boundary (untrusted text is sanitizeText-stripped
 *     before re-styling; dropped controls are counted as diagnostics — the
 *     fuzz hook);
 *   - fitCellsToWidth: the frame-level clip+pad hard guard (never splits a
 *     wide grapheme, never emits a torn/empty substitute cell).
 *
 * Width expectations are cross-checked against the WP-02 oracle
 * (`measureGrapheme` in testkit/virtual-terminal.ts), same as lines tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createCellPipelineDiagnostics,
  createResourceTable,
  fitCellsToWidth,
  terminalCellsFromLineCells,
  terminalCellsFromTrustedLine,
  terminalCellsFromUntrustedText,
  trustedLineCells,
  untrustedLineCells,
} from '../../src/tui-v2/renderer/cells.js'
import {
  DEFAULT_LINE_STYLE,
  lineStyle,
  type LineCell,
} from '../../src/tui-v2/renderer/lines.js'
import type { TerminalCell } from '../../src/tui-v2/renderer/frame.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { measureGrapheme } from '../../src/tui-v2/testkit/virtual-terminal.js'

const NARROW = getProfile('unicode-ambiguous-narrow')
const WIDE = getProfile('unicode-ambiguous-wide')

function widths(cells: readonly { width: number }[]): number[] {
  return cells.map((cell) => cell.width)
}

function graphemes(cells: readonly { grapheme: string }[]): string[] {
  return cells.map((cell) => cell.grapheme)
}

/** Scan a fitted row for the §5.5 continuation invariants. */
function continuationViolations(cells: readonly LineCell[]): string[] {
  const violations: string[] = []
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as LineCell
    if (cell.width === 2) {
      const next = cells[i + 1]
      if (next === undefined || next.width !== 0 || next.grapheme !== '') violations.push(`dangling-wide-head@${i}`)
    } else if (cell.width === 0 && cell.grapheme === '') {
      const prev = i > 0 ? cells[i - 1] : undefined
      if (prev === undefined || prev.width !== 2) violations.push(`orphan-continuation@${i}`)
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// measurement matrix at the TerminalCell level
// ---------------------------------------------------------------------------

test('cells width: ASCII/CJK produce oracle-agreed TerminalCells with continuations', () => {
  const table = createResourceTable()
  const cells = terminalCellsFromTrustedLine('ab你c', NARROW, table)
  assert.deepEqual(
    cells.map((cell) => [cell.grapheme, cell.width]),
    [
      ['a', 1],
      ['b', 1],
      ['你', 2],
      ['', 0],
      ['c', 1],
    ],
  )
  // Every non-continuation cell agrees with the xterm oracle.
  assert.equal(measureGrapheme('你', false), 2)
  // styleId 0 is the pinned default style.
  assert.ok(cells.every((cell) => cell.styleId === 0))
  assert.equal(table.snapshot().styles.length, 1)
  assert.equal(table.snapshot().styles[0]?.id, 0)
})

test('cells width: fullwidth punctuation and profile-driven ambiguous width', () => {
  const narrow = terminalCellsFromTrustedLine('，。·—', NARROW, createResourceTable())
  assert.deepEqual(widths(narrow), [2, 0, 2, 0, 1, 1])
  const wide = terminalCellsFromTrustedLine('·—', WIDE, createResourceTable())
  assert.deepEqual(widths(wide), [2, 0, 2, 0])
  // oracle agreement for both profile branches
  assert.equal(measureGrapheme('·', true), 2)
  assert.equal(measureGrapheme('—', false), 1)
})

test('cells width: combining/ZWJ/RI/VS graphemes stay whole end-to-end', () => {
  const table = createResourceTable()
  const corpus = ['é', '👨‍👩‍👧', '🇨🇳', '❤️', '✈️']
  for (const grapheme of corpus) {
    const cells = terminalCellsFromTrustedLine(grapheme, NARROW, table)
    const head = cells[0] as TerminalCell
    assert.equal(head.grapheme, grapheme, `grapheme ${JSON.stringify(grapheme)} must stay whole`)
    assert.equal(head.width, measureGrapheme(grapheme, false), `oracle width for ${JSON.stringify(grapheme)}`)
    if (head.width === 2) {
      assert.deepEqual(
        { grapheme: cells[1]?.grapheme, width: cells[1]?.width },
        { grapheme: '', width: 0 },
        'wide grapheme followed by its continuation cell',
      )
      // The continuation carries the same style id (never a pool hole).
      assert.equal(cells[1]?.styleId, head.styleId)
    }
  }
})

test('cells width: tab expands to tabstop 3 blanks carrying the current style', () => {
  const table = createResourceTable()
  const diagnostics = createCellPipelineDiagnostics()
  const cells = terminalCellsFromTrustedLine('\x1b[31ma\tb', NARROW, table, { diagnostics })
  // 'a' at column 0, tab -> 2 blanks to reach column 3, then 'b'.
  assert.deepEqual(graphemes(cells), ['a', ' ', ' ', 'b'])
  const styles = new Map(table.snapshot().styles.map((style) => [style.id, style]))
  const redId = (cells[0] as TerminalCell).styleId
  assert.equal(styles.get(redId)?.foreground, 'ansi16:1') // canonical spelling of 'red'
  // The tab blanks are real space cells with the ACTIVE style (§5.5 blank style).
  assert.equal((cells[1] as TerminalCell).styleId, redId)
  assert.equal((cells[2] as TerminalCell).styleId, redId)
  assert.equal(diagnostics.droppedControls, 0)
})

test('cells width: non-SGR/OSC8 sequences are consumed and counted, never emitted', () => {
  const table = createResourceTable()
  const diagnostics = createCellPipelineDiagnostics()
  const hostile =
    '\x1b[2J' + // CSI erase
    '\x1b[1;1H' + // CSI cursor move
    '\x1b]52;c;QUJDRA==\x07' + // OSC 52 clipboard
    '\x1b]0;pwned\x07' + // OSC title
    '\x1b_Ga=t,f=100;QUJD\x1b\\' + // kitty APC image
    'hi'
  const cells = terminalCellsFromTrustedLine(hostile, NARROW, table, { diagnostics })
  assert.deepEqual(graphemes(cells), ['h', 'i'])
  assert.equal(diagnostics.droppedControls, 5)
  // No escape byte can appear in any emitted grapheme.
  for (const cell of cells) {
    assert.ok(!/[\x1b\x7f]/.test(cell.grapheme))
  }
})

test('cells width: ANSI styles intern to stable content-keyed ids', () => {
  const table = createResourceTable()
  const first = terminalCellsFromTrustedLine('\x1b[1;31mAB\x1b[0m', NARROW, table)
  const second = terminalCellsFromTrustedLine('\x1b[31;1mCD\x1b[0m', NARROW, table)
  const redBold = (first[0] as TerminalCell).styleId
  // Same style content from different spellings/lines shares one id.
  assert.notEqual(redBold, 0)
  assert.equal((second[0] as TerminalCell).styleId, redBold)
  // The reset run falls back to the pinned default id 0.
  const plain = terminalCellsFromTrustedLine('plain', NARROW, table)
  assert.ok(plain.every((cell) => cell.styleId === 0))
  const { styles } = table.snapshot()
  assert.equal(styles.length, 2)
  assert.deepEqual(
    styles.map((style) => style.id).sort(),
    [0, 1],
  )
})

test('cells width: OSC 8 hyperlinks intern, dedupe and close', () => {
  const table = createResourceTable()
  const cells = terminalCellsFromTrustedLine(
    '\x1b]8;;https://a.example\x07link\x1b]8;;\x07 plain \x1b]8;;https://a.example\x07again\x1b]8;;\x07',
    NARROW,
    table,
  )
  const linkId = (cells[0] as TerminalCell).hyperlinkId
  assert.ok(linkId !== undefined)
  // 'link' and 'again' share one hyperlink id; ' plain ' has none.
  assert.equal((cells[3] as TerminalCell).hyperlinkId, linkId)
  assert.equal((cells[4] as TerminalCell).hyperlinkId, undefined)
  const again = cells[11] as TerminalCell
  assert.equal(again.hyperlinkId, linkId)
  const { hyperlinks } = table.snapshot()
  assert.equal(hyperlinks.length, 1)
  assert.equal(hyperlinks[0]?.uri, 'https://a.example')
  assert.equal(hyperlinks[0]?.id, linkId)
})

test('cells width: RTL text keeps logical order (no bidi shaping in v2)', () => {
  const cells = terminalCellsFromTrustedLine('aאבz', NARROW, createResourceTable())
  assert.deepEqual(graphemes(cells), ['a', 'א', 'ב', 'z'])
})

// ---------------------------------------------------------------------------
// trust boundary + fuzz hook
// ---------------------------------------------------------------------------

test('cells width: untrusted text is stripped, then uniformly re-styled', () => {
  const table = createResourceTable()
  const diagnostics = createCellPipelineDiagnostics()
  const style = lineStyle({ foreground: 'yellow' })
  const hostile = 'rm -rf \x1b[31mRED\x1b]8;;https://evil.example\x07link\x1b]52;c;QUJD\x07'
  const cells = terminalCellsFromUntrustedText(hostile, style, NARROW, table, { diagnostics })
  const text = cells.map((cell) => cell.grapheme).join('')
  assert.ok(!text.includes('\x1b'), 'no ESC survives')
  assert.ok(text.includes('RED'), 'printable text survives as plain text')
  // The whole OSC 8 sequence (uri included) is stripped: nothing of the
  // hostile link survives — not as a hyperlink, not even as visible text.
  assert.ok(!text.includes('evil.example'), 'OSC 8 uri is stripped with its sequence')
  // Every cell carries exactly the uniform style; no hyperlink can be smuggled.
  const styleId = (cells[0] as TerminalCell).styleId
  const styles = new Map(table.snapshot().styles.map((s) => [s.id, s]))
  assert.equal(styles.get(styleId)?.foreground, 'ansi16:3') // canonical spelling of 'yellow'
  assert.ok(cells.every((cell) => cell.styleId === styleId))
  assert.ok(cells.every((cell) => cell.hyperlinkId === undefined))
  assert.equal(table.snapshot().hyperlinks.length, 0)
  assert.ok(diagnostics.droppedControls >= 3, 'CSI + OSC 8 + OSC 52 counted')
})

test('cells width: fuzz hook — arbitrary bytes never leak controls into cells', () => {
  // Deterministic PRNG (mulberry32); the alphabet is heavy on escape bytes.
  let state = 0x5eed
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const alphabet = [
    'a', 'Z', '\u4f60', '\uff0c', '\u00b7', 'e\u0301', '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67', '\ud83c\udde8\ud83c\uddf3', '\u2764\ufe0f', '\u05d0', '\t', ' ',
    '\x1b', '\x07', '\x9b', '\x9d', '\x00', '\x01', '\n', '\x7f', '[', ']', 'm', ';', '0', '8',
  ]
  for (let round = 0; round < 300; round++) {
    let raw = ''
    const length = Math.floor(next() * 24)
    for (let i = 0; i < length; i++) {
      raw += alphabet[Math.floor(next() * alphabet.length)]
    }
    const diagnostics = createCellPipelineDiagnostics()
    for (const cells of [
      trustedLineCells(raw, NARROW, { diagnostics }),
      untrustedLineCells(raw, DEFAULT_LINE_STYLE, NARROW, { diagnostics }),
    ]) {
      for (const cell of cells) {
        for (const ch of cell.grapheme) {
          const cp = ch.codePointAt(0) as number
          assert.ok(
            cp >= 0x20 && !(cp >= 0x7f && cp <= 0x9f),
            `round ${round}: control U+${cp.toString(16)} leaked from ${JSON.stringify(raw)}`,
          )
        }
      }
      assert.deepEqual(continuationViolations(cells), [])
    }
  }
})

// ---------------------------------------------------------------------------
// fitCellsToWidth: frame-level clip + pad
// ---------------------------------------------------------------------------

test('cells width: fitCellsToWidth clips, pads and never splits a wide grapheme', () => {
  const diagnostics = createCellPipelineDiagnostics()
  // '你' would straddle columns 2-3 of a width-3 row after 'ab': dropped whole.
  const fitted = fitCellsToWidth(trustedLineCells('ab你cd', NARROW), 3, diagnostics)
  assert.deepEqual(graphemes(fitted), ['a', 'b', ' '])
  assert.equal(diagnostics.clippedLines, 1)
  assert.equal(diagnostics.overwideGraphemes, 1)
  assert.deepEqual(continuationViolations(fitted), [])

  // Exact fit of a wide grapheme at the right edge keeps head + continuation.
  const exact = fitCellsToWidth(trustedLineCells('a你', NARROW), 3)
  assert.deepEqual(
    exact.map((cell) => [cell.grapheme, cell.width]),
    [
      ['a', 1],
      ['你', 2],
      ['', 0],
    ],
  )

  // Padding blanks are explicit, default-styled space cells.
  const padded = fitCellsToWidth(trustedLineCells('x', NARROW), 4)
  assert.deepEqual(graphemes(padded), ['x', ' ', ' ', ' '])
  assert.ok(padded.slice(1).every((cell) => lineStyleEqualsDefault(cell.style)))

  // width <= 0 is the empty sequence (§6.1: no repeat/recursion).
  assert.deepEqual(fitCellsToWidth(trustedLineCells('abc', NARROW), 0), [])
})

function lineStyleEqualsDefault(style: LineCell['style']): boolean {
  return style.foreground === null && style.background === null && !style.bold && !style.dim && !style.italic && !style.underline && !style.inverse && !style.strike
}

test('cells width: lone over-wide grapheme on a width-1 row clips to a blank', () => {
  const diagnostics = createCellPipelineDiagnostics()
  const fitted = fitCellsToWidth(trustedLineCells('你', NARROW), 1, diagnostics)
  // §5.5 clip rule: the grapheme is dropped and the column is a real space
  // cell — the frame row must emit one terminal column per cell, so the
  // empty-grapheme substitute used in string replay is never emitted here.
  assert.deepEqual(
    fitted.map((cell) => [cell.grapheme, cell.width]),
    [[' ', 1]],
  )
  assert.equal(diagnostics.overwideGraphemes, 1)
})

test('cells width: terminalCellsFromLineCells interns per-cell styles and links', () => {
  const table = createResourceTable()
  const lineCells = trustedLineCells('\x1b[34m你\x1b[0m\x1b]8;;https://x.example\x07!\x1b]8;;\x07', NARROW)
  const cells = terminalCellsFromLineCells(fitCellsToWidth(lineCells, 6), table)
  assert.equal(cells.length, 6)
  const styles = new Map(table.snapshot().styles.map((s) => [s.id, s]))
  const links = new Map(table.snapshot().hyperlinks.map((l) => [l.id, l]))
  // Wide head and its continuation share style id; the '!' carries the link.
  assert.equal(cells[0]?.styleId, cells[1]?.styleId)
  assert.equal(styles.get((cells[0] as TerminalCell).styleId)?.foreground, 'ansi16:4') // canonical 'blue'
  assert.equal(links.get((cells[2] as TerminalCell).hyperlinkId as number)?.uri, 'https://x.example')
  // Padding blanks resolve to the pinned default style id 0.
  for (const pad of cells.slice(3)) {
    assert.equal(pad.styleId, 0)
    assert.equal(pad.hyperlinkId, undefined)
  }
})
