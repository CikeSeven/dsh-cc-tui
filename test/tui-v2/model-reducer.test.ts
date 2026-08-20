/**
 * tui-v2 WP-04a model reducer tests: §5.2 ordering (duplicate / gap buffer /
 * snapshot-gap / drain), atomic rows-reset validation, epoch discipline,
 * sourceSeq conflicts, revision rules, streaming, overlays, resize, terminal
 * lifecycle, rowId encoding, immutability, and the 22-trace replay corpus
 * with canonical-state equivalence (test names carry 'replay' for WP-05
 * pattern reuse).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AppEvent } from '../../src/tui-v2/model/events.js'
import type { EventMeta, OverlayState, UiRowSnapshot } from '../../src/tui-v2/model/schema.js'
import { serializeCanonicalUiState } from '../../src/tui-v2/model/canonical-state.js'
import { computeSnapshotHash } from '../../src/tui-v2/model/projections.js'
import { createReducer, encodeRowId, reduce } from '../../src/tui-v2/model/reducer.js'
import {
  GAP_BUFFER_MAX_EVENTS,
  GAP_BUFFER_MAX_WAIT_MS,
  initialUiState,
  type UiState,
} from '../../src/tui-v2/model/state.js'
import { readTrace, type Trace } from '../../src/tui-v2/testkit/trace.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixturesDir = path.join(repoRoot, 'fixtures', 'tui-v2', 'traces')

const BASE_AT = 1_700_000_000_000

// ---------------------------------------------------------------------------
// Builders (deterministic; adapter-1/gen-1/session-1 by default)
// ---------------------------------------------------------------------------

function meta(seq: number, at: number, overrides: Partial<EventMeta> = {}): EventMeta {
  return {
    schemaVersion: 1,
    adapterInstanceId: 'adapter-1',
    durableSessionId: 'session-1',
    uiSessionGeneration: 'gen-1',
    resetEpoch: 0,
    sessionEpoch: 'gen-1:0',
    source: 'session',
    sourceSeq: `session-src-${seq}`,
    seq,
    at,
    ...overrides,
  }
}

function row(sourceId: string, overrides: Partial<UiRowSnapshot> = {}): UiRowSnapshot {
  return {
    rowId: `gen-1:0:session:${sourceId}:session-${sourceId}-1`,
    durableSessionId: 'session-1',
    uiSessionGeneration: 'gen-1',
    sessionEpoch: 'gen-1:0',
    source: 'session',
    sourceId,
    sourceSeq: `session-${sourceId}-1`,
    revision: 0,
    kind: 'assistant',
    blocks: [`text of ${sourceId}`],
    settled: true,
    ...overrides,
  }
}

function resetEvent(
  seq: number,
  at: number,
  rows: readonly UiRowSnapshot[],
  overrides: Partial<EventMeta> & Partial<{
    resetId: string
    snapshotHash: string
    revision: number
    reason: 'new-session' | 'resume' | 'rewind' | 'clear' | 'snapshot-gap' | 'adapter-reconnect'
  }> = {},
): AppEvent {
  const { resetId, snapshotHash, revision, reason, ...metaOverrides } = overrides
  return {
    ...meta(seq, at, metaOverrides),
    type: 'session/rows-reset',
    resetId: resetId ?? `reset-${seq}`,
    rows,
    snapshotHash: snapshotHash ?? computeSnapshotHash(rows),
    revision: revision ?? 1,
    ready: true,
    reason: reason ?? 'new-session',
  }
}

function upsertEvent(seq: number, at: number, r: UiRowSnapshot, overrides: Partial<EventMeta> = {}): AppEvent {
  return { ...meta(seq, at, overrides), type: 'session/row-upsert', row: r }
}

function overlay(overlayId: string, overrides: Partial<OverlayState> = {}): OverlayState {
  return {
    overlayId,
    revision: 0,
    anchor: 'center',
    visible: true,
    captureInput: true,
    nonCapturing: false,
    payload: { kind: 'test' },
    ...overrides,
  }
}

function freshState(): UiState {
  return initialUiState({ width: 80, height: 24, profileId: 'unicode-ambiguous-narrow', theme: 'default', language: 'en' })
}

/** Reduce a whole event list, returning the final state. */
function reduceAll(events: readonly AppEvent[], start?: UiState): UiState {
  let state = start ?? freshState()
  for (const event of events) state = reduce(state, event)
  return state
}

/** Boot: bind identity via an empty rows-reset (seq 1). */
function bootedState(at: number = BASE_AT): UiState {
  return reduceAll([resetEvent(1, at, [])])
}

// ---------------------------------------------------------------------------
// initial state
// ---------------------------------------------------------------------------

test('model: initialUiState is unbound and awaiting the first reset', () => {
  const state = freshState()
  assert.equal(state.session.readiness, 'awaiting-reset')
  assert.equal(state.session.sessionEpoch, '')
  assert.equal(state.session.resetEpoch, -1)
  assert.equal(state.session.rowOrder.length, 0)
  assert.equal(state.focus.target, 'editor')
  assert.equal(state.viewport.width, 80)
  assert.equal(state.terminal.mode, 'fullscreen')
  assert.equal(state.terminal.needsFullRedraw, true)
  assert.equal(state.bookkeeping.lastAppliedSeq, 0)
})

