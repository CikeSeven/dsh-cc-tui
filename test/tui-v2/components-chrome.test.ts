/**
 * tui-v2 WP-04b chrome component tests: status line (model/tokens/cwd/branch)
 * and spinner (injected-clock frame advancement). Width contract matrix
 * included per CI guard rule 5.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createStatusLine, formatTokenCount } from '../../src/tui-v2/components/chrome/status-line.js'
import { createSpinner, DEFAULT_SPINNER_FRAMES } from '../../src/tui-v2/components/chrome/spinner.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import type { StatusLineView } from '../../src/tui-v2/model/selectors.js'
import type { Clock } from '../../src/tui-v2/model/schema.js'
import { lineToCells, measureLineWidth } from '../../src/tui-v2/renderer/lines.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'

const PROFILE = getProfile('unicode-ambiguous-narrow')

class FakeClock implements Clock {
  time = 0
  private nextId = 1
  private timers = new Map<number, { at: number; cb: () => void }>()
  now(): number {
    return this.time
  }
  setTimeout(cb: () => void, delayMs: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + delayMs, cb })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }
  get pendingCount(): number {
    return this.timers.size
  }
  advance(ms: number): void {
    this.time += ms
    for (;;) {
      let due: { id: number; at: number; cb: () => void } | null = null
      for (const [id, t] of this.timers) {
        if (t.at <= this.time && (due === null || t.at < due.at)) due = { id, ...t }
      }
      if (due === null) break
      this.timers.delete(due.id)
      due.cb()
    }
  }
}

function visible(line: string): string {
  return lineToCells(line, PROFILE)
    .filter((c) => c.width > 0)
    .map((c) => c.grapheme)
    .join('')
}

const statusView = (overrides: Partial<StatusLineView> = {}): StatusLineView => ({
  model: null,
  tokens: null,
  cwd: null,
  branch: null,
  mode: null,
  extras: {},
  ...overrides,
})

// ---------------------------------------------------------------------------
// status line
// ---------------------------------------------------------------------------

test('components/chrome: status line renders model · tokens · branch · cwd', () => {
  const component = createStatusLine(
    statusView({
      model: 'deepseek-v4',
      tokens: { input: 12_345, output: 678 },
      branch: 'main',
      cwd: '/home/user/project',
    }),
    { profile: PROFILE, theme: DEFAULT_COMPONENT_THEME },
  )
  const [line] = component.render(80)
  const text = visible(line as string)
  assert.ok(text.includes('deepseek-v4'))
  assert.ok(text.includes('⬆12.3k ⬇678'))
  assert.ok(text.includes('main'))
  assert.ok(text.includes('project'), 'cwd basename')
  // Right-aligned: branch/cwd sit at the right margin.
  assert.ok(measureLineWidth(line as string, PROFILE) <= 80)
  assert.ok((line as string).endsWith('project') || text.endsWith('project'))
})

test('components/chrome: status line truncates instead of overflowing', () => {
  const component = createStatusLine(
    statusView({ model: 'a-very-long-model-name', cwd: '/deeply/nested/long/path/here', branch: 'feature/very-long-branch' }),
    { profile: PROFILE, theme: DEFAULT_COMPONENT_THEME },
  )
  for (const width of [0, 1, 2, 5, 17]) {
    const lines = component.render(width)
    if (width === 0) {
      assert.deepEqual(lines, [])
      continue
    }
    assert.equal(lines.length, 1)
    assert.ok(measureLineWidth(lines[0] as string, PROFILE) <= width)
  }
})

test('components/chrome: status extras join the left group', () => {
  const component = createStatusLine(statusView({ extras: { tps: 42 } }), {
    profile: PROFILE,
    theme: DEFAULT_COMPONENT_THEME,
  })
  const [line] = component.render(40)
  assert.ok(visible(line as string).includes('tps 42'))
})

test('components/chrome: formatTokenCount formats k/M', () => {
  assert.equal(formatTokenCount(0), '0')
  assert.equal(formatTokenCount(999), '999')
  assert.equal(formatTokenCount(1234), '1.2k')
  assert.equal(formatTokenCount(2_500_000), '2.5M')
})

// ---------------------------------------------------------------------------
// spinner
// ---------------------------------------------------------------------------

test('components/chrome: spinner advances frames via the injected clock', () => {
  const clock = new FakeClock()
  const framesSeen: number[] = []
  const spinner = createSpinner({
    profile: PROFILE,
    clock,
    intervalMs: 80,
    onFrame: (index) => framesSeen.push(index),
  })
  assert.equal(spinner.running, false)
  spinner.start()
  assert.equal(spinner.running, true)
  assert.equal(clock.pendingCount, 1)
  clock.advance(80)
  assert.equal(spinner.frameIndex, 1)
  clock.advance(80)
  clock.advance(80)
  assert.equal(spinner.frameIndex, 3)
  assert.deepEqual(framesSeen, [1, 2, 3])
  spinner.stop()
  assert.equal(clock.pendingCount, 0, 'timer released on stop')
  clock.advance(1000)
  assert.equal(spinner.frameIndex, 3, 'no advance after stop')
})

test('components/chrome: spinner render is a single width-safe line', () => {
  const clock = new FakeClock()
  const spinner = createSpinner({ profile: PROFILE, clock })
  for (const width of [0, 1, 2, 5]) {
    const lines = spinner.render(width)
    if (width === 0) {
      assert.deepEqual(lines, [])
      continue
    }
    assert.equal(lines.length, 1)
    assert.ok(measureLineWidth(lines[0] as string, PROFILE) <= width)
  }
  clock.advance(0) // nothing scheduled: start() was never called
  assert.equal(spinner.frameIndex, 0)
  assert.equal(DEFAULT_SPINNER_FRAMES[0], '·')
})
