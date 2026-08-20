/** WP-08c transcript-search AppEvent/reducer/canonical contract. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { serializeCanonicalUiState } from '../../src/tui-v2/model/canonical-state.js'
import { validateAppEvent, type AppEvent } from '../../src/tui-v2/model/events.js'
import { computeSnapshotHash } from '../../src/tui-v2/model/projections.js'
import { reduce } from '../../src/tui-v2/model/reducer.js'
import type { EventMeta } from '../../src/tui-v2/model/schema.js'
import { initialUiState } from '../../src/tui-v2/model/state.js'

function meta(seq: number, resetEpoch = 0): EventMeta {
  return {
    schemaVersion: 1,
    adapterInstanceId: 'search-adapter',
    durableSessionId: 'search-session',
    uiSessionGeneration: 'search-gen',
    resetEpoch,
    sessionEpoch: `search-gen:${resetEpoch}`,
    source: 'overlay',
    sourceSeq: `search-${seq}`,
    seq,
    at: seq,
  }
}

function reset(seq: number, resetEpoch = 0): AppEvent {
  return {
    ...meta(seq, resetEpoch),
    source: 'session',
    sourceSeq: `reset-${seq}`,
    type: 'session/rows-reset',
    resetId: `reset-${seq}`,
    rows: [],
    snapshotHash: computeSnapshotHash([]),
    revision: 1,
    ready: true,
    reason: resetEpoch === 0 ? 'new-session' : 'resume',
  }
}

test('model search: validator enforces bounded unique row ids and current range', () => {
  const valid = {
    ...meta(2),
    type: 'search/update' as const,
    search: { query: 'needle', active: true, current: 1, matches: ['r1', 'r2'] },
  }
  assert.deepEqual(validateAppEvent(valid), valid)
  assert.throws(() => validateAppEvent({
    ...valid,
    search: { ...valid.search, matches: ['r1', 'r1'] },
  }), /unique/)
  assert.throws(() => validateAppEvent({
    ...valid,
    search: { ...valid.search, current: 2 },
  }), /current/)
  assert.throws(() => validateAppEvent({
    ...valid,
    search: { ...valid.search, matches: Array.from({ length: 513 }, (_, i) => `r${i}`), current: 0 },
  }), /512/)
})

test('model search: reducer freezes snapshots, canonicalizes them and rows-reset clears stale matches', () => {
  let state = initialUiState({ width: 40, height: 10, profileId: 'test', theme: 'default', language: 'en' })
  state = reduce(state, reset(1))
  state = reduce(state, {
    ...meta(2),
    type: 'search/update',
    search: { query: 'needle', active: true, current: 1, matches: ['r1', 'r2'] },
  })
  assert.deepEqual(state.search, { query: 'needle', active: true, current: 1, matches: ['r1', 'r2'] })
  assert.ok(Object.isFrozen(state.search))
  assert.ok(Object.isFrozen(state.search.matches))
  assert.match(serializeCanonicalUiState(state), /"search":\{"active":true,"current":1,"matches":\["r1","r2"\],"query":"needle"\}/)

  state = reduce(state, reset(3, 1))
  assert.deepEqual(state.search, { query: '', active: false, current: 0, matches: [] })
})
