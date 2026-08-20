/** WP-08e1 trajectory pure line component width/security matrix. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTrajectoryScene } from '../../src/tui-v2/components/trajectory/scene.js'
import { createTrajectoryLedger } from '../../src/tui-v2/components/trajectory/ledger.js'
import { createTrajectoryWave } from '../../src/tui-v2/components/trajectory/wave-band.js'
import { createTrajectoryHotspot } from '../../src/tui-v2/components/trajectory/hotspot.js'
import { createTrajectoryInspector } from '../../src/tui-v2/components/trajectory/inspector.js'
import { measureLineWidth } from '../../src/tui-v2/renderer/lines.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import type { TrajectoryViewModel } from '../../src/tui-v2/model/surfaces.js'

const PROFILE = getProfile('unicode-ambiguous-narrow')
const WIDTHS = [0, 1, 2, 5, 20, 80, 140]

function view(): TrajectoryViewModel {
  return {
    sceneId: 'trajectory', revision: 1, sessionEpoch: 'session-1', status: 'ready', view: 'timeline', projection: 'compressed', sort: 'duration', query: '',
    totalRows: 2, cursor: 1, windowStart: 0, windowEnd: 2,
    rows: [
      { seq: 1, time: 1, kind: 'turn', turn: 1, label: 'turn 1', durationMs: 12, status: 'ok' },
      { seq: 2, time: 2, kind: 'tool', turn: 1, label: 'bash 你好😀', detail: 'arg\x1b[2K\x1b]52;c;evil\x07', outcome: 'done 👨‍👩‍👧', durationMs: 150, status: 'error', tokens: { input: 1, output: 2, think: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
    wave: [
      { weight: 12, count: 1, input: 0, model: 12, tool: 0, error: false, retry: false, running: false, firstIndex: 0 },
      { weight: 150, count: 1, input: 0, model: 0, tool: 150, error: true, retry: false, running: false, firstIndex: 1 },
    ],
    matchedWaveColumns: [],
    hotspots: [{ label: 'bash 你好😀', totalMs: 150, count: 1, tokens: 2, error: true, firstIndex: 1 }],
    hotspotTotal: 1,
    inspector: { status: 'ready', seq: 2, title: 'bash 你好😀', facts: ['turn 1'], sections: [{ title: 'output', body: '结果 👨‍👩‍👧\x1b[2J' }] },
    totals: { turns: 1, steps: 1, rows: 2, calls: 1, errors: 1, retries: 0, spanMs: 150, toolMs: 150, decodeMs: 0, ttftMs: 0, ttftSamples: 0, retryMs: 0, tokens: { input: 1, output: 2, think: 0, cacheRead: 0, cacheWrite: 0 } },
  }
}

function assertContract(lines: readonly string[], width: number): void {
  if (width === 0) assert.deepEqual(lines, [])
  for (const line of lines) {
    assert.ok(measureLineWidth(line, PROFILE) <= width)
    assert.ok(!line.includes('\x1b]52'), 'hostile OSC52 does not survive')
    assert.ok(!line.includes('\x1b[2J'), 'hostile erase does not survive')
  }
}

test('trajectory components: ledger/wave/hotspot/inspector and scene width contracts', () => {
  const model = view()
  const factories = [
    () => createTrajectoryLedger(model, PROFILE),
    () => createTrajectoryWave(model, PROFILE),
    () => createTrajectoryHotspot({ ...model, view: 'hotspot' }, PROFILE),
    () => createTrajectoryInspector(model, PROFILE),
    () => createTrajectoryScene(model, PROFILE),
  ]
  for (const factory of factories) for (const width of WIDTHS) assertContract(factory().render(width), width)
})

test('trajectory components: loading/empty/error/cancel states are explicit', () => {
  for (const status of ['loading', 'empty', 'error', 'cancelled'] as const) {
    const lines = createTrajectoryLedger({ ...view(), status, rows: [], error: status === 'error' ? 'boom' : undefined }, PROFILE).render(40)
    assert.equal(lines.length > 0, true)
    assertContract(lines, 40)
  }
})
