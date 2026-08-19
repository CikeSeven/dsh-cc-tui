/**
 * tui-v2 WP-04b layout tests: stacking geometry, visible-window slicing and
 * overlay anchor geometry (plan §5.1/§6.2; the compositor consumes these in
 * WP-06).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  overlayGeometry,
  prefixSums,
  resolveDimension,
  sliceVisibleWindow,
  stackLines,
  totalHeight,
} from '../../src/tui-v2/renderer/layout.js'

test('layout: stackLines concatenates blocks top to bottom', () => {
  assert.deepEqual(stackLines([['a', 'b'], [], ['c']]), ['a', 'b', 'c'])
})

test('layout: totalHeight / prefixSums', () => {
  assert.equal(totalHeight([2, 3, 1]), 6)
  assert.deepEqual(prefixSums([2, 3, 1]), [0, 2, 5, 6])
  assert.deepEqual(prefixSums([]), [0])
})

test('layout: sliceVisibleWindow maps line offsets to item ranges', () => {
  const heights = [2, 3, 1, 4] // lines: 0-1, 2-4, 5, 6-9
  const win = sliceVisibleWindow(heights, 3, 4) // lines 3..6
  assert.equal(win.startIndex, 1)
  assert.equal(win.endIndex, 4)
  assert.equal(win.startClipTop, 1)
  assert.equal(win.contentHeight, 10)
  // Empty / degenerate inputs
  assert.deepEqual(sliceVisibleWindow([], 0, 5), { startIndex: -1, endIndex: 0, startClipTop: 0, contentHeight: 0 })
  assert.equal(sliceVisibleWindow(heights, 3, 0).startIndex, -1)
  // scrollTop beyond content clamps to the last line
  const clamped = sliceVisibleWindow(heights, 100, 4)
  assert.equal(clamped.startIndex, 3)
})

test('layout: resolveDimension handles absolute and percent forms', () => {
  assert.equal(resolveDimension(12, 100), 12)
  assert.equal(resolveDimension('50%', 80), 40)
  assert.equal(resolveDimension(undefined, 80), undefined)
  assert.equal(resolveDimension('33%', 10), 3)
})

test('layout: overlayGeometry centers by default and clamps to the terminal', () => {
  const center = overlayGeometry(
    { anchor: 'center', contentWidth: 20, contentHeight: 6 },
    80,
    24,
  )
  assert.deepEqual(center, { x: 30, y: 9, width: 20, height: 6, clip: false })
  const clamped = overlayGeometry(
    { anchor: 'center', contentWidth: 200, contentHeight: 100 },
    80,
    24,
  )
  assert.equal(clamped.clip, true)
  assert.equal(clamped.width, 80)
  assert.equal(clamped.height, 24)
})

test('layout: overlayGeometry anchors to edges and honors explicit row/col', () => {
  const br = overlayGeometry(
    { anchor: 'bottom-right', width: '50%', maxHeight: 5, contentWidth: 10, contentHeight: 10 },
    80,
    24,
  )
  assert.deepEqual(br, { x: 40, y: 19, width: 40, height: 5, clip: false })
  const explicit = overlayGeometry(
    { anchor: 'center', row: 2, col: '25%', contentWidth: 10, contentHeight: 3 },
    80,
    24,
  )
  assert.equal(explicit.x, 20)
  assert.equal(explicit.y, 2)
})

test('layout: overlayGeometry margin shrinks the anchoring box, offsets shift', () => {
  const rect = overlayGeometry(
    {
      anchor: 'top-left',
      margin: { top: 2, left: 4 },
      offsetX: 1,
      offsetY: 1,
      minWidth: 30,
      contentWidth: 10,
      contentHeight: 2,
    },
    80,
    24,
  )
  assert.deepEqual(rect, { x: 5, y: 3, width: 30, height: 2, clip: false })
})
