/** WP-08c pure overlay components: payload-only, hostile text and width bounds. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderDialogOverlayLines } from '../../src/tui-v2/components/overlays/render-dialog.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import type { InteractiveOverlayPayload } from '../../src/tui-v2/model/interactive-overlay-payloads.js'
import type { DialogOverlayPayload } from '../../src/tui-v2/model/overlay-payloads.js'
import { measureLineWidth } from '../../src/tui-v2/renderer/lines.js'
import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js'

const profile = unknownConservativeDefaults()
const theme = DEFAULT_COMPONENT_THEME
const hostile = '\x1b]8;;https://evil.invalid\x07控制😀e\u0301\x1b[31m red\nnext'

const selection = {
  focusIndex: 0,
  checked: [] as number[],
  text: `输入 ${hostile}`,
  cursor: 2,
  filter: '控😀',
  filterCursor: 2,
  windowStart: 0,
  windowEnd: 2,
  contentOffset: 0,
}

const list = {
  query: '控😀',
  cursor: 2,
  activeIndex: 0,
  windowStart: 0,
  windowEnd: 2,
  items: [
    { id: 'one', label: hostile, description: '第一项 😀', keywords: ['red'] },
    { id: 'two', label: 'disabled', disabled: true, disabledReason: hostile },
  ],
  sourceCount: 2,
  emptyMessage: 'empty',
  noResultsMessage: 'none',
  hint: '↑/↓ · Enter · Esc',
}

const payloads: readonly (DialogOverlayPayload | InteractiveOverlayPayload)[] = [
  {
    kind: 'approval',
    key: 'approval',
    toolName: hostile,
    command: `printf '${hostile}'`,
    reason: hostile,
    contentWindowRows: 3,
    status: 'ready',
    selection,
  },
  {
    kind: 'question',
    key: 'question',
    questionId: 'q',
    question: hostile,
    detail: `# 计划\n\n${hostile}`,
    options: [
      { id: 'yes', label: '批准😀', description: hostile },
      { id: 'no', label: '修改', disabled: true, disabledReason: hostile },
    ],
    multiSelect: true,
    position: 2,
    total: 3,
    answered: 1,
    answeredSummary: [hostile],
    optionWindowRows: 4,
    selection: { ...selection, checked: [0] },
  },
  {
    kind: 'question',
    key: 'plan',
    questionId: 'plan',
    question: 'Review this plan?',
    detail: `- ${hostile}\n- second`,
    options: [{ id: 'approve', label: 'approve' }, { id: 'revise', label: 'revise' }],
    multiSelect: false,
    intent: { kind: 'plan-review', approve: 'approve' },
    position: 1,
    total: 1,
    answered: 0,
    selection,
  },
  {
    kind: 'plugin-dialog',
    dialogKind: 'select',
    key: 'plugin-select',
    title: hostile,
    options: [
      { id: 'one', label: hostile, description: '详情😀' },
      { id: 'two', label: 'two', disabled: true, disabledReason: hostile },
    ],
    totalOptions: 2,
    initial: '',
    selection,
  },
  {
    kind: 'plugin-dialog',
    dialogKind: 'input',
    key: 'plugin-input',
    title: hostile,
    placeholder: hostile,
    initial: '',
    selection,
  },
  { kind: 'picker-dialog', key: 'picker', title: hostile, subtitle: hostile, list },
  {
    kind: 'help-dialog',
    key: 'help',
    title: hostile,
    shortcuts: [{ keys: 'Ctrl+😀', label: hostile }],
    list,
  },
  {
    kind: 'history-search-dialog',
    key: 'history',
    title: hostile,
    placeholder: hostile,
    list,
  },
  {
    kind: 'transcript-search-dialog',
    key: 'search',
    title: hostile,
    query: '控制😀',
    cursor: 3,
    current: 1,
    total: 2,
    noResultsMessage: hostile,
    hint: hostile,
  },
]

for (const width of [0, 1, 2, 8, 20, 80]) {
  test(`overlay components: every payload is cell-safe at width ${width}`, () => {
    for (const payload of payloads) {
      const lines = renderDialogOverlayLines(payload, width, { profile, theme })
      if (width === 0) {
        assert.deepEqual(lines, [])
        continue
      }
      assert.ok(lines.length > 0, `${payload.kind} rendered`)
      for (const line of lines) {
        assert.ok(
          measureLineWidth(line, profile) <= width,
          `${payload.kind} exceeds ${width}: ${JSON.stringify(line)}`,
        )
        assert.ok(!line.includes('\x1b]'), 'untrusted OSC is not replayed')
      }
    }
  })
}

test('overlay bridge rejects malformed and foreign payloads', () => {
  assert.deepEqual(renderDialogOverlayLines({ kind: 'picker-dialog' }, 80, { profile, theme }), [])
  assert.deepEqual(renderDialogOverlayLines({ kind: 'session-browser' }, 80, { profile, theme }), [])
})