// ---------------------------------------------------------------------------
// sequencing: duplicate / gap buffer / drain / snapshot-gap
// ---------------------------------------------------------------------------

test('model: duplicate or late seq is dropped and counted', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(2, BASE_AT + 200, row('a')))
  assert.equal(state.session.rowOrder.length, 1)
  // exact duplicate
  const dup = upsertEvent(2, BASE_AT + 200, row('a'))
  const afterDup = reduce(state, dup)
  assert.equal(afterDup.diagnostics.duplicate, 1)
  assert.equal(afterDup.session.rowOrder.length, 1)
  // late (older than lastAppliedSeq)
  const late = reduce(afterDup, upsertEvent(1, BASE_AT + 100, row('b')))
  assert.equal(late.diagnostics.duplicate, 2)
  assert.equal(late.session.rowOrder.length, 1)
})

test('model: out-of-order events are buffered and drained in seq order', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(3, BASE_AT + 300, row('c')))
  assert.equal(state.session.rowOrder.length, 0, 'seq 3 must not apply while seq 2 is missing')
  assert.equal(state.bookkeeping.gapBuffer.entries.length, 1)
  assert.equal(state.diagnostics.gapBuffered, 1)
  // the missing seq 2 arrives: applies, then the buffered seq 3 drains
  state = reduce(state, upsertEvent(2, BASE_AT + 200, row('b')))
  assert.deepEqual(
    state.session.rowOrder.map((id) => state.session.rowsById[id]?.sourceId),
    ['b', 'c'],
  )
  assert.equal(state.bookkeeping.gapBuffer.entries.length, 0)
  assert.equal(state.bookkeeping.lastAppliedSeq, 3)
  // a re-delivery of a buffered seq is a duplicate, not a second buffer entry
  state = reduce(state, upsertEvent(5, BASE_AT + 500, row('e')))
  state = reduce(state, upsertEvent(5, BASE_AT + 500, row('e')))
  assert.equal(state.diagnostics.duplicate, 1)
  assert.equal(state.bookkeeping.gapBuffer.entries.length, 1)
})

test('model: gap buffer entry cap triggers a snapshot-gap reset request', () => {
  let state = bootedState()
  // buffer GAP_BUFFER_MAX_EVENTS out-of-order events (seq 3..3+63)
  for (let i = 0; i < GAP_BUFFER_MAX_EVENTS; i++) {
    state = reduce(state, upsertEvent(3 + i, BASE_AT + 300 + i, row(`r${i}`)))
  }
  assert.equal(state.bookkeeping.gapBuffer.entries.length, GAP_BUFFER_MAX_EVENTS)
  assert.equal(state.session.pendingReset, null)
  // one more exceeds the cap
  state = reduce(state, upsertEvent(3 + GAP_BUFFER_MAX_EVENTS, BASE_AT + 999, row('overflow')))
  assert.equal(state.diagnostics.gapReset, 1)
  assert.equal(state.bookkeeping.gapBuffer.entries.length, 0, 'buffer discarded on gap')
  assert.ok(state.session.pendingReset)
  assert.equal(state.session.pendingReset?.reason, 'snapshot-gap')
  assert.equal(state.session.pendingReset?.gapAfterSeq, 1)
  // stragglers from the unresolved gap are dropped while the reset is pending
  state = reduce(state, upsertEvent(3 + GAP_BUFFER_MAX_EVENTS + 1, BASE_AT + 1000, row('late')))
  assert.equal(state.session.rowOrder.length, 0)
  // the answering rows-reset jumps the queue and heals the state
  const healed = row('healed', { sessionEpoch: 'gen-1:1', uiSessionGeneration: 'gen-1' })
  state = reduce(
    state,
    resetEvent(99, BASE_AT + 1100, [healed], {
      resetEpoch: 1,
      sessionEpoch: 'gen-1:1',
      reason: 'snapshot-gap',
    }),
  )
  assert.equal(state.session.pendingReset, null)
  assert.equal(state.session.sessionEpoch, 'gen-1:1')
  assert.equal(state.session.resetEpoch, 1)
  assert.equal(state.session.rowOrder.length, 1)
  assert.equal(state.bookkeeping.lastAppliedSeq, 99)
})

test('model: gap buffer wait cap (150 ms on event at) triggers snapshot-gap', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(3, BASE_AT + 100, row('first-gap')))
  assert.equal(state.bookkeeping.gapBuffer.entries.length, 1)
  // arrives within the window: still buffered
  state = reduce(state, upsertEvent(4, BASE_AT + 100 + GAP_BUFFER_MAX_WAIT_MS, row('in-window')))
  assert.equal(state.session.pendingReset, null)
  // beyond the window: gap
  state = reduce(state, upsertEvent(5, BASE_AT + 100 + GAP_BUFFER_MAX_WAIT_MS + 1, row('too-late')))
  assert.equal(state.diagnostics.gapReset, 1)
  assert.ok(state.session.pendingReset)
})

