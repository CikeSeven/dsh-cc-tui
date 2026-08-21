import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMouseController } from '../../src/tui-v2/controllers/mouse.js'
import type { TerminalInputEvent } from '../../src/tui-v2/terminal/input.js'
import { encodeLifecycleOperation } from '../../src/tui-v2/terminal/writer.js'

function mouse(payload: Record<string, unknown>): TerminalInputEvent {
  return {
    kind: 'mouse',
    sequence: 1,
    generation: 0,
    payload: {
      protocol: 'sgr-1006',
      action: 'press',
      button: 'left',
      x: 1,
      y: 2,
      modifiers: { shift: false, alt: false, ctrl: false },
      wheel: null,
      ...payload,
    } as never,
  }
}

test('mouse controller: wheel routes through scrolling and pointer routes to narrow handler', () => {
  const wheels: string[] = []
  const pointers: string[] = []
  const diagnostics: string[] = []
  const controller = createMouseController({
    mode: 'fullscreen',
    enabled: true,
    scrolling: { handleWheel: (direction) => { wheels.push(direction); return true } },
    selection: { handle: (_event, payload) => { pointers.push(`${payload.action}:${payload.button}`); return true } },
    hitTest: () => 'selection',
    onDiagnostic: ({ code }) => diagnostics.push(code),
  })

  assert.equal(controller.handleEvent(mouse({ action: 'wheel', wheel: 'up' })), true)
  assert.equal(controller.handleEvent(mouse({ action: 'press', button: 'left' })), true)
  assert.deepEqual(wheels, ['up'])
  assert.deepEqual(pointers, ['press:left'])
  assert.equal(controller.diagnostics().consumed, 2)
  assert.equal(diagnostics.length, 0)
})

test('mouse controller: unconfirmed protocol is explicitly rejected', () => {
  const controller = createMouseController({
    mode: 'fullscreen',
    enabled: true,
    supportedProtocols: ['sgr-1006'],
    selection: { handle: () => true },
  })
  assert.equal(controller.handleEvent(mouse({ protocol: 'x10' })), false)
  assert.equal(controller.diagnostics().unsupported, 1)
})

test('mouse controller: inline/unknown pointer targets degrade without throwing', () => {
  const diagnostics: string[] = []
  const controller = createMouseController({
    mode: 'inline',
    enabled: false,
    onDiagnostic: ({ code }) => diagnostics.push(code),
  })
  assert.equal(controller.handleEvent(mouse({ action: 'release' })), false)
  assert.equal(controller.diagnostics().unsupported, 1)
  assert.equal(controller.diagnostics().degraded, true)
  assert.deepEqual(diagnostics, ['mouse/unsupported'])
})

test('mouse lifecycle: tracking and encoding are separate and cleanup resets every protocol', () => {
  const urxvt = encodeLifecycleOperation({ kind: 'lifecycle', action: 'mouse', enabled: true, mouseMode: 'button-1002', mouseEncoding: 'urxvt-1015' })
  assert.ok(urxvt.includes('\u001b[?1002h'))
  assert.ok(urxvt.includes('\u001b[?1015h'))
  const x10 = encodeLifecycleOperation({ kind: 'lifecycle', action: 'mouse', enabled: true, mouseMode: 'x10-1000', mouseEncoding: 'x10' })
  assert.equal(x10.includes('\u001b[?1000h'), true)
  assert.equal(x10.includes('\u001b[?1006h'), false)
  const cleanup = encodeLifecycleOperation({ kind: 'lifecycle', action: 'mouse', enabled: false })
  for (const mode of [1000, 1002, 1003, 1006, 1015]) assert.ok(cleanup.includes(`\u001b[?${mode}l`))
})

test('mouse controller: handler failures are contained and counted', () => {
  const controller = createMouseController({
    mode: 'fullscreen',
    enabled: true,
    selection: { handle: () => { throw new Error('bad handler') } },
    hitTest: () => 'selection',
  })
  assert.doesNotThrow(() => controller.handleEvent(mouse({ action: 'release' })))
  assert.equal(controller.diagnostics().handlerErrors, 1)
})
