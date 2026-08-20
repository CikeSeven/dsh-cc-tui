/**
 * tui-v2 WP-06c content line-component tests: markdown / code / diff.
 *
 * Two assertion layers:
 *  1. Logical-line level: visible text (ANSI-stripped through the §6.1
 *     pipeline), style markers (SGR/OSC 8 bytes), and the width contract
 *     matrix {0,1,2,5,40} with CJK/emoji payloads.
 *  2. Canonical-grid level: deterministic input -> logical lines ->
 *     buildFrame -> canonicalizeFrame; row text and resolved style/hyperlink
 *     fragments are asserted on the cell grid (the frame the compositor and
 *     golden tooling would see).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderMarkdownLines } from '../../src/tui-v2/components/transcript/markdown.js'
import { renderCodeLines } from '../../src/tui-v2/components/transcript/code.js'
import { classifyDiffLine, renderDiffLines } from '../../src/tui-v2/components/transcript/diff.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import { buildFrame } from '../../src/tui-v2/renderer/frame-builder.js'
import { lineToCells, measureLineWidth } from '../../src/tui-v2/renderer/lines.js'
import type { TerminalModeSnapshot } from '../../src/tui-v2/renderer/frame.js'
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import { canonicalizeFrame, type CanonicalCell } from '../../src/tui-v2/testkit/canonical.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'

const PROFILE = getProfile('unicode-ambiguous-narrow') // supportsOsc8Hyperlinks: 'yes'
const ASCII = getProfile('ascii-narrow') // supportsOsc8Hyperlinks: 'no'
const THEME = DEFAULT_COMPONENT_THEME

function visible(line: string, profile: TerminalProfile = PROFILE): string {
  return lineToCells(line, profile)
    .filter((c) => c.width > 0)
    .map((c) => c.grapheme)
    .join('')
}

function visibleAll(lines: readonly string[], profile: TerminalProfile = PROFILE): string[] {
  return lines.map((line) => visible(line, profile))
}

function assertWidthContract(lines: readonly string[], width: number, profile: TerminalProfile = PROFILE): void {
  for (const line of lines) {
    assert.ok(
      measureLineWidth(line, profile) <= width,
      `line exceeds width ${width}: ${JSON.stringify(line)}`,
    )
  }
}

const WIDTHS = [0, 1, 2, 5, 40] as const

// ---------------------------------------------------------------------------
// canonical-grid snapshot helper (logical lines -> frame -> canonical cells)
// ---------------------------------------------------------------------------

function defaultModes(height: number): TerminalModeSnapshot {
  return {
    alternateScreen: true,
    rawInput: true,
    mouse: 'off',
    bracketedPaste: true,
    syncOutput: false,
    autowrap: true,
    wrapPending: false,
    scrollRegion: { top: 0, bottom: height - 1 },
    cursorStyle: 'block',
    cursorVisible: false,
    kittyKeyboard: false,
    modifyOtherKeys: false,
    focusReporting: false,
    windowsDec9001: false,
    osc133: false,
    title: null,
    progress: { state: 'none' },
  }
}

interface SnapshotRow {
  readonly text: string
  /** Styles of the non-default cells, in cell order: 'fg=ansi16:2,bold'. */
  readonly styled: readonly string[]
  /** Hyperlink uris of linked cells (deduped, in cell order). */
  readonly links: readonly string[]
}

/** Deterministic input -> logical lines -> cells -> canonical grid rows. */
function snapshotRows(lines: readonly string[], width: number): SnapshotRow[] {
  const frame = buildFrame({
    frameId: 'content-snapshot',
    stateRevision: 1,
    width,
    height: lines.length,
    lines,
    profile: PROFILE,
    modes: defaultModes(lines.length),
    generation: 1,
  })
  const grid = canonicalizeFrame(frame)
  const rows: SnapshotRow[] = []
  for (let y = 0; y < grid.height; y++) {
    const cells = grid.cells.slice(y * grid.width, (y + 1) * grid.width)
    const text = cells.map((cell: CanonicalCell) => cell.grapheme).join('')
    const styled: string[] = []
    const links: string[] = []
    for (const cell of cells) {
      if (cell.continuation) continue
      const s = cell.resolvedStyle
      const isDefault =
        s.foreground === null && s.background === null && !s.bold && !s.dim && !s.italic && !s.underline && !s.inverse && !s.strike
      if (!isDefault && cell.grapheme !== '') {
        const attrs = [
          s.foreground !== null ? `fg=${s.foreground}` : '',
          s.bold ? 'bold' : '',
          s.dim ? 'dim' : '',
          s.italic ? 'italic' : '',
          s.underline ? 'underline' : '',
        ]
          .filter((part) => part !== '')
          .join(',')
        styled.push(`${cell.grapheme}:${attrs}`)
      }
      if (cell.hyperlink !== null && !links.includes(cell.hyperlink.uri)) links.push(cell.hyperlink.uri)
    }
    rows.push({ text: text.trimEnd(), styled, links })
  }
  return rows
}

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

