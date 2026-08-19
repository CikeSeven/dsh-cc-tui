/**
 * tui-v2 WP-04a model selector/projection tests: transcript windowing, dock /
 * editor / status / overlay ViewModels, ChatRow-aligned projections, revision
 * allocator domains, snapshot hashing and canonical-state stability.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { serializeCanonicalUiState } from '../../src/tui-v2/model/canonical-state.js'
import { canonicalJson } from '../../src/tui-v2/model/canonical-json.js'
import { computeSnapshotHash, projectRow, type ProjectionRowInput } from '../../src/tui-v2/model/projections.js'
import { rowCacheKey } from '../../src/tui-v2/model/row-id.js'
import { createRevisionAllocator } from '../../src/tui-v2/model/revisions.js'
import type { AppEvent } from '../../src/tui-v2/model/events.js'
import type { EventMeta, UiRowSnapshot } from '../../src/tui-v2/model/schema.js'
import {
  selectCapturingOverlay,
  selectDockView,
  selectEditorView,
  selectOverlayStack,
  selectStatusLine,
  selectTranscriptView,
} from '../../src/tui-v2/model/selectors.js'
import { initialUiState, type UiState } from '../../src/tui-v2/model/state.js'
import { reduce } from '../../src/tui-v2/model/reducer.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const BASE_AT = 1_700_000_000_000

function meta(seq: number, overrides: Partial<EventMeta> = {}): EventMeta {
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
    at: BASE_AT + seq * 100,
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

function freshState(): UiState {
  return initialUiState({ width: 80, height: 24, profileId: 'unicode-ambiguous-narrow', theme: 'default', language: 'en' })
}

/** Boot with `n` rows (r1..rn) in one reset. */
function stateWithRows(n: number, height = 3): UiState {
  const rows = Array.from({ length: n }, (_, i) => row(`r${i + 1}`))
  let state = initialUiState({ width: 80, height, profileId: 'p', theme: 'default', language: 'en' })
  state = reduce(state, {
    ...meta(1),
    type: 'session/rows-reset',
    resetId: 'reset-1',
    rows,
    snapshotHash: computeSnapshotHash(rows),
    revision: 1,
    ready: true,
    reason: 'new-session',
  })
  return state
}

// ---------------------------------------------------------------------------
// selectTranscriptView
// ---------------------------------------------------------------------------

test('selectors: transcript view windows rows by viewport (sticky pins to tail)', () => {
  const state = stateWithRows(10, 3)
  const view = selectTranscriptView(state)
  assert.equal(view.totalRows, 10)
  assert.equal(view.visibleRows.length, 3)
  assert.deepEqual(view.visibleRows.map((r) => r.sourceId), ['r8', 'r9', 'r10'])
  assert.equal(view.windowStart, 7)
  assert.equal(view.windowEnd, 10)
  assert.equal(view.showUnseenIndicator, false)
})

test('selectors: non-sticky viewport windows from scrollTop', () => {
  let state = stateWithRows(10, 3)
  state = { ...state, viewport: { ...state.viewport, sticky: false, scrollTop: 2, maxScroll: 7 } }
  const view = selectTranscriptView(state)
  assert.deepEqual(view.visibleRows.map((r) => r.sourceId), ['r3', 'r4', 'r5'])
  // rows appended while not sticky count as unseen
  const appended = reduce(state, { ...meta(2), type: 'session/row-upsert', row: row('r11') })
  const view2 = selectTranscriptView(appended)
  assert.equal(view2.unseenCount, 1)
  assert.equal(view2.showUnseenIndicator, true)
  assert.equal(view2.streamingRowId, null)
})

test('selectors: empty transcript windows to nothing', () => {
  const view = selectTranscriptView(freshState())
  assert.equal(view.visibleRows.length, 0)
  assert.equal(view.totalRows, 0)
})

// ---------------------------------------------------------------------------
// dock / editor / status / overlays
// ---------------------------------------------------------------------------

test('selectors: dock/editor/status views map dock state', () => {
  let state = freshState()
  state = {
    ...state,
    dock: {
      ...state.dock,
      editor: { text: 'draft', cursor: 2, history: ['older'], historyIndex: null },
      status: { model: 'm1', tokens: { input: 3, output: 4 }, cwd: '/repo', branch: 'main', mode: 'agent' },
      activity: { label: 'working' },
      pendingMessages: ['steer me'],
      notifications: [{ notificationId: 'n1', text: 'hello' }],
    },
  }
  const dock = selectDockView(state)
  assert.equal(dock.editor.text, 'draft')
  assert.equal(dock.status.model, 'm1')
  assert.equal(dock.activity?.label, 'working')
  assert.deepEqual(dock.pendingMessages, ['steer me'])
  assert.equal(dock.notifications.length, 1)

  const editor = selectEditorView(state)
  assert.equal(editor.text, 'draft')
  assert.equal(editor.cursor, 2)
  assert.equal(editor.focused, true)

  const status = selectStatusLine(state)
  assert.deepEqual(status, { model: 'm1', tokens: { input: 3, output: 4 }, cwd: '/repo', branch: 'main', mode: 'agent', extras: {} })

  const empty = selectStatusLine(freshState())
  assert.deepEqual(empty, { model: null, tokens: null, cwd: null, branch: null, mode: null, extras: {} })
})

