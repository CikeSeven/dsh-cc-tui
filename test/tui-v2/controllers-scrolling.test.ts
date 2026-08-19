/**
 * WP-05 scrolling controller + reducer scroll semantics.
 *
 * Old-script transcriptions (state-level; grid-level assertions are WP-06):
 *  - repro-pill (REG-017 scroll-pill-decrement@v1): the new-message pill count
 *    (rowsBelowViewport) decreases monotonically while scrolling down, never
 *    increases via scroll commands, and vanishes at the tail.
 *  - verify-scroll (REG-076 scroll-sticky-state@v1): a shrink frame
 *    (maxScroll < scrollTop) freezes the position instead of jumping to 0;
 *    growing back restores normal scrolling.
 *  - verify-shrink (REG-083 shrink-frame-redraw@v1, state part): after a
 *    rewind truncation (rows-reset) the viewport returns to follow-end.
 *  - loadOlder: scroll-to-top pulls folded history synchronously and restores
 *    the anchor row at the window top; restored === 0 is a no-op.
 *
 * Every scenario ends with a live/replay canonical-equivalence assertion
 * (replayTrace over the applied event stream).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serializeCanonicalUiState } from '../../src/tui-v2/model/canonical-state.js';
import { createReducer } from '../../src/tui-v2/model/reducer.js';
import { selectTranscriptView } from '../../src/tui-v2/model/selectors.js';
import type { OverlayState } from '../../src/tui-v2/model/schema.js';
import { createScrollingController } from '../../src/tui-v2/controllers/scrolling.js';
import { replayTrace } from '../../src/tui-v2/controllers/replay.js';
import { createControllerRig, addUserRows, ManualClock, type ControllerRig } from './helpers/controller-rig.js';

function scrollingFor(rig: ControllerRig, options: { prependFallback?: 'top' | 'bottom' } = {}) {
  return createScrollingController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('input', sourceSeq),
    getState: rig.state,
    commands: rig.adapter.commands,
    ...(options.prependFallback !== undefined ? { prependFallback: options.prependFallback } : {}),
    onDiagnostic: (d) => rig.diagnostics.push({ code: `scroll/${d.code}`, message: d.message }),
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

test('controller scrolling: sticky follow + maxScroll maintenance on append/reset', () => {
  const rig = createControllerRig({ height: 5 });
  assert.equal(rig.state().viewport.sticky, true);
  assert.equal(rig.state().viewport.maxScroll, 0);

  addUserRows(rig, 10);
  const viewport = rig.state().viewport;
  assert.equal(viewport.maxScroll, 5, '10 rows - height 5');
  assert.equal(viewport.sticky, true, 'still pinned to the tail');
  assert.equal(viewport.scrollTop, 5, 'sticky follow pins scrollTop to maxScroll');
  assert.equal(viewport.unseenCount, 0);

  const view = selectTranscriptView(rig.state());
  assert.deepEqual(
    view.visibleRows.map((row) => row.sourceId),
    ['user', 'user', 'user', 'user', 'user'],
  );
  assert.equal(view.windowStart, 5);
  replayEquivalence(rig);
});

test('controller scrolling: repro-pill — unseen/pill decrement monotonically (REG-017)', () => {
  const rig = createControllerRig({ height: 5 });
  const scrolling = scrollingFor(rig);
  addUserRows(rig, 10);

  // At the tail: no pill.
  assert.equal(scrolling.rowsBelowViewport(), 0);

  // Wheel up once (3 rows): pill shows the rows below the window.
  assert.equal(scrolling.handleWheel('up'), true);
  let viewport = rig.state().viewport;
  assert.equal(viewport.sticky, false);
  assert.equal(viewport.scrollTop, 2, 'maxScroll 5 - 3 wheel rows');
  assert.equal(scrolling.rowsBelowViewport(), 3);

  // Eight rows arrive while off-bottom: the pill (unseenCount) counts them.
  addUserRows(rig, 8, 'later');
  viewport = rig.state().viewport;
  assert.equal(viewport.unseenCount, 8, 'pill text: "8 new messages"');
  assert.equal(viewport.scrollTop, 2, 'position held while off-bottom');
  assert.equal(viewport.maxScroll, 13);

  // Scroll down one row at a time: the pill count decreases monotonically
  // (capped by the rows actually below the window), never grows, and the
  // rows-below measure strictly decreases to the tail.
  const pillSeries: number[] = [];
  const unseenSeries: number[] = [];
  for (let i = 0; i < 11; i++) {
    scrolling.scrollBy(1);
    pillSeries.push(scrolling.rowsBelowViewport());
    unseenSeries.push(rig.state().viewport.unseenCount);
  }
  assert.deepEqual(pillSeries, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual(unseenSeries, [8, 8, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  for (let i = 1; i < unseenSeries.length; i++) {
    assert.ok(
      (unseenSeries[i] as number) <= (unseenSeries[i - 1] as number),
      `unseenCount must never increase while scrolling down: ${unseenSeries}`,
    );
  }

  // Reached the tail: sticky re-engaged, pill gone.
  viewport = rig.state().viewport;
  assert.equal(viewport.sticky, true);
  assert.equal(viewport.unseenCount, 0);
  assert.equal(viewport.scrollTop, viewport.maxScroll);
  replayEquivalence(rig);
});

test('controller scrolling: wheel up from sticky starts at the tail window', () => {
  const rig = createControllerRig({ height: 5 });
  const scrolling = scrollingFor(rig);
  addUserRows(rig, 30);
  assert.equal(rig.state().viewport.scrollTop, 25);

  scrolling.handleWheel('up');
  assert.equal(rig.state().viewport.scrollTop, 22, 'base is the tail window, not a stale offset');
  replayEquivalence(rig);
});

test('controller scrolling: verify-scroll shrink frame freezes position (REG-076)', () => {
  const rig = createControllerRig({ height: 5 });
  const scrolling = scrollingFor(rig);
  addUserRows(rig, 20);
  scrolling.scrollBy(-5); // scrollTop 15 -> 10, non-sticky
  assert.equal(rig.state().viewport.scrollTop, 10);
  assert.equal(rig.state().viewport.sticky, false);

  // Shrink frame: viewport grows to 18 -> maxScroll 2 < scrollTop 10.
  rig.resize(40, 18);
  let viewport = rig.state().viewport;
  assert.equal(viewport.maxScroll, 2);
  assert.equal(viewport.scrollTop, 10, 'position frozen, no jump to 0');
  assert.equal(viewport.sticky, false);

  // Grow back: the frozen offset is valid again and scrolling resumes.
  rig.resize(40, 5);
  viewport = rig.state().viewport;
  assert.equal(viewport.maxScroll, 15);
  assert.equal(viewport.scrollTop, 10, 'grow-back keeps the frozen position');
  const view = selectTranscriptView(rig.state());
  assert.equal(view.windowStart, 10);
  assert.equal(view.visibleRows.length, 5);

  scrolling.scrollBy(5);
  viewport = rig.state().viewport;
  assert.equal(viewport.sticky, true, 'reaching maxScroll re-engages sticky');
  replayEquivalence(rig);
});

test('controller scrolling: key mapping + overlay focus guard (WP-05b hook)', () => {
  const rig = createControllerRig({ height: 5 });
  const scrolling = scrollingFor(rig);
  addUserRows(rig, 20);

  assert.equal(scrolling.handleKey('pageUp'), true);
  assert.equal(rig.state().viewport.scrollTop, 15 - 4, 'pageUp = height-1 rows');
  assert.equal(scrolling.handleKey('pageDown'), true);
  assert.equal(rig.state().viewport.scrollTop, 15);
  assert.equal(rig.state().viewport.sticky, true);

  assert.equal(scrolling.handleKey('ctrl+home'), true);
  assert.equal(rig.state().viewport.scrollTop, 0);
  assert.equal(rig.state().viewport.sticky, false);
  assert.equal(scrolling.handleKey('ctrl+end'), true);
  assert.equal(rig.state().viewport.sticky, true);

  assert.equal(scrolling.handleKey('left'), false, 'non-scroll keys pass through');
  assert.equal(scrolling.handleKey(null), false);

  // A capturing overlay owns its scrolling: no interception.
  const overlay: OverlayState = {
    overlayId: 'ov',
    revision: 1,
    anchor: 'center',
    visible: true,
    captureInput: true,
    nonCapturing: false,
    payload: { kind: 'test' },
  };
  rig.streaming.ingest({
    ...rig.meta.next('input', 'ov-1'),
    type: 'overlay/open',
    overlay,
  });
  assert.equal(rig.state().focus.target, 'overlay');
  const before = scrolling.diagnostics().scrollCommands;
  assert.equal(scrolling.handleWheel('up'), false);
  assert.equal(scrolling.handleKey('pageUp'), false);
  assert.equal(scrolling.diagnostics().scrollCommands, before, 'no scroll journaled under overlay');
  replayEquivalence(rig);
});

test('controller scrolling: loadOlder restores the anchor row at the window top', () => {
  const rig = createControllerRig({ height: 5 });
  const scrolling = scrollingFor(rig);
  addUserRows(rig, 10);
  rig.channel.foldedPool = [
    { id: 901, kind: 'user', text: 'older-1', seq: 901 },
    { id: 902, kind: 'assistant', text: 'older-2', seq: 902 },
    { id: 903, kind: 'user', text: 'older-3', seq: 903 },
  ];

  // ctrl+home lands on scrollTop 0; the auto-load chain fires synchronously.
  scrolling.handleKey('ctrl+home');
  const viewport = rig.state().viewport;
  assert.equal(rig.channel.foldedPool.length, 0);
  assert.equal(rig.state().session.rowOrder.length, 13);
  assert.equal(scrolling.diagnostics().loadOlderRestored, 3);
  assert.equal(scrolling.diagnostics().anchorRestores, 1);
  assert.equal(viewport.sticky, false);
  assert.equal(viewport.scrollTop, 3, 'anchor row (row-1, now at index 3) back at the window top');

  const view = selectTranscriptView(rig.state());
  assert.equal(view.windowStart, 3);
  const firstBlock = view.visibleRows[0]?.blocks[0] as { text?: unknown } | undefined;
  assert.equal(firstBlock?.text, 'row-1', 'no window jump across the prepend');

  // Second load with an empty pool is a complete no-op.
  scrolling.scrollBy(-3);
  assert.equal(rig.state().viewport.scrollTop, 0);
  const runs = scrolling.diagnostics().loadOlderRuns;
  scrolling.scrollBy(0);
  assert.equal(scrolling.diagnostics().loadOlderRuns, runs, 'restored===0 stays a no-op');
  assert.equal(rig.state().viewport.scrollTop, 0);
  replayEquivalence(rig);
});

test('controller scrolling: loadOlder fallback when the anchor row vanished', () => {
  const rig = createControllerRig({ height: 5 });
  addUserRows(rig, 10);
  const diagnosticsBefore = rig.diagnostics.length;
  const scrolling = scrollingFor(rig);
  scrolling.scrollBy(-15); // scrollTop 0, non-sticky — but suppress auto-load? it fires…
  // The scroll above already auto-loaded (empty pool -> no-op). Now stub a
  // loadOlder that REPLACES the rows (anchor vanishes mid-load).
  const replacement = [{ id: 950, kind: 'user' as const, text: 'fresh-1', seq: 950 }];
  const rowsRef = rig.channel.rows;
  void rowsRef;
  // eslint-disable-next-line no-assign-private -- scripted channel override
  (rig.channel as { loadOlder: () => number }).loadOlder = () => {
    rig.channel.rows.length = 0;
    rig.channel.rows.push(...replacement);
    rig.channel.bump();
    return 1;
  };
  const restored = scrolling.loadOlderAtTop();
  assert.equal(restored, 1);
  assert.equal(scrolling.diagnostics().anchorFallbacks, 1);
  assert.ok(
    rig.diagnostics.some((d) => d.code === 'scroll/scroll-anchor-fallback'),
    'fallback diagnostic reported',
  );
  assert.ok(rig.diagnostics.length > diagnosticsBefore);
  // Fallback 'top': window at the transcript top of the replaced content.
  assert.equal(rig.state().viewport.scrollTop, 0);
  replayEquivalence(rig);
});

test('controller scrolling: delta 0 and empty transcript are no-ops', () => {
  const rig = createControllerRig({ height: 5 });
  const scrolling = scrollingFor(rig);
  const before = rig.state();
  scrolling.scrollBy(0);
  assert.equal(rig.state(), before, 'delta 0 leaves the state untouched');
  scrolling.scrollBy(-3);
  assert.equal(rig.state().viewport.sticky, true, 'empty transcript stays tail-pinned');
  assert.equal(rig.state().viewport.scrollTop, 0);
  replayEquivalence(rig);
});
