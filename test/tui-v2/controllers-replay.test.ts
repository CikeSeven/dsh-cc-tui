/**
 * WP-05 replay controller + live/replay equivalence.
 *
 * Coverage:
 *  - replayTrace accepts a Trace object identically to a plain event array;
 *  - a long adversarial live scenario (merged chunks, duplicate + out-of-order
 *    + gap-healing injection, resets, resume, rewind, cancel, scroll) replays
 *    to byte-identical canonical state;
 *  - replayTrace never mutates its input events/state (purity guard);
 *  - rewind three-branch flow (veto / modes / plain) with editor refill +
 *    journal, unknown rows, and superseded async ops;
 *  - resume failure mapping (app/error journal + notify, 'working' without
 *    journal), newSession failure, clear passthrough;
 *  - the update-restart mini state machine;
 *  - the controllers dependency guard (no stdout/ANSI/component imports).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeCanonicalUiState } from '../../src/tui-v2/model/canonical-state.js';
import { createReducer } from '../../src/tui-v2/model/reducer.js';
import { deepFreeze, type EventMeta } from '../../src/tui-v2/model/schema.js';
import { validateAppEvent, type AppEvent } from '../../src/tui-v2/model/events.js';
import { GAP_BUFFER_MAX_EVENTS } from '../../src/tui-v2/model/state.js';
import type { Trace } from '../../src/tui-v2/testkit/trace.js';
import { createReplayController, replayTrace, type ReplayController } from '../../src/tui-v2/controllers/replay.js';
import { createControllerRig, addUserRows, ManualClock, type ControllerRig } from './helpers/controller-rig.js';
import type { FakeChannel } from './helpers/fake-channel.js';
import type { ChatRow } from '../../src/dsh-adapter/channel.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function replayControllerFor(
  rig: ControllerRig,
  hooks: {
    drafts?: string[];
    stops?: string[];
  } = {},
): ReplayController {
  return createReplayController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('input', sourceSeq),
    commands: rig.adapter.commands,
    chatRowForRowId: (rowId) => rig.adapter.chatRowForRowId(rowId),
    promptRewind: (row) => rig.channel.promptRewind(row),
    getState: rig.state,
    setEditorDraft: (text) => hooks.drafts?.push(text),
    notify: (text, options) => {
      rig.channel.notify(text, options);
    },
    requestStop: (reason) => hooks.stops?.push(reason),
  });
}

function replayEquivalence(rig: ControllerRig): void {
  const replayed = replayTrace(rig.applied, createReducer({ clock: new ManualClock() }), rig.initialState);
  assert.equal(
    serializeCanonicalUiState(replayed),
    serializeCanonicalUiState(rig.state()),
    'live/replay canonical state must be byte-identical',
  );
}

/** First published user-row rowId (rewind target). */
function firstUserRowId(rig: ControllerRig): string {
  const state = rig.state();
  for (const rowId of state.session.rowOrder) {
    const row = state.session.rowsById[rowId];
    if (row?.kind === 'user') return rowId;
  }
  throw new Error('no user row published');
}

// ---------------------------------------------------------------------------
// replayTrace tooling
// ---------------------------------------------------------------------------

test('controller replay: replayTrace treats a Trace object like its event array', () => {
  const rig = createControllerRig({ height: 5 });
  addUserRows(rig, 4);
  const trace: Trace = {
    header: {
      traceId: 'replay-tooling@test',
      title: 'replay tooling',
      origin: 'synthetic',
      createdAt: '2026-01-01T00:00:00.000Z',
      terminalProfile: 'unknown-conservative',
      locale: 'en',
      seed: 0,
      appVersion: '0.0.0-test',
    },
    lines: rig.applied.map((event) => ({ kind: 'event' as const, event })),
  };
  const fromTrace = replayTrace(trace, createReducer({ clock: new ManualClock() }), rig.initialState);
  const fromArray = replayTrace(rig.applied, createReducer({ clock: new ManualClock() }), rig.initialState);
  assert.equal(serializeCanonicalUiState(fromTrace), serializeCanonicalUiState(fromArray));
  assert.equal(serializeCanonicalUiState(fromTrace), serializeCanonicalUiState(rig.state()));
});