test('model: rows-reset invalidates buffered old-epoch events', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(3, BASE_AT + 300, row('buffered')))
  assert.equal(state.bookkeeping.gapBuffer.entries.length, 1)
  const rewound = row('a', { sessionEpoch: 'gen-1:1' })
  state = reduce(state, resetEvent(2, BASE_AT + 200, [rewound], { resetEpoch: 1, sessionEpoch: 'gen-1:1', reason: 'rewind' }))
  assert.equal(state.bookkeeping.gapBuffer.entries.length, 0, 'reset clears the gap buffer')
  assert.equal(state.session.sessionEpoch, 'gen-1:1')
  assert.equal(state.bookkeeping.lastAppliedSeq, 2, 'the reset event itself advances the seq')
})

// ---------------------------------------------------------------------------
// rows-reset atomic validation
// ---------------------------------------------------------------------------

test('model: rows-reset atomically replaces rows and rebuilds epoch state', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(2, BASE_AT + 200, row('old')))
  state = reduce(state, { ...meta(3, BASE_AT + 300), type: 'overlay/open', overlay: overlay('ov-1') })
  assert.equal(state.overlays.stack.length, 1)
  // editor draft survives the reset (§5.2)
  state = {
    ...state,
    dock: { ...state.dock, editor: { ...state.dock.editor, text: 'draft', cursor: 5 } },
  }
  const rows = [row('u', { kind: 'user', sessionEpoch: 'gen-1:1' }), row('a', { sessionEpoch: 'gen-1:1' })]
  state = reduce(state, resetEvent(4, BASE_AT + 400, rows, { resetEpoch: 1, sessionEpoch: 'gen-1:1', reason: 'rewind' }))
  assert.equal(state.session.sessionEpoch, 'gen-1:1')
  assert.equal(state.session.resetEpoch, 1)
  assert.equal(state.session.rowOrder.length, 2)
  assert.equal(state.session.rowsById[state.session.rowOrder[0] as string]?.sourceId, 'u')
  assert.equal(state.overlays.stack.length, 0, 'overlays cleared')
  assert.equal(state.viewport.scrollTop, 0)
  assert.equal(state.viewport.sticky, true)
  assert.equal(state.focus.target, 'editor')
  assert.equal(state.dock.editor.text, 'draft', 'editor draft preserved')
  assert.equal(state.terminal.needsFullRedraw, true)
})

test('model: rows-reset with mismatched snapshotHash is rejected atomically', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(2, BASE_AT + 200, row('kept')))
  const rows = [row('x')]
  const bad = reduce(state, resetEvent(3, BASE_AT + 300, rows, { snapshotHash: 'snap-0000000000000000' }))
  assert.equal(bad.diagnostics.invalidReset, 1)
  assert.equal(bad.diagnostics.lastError?.code, 'invalid-rows-reset')
  assert.deepEqual(bad.session.rowOrder, state.session.rowOrder, 'no partial rows accepted')
  assert.equal(bad.session.rowsById === state.session.rowsById, true)
})

test('model: rows-reset with a row from the wrong epoch is rejected', () => {
  let state = bootedState()
  const badRow = row('alien', { sessionEpoch: 'gen-1:0' })
  const bad = reduce(state, resetEvent(2, BASE_AT + 200, [badRow], { resetEpoch: 1, sessionEpoch: 'gen-1:1', reason: 'rewind' }))
  assert.equal(bad.diagnostics.invalidReset, 1)
  assert.equal(bad.session.sessionEpoch, 'gen-1:0', 'epoch unchanged')
})

test('model: rows-reset with a non-positive revision is rejected', () => {
  const state = bootedState()
  const bad = reduce(state, resetEvent(2, BASE_AT + 200, [], { resetEpoch: 1, sessionEpoch: 'gen-1:1', revision: 0, reason: 'rewind' }))
  assert.equal(bad.diagnostics.invalidReset, 1)
})

test('model: rows-reset with a stale resetEpoch is rejected', () => {
  const state = bootedState()
  const again = reduce(state, resetEvent(2, BASE_AT + 200, [], { resetEpoch: 0, sessionEpoch: 'gen-1:0', resetId: 'reset-again' }))
  assert.equal(again.diagnostics.invalidReset, 1)
})

// ---------------------------------------------------------------------------
// epoch discipline / conflicts / revisions
// ---------------------------------------------------------------------------

test('model: business events from an old sessionEpoch are dropped and counted', () => {
  let state = bootedState()
  state = reduce(state, resetEvent(2, BASE_AT + 200, [row('u', { sessionEpoch: 'gen-1:1' })], { resetEpoch: 1, sessionEpoch: 'gen-1:1', reason: 'rewind' }))
  // stale epoch row-upsert
  const stale = reduce(state, upsertEvent(3, BASE_AT + 300, row('ghost', { sessionEpoch: 'gen-1:0' }), { sessionEpoch: 'gen-1:0' }))
  assert.equal(stale.diagnostics.droppedOldEpoch, 1)
  assert.equal(stale.session.rowOrder.length, 1)
  // stale epoch stream chunk
  const staleChunk = reduce(stale, { ...meta(4, BASE_AT + 400, { sessionEpoch: 'gen-1:0' }), type: 'stream/chunk', rowId: 'whatever', text: 'x' })
  assert.equal(staleChunk.diagnostics.droppedOldEpoch, 2)
})

