/**
 * tui-v2 WP-08b content component contracts: Markdown / code / diff.
 * Logical lines and canonical cells are checked across width
 * {0,1,2,5,40,120}, including CJK, ZWJ emoji, ANSI/OSC, and split diffs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderMarkdownLines } from '../../src/tui-v2/components/transcript/markdown.js'
import { normalizeCodeLanguage, renderCodeLines } from '../../src/tui-v2/components/transcript/code.js'
import {
  classifyDiffLine,
  renderDiffLines,
  SIDE_BY_SIDE_MIN_WIDTH,
} from '../../src/tui-v2/components/transcript/diff.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import { buildFrame } from '../../src/tui-v2/renderer/frame-builder.js'
import { lineToCells, measureLineWidth } from '../../src/tui-v2/renderer/lines.js'
import type { TerminalModeSnapshot } from '../../src/tui-v2/renderer/frame.js'
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import { canonicalizeFrame, type CanonicalCell } from '../../src/tui-v2/testkit/canonical.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'

const PROFILE = getProfile('unicode-ambiguous-narrow')
const ASCII = getProfile('ascii-narrow')
const THEME = DEFAULT_COMPONENT_THEME
const WIDTHS = [0, 1, 2, 5, 40, 120] as const

function visible(line: string, profile: TerminalProfile = PROFILE): string {
  return lineToCells(line, profile)
    .filter((cell) => cell.width > 0)
    .map((cell) => cell.grapheme)
    .join('')
}

function visibleAll(lines: readonly string[], profile: TerminalProfile = PROFILE): string[] {
  return lines.map((line) => visible(line, profile))
}

function assertWidthContract(lines: readonly string[], width: number, profile: TerminalProfile = PROFILE): void {
  for (const line of lines) {
    assert.ok(measureLineWidth(line, profile) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`)
  }
}

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
  readonly styled: readonly string[]
  readonly links: readonly string[]
}

/** Deterministic logical lines -> fully resolved canonical grid rows. */
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
      const style = cell.resolvedStyle
      const isDefault = style.foreground === null && style.background === null &&
        !style.bold && !style.dim && !style.italic && !style.underline && !style.inverse && !style.strike
      if (!isDefault && cell.grapheme !== '') {
        const attrs = [
          style.foreground !== null ? `fg=${style.foreground}` : '',
          style.background !== null ? `bg=${style.background}` : '',
          style.bold ? 'bold' : '',
          style.dim ? 'dim' : '',
          style.italic ? 'italic' : '',
          style.underline ? 'underline' : '',
          style.inverse ? 'inverse' : '',
          style.strike ? 'strike' : '',
        ].filter(Boolean).join(',')
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

test('content markdown: soft paragraphs, underscore/nested emphasis, setext/hr, and reference links', () => {
  const md = [
    'soft first line',
    'soft _outer **inner**_ second line',
    '',
    'Setext title',
    '===',
    '---',
    '[Guide][docs]',
    '[docs]: https://example.com/guide',
  ].join('\n')
  const lines = renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 120)
  const texts = visibleAll(lines)
  assert.equal(texts[0], 'soft first line soft outer inner second line', 'soft lines form one paragraph')
  assert.equal(texts[2], 'Setext title')
  assert.match(texts[3] as string, /^─+$/, 'thematic break is a visible rule')
  assert.equal(texts[4], 'Guide', 'reference definition is hidden')
  assert.ok((lines[4] as string).includes('\x1b]8;;https://example.com/guide\x07'))

  const nested = snapshotRows(renderMarkdownLines('_outer **inner**_', { theme: THEME, profile: PROFILE }, 40), 40)[0]
  assert.ok(nested?.styled.some((cell) => cell.includes('bold') && cell.includes('italic')), 'nested cell keeps both attrs')
  assert.ok(snapshotRows([lines[2] as string], 40)[0]?.styled.every((cell) => cell.includes('bold')), 'setext heading bold')
})

test('content markdown: loose or incomplete emphasis delimiters stay literal while streaming', () => {
  const lines = renderMarkdownLines('2 * 3 * 4 and *real* italic\npartial **bold', { theme: THEME, profile: PROFILE }, 80)
  assert.deepEqual(visibleAll(lines), ['2 * 3 * 4 and real italic partial **bold'])
  assert.equal((lines[0]?.match(/\x1b\[[0-9;]*3[0-9;]*m/g) ?? []).length, 1)
})

test('content markdown width: fenced code clips long lines, never wraps, drops fence markers', () => {
  const md = ['```ts', 'const short = 1', 'const veryLongLine = "这是一段超宽的代码行，用来验证裁剪而不是折叠的行为"', '```'].join('\n')
  const lines = renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 20)
  const texts = visibleAll(lines)
  assert.equal(lines.length, 2, 'one logical line per source line (no wrap)')
  assert.ok(!texts.some((text) => text.includes('```')))
  assert.ok(texts[0]?.includes('const short = 1'))
  assertWidthContract(lines, 20)
})