test('controller replay: replayTrace is pure (inputs untouched)', () => {
  const rig = createControllerRig({ height: 5 });
  addUserRows(rig, 3);
  const events = rig.applied.map((event) => deepFreeze(structuredClone(event)) as AppEvent);
  const initial = rig.initialState;
  const beforeEvents = serializeCanonicalUiState(replayTrace(events, createReducer({}), initial));
  const beforeInitial = JSON.stringify(initial);
  replayTrace(events, createReducer({}), initial);
  assert.equal(JSON.stringify(initial), beforeInitial, 'initial state object untouched');
  const again = replayTrace(events, createReducer({}), initial);
  assert.equal(serializeCanonicalUiState(again), beforeEvents, 'reusable frozen event array');
});

// ---------------------------------------------------------------------------
// adversarial live/replay equivalence
// ---------------------------------------------------------------------------

test('controller replay: duplicate/out-of-order/gap-heal stream replays byte-identical', () => {
  const rig = createControllerRig({ height: 5 });
  addUserRows(rig, 3);
  const last = (): number => rig.state().bookkeeping.lastAppliedSeq;
  const inject = (seq: number, at: number, body: Partial<AppEvent> & { type: AppEvent['type'] }): AppEvent =>
    ({
      schemaVersion: 1,
      adapterInstanceId: 'rig-adapter',
      durableSessionId: 'rig-session',
      uiSessionGeneration: 'rig-gen',
      resetEpoch: rig.state().session.resetEpoch,
      sessionEpoch: rig.state().session.sessionEpoch,
      source: 'session',
      sourceSeq: `inject-${seq}`,
      seq,
      at,
      ...body,
    }) as AppEvent;

  // A published row to re-upsert idempotently (same revision+bytes = no-op).
  const someRow = rig.state().session.rowsById[rig.state().session.rowOrder[0] as string];
  assert.ok(someRow !== undefined);

  // Build the manual chain on top of the live state, recording every event.
  const manualEvents: AppEvent[] = [];
  let manual = rig.state();
  const apply = (event: AppEvent): void => {
    const validated = validateAppEvent(event);
    manual = rig.reducer.reduce(manual, deepFreeze(validated) as AppEvent);
    manualEvents.push(validated);
  };

  // Duplicate: seq <= lastApplied is dropped (counted).
  apply(inject(last(), 1, { type: 'session/row-upsert', row: someRow }));
  assert.equal(manual.diagnostics.duplicate, rig.state().diagnostics.duplicate + 1);

  // Out-of-order within the gap window: buffer, then fill the hole.
  const base = last();
  const at = 1000;
  apply(inject(base + 2, at + 1, { type: 'session/row-upsert', row: { ...someRow, rowId: `${someRow.rowId}:x2`, sourceSeq: 'x2' } }));
  assert.equal(manual.diagnostics.gapBuffered, rig.state().diagnostics.gapBuffered + 1);
  assert.equal(manual.bookkeeping.lastAppliedSeq, base, 'out-of-order event held in the buffer');
  apply(inject(base + 1, at + 2, { type: 'session/row-upsert', row: { ...someRow, rowId: `${someRow.rowId}:x1`, sourceSeq: 'x1' } }));
  assert.equal(manual.bookkeeping.lastAppliedSeq, base + 2, 'gap buffer drained in order');

  // Force the gap window: >GAP_BUFFER_MAX_EVENTS buffered -> pendingReset.
  const gapStart = manual.bookkeeping.lastAppliedSeq;
  for (let i = 0; i <= GAP_BUFFER_MAX_EVENTS; i++) {
    apply(
      inject(gapStart + 2 + i, at + 10 + i, {
        type: 'session/row-upsert',
        row: { ...someRow, rowId: `${someRow.rowId}:ov-${i}`, sourceSeq: `ov-${i}` },
      }),
    );
  }
  assert.equal(manual.session.pendingReset?.reason, 'snapshot-gap', 'reducer requests the heal');

  // Replay of the identical stream converges byte-identically.
  const manualLive = replayTrace(
    [...rig.applied, ...manualEvents],
    createReducer({ clock: new ManualClock() }),
    rig.initialState,
  );
  assert.equal(
    serializeCanonicalUiState(manualLive),
    serializeCanonicalUiState(manual),
    'live manual chain and replayTrace agree (gap detection included)',
  );
});

