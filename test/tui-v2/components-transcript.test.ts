/**
 * tui-v2 transcript component contracts. WP-08b tool cards are exercised at
 * width {0,1,2,5,40,120} with immutable verbose/expanded/footnote views.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createUserMessage, USER_POINTER } from '../../src/tui-v2/components/transcript/user-message.js'
import { createAssistantMessage, ASSISTANT_BULLET } from '../../src/tui-v2/components/transcript/assistant-message.js'
import {
  createToolRow,
  formatToolDuration,
  synthesizeUnifiedDiff,
} from '../../src/tui-v2/components/transcript/tool-row.js'
import type { TranscriptRowView } from '../../src/tui-v2/components/transcript/row-view.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import { measureLineWidth, lineToCells } from '../../src/tui-v2/renderer/lines.js'
import type { RowBlock } from '../../src/tui-v2/model/projections.js'
import type { ToolLifecycleSnapshot } from '../../src/tui-v2/model/schema.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'

const PROFILE = getProfile('unicode-ambiguous-narrow')
const WIDE = getProfile('unicode-ambiguous-wide')
const WIDTHS = [0, 1, 2, 5, 40, 120] as const

let n = 0
function view(blocks: readonly RowBlock[], overrides: Partial<TranscriptRowView> = {}): TranscriptRowView {
  n += 1
  return {
    rowId: `epoch:user:src:${n}`,
    revision: 1,
    blocks,
    streaming: false,
    theme: DEFAULT_COMPONENT_THEME,
    ...overrides,
  }
}

function visible(line: string): string {
  return lineToCells(line, PROFILE)
    .filter((cell) => cell.width > 0)
    .map((cell) => cell.grapheme)
    .join('')
}

function assertWidthContract(lines: readonly string[], width: number, profile = PROFILE): void {
  for (const line of lines) {
    assert.ok(measureLineWidth(line, profile) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`)
  }
}

// ---------------------------------------------------------------------------
// user message
// ---------------------------------------------------------------------------

test('components: user message renders ❯ prefix + text with hanging indent', () => {
  const component = createUserMessage(view([{ type: 'text', text: 'hello world from the user' }]), PROFILE)
  const lines = component.render(12)
  assert.ok(lines.length > 1, 'wraps')
  assert.ok(visible(lines[0] as string).startsWith(`${USER_POINTER} hello`))
  assert.ok(lines.slice(1).every((line) => visible(line).startsWith('  ')), 'hanging indent')
})

test('components: user message label block renders dim line above text', () => {
  const component = createUserMessage(
    view([
      { type: 'label', text: 'steer' },
      { type: 'text', text: 'body' },
    ]),
    PROFILE,
  )
  const lines = component.render(40)
  assert.equal(visible(lines[0] as string), 'steer')
  assert.ok(visible(lines[1] as string).includes('body'))
})

test('components: user message sanitizes hostile input before styling', () => {
  const component = createUserMessage(view([{ type: 'text', text: 'pwn\x1b[2K\x1b]52;c;Zm9v\x07ed' }]), PROFILE)
  for (const line of component.render(40)) {
    assert.ok(!line.includes('\x1b]52'), 'OSC 52 stripped')
    assert.ok(visible(line).includes('pwned'))
  }
})

test('components: user message width contract (0/1/2/narrow/wide, CJK + emoji)', () => {
  const component = createUserMessage(view([{ type: 'text', text: '你好世界 👨‍👩‍👧 tail' }]), PROFILE)
  for (const width of WIDTHS) {
    const lines = component.render(width)
    if (width === 0) assert.deepEqual(lines, [])
    else assertWidthContract(lines, width)
  }
  // ambiguous-narrow vs wide: '·' wraps differently
  const dot = createUserMessage(view([{ type: 'text', text: 'a·b·c·d·e·f' }]), WIDE)
  assertWidthContract(dot.render(4), 4, WIDE)
})

test('components: user message invalidate() drops the width cache', () => {
  const component = createUserMessage(view([{ type: 'text', text: 'cache me please, this is long enough to wrap' }]), PROFILE)
  const wide = component.render(40)
  const narrow = component.render(10)
  assert.ok(narrow.length > wide.length, 'narrow width wraps')
  component.invalidate()
  assertWidthContract(component.render(10), 10)
})

// ---------------------------------------------------------------------------
// assistant message
// ---------------------------------------------------------------------------

test('components: assistant message renders ● prefix and continuation indent', () => {
  const component = createAssistantMessage(view([{ type: 'markdown', text: 'plain answer text that wraps around' }]), PROFILE)
  const lines = component.render(14)
  assert.ok(lines.length > 1)
  assert.ok(visible(lines[0] as string).startsWith(`${ASSISTANT_BULLET} plain`))
  assert.ok(visible(lines[1] as string).startsWith('  '))
})

test('components: assistant markdown-lite handles bold/code/heading/fence', () => {
  const md = ['# Title', '', 'has **bold** and `code`', '', '```ts', 'const x = 1', '```'].join('\n')
  const component = createAssistantMessage(view([{ type: 'markdown', text: md }]), PROFILE)
  const lines = component.render(60)
  const texts = lines.map(visible)
  assert.ok(texts.some((line) => line.includes('Title') && !line.includes('#')))
  assert.ok(texts.some((line) => line.includes('bold') && line.includes('code')))
  assert.ok(texts.some((line) => line.includes('const x = 1')))
  assert.ok(!texts.some((line) => line.includes('```')), 'fence markers render nothing')
  const titleLine = lines.find((line) => visible(line).includes('Title')) as string
  assert.ok(titleLine.includes('\x1b[0;1m'), 'heading is bold')
  const codeLine = lines.find((line) => visible(line).includes('const x')) as string
  assert.ok(codeLine.includes('\x1b['), 'code line is styled')
})

test('components: assistant streaming flag keeps the same contract', () => {
  const component = createAssistantMessage(
    view([{ type: 'markdown', text: 'partial…' }], { streaming: true }),
    PROFILE,
  )
  assertWidthContract(component.render(9), 9)
})

test('components: assistant width contract (0/1/2/narrow/wide, CJK + emoji)', () => {
  const component = createAssistantMessage(view([{ type: 'markdown', text: '回复：你好世界 👍 结束' }]), PROFILE)
  for (const width of WIDTHS) {
    const lines = component.render(width)
    if (width === 0) assert.deepEqual(lines, [])
    else assertWidthContract(lines, width)
  }
})

// ---------------------------------------------------------------------------
// tool row
// ---------------------------------------------------------------------------

const tool = (phase: ToolLifecycleSnapshot['phase'], extra: Partial<ToolLifecycleSnapshot> = {}): ToolLifecycleSnapshot => ({
  phase,
  lifecycleRevision: 1,
  ...extra,
})

test('components: running tool without a preview renders a deterministic pending line', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Bash(ls -la)' }], { tool: tool('running'), streaming: true }),
    PROFILE,
  )
  const lines = component.render(40)
  assert.equal(lines.length, 2)
  assert.ok(visible(lines[0] as string).startsWith('● Bash(ls -la)'))
  assert.ok(visible(lines[1] as string).startsWith(' ⎿ Running…'))
  assert.ok((lines[0] as string).includes('\x1b['), 'glyph/background styled')
})

test('components: collapsed tool output shows duration, 3 rows, and ctrl+o fold hint', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Read /tmp/a.ts' }], {
      tool: tool('result', {
        durationMs: 1234,
        resultView: { card: 'terminal', output: 'line1\nline2\nline3\nline4\nline5' } as never,
      }),
    }),
    PROFILE,
  )
  const lines = component.render(40)
  assert.ok(visible(lines[0] as string).includes('(1.2 s)'))
  const body = lines.slice(1)
  assert.equal(body.length, 4, '3 shown + fold hint')
  assert.ok(visible(body[0] as string).startsWith(' ⎿ line1'))
  assert.ok(visible(body[3] as string).includes('… +2 lines (ctrl+o to expand)'))
})

test('components: verbose error card renders message, code, recovery, and details', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Bash(false)' }], {
      verbose: true,
      tool: tool('error', {
        durationMs: 8,
        error: {
          code: 'exit-1',
          message: 'command failed',
          recoverable: true,
          details: { exitCode: 1, stderr: '坏 👨‍👩‍👧' },
        },
      }),
    }),
    PROFILE,
  )
  const texts = component.render(80).map(visible)
  assert.ok(texts[0]?.startsWith('✗ Bash(false)'))
  assert.ok(texts.some((line) => line.includes('command failed')))
  assert.ok(texts.some((line) => line.includes('Code: exit-1')))
  assert.ok(texts.some((line) => line.includes('Recoverable: yes')))
  assert.ok(texts.some((line) => line.includes('Details: {"exitCode":1')))
})

test('components: tool duration formatting', () => {
  assert.equal(formatToolDuration(12), '12 ms')
  assert.equal(formatToolDuration(1234), '1.2 s')
  assert.equal(formatToolDuration(65_000), '1 m 5 s')
  assert.equal(formatToolDuration(120_000), '2 m')
})

test('components: tool row width contract (0/1/2/narrow/wide, CJK + ZWJ emoji)', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Bash(echo 你好 👨‍👩‍👧)' }], {
      tool: tool('result', { durationMs: 5, resultView: { card: 'terminal', output: '你好世界 👨‍👩‍👧' } as never }),
    }),
    PROFILE,
  )
  for (const width of WIDTHS) {
    const lines = component.render(width)
    if (width === 0) assert.deepEqual(lines, [])
    else assertWidthContract(lines, width)
  }
})

// ---------------------------------------------------------------------------
// complete tool cards (WP-08b)
// ---------------------------------------------------------------------------

test('components: settled diff card keeps file headers, line tones, and cell-safe gutters', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Edit /tmp/a.ts' }], {
      tool: tool('result', {
        resultView: {
          card: 'diff',
          diffs: [
            { path: 'a.ts', oldText: 'const x = 1', newText: 'const x = 2\nconst y = 3' },
            { path: 'b.ts', oldText: null, newText: 'created' },
          ],
        } as never,
      }),
    }),
    PROFILE,
  )
  const lines = component.render(40)
  const texts = lines.map(visible)
  assert.ok(texts[0]?.startsWith('● Edit /tmp/a.ts'))
  assert.ok(texts[1]?.startsWith(' ⎿ --- a/a.ts'))
  assert.ok(texts.some((text) => text.includes('+++ b/b.ts')))
  const del = lines.find((line) => visible(line).includes('- const x = 1')) as string
  const add = lines.find((line) => visible(line).includes('+ const x = 2')) as string
  assert.ok(lineToCells(del, PROFILE).some((cell) => cell.style.foreground === 'red'))
  assert.ok(lineToCells(add, PROFILE).some((cell) => cell.style.foreground === 'green'))
  assert.ok(visible(del).startsWith('   '))
  assert.ok(texts.some((text) => text.includes('+ created')))
  assert.ok(!texts.some((text) => text.includes('- created')))
})

test('components: running edit previews callView and switches to split panes when wide', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Edit src/a.ts' }], {
      streaming: true,
      tool: tool('running', {
        callView: {
          card: 'diff',
          title: 'Edit src/a.ts',
          diffs: [{ path: 'src/a.ts', oldText: 'const oldName = 1', newText: 'const newName = 1' }],
        } as never,
      }),
    }),
    PROFILE,
  )
  const narrow = component.render(60).map(visible)
  assert.ok(narrow.some((line) => line.includes('- const oldName')))
  assert.ok(narrow.some((line) => line.includes('+ const newName')))
  assert.ok(!narrow.some((line) => line.includes('Running…')))

  const wide = component.render(120)
  assert.ok(wide.slice(1).some((line) => visible(line).includes('│')), 'wide pending diff is side-by-side')
  assertWidthContract(wide, 120)
})

test('components: synthesized same-file hunks use the ⋯ separator', () => {
  const diff = synthesizeUnifiedDiff([
    { path: 'a.ts', oldText: 'old one', newText: 'new one' },
    { path: 'a.ts', oldText: 'old two', newText: 'new two' },
  ])
  assert.ok(diff.includes('\n⋯\n'))
  assert.ok(!diff.includes('\n@@\n'))
})

test('components: collapsed diff body caps at 8 physical rows with a fold hint', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Edit big.ts' }], {
      tool: tool('result', {
        resultView: {
          card: 'diff',
          diffs: [{ path: 'big.ts', oldText: 'a\nb\nc\nd\ne', newText: '1\n2\n3\n4\n5\n6\n7' }],
        } as never,
      }),
    }),
    PROFILE,
  )
  const lines = component.render(40)
  assert.equal(lines.length, 1 + 8 + 1)
  assert.ok(visible(lines[lines.length - 1] as string).includes('… +4 lines (ctrl+o to expand)'))
})

test('components: verbose uncaps long output; a single overflow row is shown directly', () => {
  const resultView = { card: 'terminal', output: 'one\ntwo\nthree\nfour\nfive' } as never
  const verbose = createToolRow(
    view([{ type: 'text', text: 'Bash(long)' }], { verbose: true, tool: tool('result', { resultView }) }),
    PROFILE,
  ).render(60)
  assert.equal(verbose.length, 1 + 5)
  assert.ok(!verbose.some((line) => visible(line).includes('ctrl+o')))

  const oneExtra = createToolRow(
    view([{ type: 'text', text: 'Bash(four)' }], {
      tool: tool('result', { resultView: { card: 'terminal', output: 'one\ntwo\nthree\nfour' } as never }),
    }),
    PROFILE,
  ).render(60)
  assert.equal(oneExtra.length, 1 + 4)
  assert.ok(!oneExtra.some((line) => visible(line).includes('ctrl+o')))
})

test('components: result falls back to callView and terminal status lines remain errors', () => {
  const callFallback = createToolRow(
    view([{ type: 'text', text: 'Bash(npm test)' }], {
      tool: tool('result', { callView: { card: 'terminal', title: 'npm test', output: 'ok\nok2' } as never }),
    }),
    PROFILE,
  ).render(40)
  assert.ok(callFallback.slice(1).some((line) => visible(line).includes('ok2')))

  const terminal = createToolRow(
    view([{ type: 'text', text: 'Bash(make)' }], {
      verbose: true,
      tool: tool('result', {
        resultView: { card: 'terminal', output: 'boom', exitCode: 2, signal: 'SIGKILL' } as never,
      }),
    }),
    PROFILE,
  ).render(60).map(visible)
  assert.ok(terminal.some((line) => line.includes('Exit code 2')))
  assert.ok(terminal.some((line) => line.includes('Killed by signal SIGKILL')))
})

test('components: card title fallback and structured search output remain available', () => {
  const title = createToolRow(
    view([], { tool: tool('result', { resultView: { card: 'generic', title: 'WebSearch: dsh tui' } as never }) }),
    PROFILE,
  ).render(60)
  assert.ok(visible(title[0] as string).startsWith('● WebSearch: dsh tui'))

  const search = createToolRow(
    view([{ type: 'text', text: 'Grep(foo)' }], {
      tool: tool('result', {
        resultView: {
          card: 'search',
          shape: 'matches',
          files: [{ path: 'src/a.ts', matches: [{ lineNumber: 12, line: 'const foo = 1' }] }],
          truncated: true,
          total: 42,
        } as never,
      }),
    }),
    PROFILE,
  ).render(60).map(visible)
  assert.ok(search.some((line) => line.includes('src/a.ts')))
  assert.ok(search.some((line) => line.includes('12: const foo = 1')))
  assert.ok(search.some((line) => line.includes('… (42 total)')))
})

test('components: expanded background fills every row and footnote stays outside the cap', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Bash(long)' }], {
      expanded: true,
      footnote: 'Open trajectory for recovery',
      tool: tool('result', {
        resultView: { card: 'terminal', output: 'one\ntwo\nthree\nfour\nfive' } as never,
      }),
    }),
    PROFILE,
  )
  const first = component.render(40)
  const second = component.render(40)
  assert.strictEqual(second, first, 'same width returns the immutable cached lines')
  assert.ok(visible(first[first.length - 1] as string).includes('Open trajectory for recovery'))
  for (const line of first) {
    assert.equal(measureLineWidth(line, PROFILE), 40, 'background row is padded to viewport')
    const cells = lineToCells(line, PROFILE).filter((cell) => cell.width > 0)
    assert.ok(cells.every((cell) => cell.style.background === 'ansi256:238'))
  }
  component.invalidate()
  assert.notStrictEqual(component.render(40), first, 'invalidate drops the component cache')
})

test('components: tool diff width contract (0/1/2/narrow/wide, CJK + emoji)', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Edit 配置.ts 👨‍👩‍👧' }], {
      tool: tool('result', {
        resultView: {
          card: 'diff',
          diffs: [{ path: '配置.ts', oldText: '旧值 👨‍👩‍👧 = 1', newText: '新值 👨‍👩‍👧 = 2 // 非常非常长的注释' }],
        } as never,
      }),
    }),
    PROFILE,
  )
  for (const width of WIDTHS) {
    const lines = component.render(width)
    if (width === 0) assert.deepEqual(lines, [])
    else assertWidthContract(lines, width)
  }
})
