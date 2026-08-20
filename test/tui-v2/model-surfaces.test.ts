/** WP-08e1 surface AppEvent/reducer/replay contract. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateAppEvent, parseAppEvent, serializeAppEvent, type AppEvent } from '../../src/tui-v2/model/events.js'
import { createReducer } from '../../src/tui-v2/model/reducer.js'
import { computeSnapshotHash } from '../../src/tui-v2/model/projections.js'
import { initialUiState } from '../../src/tui-v2/model/state.js'
import { emptySurfaceView } from '../../src/tui-v2/model/surfaces.js'
import { serializeCanonicalUiState } from '../../src/tui-v2/model/canonical-state.js'

const meta = (seq: number, epoch = 'g:1') => ({
  schemaVersion: 1 as const, adapterInstanceId: 'a', durableSessionId: 's', uiSessionGeneration: 'g', resetEpoch: 1,
  sessionEpoch: epoch, source: 'session' as const, sourceSeq: `surface-${seq}`, seq, at: seq,
})

const reset: AppEvent = {
  ...meta(1), type: 'session/rows-reset', resetId: 'r1', rows: [], snapshotHash: computeSnapshotHash([]), revision: 1, ready: true, reason: 'new-session',
}

function update(seq: number, revision: number): AppEvent {
  return { ...meta(seq), type: 'surface/update', surface: {
    ...emptySurfaceView('g:1'), revision, sessionEpoch: 'g:1', activityEnabled: true, contextBarEnabled: true,
    goalTodo: { goal: { id: 'g1', revision, objective: '目标 你好😀', phase: 'active', maxGoalRounds: 5, roundsStarted: 1 }, todos: [{ content: 'todo', status: 'in_progress' }], hiddenTodos: 0 },
  } }
}

test('surface event: JSON round trip, reducer revision and canonical projection', () => {
  const event = validateAppEvent(update(2, 1))
  assert.deepEqual(parseAppEvent(serializeAppEvent(event)), event)
  const reducer = createReducer()
  let state = initialUiState({ width: 80, height: 24, profileId: 'p', theme: 't', language: 'en' })
  state = reducer.reduce(state, reset)
  state = reducer.reduce(state, event)
  assert.equal(state.surface.goalTodo.goal?.objective, '目标 你好😀')
  assert.ok(serializeCanonicalUiState(state).includes('目标 你好😀'))
})

test('surface reducer: stale revision drops and stale epoch is fenced', () => {
  const reducer = createReducer()
  let state = initialUiState({ width: 80, height: 24, profileId: 'p', theme: 't', language: 'en' })
  state = reducer.reduce(state, reset)
  state = reducer.reduce(state, update(2, 2))
  const before = state.surface
  state = reducer.reduce(state, update(3, 1))
  assert.equal(state.surface, before)
  assert.equal(state.diagnostics.droppedStaleRevision, 1)
  const stale = { ...update(4, 3), sessionEpoch: 'old:1', surface: { ...emptySurfaceView('old:1'), revision: 3, sessionEpoch: 'old:1' } } as AppEvent
  state = reducer.reduce(state, stale)
  assert.equal(state.surface, before)
  assert.equal(state.diagnostics.droppedOldEpoch, 1)
})

test('surface validator rejects oversized todo arrays and non-serializable payloads', () => {
  const event = update(2, 1) as Extract<AppEvent, { type: 'surface/update' }>
  assert.throws(() => validateAppEvent({ ...event, surface: { ...event.surface, goalTodo: { goal: null, todos: Array.from({ length: 65 }, () => ({ content: 'x', status: 'pending' })), hiddenTodos: 0 } } }), /at most 64/)
  assert.throws(() => validateAppEvent({ ...event, surface: { ...event.surface, bad: () => {} } }), /SerializableValue/)
})