test('controller replay: long live scenario replays byte-identical', async () => {
  const rig = createControllerRig({ height: 5, welcomeText: 'welcome' });
  const replay = replayControllerFor(rig);

  // Streaming with merged chunks.
  rig.channel.addUserRow('hello');
  rig.channel.startAssistant('a');
  rig.channel.appendAssistant('b');
  rig.channel.appendAssistant('c');
  rig.clock.advance(20); // flush the merge window
  rig.channel.settleAssistant();

  // Tool row lifecycle, including an error.
  const tool = rig.channel.addToolRow('Bash', 'ls');
  rig.channel.settleTool(tool, 'ok');
  const tool2 = rig.channel.addToolRow('Read');
  rig.channel.failTool(tool2, 'ENOENT');

  // Cancel mid-stream.
  rig.channel.startAssistant('x');
  const streamingRowId = rig.state().session.streamingRowId;
  assert.ok(streamingRowId !== null);
  rig.streaming.cancelStream(streamingRowId);
  rig.channel.appendAssistant('dropped');
  rig.channel.settleAssistant();

  // Scroll commands + resize.
  rig.streaming.ingest({
    ...rig.meta.next('input', 'scr-1'),
    type: 'input/command',
    command: { type: 'scroll', delta: -3 },
  });
  rig.resize(40, 8);
  rig.resize(40, 5);

  // loadOlder prepend (snapshot-gap reset) + rewind truncation.
  rig.channel.foldedPool = [{ id: 901, kind: 'user', text: 'older', seq: 901 }];
  rig.adapter.commands.loadOlder();
  const rowId = firstUserRowId(rig);
  rig.channel.promptRewindResult = null;
  const requested = await replay.requestRewind(rowId);
  assert.equal(requested.kind, 'ready');
  const confirmed = await replay.confirmRewind(rowId);
  assert.equal(confirmed.kind, 'rewound');

  // resume (async withReset) + clear.
  rig.channel.resumeRows = [{ id: 991, kind: 'user', text: 'resumed', seq: 991 }];
  const resumed = await replay.resume('session-2');
  assert.equal(resumed.ok, true);
  replay.clear();

  replayEquivalence(rig);
});

// ---------------------------------------------------------------------------
// rewind flow
// ---------------------------------------------------------------------------

test('controller replay: rewind candidates are user rows without labels, newest first', () => {
  const rig = createControllerRig({ height: 5 });
  const replay = replayControllerFor(rig);
  rig.channel.addUserRow('first');
  rig.channel.addUserRow('second');
  rig.channel.startAssistant('answer');
  rig.channel.settleAssistant();
  const candidates = replay.listRewindCandidates();
  assert.deepEqual(
    candidates.map((candidate) => candidate.text),
    ['second', 'first'],
  );
});