test('selectors: overlay stack is ordered; capturing overlay is the topmost capturing one', () => {
  let state = stateWithRows(0)
  const mk = (overlayId: string, captureInput: boolean) => ({
    overlayId,
    revision: 0,
    anchor: 'center' as const,
    visible: true,
    captureInput,
    nonCapturing: !captureInput,
    payload: {},
  })
  const open = (seq: number, overlay: ReturnType<typeof mk>): AppEvent => ({
    ...meta(seq, { source: 'overlay' }),
    type: 'overlay/open',
    overlay,
  })
  state = reduce(state, open(2, mk('bottom', true)))
  state = reduce(state, open(3, mk('decor', false)))
  const stack = selectOverlayStack(state)
  assert.deepEqual(stack.map((o) => o.overlayId), ['bottom', 'decor'])
  assert.equal(selectCapturingOverlay(state)?.overlayId, 'bottom')
  const empty = freshState()
  assert.equal(selectCapturingOverlay(empty), null)
  assert.deepEqual(selectOverlayStack(empty), [])
})

// ---------------------------------------------------------------------------
// projections
// ---------------------------------------------------------------------------

function projectionInput(overrides: Partial<ProjectionRowInput> = {}): ProjectionRowInput {
  return {
    durableSessionId: 'session-1',
    uiSessionGeneration: 'gen-1',
    sessionEpoch: 'gen-1:0',
    source: 'session',
    sourceId: 'row-1',
    sourceSeq: 'session-row-1-1',
    revision: 0,
    kind: 'assistant',
    text: 'hello',
    ...overrides,
  }
}

test('projections: projectRow builds per-kind block layouts', () => {
  const user = projectRow(projectionInput({ kind: 'user', label: 'steering' }))
  assert.deepEqual(user.blocks, [
    { type: 'label', text: 'steering' },
    { type: 'text', text: 'hello' },
  ])
  assert.equal(user.settled, true)

  const assistant = projectRow(projectionInput({ streaming: true }))
  assert.deepEqual(assistant.blocks, [{ type: 'markdown', text: 'hello' }])
  assert.equal(assistant.settled, false)

  const reasoning = projectRow(projectionInput({ kind: 'reasoning', durationMs: 120 }))
  assert.deepEqual(reasoning.blocks, [{ type: 'reasoning', text: 'hello', durationMs: 120 }])

  const notice = projectRow(projectionInput({ kind: 'notice', source: 'notice' }))
  assert.deepEqual(notice.blocks, [{ type: 'notice', text: 'hello' }])

  const interrupt = projectRow(projectionInput({ kind: 'interrupt' }))
  assert.deepEqual(interrupt.blocks, [{ type: 'interrupt', text: 'hello' }])

  const compact = projectRow(projectionInput({ kind: 'compact', folded: true, restored: true, time: 7 }))
  assert.deepEqual(compact.blocks, [
    { type: 'compact', text: 'hello' },
    { type: 'meta', time: 7, folded: true, restored: true },
  ])

  const local = projectRow(projectionInput({ kind: 'local', source: 'local' }))
  assert.deepEqual(local.blocks, [{ type: 'text', text: 'hello' }])
})

test('projections: tool status maps to lifecycle phases with passthrough views', () => {
  const running = projectRow(
    projectionInput({
      kind: 'tool',
      text: '',
      tool: { status: 'running', lifecycleRevision: 0, callView: { name: 'bash', args: '{}' } },
    }),
  )
  assert.equal(running.tool?.phase, 'running')
  assert.deepEqual(running.tool?.callView, { name: 'bash', args: '{}' })
  assert.equal(running.blocks.length, 0, 'empty tool text yields no fallback block')

  const ok = projectRow(
    projectionInput({
      kind: 'tool',
      text: 'done',
      tool: { status: 'ok', lifecycleRevision: 1, durationMs: 55, resultView: 'output' },
    }),
  )
  assert.equal(ok.tool?.phase, 'result')
  assert.equal(ok.tool?.durationMs, 55)
  assert.equal(ok.tool?.resultView, 'output')

  const failed = projectRow(
    projectionInput({
      kind: 'tool',
      text: 'failed',
      tool: { status: 'error', lifecycleRevision: 1, error: { code: 'E', message: 'm', recoverable: true } },
    }),
  )
  assert.equal(failed.tool?.phase, 'error')
  assert.equal(failed.tool?.error?.code, 'E')
})

