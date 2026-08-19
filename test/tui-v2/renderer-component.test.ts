/**
 * tui-v2 WP-04b component-contract tests (plan §5.1): OverlayOptions ->
 * OverlayState normalization — visible callbacks become booleans, the
 * captureInput === !nonCapturing rule is enforced by schema validation, and
 * contradictory combinations are rejected (never guessed by the renderer).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeOverlayOptions,
  type Component,
  type Focusable,
  type Overlay,
  type OverlayOptions,
} from '../../src/tui-v2/renderer/component.js'
import { validateOverlayState } from '../../src/tui-v2/model/schema.js'

const base = {
  overlayId: 'ov-1',
  revision: 3,
  payload: { kind: 'picker' },
  termWidth: 120,
  termHeight: 40,
}

test('component: visible callback normalizes to a boolean', () => {
  const state = normalizeOverlayOptions({
    ...base,
    options: { visible: (termWidth) => termWidth > 80 },
  })
  assert.equal(state.visible, true)
  assert.equal(typeof state.visible, 'boolean')
  const hidden = normalizeOverlayOptions({ ...base, options: { visible: () => false } })
  assert.equal(hidden.visible, false)
  // Default: visible.
  assert.equal(normalizeOverlayOptions({ ...base, options: {} }).visible, true)
})

test('component: captureInput is the negation of nonCapturing', () => {
  const capturing = normalizeOverlayOptions({ ...base, options: {} })
  assert.deepEqual(
    { captureInput: capturing.captureInput, nonCapturing: capturing.nonCapturing },
    { captureInput: true, nonCapturing: false },
  )
  const passive = normalizeOverlayOptions({ ...base, options: { nonCapturing: true } })
  assert.deepEqual(
    { captureInput: passive.captureInput, nonCapturing: passive.nonCapturing },
    { captureInput: false, nonCapturing: true },
  )
})

test('component: normalized state passes schema validation end to end', () => {
  const state = normalizeOverlayOptions({
    ...base,
    options: {
      anchor: 'bottom-center',
      width: '60%',
      minWidth: 20,
      maxHeight: '50%',
      margin: { top: 1, left: 2 },
      offsetX: -1,
      nonCapturing: false,
    },
  })
  assert.doesNotThrow(() => validateOverlayState(state))
  assert.equal(state.anchor, 'bottom-center')
  assert.equal(state.width, '60%')
})

test('component: schema rejects contradictory capture flags (no renderer guessing)', () => {
  assert.throws(
    () =>
      validateOverlayState({
        overlayId: 'x',
        revision: 0,
        anchor: 'center',
        visible: true,
        captureInput: true,
        nonCapturing: true,
        payload: null,
      }),
    TypeError,
  )
})

test('component: contracts are implementable (compile-time shape smoke)', () => {
  const component: Component = {
    render: (width: number) => ['x'.repeat(Math.max(0, Math.min(1, width)))],
    invalidate() {},
    handleInput() {},
    wantsKeyRelease: false,
  }
  const focusable: Focusable = { focused: true, cursor: { x: 0, y: 0, visible: true } }
  const options: OverlayOptions = { anchor: 'center', visible: () => true }
  const overlay: Overlay = { ...component, options }
  assert.equal(overlay.render(10).length, 1)
  assert.equal(focusable.cursor?.visible, true)
})