test('content markdown: tilde/info-string and unclosed fences render gathered streaming lines', () => {
  const lines = renderMarkdownLines('~~~ typescript title=demo\nconst answer = 42', { theme: THEME, profile: PROFILE }, 80)
  assert.deepEqual(visibleAll(lines), ['const answer = 42'])
  const row = snapshotRows(lines, 80)[0]
  assert.ok(row?.styled.some((cell) => cell.startsWith('c:') && cell.includes('bold')), 'info first token selects TS lexer')
  assert.deepEqual(
    visibleAll(renderMarkdownLines('```\npartial line', { theme: THEME, profile: PROFILE }, 40)),
    ['partial line'],
  )
})

test('content markdown: a ```diff fence renders with diff coloring', () => {
  const md = ['```diff', '- old()', '+ new()', '```'].join('\n')
  const lines = renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 40)
  const del = lines.find((line) => visible(line).includes('old')) as string
  const add = lines.find((line) => visible(line).includes('new')) as string
  assert.ok(lineToCells(del, PROFILE).some((cell) => cell.style.foreground === 'red'))
  assert.ok(lineToCells(add, PROFILE).some((cell) => cell.style.foreground === 'green'))
})

test('content markdown tables align by cell width and degrade to clipping when narrow', () => {
  const md = ['| Name | State | Count |', '| :--- | :---: | ---: |', '| alpha | 中 | 7 |'].join('\n')
  const wide = renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 50)
  assert.equal(wide.length, 3)
  assert.equal(visible(wide[2] as string), '| alpha |  中   |     7 |')
  assertWidthContract(wide, 50)

  const narrow = renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 12)
  assert.equal(narrow.length, 3)
  assert.ok(visible(narrow[0] as string).startsWith('| Name'))
  assertWidthContract(narrow, 12)
})

test('content markdown: hostile escape input is stripped before styling', () => {
  const md = 'pwn\x1b[2K\x1b]52;c;Zm9v\x07ed **b\x1b[7mold** [l](https://e.com/\x1b]8;;https://evil\x07)'
  for (const line of renderMarkdownLines(md, { theme: THEME, profile: PROFILE }, 60)) {
    assert.ok(!line.includes('\x1b]52'), 'OSC 52 stripped')
    assert.ok(!line.includes('https://evil'), 'injected OSC 8 uri stripped')
  }
})

