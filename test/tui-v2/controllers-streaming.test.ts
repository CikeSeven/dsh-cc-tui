/**
 * WP-05 streaming controller deepening + adapter dock mirror.
 *
 * Coverage: chunk merge windows, cancel marks (idempotent, barrier release,
 * rows-reset clearing), settled idempotency, tool running -> result/error
 * revision + lifecycleRevision bumps, and the dock mirror (status/pending/
 * notifications dedup by signature).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serializeCanonicalUiState } from '../../src/tui-v2/model/canonical-state.js';
import { createReducer } from '../../src/tui-v2/model/reducer.js';
import { replayTrace } from '../../src/tui-v2/controllers/replay.js';
import { createControllerRig, ManualClock, type ControllerRig } from './helpers/controller-rig.js';

function replayEquivalence(rig: ControllerRig): void {
  const replayed = replayTrace(rig.applied, createReducer({ clock: new ManualClock() }), rig.initialState);
  assert.equal(serializeCanonicalUiState(replayed), serializeCanonicalUiState(rig.state()));
}

test('controller streaming: chunk bursts merge per window, causal order kept', () => {
  const rig = createControllerRig({ height: 5 });
  rig.channel.addUserRow('q');
  rig.channel.startAssistant('');
  rig.channel.appendAssistant('a');
  rig.channel.appendAssistant('b');
  rig.channel.appendAssistant('c');
  // Still inside the merge window: nothing emitted for the chunks yet.
  assert.ok(rig.streaming.diagnostics().mergedChunks >= 2);

  rig.clock.advance(20);
  rig.channel.settleAssistant();

  const state = rig.state();
  const rowId = state.session.streamingRowId;
  assert.equal(rowId, null, 'settled');
  const lastRow = state.session.rowsById[state.session.rowOrder[state.session.rowOrder.length - 1] as string];
  assert.ok(lastRow !== undefined && lastRow.settled);
  const text = lastRow.blocks
    .map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String((block as { text: unknown }).text) : String(block)))
    .join('');
  assert.equal(text, 'abc');
  replayEquivalence(rig);
});

test('controller streaming: cancelStream is idempotent and barrier-released', () => {
  const rig = createControllerRig({ height: 5 });
  rig.channel.startAssistant('');
  const rowId = rig.state().session.streamingRowId;
  assert.ok(rowId !== null);

  rig.streaming.cancelStream(rowId);
  rig.streaming.cancelStream(rowId);
  assert.equal(rig.streaming.diagnostics().cancelledStreams, 1, 're-marking is a no-op');

  rig.channel.appendAssistant('dropped-1');
  rig.channel.appendAssistant('dropped-2');
  rig.clock.advance(20);
  assert.equal(rig.streaming.diagnostics().droppedChunks, 2);

  // The settle barrier releases the mark; buffered text (none) aside, the row
  // settles cleanly and later growth republishes as row-upsert revisions.
  rig.channel.settleAssistant();
  const row = rig.state().session.rowsById[rowId];
  assert.equal(row?.settled, true);
  assert.equal(rig.state().session.streamingRowId, null);
  replayEquivalence(rig);
});

test('controller streaming: rows-reset clears cancel marks but keeps pending buffer order', () => {
  const rig = createControllerRig({ height: 5 });
  rig.channel.startAssistant('pre-reset');
  const rowId = rig.state().session.streamingRowId;
  assert.ok(rowId !== null);
  rig.streaming.cancelStream(rowId);

  // A reset (clear) lands while the mark is held: the mark is cleared and
  // counted; the reset still publishes after the buffered pre-reset chunk.
  rig.adapter.commands.clear();
  const diag = rig.streaming.diagnostics();
  assert.equal(diag.cancelMarksReset, 1);
  assert.equal(rig.state().session.rowOrder.length, 0);

  // Post-reset streaming works without interference from the stale mark.
  rig.channel.startAssistant('new epoch');
  rig.channel.appendAssistant('!');
  rig.clock.advance(20);
  const state = rig.state();
  const newRowId = state.session.streamingRowId;
  assert.ok(newRowId !== null && newRowId !== rowId);
  replayEquivalence(rig);
});

test('controller streaming: duplicate settles are idempotent (counted, not applied twice)', () => {
  const rig = createControllerRig({ height: 5 });
  rig.channel.startAssistant('hi');
  rig.clock.advance(20);
  rig.channel.settleAssistant();
  const rowId = rig.state().session.rowOrder[rig.state().session.rowOrder.length - 1] as string;
  const settled = rig.state().session.rowsById[rowId];
  assert.ok(settled !== undefined);

  // Redeliver the settle directly at the reducer boundary (a replay artifact).
  const before = rig.state();
  const redelivered = rig.reducer.reduce(before, {
    schemaVersion: 1,
    adapterInstanceId: 'rig-adapter',
    durableSessionId: 'rig-session',
    uiSessionGeneration: 'rig-gen',
    resetEpoch: before.session.resetEpoch,
    sessionEpoch: before.session.sessionEpoch,
    source: 'session',
    sourceSeq: 'dup-settle',
    seq: before.bookkeeping.lastAppliedSeq + 1,
    at: 0,
    type: 'stream/settled',
    rowId,
    revision: settled.revision,
  });
  assert.equal(
    redelivered.session.rowsById[rowId]?.revision,
    settled.revision,
    'settle pins max(applied, claimed) and never moves backwards',
  );
  assert.equal(redelivered.session.streamingRowId, null);
});

test('controller streaming: tool running -> result/error bumps revision + lifecycleRevision', () => {
  const rig = createControllerRig({ height: 5 });
  const tool = rig.channel.addToolRow('Bash', 'ls -la');
  const rowId = rig.state().session.rowOrder[rig.state().session.rowOrder.length - 1] as string;
  const running = rig.state().session.rowsById[rowId];
  assert.equal(running?.tool?.phase, 'running');
  const runningRevision = running?.revision ?? 0;
  const runningLifecycle = running?.tool?.lifecycleRevision ?? 0;

  rig.channel.settleTool(tool, 'total 42');
  const result = rig.state().session.rowsById[rowId];
  assert.equal(result?.tool?.phase, 'result');
  assert.ok((result?.revision ?? 0) > runningRevision, 'row revision bumped');
  assert.ok(
    (result?.tool?.lifecycleRevision ?? 0) > runningLifecycle,
    'lifecycleRevision bumped on running -> result',
  );
  assert.equal(result?.tool?.resultView, 'total 42');
  assert.ok(rig.adapter.diagnostics().settledRevisionBumps >= 1);

  const tool2 = rig.channel.addToolRow('Write', '{}');
  const rowId2 = rig.state().session.rowOrder[rig.state().session.rowOrder.length - 1] as string;
  const runningLifecycle2 = rig.state().session.rowsById[rowId2]?.tool?.lifecycleRevision ?? 0;
  rig.channel.failTool(tool2, 'EACCES');
  const errored = rig.state().session.rowsById[rowId2];
  assert.equal(errored?.tool?.phase, 'error');
  assert.equal(errored?.tool?.error?.message, 'EACCES');
  assert.ok(
    (errored?.tool?.lifecycleRevision ?? 0) > runningLifecycle2,
    'lifecycleRevision bumped on running -> error',
  );
  replayEquivalence(rig);
});

// ---------------------------------------------------------------------------
// dock mirror
// ---------------------------------------------------------------------------

test('controller streaming: dock mirror tracks pending + notifications, deduped', () => {
  const rig = createControllerRig({ height: 5 });
  const initial = rig.dock();
  assert.ok(initial !== null, 'published at start');
  assert.equal(initial.status.model, 'fake-model');
  assert.equal(initial.status.effort, 'high', 'dock reflects the Channel actual effort');
  assert.equal(initial.pending.length, 0);
  const revision = initial.revision;

  rig.channel.bump();
  assert.equal(rig.dock()?.revision, revision, 'no-op wakeups do not republish the dock');

  // steer while working queues a pending message.
  rig.channel.setWorking(true);
  rig.channel.steer('queued while busy');
  let dock = rig.dock();
  assert.equal(dock?.pending.length, 1);
  assert.equal(dock?.pending[0]?.text, 'queued while busy');
  assert.equal(dock?.pending[0]?.placement, 'steer');
  assert.ok((dock?.revision ?? 0) > revision);

  // interruptAndDeliver drains the queue.
  rig.channel.interruptAndDeliver(['queued while busy']);
  dock = rig.dock();
  assert.equal(dock?.pending.length, 0);

  // Notifications mirror with ids/colors; the dismiss handle re-publishes.
  const dismiss = rig.channel.notify('careful', { color: 'warning' });
  dock = rig.dock();
  assert.equal(dock?.notifications.length, 1);
  assert.equal(dock?.notifications[0]?.text, 'careful');
  assert.equal(dock?.notifications[0]?.color, 'warning');
  dismiss();
  assert.equal(rig.dock()?.notifications.length, 0);

  // Status mirror.
  assert.equal(rig.dock()?.status.working, false);
  assert.equal(rig.dock()?.status.branch, 'main');
});
