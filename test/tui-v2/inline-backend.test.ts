/**
 * tui-v2 WP-07 inline backend unit tests (plan §WP-07).
 *
 * Covers the InlineBackend physical recipes against the contract:
 * capabilities, generation gates, initial append paint, append recipe with
 * the minimal-scroll search (growth / settle / duplicate / blank-pad /
 * mutation-fallback / followEnd gating / missing hint), re-anchor recipes,
 * the exit park patch, and explicit image fallback. Byte-level checks replay the
 * encoded patches through the VirtualTerminal (scrollback included).
 *
 * Top-level names carry "inline"/"scrollback" so
 * `--test-name-pattern 'inline|scrollback|third-party output'` selects them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFrame } from '../../src/tui-v2/renderer/frame-builder.js';
import type { Frame, PatchOperation } from '../../src/tui-v2/renderer/frame.js';
import { INLINE_CAPABILITIES, InlineBackend } from '../../src/tui-v2/terminal/inline-backend.js';
import { unknownConservativeDefaults, type TerminalProfile } from '../../src/tui-v2/terminal/profile.js';
import { encodePatchOperationsSync } from '../../src/tui-v2/terminal/writer.js';
import { canonicalizeFrame, compareGrid } from '../../src/tui-v2/testkit/canonical.js';
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js';
import { harnessModes } from './helpers/fullscreen-harness.js';

const PROFILE: TerminalProfile = {
  ...unknownConservativeDefaults(),
  id: 'inline-unit',
  columns: 10,
  rows: 6,
};

type Reason = 'initial' | 'resize' | 'resume' | 'damage' | 'unknown-mode' | 'cleanup';

function mkFrame(
  frameId: string,
  stateRevision: number,
  lines: readonly string[],
  hint?: { readonly liveStart: number; readonly followEnd: boolean },
  extra: { fullRedraw?: boolean; fullRedrawReason?: Reason; generation?: number } = {},
): Frame {
  return buildFrame({
    frameId,
    stateRevision,
    width: PROFILE.columns,
    height: PROFILE.rows,
    lines,
    profile: PROFILE,
    modes: harnessModes(PROFILE.rows, false),
    cursor: { x: 0, y: 0, visible: false },
    generation: extra.generation ?? 0,
    fullRedraw: extra.fullRedraw ?? false,
    ...(extra.fullRedrawReason !== undefined ? { fullRedrawReason: extra.fullRedrawReason } : {}),
    ...(hint !== undefined ? { inlineHint: hint } : {}),
  });
}

function opKinds(patch: { operations: readonly PatchOperation[] }): string[] {
  return patch.operations.map((op) => op.kind);
}

function opsOfKind<K extends PatchOperation['kind']>(
  patch: { operations: readonly PatchOperation[] },
  kind: K,
): Extract<PatchOperation, { kind: K }>[] {
  return patch.operations.filter((op) => op.kind === kind) as Extract<PatchOperation, { kind: K }>[];
}

const HINT_4 = { liveStart: 4, followEnd: true } as const;

test('inline backend capabilities: inline live region only, frozen', () => {
  const backend = new InlineBackend();
  assert.equal(backend.mode, 'inline');
  assert.equal(backend.capabilities, INLINE_CAPABILITIES);
  assert.deepEqual(INLINE_CAPABILITIES, {
    supportsViewportLayout: false,
    supportsNestedOverlay: false,
    supportsScrollRegion: false,
    supportsInlineLiveRegion: true,
  });
  assert.ok(Object.isFrozen(INLINE_CAPABILITIES));
});

test('inline backend initial paint appends H rows at the current cursor (no CUP, no erase)', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  const frame = mkFrame('f1', 0, ['L0', 'L1', 'L2', 'L3', 'editor', 'status'], HINT_4, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
  });
  const patch = backend.plan(null, frame);
  assert.equal(patch.fullRedraw, true);
  assert.equal(patch.patchSeq, 0);
  const kinds = opKinds(patch);
  assert.deepEqual(kinds, ['resources', 'append', 'append', 'append', 'append', 'append', 'append', 'cursor']);
  const appends = opsOfKind(patch, 'append');
  assert.deepEqual(appends.map((op) => op.feed), [true, true, true, true, true, false]);
  assert.equal(patch.bytes, encodePatchOperationsSync(patch.operations).bytes);

  // Byte-level: a fresh VT (cursor at 0,0) shows the frame, scrollback empty.
  const vt = new VirtualTerminal(PROFILE);
  vt.write(encodePatchOperationsSync(patch.operations).encoded);
  const expected = { ...canonicalizeFrame(frame), scrollback: [] };
  const comparison = compareGrid(vt.snapshot(), { gridEncoding: 'readable', value: expected });
  if (!comparison.ok) assert.fail(`initial paint VT mismatch: ${JSON.stringify(comparison.diffs)}`);
});

test('inline backend generation gates: start ordering, stale frame generation, patchSeq restart', async () => {
  const backend = new InlineBackend();
  assert.throws(() => void backend.start(-1), TypeError);
  await backend.start(1);
  assert.throws(() => void backend.start(0), RangeError);
  const stale = mkFrame('g0', 0, ['x'], HINT_4, { fullRedraw: true, fullRedrawReason: 'initial', generation: 0 });
  assert.throws(() => backend.plan(null, stale), RangeError);

  const f1 = mkFrame('g1a', 1, ['a'], HINT_4, { fullRedraw: true, fullRedrawReason: 'initial', generation: 1 });
  const f2 = mkFrame('g1b', 2, ['a'], HINT_4, { generation: 1 });
  const f3 = mkFrame('g2a', 3, ['a'], HINT_4, { generation: 2 });
  assert.equal(backend.plan(null, f1).patchSeq, 0);
  assert.equal(backend.plan(f1, f2).patchSeq, 1);
  // Generation change forces a full re-anchor and restarts the patchSeq lineage.
  const patch3 = backend.plan(f2, f3);
  assert.equal(patch3.patchSeq, 0);
  assert.equal(patch3.fullRedraw, true);
  assert.ok(opKinds(patch3).includes('erase'), 'generation change re-anchors');
});

test('inline backend append recipe scrolls exactly the departing settled lines', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  const f1 = mkFrame('a1', 0, ['L0', 'L1', 'L2', 'L3', 'editor', 'status'], HINT_4, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
  });
  const f2 = mkFrame('a2', 1, ['L1', 'L2', 'L3', 'L4', 'editor', 'status'], HINT_4);
  const patch1 = backend.plan(null, f1);
  const patch = backend.plan(f1, f2);
  assert.equal(patch.fullRedraw, false);
  // One departing settled line: exactly one feed; the newly settled row 3 is
  // written once; the live region is rewritten over its shifted position
  // (after the scroll its rows sit one line higher than the frame wants).
  assert.deepEqual(opKinds(patch), ['resources', 'line-feed', 'write-cells', 'write-cells', 'write-cells', 'cursor']);
  const feed = opsOfKind(patch, 'line-feed')[0];
  assert.deepEqual({ y: feed.y, count: feed.count }, { y: PROFILE.rows - 1, count: 1 });
  const writes = opsOfKind(patch, 'write-cells');
  assert.deepEqual(writes.map((op) => op.y), [3, 4, 5]);
  assert.equal(writes[0]?.cells.map((cell) => cell.grapheme).join('').trim(), 'L4');

  // Byte-level: L0 lands in scrollback; the screen is frame f2.
  const vt = new VirtualTerminal(PROFILE);
  vt.write(encodePatchOperationsSync(patch1.operations).encoded);
  vt.write(encodePatchOperationsSync(patch.operations).encoded);
  const snapshot = vt.snapshot();
  const expected = canonicalizeFrame(f2);
  const comparison = compareGrid(snapshot, {
    gridEncoding: 'readable',
    value: { ...expected, scrollback: snapshot.scrollback },
  });
  if (!comparison.ok) assert.fail(`append recipe VT mismatch: ${JSON.stringify(comparison.diffs)}`);
  assert.equal(snapshot.scrollback.length, 1, 'exactly one line scrolled into scrollback');
  assert.equal(
    snapshot.scrollback[0]?.map((cell) => cell.grapheme).join('').trim(),
    'L0',
    'scrollback received the departing top line (no duplication, no copy of the update)',
  );
});

test('inline backend settle appends newly settled rows without scrolling', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  // Streaming row inside the live region (row 3, liveStart=3); it settles
  // into rows [3..5) while the dock stays live (liveStart 5).
  const f1 = mkFrame('s1', 0, ['L1', 'L2', 'L3', 'S…', 'editor', 'status'], { liveStart: 3, followEnd: true }, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
  });
  const f2 = mkFrame('s2', 1, ['L1', 'L2', 'L3', 'S done', 'editor', 'status'], { liveStart: 5, followEnd: true });
  backend.plan(null, f1);
  const patch = backend.plan(f1, f2);
  // k=0 (nothing departed): no line-feed; the newly settled rows [3..5) are
  // rewritten (they held live content); the dock row 5 is unchanged.
  assert.deepEqual(opKinds(patch), ['resources', 'write-cells', 'write-cells', 'cursor']);
  assert.deepEqual(opsOfKind(patch, 'write-cells').map((op) => op.y), [3, 4]);
});

test('inline backend picks the minimal scroll count on repeated content', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  // Repeated 'X' rows make k=1 and k=2 both seamless; the smaller k wins
  // (宁缺勿滥: never scroll more than the departing settled lines).
  const f1 = mkFrame('r1', 0, ['X', 'X', 'X', 'D', 'e', 's'], HINT_4, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
  });
  const f2 = mkFrame('r2', 1, ['X', 'X', 'D', 'N', 'e', 's'], HINT_4);
  backend.plan(null, f1);
  const patch = backend.plan(f1, f2);
  const feeds = opsOfKind(patch, 'line-feed');
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0]?.count, 1, 'minimal k chosen over larger seamless shifts');
  // Row 3 is the newly settled 'N'; rows 4-5 are the live region rewritten
  // over its post-scroll position.
  assert.deepEqual(opsOfKind(patch, 'write-cells').map((op) => op.y), [3, 4, 5]);
});

test('inline backend refuses to scroll blank pad rows into scrollback', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  // Bottom-aligned region still filling the viewport: growth shifts content
  // up over blank pad rows. Scrolling them would only add blank noise to the
  // shell's scrollback — repaint instead (identical screen).
  const f1 = mkFrame('b1', 0, ['', '', 'editor', 'status', '', ''], { liveStart: 2, followEnd: true }, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
  });
  const f2 = mkFrame('b2', 1, ['', 'L1', 'editor', 'status', '', ''], { liveStart: 2, followEnd: true });
  backend.plan(null, f1);
  const patch = backend.plan(f1, f2);
  assert.equal(opsOfKind(patch, 'line-feed').length, 0, 'blank-only scroll refused');
  assert.deepEqual(opsOfKind(patch, 'write-cells').map((op) => op.y), [1], 'row 1 repainted in place');
});

test('inline backend repaints in place when followEnd is broken (internal scroll never feeds scrollback)', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  const f1 = mkFrame('w1', 0, ['L0', 'L1', 'L2', 'L3', 'editor', 'status'], HINT_4, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
  });
  // Same content shift as the append-recipe test, but the window is NOT
  // follow-end (user browsing): repaint, never feed.
  const f2 = mkFrame('w2', 1, ['L1', 'L2', 'L3', 'L4', 'editor', 'status'], { liveStart: 4, followEnd: false });
  backend.plan(null, f1);
  const patch = backend.plan(f1, f2);
  assert.equal(opsOfKind(patch, 'line-feed').length, 0);
  assert.deepEqual(opsOfKind(patch, 'write-cells').map((op) => op.y), [0, 1, 2, 3]);
});

test('inline backend falls back to repaint when a settled row mutated', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  const f1 = mkFrame('m1', 0, ['A', 'B', 'C', 'D', 'editor', 'status'], HINT_4, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
  });
  const f2 = mkFrame('m2', 1, ['A', 'B-mutated', 'C', 'D', 'editor', 'status'], HINT_4);
  backend.plan(null, f1);
  const patch = backend.plan(f1, f2);
  assert.equal(opsOfKind(patch, 'line-feed').length, 0, 'no seamless shift exists — no scroll');
  assert.deepEqual(opsOfKind(patch, 'write-cells').map((op) => op.y), [1], 'mutated row repainted in place');
});

test('inline backend without hints repaints row-wise (missing hint is not an error)', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  const f1 = mkFrame('h1', 0, ['A', 'B', 'C', 'D', 'editor', 'status'], undefined, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
  });
  const f2 = mkFrame('h2', 1, ['A', 'B2', 'C', 'D', 'editor!', 'status']);
  backend.plan(null, f1);
  const patch = backend.plan(f1, f2);
  assert.equal(opsOfKind(patch, 'line-feed').length, 0);
  assert.deepEqual(opsOfKind(patch, 'write-cells').map((op) => op.y), [1, 4]);
});

test('inline backend re-anchors on damage (erase + absolute rewrite, no feed)', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  const f1 = mkFrame('d1', 0, ['A', 'B', 'C', 'D', 'editor', 'status'], HINT_4, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
  });
  const f2 = mkFrame('d2', 1, ['A', 'B', 'C', 'D', 'editor', 'status'], HINT_4, {
    fullRedraw: true,
    fullRedrawReason: 'damage',
  });
  backend.plan(null, f1);
  const patch = backend.plan(f1, f2);
  assert.equal(patch.fullRedraw, true);
  const kinds = opKinds(patch);
  assert.equal(kinds[0], 'resources');
  assert.equal(kinds[1], 'erase');
  assert.deepEqual(opsOfKind(patch, 'erase').map((op) => [op.x, op.y, op.width, op.height]), [[0, 0, 10, 6]]);
  assert.equal(opsOfKind(patch, 'write-cells').length, 6, 'every row rewritten');
  assert.equal(opsOfKind(patch, 'line-feed').length + opsOfKind(patch, 'append').length, 0, 'no feed/append in a re-anchor');
  const encoded = encodePatchOperationsSync(patch.operations).encoded;
  assert.ok(!encoded.includes('\x1b[3J'), 'never the dangerous scrollback clear');
  assert.ok(!/\x1b\[[\d;]*r/.test(encoded), 'never DECSTBM');
});

test('inline backend re-anchors (never appends) when the first frame is a resize reset', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  // previous === null with a non-initial reason: the screen is dirty, so the
  // recipe is erase + rewrite even without a previous frame.
  const frame = mkFrame('rz', 0, ['X'], HINT_4, { fullRedraw: true, fullRedrawReason: 'resize' });
  const patch = backend.plan(null, frame);
  assert.ok(opKinds(patch).includes('erase'));
  assert.equal(opsOfKind(patch, 'append').length, 0);
});

test('inline backend exit park: null before any frame, then feed + visible cursor below the frame', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  assert.equal(backend.planExitPark(0), null, 'nothing painted — nothing to park under');
  const frame = mkFrame('p1', 7, ['top', 'mid', 'bottom', 'D', 'editor', 'status'], HINT_4, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
  });
  const painted = backend.plan(null, frame);
  const park = backend.planExitPark(0);
  assert.ok(park !== null);
  assert.deepEqual(opKinds(park), ['line-feed', 'cursor']);
  const feed = opsOfKind(park, 'line-feed')[0];
  assert.deepEqual({ y: feed.y, count: feed.count }, { y: PROFILE.rows - 1, count: 1 });
  const cursor = opsOfKind(park, 'cursor')[0];
  assert.deepEqual({ x: cursor.x, y: cursor.y, visible: cursor.visible }, { x: 0, y: PROFILE.rows - 1, visible: true });
  assert.equal(park.patchSeq, painted.patchSeq + 1, 'patchSeq lineage continues');
  assert.equal(park.stateRevision, 7, 'stateRevision is the last frame’s');
  assert.equal(park.bytes, encodePatchOperationsSync(park.operations).bytes);

  // Byte-level: the top frame line moves into scrollback; the cursor rests
  // visible on the blank bottom row.
  const vt = new VirtualTerminal(PROFILE);
  vt.write(encodePatchOperationsSync(painted.operations).encoded);
  vt.write(encodePatchOperationsSync(park.operations).encoded);
  const snapshot = vt.snapshot();
  assert.equal(snapshot.scrollback.length, 1);
  assert.equal(snapshot.scrollback[0]?.map((cell) => cell.grapheme).join('').trim(), 'top');
  const cursorNow = snapshot.cursor as { x: number; y: number; visible: boolean };
  assert.deepEqual(cursorNow, { x: 0, y: PROFILE.rows - 1, visible: true });
});

test('inline backend exit park is stale-safe across generations', async () => {
  const backend = new InlineBackend();
  await backend.start(1);
  const frame = mkFrame('pg', 0, ['x'], HINT_4, { fullRedraw: true, fullRedrawReason: 'initial', generation: 1 });
  backend.plan(null, frame);
  assert.equal(backend.planExitPark(0), null, 'older generation never writes into a newer session');
  assert.ok(backend.planExitPark(1) !== null);
  assert.throws(() => backend.planExitPark(-1), TypeError);
});

test('inline backend image capability is an explicit unsupported fallback, never fullscreen parity', async () => {
  const diagnostics: string[] = [];
  const backend = new InlineBackend({
    profile: { ...PROFILE, imageProtocol: 'kitty' },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
  });
  await backend.start(0);
  const base = mkFrame('img', 0, ['[Image unavailable]'], HINT_4, { fullRedraw: true, fullRedrawReason: 'initial' });
  const frame: Frame = {
    ...base,
    images: [
      {
        imageId: 'img-1',
        protocol: 'kitty',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        payloadHash: '1'.repeat(64),
        storeKey: `image:kitty:${'1'.repeat(64)}`,
      },
    ],
  };
  const patch = backend.plan(null, frame);
  assert.equal(patch.operations.some((operation) => operation.kind.startsWith('image-')), false);
  assert.ok(patch.operations.some((operation) => operation.kind === 'append'), 'append-only initial recipe remains intact');
  assert.deepEqual(diagnostics, ['unsupported-image']);
});

test('inline backend identical frame produces a resources-only patch', async () => {
  const backend = new InlineBackend();
  await backend.start(0);
  const f1 = mkFrame('i1', 0, ['A', 'B', 'C', 'D', 'editor', 'status'], HINT_4, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
  });
  const f2 = mkFrame('i2', 1, ['A', 'B', 'C', 'D', 'editor', 'status'], HINT_4);
  backend.plan(null, f1);
  const patch = backend.plan(f1, f2);
  assert.deepEqual(opKinds(patch), ['resources'], 'no cell/cursor/mode ops when nothing changed');
});