test('content markdown width contract (0/1/2/narrow/wide, CJK + emoji, list/quote/code)', () => {
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

test('content code clips without wrapping and keeps the language badge opt-in', () => {
  assert.deepEqual(renderCodeLines('', { theme: THEME, profile: PROFILE }, 20), [])
  const lines = renderCodeLines('const a = 1\nconst 超宽行 = "你好世界你好世界你好世界"\n', {
    theme: THEME,
    profile: PROFILE,
    language: 'typescript title=demo',
  }, 16)
  assert.equal(lines.length, 2, 'default badge is off and trailing newline is a terminator')
  assert.equal(visible(lines[0] as string), 'const a = 1')
  assertWidthContract(lines, 16)

  const badged = renderCodeLines('x', {
    theme: THEME,
    profile: PROFILE,
    language: 'typescript title=demo',
    showLanguage: true,
  }, 16)
  assert.deepEqual(visibleAll(badged), ['ts', 'x'], 'explicit badge uses normalized first info token')

  const hung = renderCodeLines('a\nb', { theme: THEME, profile: PROFILE, indent: '   ', firstIndent: ' ⎿ ' }, 16)
  assert.ok(visible(hung[0] as string).startsWith(' ⎿ a'))
  assert.ok(visible(hung[1] as string).startsWith('   b'))
})

test('content code lexer normalizes common aliases and highlights deterministic token classes', () => {
  assert.deepEqual(
    ['typescript', 'tsx', 'javascript', 'python3', 'sh', 'jsonc', 'patch', 'unknown'].map(normalizeCodeLanguage),
    ['ts', 'ts', 'js', 'py', 'bash', 'json', 'diff', 'plain'],
  )

  const ts = snapshotRows(renderCodeLines('const value = "ok"; // note', {
    theme: THEME,
    profile: PROFILE,
    language: 'typescript title=x',
  }, 80), 80)[0]
  assert.ok(ts?.styled.some((cell) => cell.startsWith('c:fg=ansi16:6') && cell.includes('bold')), 'keyword')
  assert.ok(ts?.styled.some((cell) => cell.startsWith('o:fg=ansi16:2')), 'string')
  assert.ok(ts?.styled.some((cell) => cell.startsWith('/:fg=ansi16:8')), 'comment')

  const number = snapshotRows(renderCodeLines('let n = 42', { theme: THEME, profile: PROFILE, language: 'js' }, 40), 40)[0]
  assert.ok(number?.styled.some((cell) => cell.startsWith('4:fg=ansi16:3') && cell.includes('bold')), 'number')

  for (const [language, source] of [
    ['py', 'def f(): # note'],
    ['bash', 'if true; then echo "ok"; fi'],
    ['json', '{"ok": true, "n": 1}'],
  ] as const) {
    const rendered = renderCodeLines(source, { theme: THEME, profile: PROFILE, language }, 80)
    assert.equal(visible(rendered[0] as string), source)
    assert.ok((rendered[0] as string).includes('\x1b['), `${language} styled`)
  }

  const diff = renderCodeLines('-old\n+new', { theme: THEME, profile: PROFILE, language: 'patch' }, 40)
  assert.ok(lineToCells(diff[0] as string, PROFILE).some((cell) => cell.style.foreground === 'red'))
  assert.ok(lineToCells(diff[1] as string, PROFILE).some((cell) => cell.style.foreground === 'green'))

  const multiline = snapshotRows(renderCodeLines('/* open\nstill */ const x = 1', {
    theme: THEME,
    profile: PROFILE,
    language: 'js',
  }, 80), 80)
  assert.ok(multiline[1]?.styled.some((cell) => cell.startsWith('s:fg=ansi16:8')), 'block comment state crosses lines')
  assert.ok(multiline[1]?.styled.some((cell) => cell.startsWith('c:fg=ansi16:6') && cell.includes('bold')), 'lexer resumes')
})

test('content code width contract (0/1/2/narrow/wide, CJK + ZWJ emoji + tabs)', () => {
  for (const width of WIDTHS) {
    const lines = renderCodeLines('\tconst 值 = "👨‍👩‍👧"\n你好世界', { theme: THEME, profile: PROFILE, language: 'ts' }, width)
    if (width === 0) assert.deepEqual(lines, [])
    else assertWidthContract(lines, width)
  }
})

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test('content diff classifies unified metadata and same-file separators', () => {
  assert.equal(classifyDiffLine('diff --git a/x b/x'), 'header')
  assert.equal(classifyDiffLine('index 123..456 100644'), 'header')
  assert.equal(classifyDiffLine('--- a/x'), 'header')
  assert.equal(classifyDiffLine('+++ b/x'), 'header')
  assert.equal(classifyDiffLine('@@ -1,2 +1,3 @@'), 'hunk')
  assert.equal(classifyDiffLine('⋯'), 'separator')
  assert.equal(classifyDiffLine('+added'), 'add')
  assert.equal(classifyDiffLine('-removed'), 'del')
  assert.equal(classifyDiffLine(' same'), 'context')
  assert.equal(classifyDiffLine('\\ No newline at end of file'), 'marker')
})

test('content diff width: roles, clipping, and optional line-number gutter', () => {
  const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' ctx', '-old 超宽超宽超宽超宽超宽', '+new', '+new2'].join('\n')
  const lines = renderDiffLines(diff, { theme: THEME, profile: PROFILE }, 16)
  const texts = visibleAll(lines)
  assert.deepEqual(texts.map((text) => text.trimEnd()).slice(0, 3), ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@'].map((text) => text.slice(0, 16)))
  assert.ok(lineToCells(lines[0] as string, PROFILE).some((cell) => cell.style.foreground === 'bright-black'))
  assert.ok(lineToCells(lines[2] as string, PROFILE).some((cell) => cell.style.foreground === 'cyan'))
  assert.ok(lineToCells(lines[4] as string, PROFILE).some((cell) => cell.style.foreground === 'red'))
  assert.ok(lineToCells(lines[5] as string, PROFILE).some((cell) => cell.style.foreground === 'green'))
  assertWidthContract(lines, 16)

  const numbered = renderDiffLines(diff, { theme: THEME, profile: PROFILE, lineNumbers: true }, 24)
  const numberedTexts = visibleAll(numbered)
  assert.ok(numberedTexts[3]?.startsWith(' 1  ctx'))
  assert.ok(numberedTexts[4]?.startsWith('   -old'), 'deletion gutter blank')
  assert.ok(numberedTexts[5]?.startsWith(' 2 +new'))
  assert.ok(numberedTexts[6]?.startsWith(' 3 +new2'))
  assertWidthContract(numbered, 24)
})

test('content diff pairs +/- blocks and highlights only changed tokens', () => {
  const rows = snapshotRows(renderDiffLines('-const oldName = 1\n+const newName = 1', {
    theme: THEME,
    profile: PROFILE,
    layout: 'unified',
  }, 80), 80)
  assert.deepEqual(rows.map((row) => row.text), ['-const oldName = 1', '+const newName = 1'])
  assert.ok(rows[0]?.styled.some((cell) => cell.startsWith('o:') && cell.includes('inverse')), 'old token changed')
  assert.ok(rows[1]?.styled.some((cell) => cell.startsWith('n:') && cell.includes('inverse')), 'new token changed')
  assert.ok(rows[0]?.styled.some((cell) => cell.startsWith('c:') && !cell.includes('inverse')), 'shared token unchanged')
})

test('content diff uses split panes at 110 columns and unified rows below it', () => {
  const diff = '-old value\n+new value'
  const narrow = renderDiffLines(diff, { theme: THEME, profile: PROFILE }, SIDE_BY_SIDE_MIN_WIDTH - 1)
  assert.equal(narrow.length, 2)
  assert.ok(!visibleAll(narrow).some((line) => line.includes('│')))

  const split = renderDiffLines(diff, { theme: THEME, profile: PROFILE }, SIDE_BY_SIDE_MIN_WIDTH)
  assert.equal(split.length, 1, 'paired source lines share one terminal row')
  assert.ok(visible(split[0] as string).includes('│'))
  assert.ok(visible(split[0] as string).startsWith('- old value'))
  assertWidthContract(split, SIDE_BY_SIDE_MIN_WIDTH)

  const forcedUnified = renderDiffLines(diff, { theme: THEME, profile: PROFILE, layout: 'unified' }, 120)
  assert.equal(forcedUnified.length, 2)
})

test('content diff width contract (0/1/2/narrow/wide, CJK + emoji + hostile bytes)', () => {
  const diff = ['@@ -0,0 +1,2 @@', '-旧值 👨‍👩‍👧 很长的删除行很长的删除行', '+新值 👨‍👩‍👧 很长的增加行很长的增加行', '\\ No newline at end of file', '-删除 \x1b[2K 带恶意字节'].join('\n')
  for (const width of WIDTHS) {
    const lines = renderDiffLines(diff, { theme: THEME, profile: PROFILE }, width)
    if (width === 0) assert.deepEqual(lines, [])
    else {
      assertWidthContract(lines, width)
      for (const line of lines) assert.ok(!line.includes('\x1b[2K'), 'hostile CSI stripped')
    }
  }
})

test('content diff canonical grid preserves line tones and changed-word attrs', () => {
  const diff = ['@@ -1 +1,2 @@', '-old', '+new'].join('\n')
  const rows = snapshotRows(renderDiffLines(diff, { theme: THEME, profile: PROFILE }, 20), 20)
  assert.deepEqual(rows.map((row) => row.text), ['@@ -1 +1,2 @@', '-old', '+new'])
  assert.ok(rows[0]?.styled.every((cell) => cell.includes('fg=ansi16:6')), 'hunk cyan')
  assert.ok(rows[1]?.styled.every((cell) => cell.includes('fg=ansi16:1')), 'deletion red')
  assert.ok(rows[2]?.styled.every((cell) => cell.includes('fg=ansi16:2')), 'addition green')
  assert.ok(rows[1]?.styled.some((cell) => cell.includes('inverse')), 'changed deletion emphasized')
  assert.ok(rows[2]?.styled.some((cell) => cell.includes('inverse')), 'changed addition emphasized')
})

test('content markdown: canonical grid carries the OSC 8 hyperlink on link cells', () => {
  const rows = snapshotRows(renderMarkdownLines('[docs](https://example.com) end', { theme: THEME, profile: PROFILE }, 40), 40)
  assert.equal(rows[0]?.text, 'docs end')
  assert.deepEqual(rows[0]?.links, ['https://example.com'])
  const linkCells = rows[0]?.styled.filter((s) => s.includes('underline')) ?? []
  assert.equal(linkCells.length, 4, 'docs is underlined')
  assert.ok(linkCells.every((s) => s.includes('fg=ansi16:6')), 'link role foreground')
})