test('model: same sourceSeq with different payload is a conflict; first applied wins', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(2, BASE_AT + 200, row('a')))
  // same source identity, different rowId
  const alien = row('a', { rowId: 'gen-1:0:session:a:FORGED', blocks: ['forged'] })
  const after = reduce(state, upsertEvent(3, BASE_AT + 300, alien))
  assert.equal(after.diagnostics.conflict, 1)
  assert.equal(after.session.rowOrder.length, 1)
  assert.equal(after.session.rowsById['gen-1:0:session:a:FORGED'], undefined)
  // same rowId + same revision, different payload
  const forged2 = row('a', { blocks: ['forged again'] })
  const after2 = reduce(after, upsertEvent(4, BASE_AT + 400, forged2))
  assert.equal(after2.diagnostics.conflict, 2)
  assert.deepEqual(after2.session.rowsById['gen-1:0:session:a:session-a-1']?.blocks, ['text of a'])
  // identical redelivery at the same revision is an idempotent no-op for
  // business state (sequencing bookkeeping still advances past seq 5)
  const same = reduce(after2, upsertEvent(5, BASE_AT + 500, row('a')))
  assert.equal(same.diagnostics.conflict, 2)
  assert.equal(same.session.rowsById, after2.session.rowsById, 'idempotent redelivery leaves rows untouched')
  assert.equal(serializeCanonicalUiState(same), serializeCanonicalUiState(after2))
})

test('model: row-upsert revision must strictly increase', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(2, BASE_AT + 200, row('a', { revision: 1 })))
  // lower revision: dropped
  const lower = reduce(state, upsertEvent(3, BASE_AT + 300, row('a', { revision: 0, blocks: ['newer'] })))
  assert.equal(lower.diagnostics.droppedStaleRevision, 1)
  assert.deepEqual(lower.session.rowsById['gen-1:0:session:a:session-a-1']?.blocks, ['text of a'])
  // higher revision: replaces
  const higher = reduce(lower, upsertEvent(4, BASE_AT + 400, row('a', { revision: 2, blocks: ['newer'] })))
  assert.equal(higher.session.rowsById['gen-1:0:session:a:session-a-1']?.revision, 2)
  assert.deepEqual(higher.session.rowsById['gen-1:0:session:a:session-a-1']?.blocks, ['newer'])
})

// ---------------------------------------------------------------------------
// streaming
// ---------------------------------------------------------------------------

test('model: stream chunks append only to the current streaming row', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(2, BASE_AT + 200, row('s', { blocks: [], settled: false })))
  const rowId = 'gen-1:0:session:s:session-s-1'
  state = reduce(state, { ...meta(3, BASE_AT + 300, { source: 'stream' }), type: 'stream/chunk', rowId, text: 'hello ' })
  state = reduce(state, { ...meta(4, BASE_AT + 400, { source: 'stream' }), type: 'stream/chunk', rowId, text: 'world' })
  const r = state.session.rowsById[rowId]
  assert.deepEqual(r?.blocks, ['hello world'])
  assert.equal(r?.revision, 2, 'each chunk bumps the row revision')
  assert.equal(r?.settled, false)
  // chunk for another row is dropped
  const other = reduce(state, { ...meta(5, BASE_AT + 500, { source: 'stream' }), type: 'stream/chunk', rowId: 'gen-1:0:session:other:1', text: 'x' })
  assert.equal(other.diagnostics.droppedUnknownRow, 1)
})

test('model: stream/settled pins the revision and later chunks are dropped', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(2, BASE_AT + 200, row('s', { blocks: [], settled: false })))
  const rowId = 'gen-1:0:session:s:session-s-1'
  state = reduce(state, { ...meta(3, BASE_AT + 300, { source: 'stream' }), type: 'stream/chunk', rowId, text: 'partial' })
  state = reduce(state, { ...meta(4, BASE_AT + 400, { source: 'stream' }), type: 'stream/settled', rowId, revision: 1 })
  const settled = state.session.rowsById[rowId]
  assert.equal(settled?.settled, true)
  assert.equal(settled?.revision, 1, 'revision fixed at settle (never moves backwards)')
  assert.equal(state.session.streamingRowId, null)
  const late = reduce(state, { ...meta(5, BASE_AT + 500, { source: 'stream' }), type: 'stream/chunk', rowId, text: 'late' })
  assert.equal(late.diagnostics.droppedUnknownRow, 1)
  assert.deepEqual(late.session.rowsById[rowId]?.blocks, ['partial'])
})