test('content markdown width: headings/lists/quotes render structured logical lines', () => {
  const md = ['# Title', '', 'plain **bold** *it* `code`', '- one', '- 第二项 换行换行换行换行', '> 引文 **重点**'].join('\n')
  const lines = renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 24)
  const texts = visibleAll(lines)
  assert.ok(texts[0]?.includes('Title') && !texts[0].includes('#'))
  assert.ok((lines[0] as string).includes('\x1b[0;1m'), 'heading is bold')
  assert.equal(texts[1], '')
  const body = texts.find((t) => t.includes('bold')) as string
  assert.ok(body.includes('plain bold it code'), 'inline markers stripped')
  assert.ok(texts.some((t) => t.startsWith('- one')))
  const second = texts.findIndex((t) => t.startsWith('- 第二项'))
  assert.ok(second > 0 && (texts[second + 1] as string).startsWith('  换'), 'list continuation aligns under the text')
  const quote = texts.find((t) => t.includes('引文')) as string
  assert.ok(quote.startsWith('│ '), 'quote gutter')
  assertWidthContract(lines, 24)
})

test('content markdown: links emit OSC 8 + underline when the profile allows', () => {
  const lines = renderMarkdownLines('see [the docs](https://example.com/x) now', { theme: THEME, profile: PROFILE }, 60)
  assert.equal(lines.length, 1)
  const line = lines[0] as string
  assert.ok(line.includes('\x1b]8;;https://example.com/x\x07'), 'OSC 8 open emitted')
  assert.ok(line.includes('\x1b]8;;\x07'), 'hyperlink run closed before the line ends')
  assert.ok(line.includes('\x1b['), 'link text carries SGR (underline)')
  assert.equal(visible(line), 'see the docs now')
  // No OSC 8 without profile support or with a disallowed scheme: plain text.
  const ascii = renderMarkdownLines('see [the docs](https://example.com/x) now', { theme: THEME, profile: ASCII }, 80)
  assert.equal(visible(ascii[0] as string, ASCII), 'see the docs (https://example.com/x) now')
  assert.ok(!(ascii[0] as string).includes('\x1b]8;'))
  const js = renderMarkdownLines('[x](javascript:alert(1))', { theme: THEME, profile: PROFILE }, 80)
  assert.ok(!(js[0] as string).includes('\x1b]8;'), 'non-http(s) scheme stays plain text')
  assert.equal(visible(js[0] as string), 'x (javascript:alert(1))')
})

test('content markdown: loose emphasis delimiters stay literal (2 * 3 * 4)', () => {
  const lines = renderMarkdownLines('2 * 3 * 4 and *real* italic', { theme: THEME, profile: PROFILE }, 60)
  const line = lines[0] as string
  assert.equal(visible(line), '2 * 3 * 4 and real italic')
  // Exactly one italic span opens — the tight `*real*`, never the loose `* 3 *`.
  assert.equal((line.match(/\x1b\[0;3m/g) ?? []).length, 1)
})

test('content markdown width: fenced code clips long lines, never wraps, drops fence markers', () => {
  const md = ['```ts', 'const short = 1', 'const veryLongLine = "这是一段超宽的代码行，用来验证裁剪而不是折叠的行为"', '```'].join('\n')
  const lines = renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 20)
  const texts = visibleAll(lines)
  assert.equal(lines.length, 2, 'one logical line per source line (no wrap)')
  assert.ok(!texts.some((t) => t.includes('```')))
  assert.ok(texts[0]?.includes('const short = 1'))
  assertWidthContract(lines, 20)
})

test('content markdown: unclosed fence still renders gathered lines (streaming)', () => {
  const lines = renderMarkdownLines('```\npartial line', { theme: THEME, profile: PROFILE }, 40)
  assert.deepEqual(visibleAll(lines), ['partial line'])
})