test('projections: rowId derives from the canonical identity tuple', () => {
  const a = projectRow(projectionInput())
  const b = projectRow(projectionInput({ sourceId: 'row-2' }))
  assert.notEqual(a.rowId, b.rowId)
  assert.equal(a.rowId, projectRow(projectionInput()).rowId, 'deterministic')
  // identity includes sessionEpoch: same source in another epoch is a new row
  const otherEpoch = projectRow(projectionInput({ sessionEpoch: 'gen-1:1' }))
  assert.notEqual(a.rowId, otherEpoch.rowId)
})

test('projections: computeSnapshotHash matches the corpus reset payloads', async () => {
  // Cross-check against a real fixture: the trace generator must agree.
  const raw = await readFile(path.join(repoRoot, 'fixtures', 'tui-v2', 'traces', 'resume-rewind.jsonl'), 'utf8')
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l))
  for (const line of lines) {
    if (line.kind === 'event' && line.event.type === 'session/rows-reset') {
      assert.equal(computeSnapshotHash(line.event.rows), line.event.snapshotHash)
    }
  }
})

// ---------------------------------------------------------------------------
// revisions
// ---------------------------------------------------------------------------

test('revisions: allocator grows per-row and lifecycle domains independently', () => {
  const alloc = createRevisionAllocator()
  assert.equal(alloc.current('r1'), -1)
  assert.equal(alloc.next('r1'), 0)
  assert.equal(alloc.next('r1'), 1)
  assert.equal(alloc.current('r1'), 1)
  assert.equal(alloc.next('r2'), 0, 'other rows allocate independently')
  assert.equal(alloc.nextLifecycle('r1'), 0, 'lifecycle domain is separate')
  assert.equal(alloc.currentLifecycle('r1'), 0)
  assert.equal(alloc.current('r1'), 1, 'lifecycle allocation does not touch row revision')
  alloc.reset()
  assert.equal(alloc.current('r1'), -1)
  assert.equal(alloc.currentLifecycle('r1'), -1)
  assert.equal(alloc.next('r1'), 0, 'reset epoch restarts revisions')
})

// ---------------------------------------------------------------------------
// row cache key (§5.3)
// ---------------------------------------------------------------------------

test('rowCacheKey: width/theme/profile invalidate cache, not business revision', () => {
  const r = row('a')
  const ctx = { width: 80, themeId: 'default', terminalProfileId: 'p' }
  const key = rowCacheKey(r, ctx)
  assert.deepEqual(key, {
    durableSessionId: 'session-1',
    uiSessionGeneration: 'gen-1',
    sessionEpoch: 'gen-1:0',
    rowId: r.rowId,
    revision: 0,
    width: 80,
    themeId: 'default',
    terminalProfileId: 'p',
  })
  assert.notEqual(canonicalJson(rowCacheKey(r, { ...ctx, width: 100 })), canonicalJson(key), 'width change changes the cache key')
  assert.notEqual(canonicalJson(rowCacheKey(r, { ...ctx, themeId: 'dark' })), canonicalJson(key), 'theme change changes the cache key')
  assert.equal(canonicalJson(rowCacheKey(r, ctx)), canonicalJson(key), 'stable serialization')
})

// ---------------------------------------------------------------------------
// canonical state stability
// ---------------------------------------------------------------------------

test('canonical state excludes diagnostics, seq bookkeeping, at and identity of the adapter', () => {
  const eventsA: AppEvent[] = [
    { ...meta(1), type: 'session/rows-reset', resetId: 'r1', rows: [row('a')], snapshotHash: computeSnapshotHash([row('a')]), revision: 1, ready: true, reason: 'new-session' },
    { ...meta(2), type: 'session/row-upsert', row: row('b') },
  ]
  let a = freshState()
  for (const e of eventsA) a = reduce(a, e)

  // Same business events but with one duplicate seq and different at values:
  // diagnostics differ, canonical state must not.
  let b = freshState()
  b = reduce(b, eventsA[0] as AppEvent)
  b = reduce(b, eventsA[1] as AppEvent)
  b = reduce(b, { ...(eventsA[1] as AppEvent), at: BASE_AT + 999 }) // duplicate seq 2
  assert.equal(b.diagnostics.duplicate, 1)
  assert.equal(a.diagnostics.duplicate, 0)
  assert.equal(serializeCanonicalUiState(b), serializeCanonicalUiState(a))

  // diagnostics edits never leak into canonical bytes
  const hacked = {
    ...a,
    diagnostics: { ...a.diagnostics, gapReset: 99, lastError: { code: 'X', message: 'm', seq: 1 } },
    bookkeeping: { ...a.bookkeeping, lastAppliedSeq: 12345, adapterInstanceId: 'other' },
  }
  assert.equal(serializeCanonicalUiState(hacked), serializeCanonicalUiState(a))
})