test('model: row-complete marks settled and is idempotent', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(2, BASE_AT + 200, row('s', { blocks: [], settled: false, revision: 0 })))
  const rowId = 'gen-1:0:session:s:session-s-1'
  state = reduce(state, { ...meta(3, BASE_AT + 300), type: 'session/row-complete', rowId, revision: 2 })
  assert.equal(state.session.rowsById[rowId]?.settled, true)
  assert.equal(state.session.rowsById[rowId]?.revision, 2)
  assert.equal(state.session.streamingRowId, null)
  const again = reduce(state, { ...meta(4, BASE_AT + 400), type: 'session/row-complete', rowId, revision: 2 })
  assert.equal(again.session.rowsById, state.session.rowsById, 'idempotent completion leaves rows untouched')
  assert.equal(serializeCanonicalUiState(again), serializeCanonicalUiState(state))
  const unknown = reduce(again, { ...meta(5, BASE_AT + 500), type: 'session/row-complete', rowId: 'nope', revision: 0 })
  assert.equal(unknown.diagnostics.droppedUnknownRow, 1)
})

test('model: tool running -> result publishes a new snapshot, old one untouched', () => {
  let state = bootedState()
  const toolRow = (revision: number, phase: 'running' | 'result') =>
    row('call-1', {
      kind: 'tool',
      revision,
      tool: {
        phase,
        lifecycleRevision: revision,
        ...(phase === 'running' ? { callView: { name: 'tool', args: '{}' } } : { durationMs: 42, resultView: 'done' }),
      },
    })
  state = reduce(state, upsertEvent(2, BASE_AT + 200, toolRow(0, 'running')))
  const running = state.session.rowsById['gen-1:0:session:call-1:session-call-1-1']
  state = reduce(state, upsertEvent(3, BASE_AT + 300, toolRow(1, 'result')))
  const result = state.session.rowsById['gen-1:0:session:call-1:session-call-1-1']
  assert.equal(running?.tool?.phase, 'running', 'published snapshot not mutated in place')
  assert.equal(result?.tool?.phase, 'result')
  assert.equal(result?.tool?.lifecycleRevision, 1)
  assert.equal(result?.tool?.durationMs, 42)
  assert.equal(result?.revision, 1)
})

// ---------------------------------------------------------------------------
// overlays / viewport / terminal / input / errors
// ---------------------------------------------------------------------------

test('model: overlay open/close maintain the ordered stack and focus', () => {
  let state = bootedState()
  state = reduce(state, { ...meta(2, BASE_AT + 200, { source: 'overlay' }), type: 'overlay/open', overlay: overlay('a') })
  state = reduce(state, { ...meta(3, BASE_AT + 300, { source: 'overlay' }), type: 'overlay/open', overlay: overlay('b') })
  assert.deepEqual(state.overlays.stack.map((o) => o.overlayId), ['a', 'b'])
  assert.deepEqual(state.focus, { target: 'overlay', overlayId: 'b' })
  // re-open same id with higher revision updates in place (position kept)
  state = reduce(state, { ...meta(4, BASE_AT + 400, { source: 'overlay' }), type: 'overlay/open', overlay: overlay('a', { revision: 1, anchor: 'top-left' }) })
  assert.deepEqual(state.overlays.stack.map((o) => o.overlayId), ['a', 'b'])
  assert.equal(state.overlays.stack[0]?.anchor, 'top-left')
  // stale overlay revision dropped
  const stale = reduce(state, { ...meta(5, BASE_AT + 500, { source: 'overlay' }), type: 'overlay/open', overlay: overlay('a', { revision: 1 }) })
  assert.equal(stale.diagnostics.droppedStaleRevision, 1)
  // close topmost: focus falls back to the remaining capturing overlay
  state = reduce(stale, { ...meta(6, BASE_AT + 600, { source: 'overlay' }), type: 'overlay/close', overlayId: 'b' })
  assert.deepEqual(state.overlays.stack.map((o) => o.overlayId), ['a'])
  assert.deepEqual(state.focus, { target: 'overlay', overlayId: 'a' })
  state = reduce(state, { ...meta(7, BASE_AT + 700, { source: 'overlay' }), type: 'overlay/close', overlayId: 'a' })
  assert.deepEqual(state.focus, { target: 'editor', overlayId: null })
  const unknown = reduce(state, { ...meta(8, BASE_AT + 800, { source: 'overlay' }), type: 'overlay/close', overlayId: 'ghost' })
  assert.equal(unknown.diagnostics.droppedUnknownOverlay, 1)
  // non-capturing overlay never takes focus
  const nc = reduce(state, { ...meta(9, BASE_AT + 900, { source: 'overlay' }), type: 'overlay/open', overlay: overlay('nc', { captureInput: false, nonCapturing: true }) })
  assert.equal(nc.focus.target, 'editor')
})

test('model: viewport resize updates size; width change requires full redraw', () => {
  let state = bootedState()
  state = reduce(state, { ...meta(2, BASE_AT + 200, { source: 'terminal' }), type: 'viewport/resize', width: 120, height: 40 })
  assert.equal(state.viewport.width, 120)
  assert.equal(state.terminal.needsFullRedraw, true)
  state = { ...state, terminal: { ...state.terminal, needsFullRedraw: false } }
  state = reduce(state, { ...meta(3, BASE_AT + 300, { source: 'terminal' }), type: 'viewport/resize', width: 120, height: 30 })
  assert.equal(state.viewport.height, 30)
  assert.equal(state.terminal.needsFullRedraw, false, 'height-only resize keeps redraw flag')
})