test('controller replay: rewind veto / modes / confirm refill the editor + journal', async () => {
  const rig = createControllerRig({ height: 5 });
  const drafts: string[] = [];
  const replay = replayControllerFor(rig, { drafts });
  rig.channel.addUserRow('pick me');
  rig.channel.startAssistant('answer');
  rig.channel.settleAssistant();
  const rowId = firstUserRowId(rig);

  // Veto branch.
  rig.channel.promptRewindResult = 'cancel';
  assert.deepEqual(await replay.requestRewind(rowId), { kind: 'cancelled' });

  // Modes branch.
  rig.channel.promptRewindResult = { modes: [{ id: 'm1', label: 'Mode 1' }] };
  const requested = await replay.requestRewind(rowId);
  assert.equal(requested.kind, 'ready');
  if (requested.kind === 'ready') assert.equal(requested.modes.length, 1);

  // Confirm: rows truncated, editor refilled, journal carries the insert.
  const rowsBefore = rig.state().session.rowOrder.length;
  const confirmed = await replay.confirmRewind(rowId, 'm1');
  assert.equal(confirmed.kind, 'rewound');
  if (confirmed.kind === 'rewound') assert.equal(confirmed.text, 'pick me');
  assert.deepEqual(drafts, ['pick me']);
  assert.ok(rig.state().session.rowOrder.length < rowsBefore, 'rewind truncated the transcript');
  assert.equal(rig.state().viewport.sticky, true, 'back to follow-end after the truncation');
  const insertJournal = rig.applied.find(
    (event) =>
      event.type === 'input/command' &&
      event.command.type === 'editor' &&
      event.command.command === 'insert' &&
      event.command.text === 'pick me',
  );
  assert.ok(insertJournal !== undefined, 'editor/insert journaled for replay');
  assert.ok(rig.channel.notifyLog.some((entry) => /rewound/i.test(entry.text)));

  // Unknown rows never reach the channel.
  assert.deepEqual(await replay.requestRewind('no-such-row'), { kind: 'unknown-row' });
  replayEquivalence(rig);
});

test('controller replay: rewind confirm with an evicted channel row is empty + notified', async () => {
  const rig = createControllerRig({ height: 5 });
  const replay = replayControllerFor(rig);
  rig.channel.addUserRow('gone soon');
  const rowId = firstUserRowId(rig);
  // Evict the ChatRow without a bump: the adapter's rowId map still holds it.
  (rig.channel.rows as ChatRow[]).length = 0;
  const confirmed = await replay.confirmRewind(rowId);
  assert.equal(confirmed.kind, 'empty');
  assert.ok(rig.channel.notifyLog.some((entry) => /unavailable/i.test(entry.text)));
});

test('controller replay: superseded async ops are dropped', async () => {
  const rig = createControllerRig({ height: 5 });
  const replay = replayControllerFor(rig);
  rig.channel.addUserRow('slow prompt');
  const rowId = firstUserRowId(rig);

  let release!: (value: 'cancel' | null) => void;
  const gated = new Promise<'cancel' | null>((resolve) => {
    release = resolve;
  });
  const channel = rig.channel as FakeChannel & {
    promptRewind: (row: ChatRow) => Promise<'cancel' | null>;
  };
  let promptCalls = 0;
  channel.promptRewind = async () => {
    promptCalls += 1;
    // Only the FIRST request parks; the superseding one resolves immediately.
    return promptCalls === 1 ? gated : null;
  };

  const stale = replay.requestRewind(rowId);
  rig.channel.promptRewindResult = null;
  const fresh = replay.requestRewind(rowId); // supersedes `stale`
  release('cancel');
  assert.deepEqual(await stale, { kind: 'superseded' });
  assert.equal((await fresh).kind, 'ready');
  assert.ok(replay.diagnostics().superseded >= 1);
});

// ---------------------------------------------------------------------------
// resume / newSession / clear
// ---------------------------------------------------------------------------

