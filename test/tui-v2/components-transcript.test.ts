/**
 * tui-v2 WP-04b transcript component tests: user/assistant/tool rows.
 * Every component gets the CI-guard contract matrix: width ∈ {0,1,2,5,40}
 * with ASCII + CJK + emoji payloads, and all emitted lines measured through
 * the §6.1 pipeline must fit the width (rule 5).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createUserMessage, USER_POINTER } from '../../src/tui-v2/components/transcript/user-message.js'
import { createAssistantMessage, ASSISTANT_BULLET } from '../../src/tui-v2/components/transcript/assistant-message.js'
import { createToolRow, formatToolDuration } from '../../src/tui-v2/components/transcript/tool-row.js'
import type { TranscriptRowView } from '../../src/tui-v2/components/transcript/row-view.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import { measureLineWidth, lineToCells } from '../../src/tui-v2/renderer/lines.js'
import type { RowBlock } from '../../src/tui-v2/model/projections.js'
import type { ToolLifecycleSnapshot } from '../../src/tui-v2/model/schema.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'

const PROFILE = getProfile('unicode-ambiguous-narrow')
const WIDE = getProfile('unicode-ambiguous-wide')

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

/** Strip ANSI for text assertions. */
function visible(line: string): string {
  return lineToCells(line, PROFILE)
    .filter((c) => c.width > 0)
    .map((c) => c.grapheme)
    .join('')
}

function assertWidthContract(lines: readonly string[], width: number, profile = PROFILE): void {
  for (const line of lines) {
    assert.ok(
      measureLineWidth(line, profile) <= width,
      `line exceeds width ${width}: ${JSON.stringify(line)}`,
    )
  }
}

const WIDTHS = [0, 1, 2, 5, 40] as const

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

test('components: user message width contract (0/1/2/5/40, CJK + emoji)', () => {
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

test('components: assistant width contract (0/1/2/5/40, CJK + emoji)', () => {
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

test('components: tool row running state: ● accent glyph, no body', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Bash(ls -la)' }], { tool: tool('running'), streaming: true }),
    PROFILE,
  )
  const lines = component.render(40)
  assert.equal(lines.length, 1)
  assert.ok(visible(lines[0] as string).startsWith('● Bash(ls -la)'))
  assert.ok((lines[0] as string).includes('\x1b['), 'glyph styled')
})

test('components: tool row result state shows duration and guttered body', () => {
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
  assert.ok(visible(lines[0] as string).includes('(1.2 s)'), 'duration suffix')
  const body = lines.slice(1)
  assert.equal(body.length, 4, '3 shown + fold hint')
  assert.ok(visible(body[0] as string).startsWith(' ⎿ line1'))
  assert.ok(visible(body[3] as string).includes('… +2 lines'))
})

test('components: tool row error state renders ✗ and the error message', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Bash(false)' }], {
      tool: tool('error', { error: { code: 'exit-1', message: 'command failed', recoverable: true } }),
    }),
    PROFILE,
  )
  const lines = component.render(40)
  assert.ok(visible(lines[0] as string).startsWith('✗'))
  assert.ok(lines.slice(1).some((line) => visible(line).includes('command failed')))
})

test('components: tool duration formatting', () => {
  assert.equal(formatToolDuration(12), '12 ms')
  assert.equal(formatToolDuration(1234), '1.2 s')
  assert.equal(formatToolDuration(65_000), '1 m 5 s')
  assert.equal(formatToolDuration(120_000), '2 m')
})

test('components: tool row width contract (0/1/2/5/40, CJK tool output)', () => {
  const component = createToolRow(
    view([{ type: 'text', text: 'Bash(echo 你好)' }], {
      tool: tool('result', { durationMs: 5, resultView: { card: 'terminal', output: '你好世界 👋' } as never }),
    }),
    PROFILE,
  )
  for (const width of WIDTHS) {
    const lines = component.render(width)
    if (width === 0) assert.deepEqual(lines, [])
    else assertWidthContract(lines, width)
  }
})