test('model: terminal suspend/resume mark full redraw and bump generation', () => {
  let state = bootedState()
  state = { ...state, terminal: { ...state.terminal, needsFullRedraw: false } }
  state = reduce(state, { ...meta(2, BASE_AT + 200, { source: 'terminal' }), type: 'terminal/suspended' })
  assert.equal(state.terminal.suspended, true)
  assert.equal(state.terminal.needsFullRedraw, true)
  state = reduce(state, { ...meta(3, BASE_AT + 300, { source: 'terminal' }), type: 'terminal/resumed' })
  assert.equal(state.terminal.suspended, false)
  assert.equal(state.terminal.generation, 1)
  assert.equal(state.terminal.needsFullRedraw, true)
})

test('model: input/command only journals the command (bounded), business state untouched', () => {
  let state = bootedState()
  const before = state.dock
  state = reduce(state, { ...meta(2, BASE_AT + 200, { source: 'input' }), type: 'input/command', command: { type: 'editor', command: 'insert', text: 'x' } })
  state = reduce(state, { ...meta(3, BASE_AT + 300, { source: 'input' }), type: 'input/command', command: { type: 'editor', command: 'submit' } })
  assert.equal(state.pendingCommands.length, 2)
  assert.equal(state.pendingCommands[0]?.seq, 2)
  assert.equal(state.dock, before, 'dock/editor state is driven by controller-emitted events, not input')
  // journal is bounded
  for (let i = 0; i < 40; i++) {
    state = reduce(state, { ...meta(4 + i, BASE_AT + 400 + i, { source: 'input' }), type: 'input/command', command: { type: 'scroll', delta: 1 } })
  }
  assert.equal(state.pendingCommands.length, 32)
  assert.equal(state.pendingCommands[31]?.seq, 43)
})

test('model: app/error records a bounded lastError summary', () => {
  let state = bootedState()
  state = reduce(state, { ...meta(2, BASE_AT + 200, { source: 'app' }), type: 'app/error', error: { code: 'FATAL', message: 'x'.repeat(500), recoverable: false } })
  assert.equal(state.diagnostics.lastError?.code, 'FATAL')
  assert.ok((state.diagnostics.lastError?.message.length ?? 0) <= 241)
  assert.equal(state.diagnostics.lastError?.seq, 2)
})

test('model: events before the first reset are dropped as not-ready', () => {
  const state = reduce(freshState(), upsertEvent(1, BASE_AT + 100, row('a')))
  assert.equal(state.diagnostics.droppedNotReady, 1, 'unbound: non-reset events wait for the first rows-reset')
  assert.equal(state.session.rowOrder.length, 0)
})

// ---------------------------------------------------------------------------
// adapter rebinding (cross-process resume)
// ---------------------------------------------------------------------------

test('model: a foreign adapter may rebind only via rows-reset with the same durable session', () => {
  let state = bootedState()
  // foreign non-reset event: dropped
  const foreign = reduce(state, upsertEvent(1, BASE_AT + 100, row('x'), { adapterInstanceId: 'adapter-2', uiSessionGeneration: 'gen-2', sessionEpoch: 'gen-2:0' }))
  assert.equal(foreign.diagnostics.adapterMismatch, 1)
  // foreign rows-reset with a different durable session: dropped
  const wrongSession = reduce(
    state,
    resetEvent(1, BASE_AT + 100, [], { adapterInstanceId: 'adapter-2', durableSessionId: 'other-session', uiSessionGeneration: 'gen-2', resetEpoch: 0, sessionEpoch: 'gen-2:0', reason: 'resume' }),
  )
  assert.equal(wrongSession.diagnostics.adapterMismatch, 1)
  assert.equal(wrongSession.bookkeeping.adapterInstanceId, 'adapter-1')
  // foreign rows-reset with the same durable session: rebind
  const resumed = reduce(
    state,
    resetEvent(1, BASE_AT + 100, [row('u', { uiSessionGeneration: 'gen-2', sessionEpoch: 'gen-2:0' })], { adapterInstanceId: 'adapter-2', uiSessionGeneration: 'gen-2', resetEpoch: 0, sessionEpoch: 'gen-2:0', reason: 'resume' }),
  )
  assert.equal(resumed.bookkeeping.adapterInstanceId, 'adapter-2')
  assert.equal(resumed.bookkeeping.lastAppliedSeq, 1, 'new adapter seq stream re-established')
  assert.equal(resumed.session.sessionEpoch, 'gen-2:0')
})

// ---------------------------------------------------------------------------
// rowId encoding (§5.3)
// ---------------------------------------------------------------------------