test('content markdown: a ```diff fence renders with diff coloring', () => {
  const md = ['```diff', '- old()', '+ new()', '```'].join('\n')
  const lines = renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 40)
  const del = lines.find((l) => visible(l).includes('old')) as string
  const add = lines.find((l) => visible(l).includes('new')) as string
  assert.ok(del.includes('\x1b[0;31m'), 'deletion in red (error role)')
  assert.ok(add.includes('\x1b[0;32m'), 'addition in green (success role)')
})

test('content markdown width: tables degrade to verbatim clipped lines', () => {
  const md = ['| 名称 | 值 |', '| --- | --- |', '| alpha | 1 |'].join('\n')
  const lines = renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 10)
  assert.equal(lines.length, 3)
  assert.ok(visible(lines[0] as string).startsWith('|'))
  assertWidthContract(lines, 10)
})

test('content markdown: hostile escape input is stripped before styling', () => {
  const md = 'pwn\x1b[2K\x1b]52;c;Zm9v\x07ed **b\x1b[7mold** [l](https://e.com/\x1b]8;;https://evil\x07)'
  for (const line of renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 60)) {
    assert.ok(!line.includes('\x1b]52'), 'OSC 52 stripped')
    assert.ok(!line.includes('https://evil'), 'injected OSC 8 uri stripped')
  }
})

test('content markdown width contract (0/1/2/5/40, CJK + emoji, list/quote/code)', () => {
  const md = ['# 标题 🚀', '', '- 你好世界 👨‍👩‍👧 这是一段很长很长的列表项用来触发折叠', '> 引用：宽度边界·测试', '', '```', 'const x = "你好"; // 超长注释超长注释超长注释', '```'].join('\n')
  for (const width of WIDTHS) {
    const lines = renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, width)
    if (width === 0) assert.deepEqual(lines, [])
    else assertWidthContract(lines, width)
  }
  // ambiguous-wide profile: '·' measures 2 columns there.
  const wide = getProfile('unicode-ambiguous-wide')
  assertWidthContract(renderMarkdownLines('a·b·c·d·e·f', { theme: THEME, profile: wide }, 4), 4, wide)
})

test('content markdown: canonical grid snapshot (cells/styles/hyperlink)', () => {
  const md = ['# Hi', '- **b** [x](https://example.com)'].join('\n')
  const rows = snapshotRows(renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 30), 30)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.text, 'Hi')
  assert.deepEqual(rows[0]?.styled, ['H:bold', 'i:bold'], 'heading cells bold, default color')
  assert.equal(rows[1]?.text, '- b x')
  assert.deepEqual(rows[1]?.links, ['https://example.com'])
  const boldCell = rows[1]?.styled.find((s) => s.startsWith('b:'))
  assert.equal(boldCell, 'b:bold')
  const linkCell = rows[1]?.styled.find((s) => s.startsWith('x:'))
  assert.ok(linkCell?.includes('underline') && linkCell.includes('fg=ansi16:6'), 'link role on link cells')
})

// ---------------------------------------------------------------------------
// code
// ---------------------------------------------------------------------------

test('content code width: clips long lines, never wraps; badge optional; empty renders nothing', () => {
  assert.deepEqual(renderCodeLines('', { theme: THEME, profile: PROFILE }, 20), [])
  const lines = renderCodeLines('const a = 1\nconst 超宽行 = "你好世界你好世界你好世界"\n', { theme: THEME, profile: PROFILE }, 16)
  assert.equal(lines.length, 2, 'trailing newline is a terminator, not a line')
  assert.equal(visible(lines[0] as string), 'const a = 1')
  assertWidthContract(lines, 16)
  const badged = renderCodeLines('x', { theme: THEME, profile: PROFILE, language: 'ts', showLanguage: true }, 16)
  assert.equal(visible(badged[0] as string), 'ts')
  assert.equal(visible(badged[1] as string), 'x')
  // indent gutter hangs every line; firstIndent overrides the first lead.
  const hung = renderCodeLines('a\nb', { theme: THEME, profile: PROFILE, indent: '   ', firstIndent: ' ⎿ ' }, 16)
  assert.ok(visible(hung[0] as string).startsWith(' ⎿ a'))
  assert.ok(visible(hung[1] as string).startsWith('   b'))
})

