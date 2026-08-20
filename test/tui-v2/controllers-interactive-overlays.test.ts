/** WP-08c utility overlay controller: filtering, focus, callbacks and search. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createInteractiveOverlaysController } from '../../src/tui-v2/controllers/interactive-overlays.js'
import { replayTrace } from '../../src/tui-v2/controllers/replay.js'
import { serializeCanonicalUiState } from '../../src/tui-v2/model/canonical-state.js'
import { parseInteractiveOverlayPayload } from '../../src/tui-v2/model/interactive-overlay-payloads.js'
import { createReducer } from '../../src/tui-v2/model/reducer.js'
import type { OverlayState } from '../../src/tui-v2/model/schema.js'
import type { TerminalInputEvent } from '../../src/tui-v2/terminal/input.js'
import { createControllerRig, ManualClock } from './helpers/controller-rig.js'

function keyEvent(key: string): TerminalInputEvent {
  return { kind: 'key', sequence: 0, generation: 0, payload: { key, raw: '', text: null, eventType: 'press' } }
}

function charEvent(text: string): TerminalInputEvent {
  return { kind: 'key', sequence: 0, generation: 0, payload: { key: null, raw: text, text, eventType: 'press' } }
}

function pasteEvent(text: string): TerminalInputEvent {
  return { kind: 'paste', sequence: 0, generation: 0, payload: { text } }
}

function replayEquivalent(rig: ReturnType<typeof createControllerRig>): void {
  const replayed = replayTrace(rig.applied, createReducer({ clock: new ManualClock() }), rig.initialState)
  assert.equal(serializeCanonicalUiState(replayed), serializeCanonicalUiState(rig.state()))
}

function topPayload(rig: ReturnType<typeof createControllerRig>) {
  const overlay = rig.state().overlays.stack.at(-1)
  assert.ok(overlay !== undefined)
  const payload = parseInteractiveOverlayPayload(overlay.payload)
  assert.ok(payload !== null)
  return payload
}

test('interactive overlays: picker filters, edits by code point, skips disabled and closes before callback', () => {
  const rig = createControllerRig({ height: 10 })
  let business = false
  let selected = ''
  let closedBeforeCallback = false
  const controller = createInteractiveOverlaysController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
    getState: rig.state,
    isBusinessDialogActive: () => business,
  })

  assert.equal(controller.openPicker({
    key: 'demo',
    title: 'Pick',
    items: [
      { id: 'alpha', label: 'Alpha' },
      { id: 'blocked', label: 'Beta', disabled: true, disabledReason: 'not now' },
      { id: 'gamma', label: 'Gamma 😀', keywords: ['third'] },
    ],
    onSelect: (id) => {
      selected = id
      closedBeforeCallback = rig.state().overlays.stack.length === 0
    },
  }), true)
  assert.equal(controller.activeOverlayId(), 'utility/picker/demo')
  assert.equal(rig.state().focus.overlayId, 'utility/picker/demo')

  controller.handleInput(keyEvent('down'))
  let payload = topPayload(rig)
  assert.equal(payload.kind, 'picker-dialog')
  if (payload.kind === 'picker-dialog') assert.equal(payload.list.activeIndex, 2, 'disabled row skipped')

  controller.handleInput(charEvent('😀'))
  controller.handleInput(keyEvent('left'))
  controller.handleInput(charEvent('g'))
  controller.handleInput(pasteEvent('\namm'))
  payload = topPayload(rig)
  assert.equal(payload.kind, 'picker-dialog')
  if (payload.kind === 'picker-dialog') {
    assert.equal(payload.list.query, 'g amm😀', 'cursor-safe insertion and flattened paste')
    assert.equal(payload.list.items.length, 0)
  }
  controller.handleInput(keyEvent('home'))
  for (let i = 0; i < 6; i++) controller.handleInput(keyEvent('delete'))
  controller.handleInput(charEvent('g'))
  payload = topPayload(rig)
  if (payload.kind === 'picker-dialog') {
    assert.equal(payload.list.items[0]?.id, 'gamma')
    assert.equal(payload.list.activeIndex, 0)
  }
  controller.handleInput(keyEvent('enter'))
  assert.equal(selected, 'gamma')
  assert.equal(closedBeforeCallback, true)
  assert.equal(controller.activeOverlayId(), null)
  assert.deepEqual(rig.state().focus, { target: 'editor', overlayId: null })
  replayEquivalent(rig)

  business = true
  assert.equal(controller.openHelp({ title: 'Help', items: [], onSelect: () => {} }), false)
  assert.equal(controller.diagnostics().blocked, 1)
})

test('interactive overlays: later business overlay preempts focus and close falls back to utility', () => {
  const rig = createControllerRig({ height: 10 })
  const controller = createInteractiveOverlaysController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
    getState: rig.state,
    isBusinessDialogActive: () => false,
  })
  controller.openHistory({
    title: 'History',
    items: [{ id: 'one', label: 'one' }],
    onSelect: () => {},
  })
  const utilityId = controller.activeOverlayId()
  assert.equal(utilityId, 'utility/history')

  const business: OverlayState = {
    overlayId: 'dialog/question/later',
    revision: 1,
    anchor: 'bottom-center',
    visible: true,
    captureInput: true,
    nonCapturing: false,
    payload: { note: 'business' },
  }
  rig.streaming.ingest({ ...rig.meta.next('overlay', 'business-open'), type: 'overlay/open', overlay: business })
  assert.equal(rig.state().focus.overlayId, business.overlayId)
  controller.handleInput(keyEvent('down'))
  assert.equal(controller.diagnostics().staleInput, 1)

  rig.streaming.ingest({
    ...rig.meta.next('overlay', 'business-close'),
    type: 'overlay/close',
    overlayId: business.overlayId,
  })
  assert.equal(rig.state().focus.overlayId, utilityId)
  controller.handleInput(keyEvent('escape'))
  assert.equal(rig.state().focus.target, 'editor')
  replayEquivalent(rig)
})

test('interactive overlays: transcript search journals matches/current and deactivates on close', () => {
  const rig = createControllerRig({ height: 10 })
  let closed = 0
  const controller = createInteractiveOverlaysController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
    getState: rig.state,
    isBusinessDialogActive: () => false,
  })
  controller.openTranscriptSearch({
    query: 'err',
    findMatches: (query) => query === 'err' ? ['row-1', 'row-2', 'row-2'] : [],
    onClose: () => { closed += 1 },
  })
  assert.deepEqual(rig.state().search, {
    query: 'err', active: true, current: 0, matches: ['row-1', 'row-2'],
  })
  let payload = topPayload(rig)
  assert.equal(payload.kind, 'transcript-search-dialog')
  if (payload.kind === 'transcript-search-dialog') assert.equal(payload.total, 2)

  controller.handleInput(keyEvent('enter'))
  assert.equal(rig.state().search.current, 1)
  controller.handleInput(keyEvent('up'))
  assert.equal(rig.state().search.current, 0)
  controller.handleInput(keyEvent('escape'))
  assert.equal(rig.state().search.active, false)
  assert.equal(closed, 1)
  assert.equal(rig.state().overlays.stack.length, 0)
  replayEquivalent(rig)
})

test('interactive overlays: help/history payloads are serializable and dispose is inert', () => {
  const rig = createControllerRig({ height: 10 })
  const controller = createInteractiveOverlaysController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
    getState: rig.state,
    isBusinessDialogActive: () => false,
  })
  controller.openHelp({
    title: 'Help',
    query: 'run',
    shortcuts: [{ keys: '?', label: 'help' }],
    items: [{ id: 'run', label: '/run' }],
    onSelect: () => {},
  })
  const help = topPayload(rig)
  assert.equal(help.kind, 'help-dialog')
  if (help.kind === 'help-dialog') assert.equal(help.list.query, 'run')

  controller.openHistory({ title: 'History', items: [], onSelect: () => {} })
  assert.equal(topPayload(rig).kind, 'history-search-dialog')
  assert.equal(controller.diagnostics().replaced, 1)
  controller.dispose()
  const events = rig.applied.length
  assert.equal(rig.state().overlays.stack.length, 0)
  assert.equal(controller.openPicker({ title: 'late', items: [], onSelect: () => {} }), false)
  controller.handleInput(keyEvent('escape'))
  assert.equal(rig.applied.length, events)
  replayEquivalent(rig)
})

test('interactive overlays: windows budget rendered rows and page movement normalizes modulo', () => {
  const rig = createControllerRig({ height: 10 })
  const controller = createInteractiveOverlaysController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
    getState: rig.state,
    isBusinessDialogActive: () => false,
  })
  controller.openPicker({
    title: 'Tall results',
    maxRows: 4,
    items: [
      { id: 'a', label: 'A', description: 'details' },
      { id: 'b', label: 'B', disabled: true, disabledReason: 'busy' },
      { id: 'c', label: 'C' },
      { id: 'd', label: 'D' },
    ],
    onSelect: () => {},
  })
  let payload = topPayload(rig)
  assert.equal(payload.kind, 'picker-dialog')
  if (payload.kind === 'picker-dialog') {
    assert.equal(payload.list.windowStart, 0)
    assert.equal(payload.list.windowEnd, 2, 'description and disabled-reason rows consume the budget')
  }

  controller.openPicker({
    title: 'Paging',
    maxRows: 8,
    items: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ],
    onSelect: () => {},
  })
  controller.handleInput(keyEvent('pageUp'))
  payload = topPayload(rig)
  assert.equal(payload.kind, 'picker-dialog')
  if (payload.kind === 'picker-dialog') assert.equal(payload.list.activeIndex, 1)
  controller.dispose()
  replayEquivalent(rig)
})