test('model: encodeRowId is deterministic and separator-safe', () => {
  const a = encodeRowId('gen:0', 'session', 'user:1', '42')
  const b = encodeRowId('gen:0', 'session', 'user:1', '42')
  assert.equal(a, b, 'same input -> same byte string')
  // delimiter-containing segments must not collide with a different split
  assert.notEqual(encodeRowId('e', 'a:b', 'c', 's'), encodeRowId('e', 'a', 'b:c', 's'))
  assert.notEqual(encodeRowId('e', 'session', '1:2', '3'), encodeRowId('e', 'session', '1', '2:3'))
  // prefix collision attempt: '1:a' vs '11:x...' style lengths differ
  assert.notEqual(encodeRowId('e', 's', 'x', '1:a'), encodeRowId('e', 's', 'x1', ':a'))
})

// ---------------------------------------------------------------------------
// immutability
// ---------------------------------------------------------------------------

test('model: published rows are frozen; mutation fails and canonical state is unaffected', () => {
  let state = bootedState()
  state = reduce(state, upsertEvent(2, BASE_AT + 200, row('s', { blocks: [], settled: false })))
  state = reduce(state, { ...meta(3, BASE_AT + 300, { source: 'stream' }), type: 'stream/chunk', rowId: 'gen-1:0:session:s:session-s-1', text: 'chunk' })
  const before = serializeCanonicalUiState(state)
  const published = state.session.rowsById['gen-1:0:session:s:session-s-1'] as UiRowSnapshot
  assert.ok(Object.isFrozen(published))
  assert.ok(Object.isFrozen(published.blocks))
  assert.throws(() => {
    ;(published as { revision: number }).revision = 99
  }, TypeError)
  assert.throws(() => {
    ;(published.blocks as string[]).push('hacked')
  }, TypeError)
  assert.equal(serializeCanonicalUiState(state), before, 'canonical state unchanged')
})

test('model: reduce never mutates its input state', () => {
  const state = bootedState()
  const before = serializeCanonicalUiState(state)
  const rowsRef = state.session.rowsById
  reduce(state, upsertEvent(2, BASE_AT + 200, row('new')))
  assert.equal(serializeCanonicalUiState(state), before)
  assert.equal(state.session.rowsById, rowsRef, 'input state graph untouched')
})

// ---------------------------------------------------------------------------
// live/replay equivalence (grouping + at independence)
// ---------------------------------------------------------------------------

test('model: live/replay equivalence — same events, different at and chunking, byte-equal canonical', () => {
  const events = (atStep: (i: number) => number): AppEvent[] => {
    const at = (i: number) => BASE_AT + atStep(i)
    return [
      resetEvent(1, at(0), []),
      upsertEvent(2, at(1), row('u', { kind: 'user' })),
      upsertEvent(3, at(2), row('s', { blocks: [], settled: false })),
      { ...meta(4, at(3), { source: 'stream' }), type: 'stream/chunk', rowId: 'gen-1:0:session:s:session-s-1', text: 'a' },
      { ...meta(5, at(4), { source: 'stream' }), type: 'stream/chunk', rowId: 'gen-1:0:session:s:session-s-1', text: 'b' },
      { ...meta(6, at(5), { source: 'stream' }), type: 'stream/settled', rowId: 'gen-1:0:session:s:session-s-1', revision: 5 },
      { ...meta(7, at(6)), type: 'session/row-complete', rowId: 'gen-1:0:session:s:session-s-1', revision: 5 },
      { ...meta(8, at(7), { source: 'overlay' }), type: 'overlay/open', overlay: overlay('ov') },
      { ...meta(9, at(8), { source: 'terminal' }), type: 'viewport/resize', width: 100, height: 30 },
      { ...meta(10, at(9), { source: 'input' }), type: 'input/command', command: { type: 'scroll', delta: -2 } },
      { ...meta(11, at(10), { source: 'overlay' }), type: 'overlay/close', overlayId: 'ov' },
    ]
  }
  const live = reduceAll(events((i) => i * 100))
  // "replay": same seq stream, different at spacing, fed in two chunks.
  const replayEvents = events((i) => 7 + i * 1000)
  let replay = freshState()
  for (const event of replayEvents.slice(0, 4)) replay = reduce(replay, event)
  for (const event of replayEvents.slice(4)) replay = reduce(replay, event)
  assert.equal(serializeCanonicalUiState(replay), serializeCanonicalUiState(live))
})

// ---------------------------------------------------------------------------
// fixture corpus replay (WP-05 selects these via --test-name-pattern 'replay')
// ---------------------------------------------------------------------------

async function loadTraces(): Promise<{ file: string; trace: Trace }[]> {
  const files = (await readdir(fixturesDir)).filter((f) => f.endsWith('.jsonl')).sort()
  const out: { file: string; trace: Trace }[] = []
  for (const file of files) out.push({ file, trace: await readTrace(path.join(fixturesDir, file)) })
  return out
}

function initialStateForTrace(trace: Trace): UiState {
  const profileRef = trace.header.terminalProfile
  const profile = typeof profileRef === 'string' ? getProfile(profileRef) : profileRef
  return initialUiState({
    width: profile.columns,
    height: profile.rows,
    profileId: profile.id,
    theme: 'default',
    language: 'en',
  })
}