test('content code width contract (0/1/2/5/40, CJK + tabs)', () => {
  for (const width of WIDTHS) {
    const lines = renderCodeLines('\tconst 值 = "👍"\n你好世界', { theme: THEME, profile: PROFILE }, width)
    if (width === 0) assert.deepEqual(lines, [])
    else assertWidthContract(lines, width)
  }
})

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test('content diff: classifyDiffLine buckets the unified-diff line shapes', () => {
  assert.equal(classifyDiffLine('diff --git a/x b/x'), 'header')
  assert.equal(classifyDiffLine('index 123..456 100644'), 'header')
  assert.equal(classifyDiffLine('--- a/x'), 'header')
  assert.equal(classifyDiffLine('+++ b/x'), 'header')
  assert.equal(classifyDiffLine('@@ -1,2 +1,3 @@'), 'hunk')
  assert.equal(classifyDiffLine('+added'), 'add')
  assert.equal(classifyDiffLine('-removed'), 'del')
  assert.equal('context', classifyDiffLine(' same'))
  assert.equal(classifyDiffLine('\\ No newline at end of file'), 'marker')
})

test('content diff width: roles, clipping, and the optional line-number gutter', () => {
  const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' ctx', '-old 超宽超宽超宽超宽超宽', '+new', '+new2'].join('\n')
  const lines = renderDiffLines(diff, { theme: THEME, profile: PROFILE }, 16)
  const texts = visibleAll(lines)
  assert.deepEqual(texts.map((t) => t.trimEnd()).slice(0, 3), ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@'].map((s) => s.slice(0, 16)))
  assert.ok((lines[0] as string).includes('\x1b[0;90m'), 'file header dimmed')
  assert.ok((lines[2] as string).includes('\x1b[0;36m'), 'hunk header in accent cyan')
  assert.ok((lines[4] as string).includes('\x1b[0;31m'), 'deletion red')
  assert.ok((lines[5] as string).includes('\x1b[0;32m'), 'addition green')
  assertWidthContract(lines, 16)
  // Line numbers track the new-file counter; deletions get a blank gutter.
  const numbered = renderDiffLines(diff, { theme: THEME, profile: PROFILE, lineNumbers: true }, 24)
  const numberedTexts = visibleAll(numbered)
  assert.ok(numberedTexts[3]?.startsWith(' 1  ctx'), 'context line numbered (right-aligned gutter)')
  assert.ok(numberedTexts[4]?.startsWith('   -old'), 'deletion gutter blank')
  assert.ok(numberedTexts[5]?.startsWith(' 2 +new'), 'addition numbered from the hunk header')
  assert.ok(numberedTexts[6]?.startsWith(' 3 +new2'))
  assertWidthContract(numbered, 24)
})

test('content diff width contract (0/1/2/5/40, CJK + hostile bytes)', () => {
  const diff = ['@@ -0,0 +1,2 @@', '+你好世界 👋 很长的增加行很长的增加行', '-删除 \x1b[2K 带恶意字节'].join('\n')
  for (const width of WIDTHS) {
    const lines = renderDiffLines(diff, { theme: THEME, profile: PROFILE, lineNumbers: width % 2 === 0 }, width)
    if (width === 0) assert.deepEqual(lines, [])
    else {
      assertWidthContract(lines, width)
      for (const line of lines) assert.ok(!line.includes('\x1b[2K'), 'hostile CSI stripped')
    }
  }
})

test('content diff: canonical grid snapshot (add/del/hunk styles on cells)', () => {
  const diff = ['@@ -1 +1,2 @@', '-old', '+new'].join('\n')
  const rows = snapshotRows(renderDiffLines(diff, { theme: THEME, profile: PROFILE }, 20), 20)
  assert.deepEqual(rows.map((r) => r.text), ['@@ -1 +1,2 @@', '-old', '+new'])
  assert.ok(rows[0]?.styled.every((s) => s.endsWith(':fg=ansi16:6')), 'hunk row accent cyan')
  assert.ok(rows[1]?.styled.every((s) => s.endsWith(':fg=ansi16:1')), 'del row red')
  assert.ok(rows[2]?.styled.every((s) => s.endsWith(':fg=ansi16:2')), 'add row green')
})

test('content markdown: canonical grid carries the OSC 8 hyperlink on link cells', () => {
  const rows = snapshotRows(renderMarkdownLines('[docs](https://example.com) end', { theme: THEME, profile: PROFILE }, 40), 40)
  assert.equal(rows[0]?.text, 'docs end')
  assert.deepEqual(rows[0]?.links, ['https://example.com'])
  const linkCells = rows[0]?.styled.filter((s) => s.includes('underline')) ?? []
  assert.equal(linkCells.length, 4, 'docs is underlined')
  assert.ok(linkCells.every((s) => s.includes('fg=ansi16:6')), 'link role foreground')
})
