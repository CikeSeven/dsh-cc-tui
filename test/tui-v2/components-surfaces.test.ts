/** WP-08e1 surface component contracts and width matrix. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createGoalTodoComponent } from '../../src/tui-v2/components/panes/goal-todo.js'
import { createContextPanel } from '../../src/tui-v2/components/panes/context-panel.js'
import { createActivityLine } from '../../src/tui-v2/components/chrome/activity-line.js'
import { createContextBar } from '../../src/tui-v2/components/chrome/context-bar.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { measureLineWidth } from '../../src/tui-v2/renderer/lines.js'
import type { ActivityView, ContextBarView, GoalTodoView, LoadedContextView } from '../../src/tui-v2/model/surfaces.js'

const PROFILE = getProfile('unicode-ambiguous-narrow')
const WIDTHS = [0, 1, 2, 5, 20, 80, 140]

function assertWidths(lines: readonly string[], width: number): void {
  for (const line of lines) assert.ok(measureLineWidth(line, PROFILE) <= width, `${width}: ${JSON.stringify(line)}`)
}

const goalTodo: GoalTodoView = {
  goal: {
    id: 'g1', revision: 2, objective: 'Ship 版本 🚀\x1b[2K', phase: 'blocked', maxGoalRounds: 5, roundsStarted: 2,
    blockedReason: { code: 'WAIT', message: '等待外部审批 \x1b]52;c;bad\x07' },
  },
  todos: [
    { content: '完成 CJK 检查 👨‍👩‍👧', status: 'completed' },
    { content: '修复宽度边界', status: 'in_progress' },
    { content: '补充 trace', status: 'pending' },
  ],
  hiddenTodos: 4,
}

const context: LoadedContextView = {
  available: true,
  loading: false,
  sections: [{ name: 'system:identity', text: '系统内容 你好😀 '.repeat(30) }],
  contexts: [{ name: 'runtime:cwd', text: '/workspace/project' }],
  files: [{ displayPath: './AGENTS.md' }],
  skills: [{ name: 'review', description: '检查代码' }],
  tools: [{ name: 'bash', description: 'run commands' }],
  summary: 'sections 1 · runtime 1 · files 1 · skills 1 · tools 1',
}

const activity: ActivityView = {
  phase: 'thinking', line: '正在分析配置 你好😀', preset: 'claude', frame: '✻', frameIndex: 2, intervalMs: 150,
  updatedAt: 0,
}

const bar: ContextBarView = {
  contextSegments: { system: 300, prompt: 400, assistant: 500, thinking: 200, tools: 100 },
  contextWindow: 2_000,
  usage: { input: 700, cacheRead: 100, cacheWrite: 20 },
}

test('surface components: goal/todo phase, blocked reason, status glyph and overflow', () => {
  const component = createGoalTodoComponent(goalTodo, PROFILE)
  const lines = component.render(80)
  assert.ok(lines.some((line) => line.includes('blocked')))
  assert.ok(lines.some((line) => line.includes('修复宽度边界')))
  assert.ok(lines.some((line) => line.includes('4 more')))
  for (const width of WIDTHS) assertWidths(component.render(width), width)
})

test('surface components: activity has deterministic frame and no component timer', () => {
  const component = createActivityLine(activity, PROFILE)
  assert.ok(component)
  assert.ok(component!.render(80)[0]?.includes('✻'))
  assertWidths(component!.render(80), 80)
  assert.deepEqual(component!.render(0), [])
})

test('surface components: context bar percentages and grouped panel are width-safe', () => {
  const barComponent = createContextBar(bar, PROFILE)
  assert.ok(barComponent.render(80)[0]?.includes('sys'))
  assert.ok(barComponent.render(80)[0]?.includes('ctx'))
  for (const width of WIDTHS) assertWidths(barComponent.render(width), width)

  const panel = createContextPanel(context, PROFILE, true)
  const panelLines = panel.render(80)
  assert.ok(panelLines.some((line) => line.includes('sections')))
  assert.ok(panelLines.some((line) => line.includes('AGENTS')))
  for (const width of WIDTHS) assertWidths(panel.render(width), width)
})