function traceEvents(trace: Trace): AppEvent[] {
  return trace.lines.filter((l) => l.kind === 'event').map((l) => (l as { event: AppEvent }).event)
}

test('model replay: all 23 corpus traces reduce deterministically (replay)', async () => {
  const traces = await loadTraces()
  assert.equal(traces.length, 23)
  for (const { file, trace } of traces) {
    const events = traceEvents(trace)
    const finalA = reduceAll(events, initialStateForTrace(trace))
    // differential-only fixtures are well-formed: no conflicts or bad resets
    assert.equal(finalA.diagnostics.conflict, 0, `${file}: no sourceSeq conflicts`)
    assert.equal(finalA.diagnostics.invalidReset, 0, `${file}: all rows-reset events validate`)
    assert.equal(finalA.diagnostics.duplicate, 0, `${file}: no duplicate seq`)
    assert.equal(finalA.diagnostics.gapReset, 0, `${file}: no seq gaps`)
    assert.equal(finalA.session.readiness, 'ready', `${file}: reset bound`)
    // replay the same trace twice: byte-equal canonical state
    const finalB = reduceAll(events, initialStateForTrace(trace))
    assert.equal(
      serializeCanonicalUiState(finalB),
      serializeCanonicalUiState(finalA),
      `${file}: double replay byte-equal`,
    )
    // replay with perturbed at values: canonical state must not change
    const jittered = events.map((event, i) => ({ ...event, at: event.at + 1 + (i % 7) }))
    const finalC = reduceAll(jittered, initialStateForTrace(trace))
    assert.equal(
      serializeCanonicalUiState(finalC),
      serializeCanonicalUiState(finalA),
      `${file}: canonical state independent of event at`,
    )
  }
})

test('model replay: resume-rewind trace switches epochs and rebinds the adapter (replay)', async () => {
  const trace = await readTrace(path.join(fixturesDir, 'resume-rewind.jsonl'))
  const events = traceEvents(trace)
  let state = initialStateForTrace(trace)
  const canonical: string[] = []
  for (const event of events) {
    state = reduce(state, event)
    canonical.push(serializeCanonicalUiState(state))
  }
  assert.equal(events.length, 4)
  // after rewind: same generation, resetEpoch 1
  const afterRewind = reduceAll(events.slice(0, 3), initialStateForTrace(trace))
  assert.equal(afterRewind.session.sessionEpoch, 'fixture-gen-1:1')
  assert.equal(afterRewind.session.resetEpoch, 1)
  assert.equal(afterRewind.bookkeeping.adapterInstanceId, 'fixture-adapter-1')
  // after resume: new adapter + generation, same durable session
  assert.equal(state.session.sessionEpoch, 'fixture-gen-2:0')
  assert.equal(state.session.resetEpoch, 0)
  assert.equal(state.session.durableSessionId, 'fixture-session-1')
  assert.equal(state.bookkeeping.adapterInstanceId, 'fixture-adapter-2')
  assert.equal(state.bookkeeping.lastAppliedSeq, 1, 'seq stream restarts on cross-process resume')
  assert.equal(state.session.rowOrder.length, 1)
  // rowIds are opaque to the reducer; the row's epoch identity is authoritative
  assert.equal(state.session.rowsById[state.session.rowOrder[0] as string]?.sessionEpoch, 'fixture-gen-2:0')
  // each epoch transition produces a distinct canonical state
  assert.notEqual(canonical[1], canonical[2], 'rewind changes canonical state (epoch switch)')
  assert.notEqual(canonical[2], canonical[3], 'resume changes canonical state (generation switch)')
  // a stale business event from the previous epoch is dropped after the switch
  const stale = reduce(state, {
    ...meta(2, BASE_AT + 9999, {
      adapterInstanceId: 'fixture-adapter-2',
      durableSessionId: 'fixture-session-1',
      uiSessionGeneration: 'fixture-gen-2',
      sessionEpoch: 'fixture-gen-1:1',
    }),
    type: 'session/row-upsert',
    row: row('ghost', { sessionEpoch: 'fixture-gen-1:1', uiSessionGeneration: 'fixture-gen-1' }),
  })
  assert.equal(stale.diagnostics.droppedOldEpoch, 1)
  assert.equal(stale.session.rowOrder.length, 1)
})

test('model replay: createReducer with injected deterministic clock matches plain reduce (replay)', async () => {
  const trace = await readTrace(path.join(fixturesDir, 'assistant-stream.jsonl'))
  const events = traceEvents(trace)
  let t = BASE_AT
  const reducer = createReducer({
    clock: {
      now: () => t,
      setTimeout: () => null,
      clearTimeout: () => {},
    },
    random: { next: () => 0.5 },
  })
  let withClock = initialStateForTrace(trace)
  for (const event of events) {
    t = event.at
    withClock = reducer.reduce(withClock, event)
  }
  const plain = reduceAll(events, initialStateForTrace(trace))
  assert.equal(serializeCanonicalUiState(withClock), serializeCanonicalUiState(plain))
  assert.deepEqual(withClock.diagnostics, plain.diagnostics)
})