test('controller replay: resume failure journals app/error + notifies; working only notifies', async () => {
  const rig = createControllerRig({ height: 5 });
  const replay = replayControllerFor(rig);
  rig.channel.addUserRow('kept');

  rig.channel.resumeResult = { ok: false, reason: 'failed', error: 'boom' };
  const failed = await replay.resume('missing');
  assert.equal(failed.ok, false);
  assert.ok(rig.channel.notifyLog.some((entry) => entry.color === 'error' && /boom/.test(entry.text)));
  assert.ok(
    rig.state().diagnostics.lastError?.code === 'resume-failed',
    'app/error journaled for failed resumes',
  );

  rig.channel.resumeResult = { ok: false, reason: 'working' };
  const working = await replay.resume('busy');
  assert.deepEqual(working, { ok: false, reason: 'working' });
  assert.ok(rig.channel.notifyLog.some((entry) => /working/i.test(entry.text)));
  assert.equal(replay.diagnostics().resumeFailures, 2);

  rig.channel.resumeRows = [{ id: 991, kind: 'user', text: 'resumed row', seq: 991 }];
  rig.channel.resumeResult = { ok: true };
  const ok = await replay.resume('session-2');
  assert.equal(ok.ok, true);
  assert.equal(rig.state().session.rowOrder.length, 1);
  replayEquivalence(rig);
});

test('controller replay: newSession failure journals + notifies; clear resets', async () => {
  const rig = createControllerRig({ height: 5 });
  const replay = replayControllerFor(rig);
  rig.channel.addUserRow('x');

  rig.channel.newSessionResult = false;
  assert.equal(await replay.newSession(), false);
  assert.equal(rig.state().diagnostics.lastError?.code, 'new-session-failed');

  rig.channel.newSessionResult = true;
  assert.equal(await replay.newSession(), true);
  assert.equal(rig.state().session.rowOrder.length, 0, 'new session clears the transcript');

  rig.channel.addUserRow('y');
  replay.clear();
  assert.equal(rig.state().session.rowOrder.length, 0);
  assert.equal(replay.diagnostics().clears, 1);
  replayEquivalence(rig);
});

// ---------------------------------------------------------------------------
// update restart machine
// ---------------------------------------------------------------------------

test('controller replay: update-restart machine prepared -> committed -> stopped|cancelled', () => {
  const rig = createControllerRig({ height: 5 });
  const stops: string[] = [];
  const replay = replayControllerFor(rig, { stops });
  const machine = replay.updateRestart;

  assert.equal(machine.phase(), 'idle');
  assert.equal(machine.commit(), false, 'commit requires prepare');
  machine.cancel(); // cancel before prepare: no-op
  assert.equal(machine.phase(), 'idle');

  machine.prepare();
  assert.equal(machine.phase(), 'prepared');
  machine.cancel();
  assert.equal(machine.phase(), 'cancelled', 'cancel before commit recovers');
  assert.equal(stops.length, 0);

  machine.prepare();
  assert.equal(machine.commit(), true);
  assert.equal(machine.phase(), 'committed');
  assert.deepEqual(stops, ['teardown']);
  machine.markStopped();
  assert.equal(machine.phase(), 'stopped');
  assert.equal(machine.commit(), false, 'committed is terminal for this machine');
});

// ---------------------------------------------------------------------------
// dependency guard
// ---------------------------------------------------------------------------

test('controller replay: controllers never touch stdout/ANSI/components (static guard)', async () => {
  const controllersDir = path.join(repoRoot, 'src', 'tui-v2', 'controllers');
  const files = (await readdir(controllersDir)).filter((file) => file.endsWith('.ts'));
  assert.ok(files.length >= 5, 'controllers directory scanned');
  const forbidden = /process\.stdout|process\.stderr|console\.|fetch\(|\.write\(|vendor\/|components\//;
  for (const file of files) {
    const source = await readFile(path.join(controllersDir, file), 'utf8');
    const hits = source
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => forbidden.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    assert.deepEqual(
      hits.map(({ index }) => `${file}:${index + 1}`),
      [],
      `${file} must not touch stdout/ANSI/vendor/components`,
    );
  }
});
