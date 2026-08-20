/** WP-08c visible-frame transcript search highlight producer. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildFrame } from '../../src/tui-v2/renderer/frame-builder.js'
import type { TerminalModeSnapshot } from '../../src/tui-v2/renderer/frame.js'
import { lineStyle } from '../../src/tui-v2/renderer/lines.js'
import { buildSearchHighlightRegions } from '../../src/tui-v2/renderer/search-highlights.js'
import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js'

const profile = unknownConservativeDefaults()
const modes: TerminalModeSnapshot = {
  alternateScreen: true,
  rawInput: true,
  mouse: 'off',
  bracketedPaste: false,
  syncOutput: false,
  autowrap: true,
  wrapPending: false,
  scrollRegion: { top: 0, bottom: 3 },
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
const match = lineStyle({ background: 'yellow' })
const current = lineStyle({ background: 'cyan', bold: true })

function frame(lines: readonly string[]) {
  return buildFrame({
    frameId: 'search-base',
    stateRevision: 1,
    width: 20,
    height: 4,
    lines,
    profile: { ...profile, columns: 20, rows: 4 },
    modes,
    generation: 0,
  })
}

test('search highlights: finds case-insensitive occurrences and marks current', () => {
  const regions = buildSearchHighlightRegions(frame(['Foo foo', 'nothing']), 'foo', 1, { match, current })
  assert.deepEqual(regions.map(({ x, y, width }) => ({ x, y, width })), [
    { x: 0, y: 0, width: 3 },
    { x: 4, y: 0, width: 3 },
  ])
  assert.deepEqual(regions[0]?.style, match)
  assert.deepEqual(regions[1]?.style, current)
})

test('search highlights: wide graphemes cover both cells and matches never cross rows', () => {
  const base = frame(['a你好b', '你', '好'])
  const regions = buildSearchHighlightRegions(base, '你好', 0, { match, current })
  assert.equal(regions.length, 1)
  assert.deepEqual(
    { x: regions[0]?.x, y: regions[0]?.y, width: regions[0]?.width },
    { x: 1, y: 0, width: 4 },
  )
})

test('search highlights: empty query is a no-op and current clamps safely', () => {
  const base = frame(['one one'])
  assert.deepEqual(buildSearchHighlightRegions(base, '', 0, { match, current }), [])
  const regions = buildSearchHighlightRegions(base, 'one', 99, { match, current })
  assert.deepEqual(regions[1]?.style, current)
})

test('search highlights: transcript boundary excludes matching dock rows', () => {
  const base = frame(['foo transcript', 'foo dock'])
  const regions = buildSearchHighlightRegions(base, 'foo', 0, { match, current }, 1)
  assert.deepEqual(regions.map(({ x, y, width }) => ({ x, y, width })), [
    { x: 0, y: 0, width: 3 },
  ])
})
