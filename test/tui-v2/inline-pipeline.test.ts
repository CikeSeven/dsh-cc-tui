/**
 * tui-v2 WP-07 inline pipeline tests (plan §WP-07).
 *
 * Three layers:
 *  1. `computeInlineLiveRegion` unit tests — the append-only boundary math
 *     (pad, first-visible-mutable, unseen indicator, followEnd passthrough).
 *  2. Trace replay through the inline pipeline (`runInlineTraceReplay`, the
 *     same runner `--check inline` uses): every selected trace must be ok;
 *     the purpose-built `inline-scrollback` trace must actually SCROLL settled
 *     lines into scrollback; the overlay trace must strip overlays.
 *  3. Coordinator-level overlay degradation: an inline rig with a real
 *     approval store proves the hidden-overlay path — warning notification,
 *     `overlay/unsupported` diagnostic, dialog absent from the screen, keys
 *     still routed to the (invisible) dialog.
 *
 * Top-level names carry "inline"/"scrollback" so
 * `--test-name-pattern 'inline|scrollback|third-party output'` selects them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';

import { computeInlineLiveRegion } from '../../src/tui-v2/app/inline-live-region.js';
import { createTuiV2Coordinator } from '../../src/tui-v2/app/coordinator.js';
import type { Clock } from '../../src/tui-v2/model/schema.js';
import { buildHeightIndex } from '../../src/tui-v2/renderer/base-renderer.js';
import { unknownConservativeDefaults, type TerminalProfile } from '../../src/tui-v2/terminal/profile.js';
import { readTrace, type Trace } from '../../src/tui-v2/testkit/trace.js';
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js';
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js';
import { createFakeChannel, type FakeChannel } from './helpers/fake-channel.js';
import { createFakeApprovalStore, type FakeApprovalStore } from './helpers/fake-dialog-stores.js';
import { runInlineTraceReplay, type InlineTraceReplayResult } from './helpers/inline-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tracesDir = path.join(repoRoot, 'fixtures', 'tui-v2', 'traces');

async function loadTrace(name: string): Promise<Trace> {
  return readTrace(path.join(tracesDir, `${name}.jsonl`));
}

// ---------------------------------------------------------------------------
// computeInlineLiveRegion
// ---------------------------------------------------------------------------

test('inline live region: all settled rows push liveStart to the dock boundary', () => {
  const hint = computeInlineLiveRegion({
    transcriptHeight: 8,
    scrollTopLine: 2,
    heightIndex: buildHeightIndex([
      { rowId: 'r0', height: 3 },
      { rowId: 'r1', height: 3 },
      { rowId: 'r2', height: 3 },
    ]),
    isMutableRow: () => false,
    showUnseenIndicator: false,
    followEnd: true,
  });
  assert.deepEqual(hint, { liveStart: 8, followEnd: true });
});

test('inline live region: the first visible mutable row starts the live region (pad-adjusted)', () => {
  // totalHeight 9, window [2..9) on a transcript area of 8 rows: pad = 1.
  // r1 covers lines [3..6), first visible at 3 -> liveStart = 1 + (3-2) = 2.
  const hint = computeInlineLiveRegion({
    transcriptHeight: 8,
    scrollTopLine: 2,
    heightIndex: buildHeightIndex([
      { rowId: 'r0', height: 3 },
      { rowId: 'r1', height: 3 },
      { rowId: 'r2', height: 3 },
    ]),
    isMutableRow: (rowId) => rowId === 'r1',
    showUnseenIndicator: false,
    followEnd: true,
  });
  assert.deepEqual(hint, { liveStart: 2, followEnd: true });
});

test('inline live region: bottom-aligned pad offsets the mutable row position', () => {
  // Content (4 lines) shorter than the transcript area (8 rows): pad = 4.
  const hint = computeInlineLiveRegion({
    transcriptHeight: 8,
    scrollTopLine: 0,
    heightIndex: buildHeightIndex([
      { rowId: 'r0', height: 2 },
      { rowId: 'r1', height: 2 },
    ]),
    isMutableRow: (rowId) => rowId === 'r1',
    showUnseenIndicator: false,
    followEnd: true,
  });
  assert.deepEqual(hint, { liveStart: 4 + 2, followEnd: true });
});

test('inline live region: unseen indicator reserves the last transcript row', () => {
  const hint = computeInlineLiveRegion({
    transcriptHeight: 8,
    scrollTopLine: 0,
    heightIndex: buildHeightIndex([{ rowId: 'r0', height: 12 }]),
    isMutableRow: () => false,
    showUnseenIndicator: true,
    followEnd: true,
  });
  assert.deepEqual(hint, { liveStart: 7, followEnd: true });
});

test('inline live region: followEnd passes through, empty transcript pins liveStart to 0', () => {
  const base = {
    transcriptHeight: 6,
    scrollTopLine: 0,
    heightIndex: buildHeightIndex([{ rowId: 'r0', height: 2 }]),
    isMutableRow: () => false,
    showUnseenIndicator: false,
  };
  assert.equal(computeInlineLiveRegion({ ...base, followEnd: false }).followEnd, false);
  assert.equal(computeInlineLiveRegion({ ...base, followEnd: true }).followEnd, true);
  assert.deepEqual(computeInlineLiveRegion({ ...base, transcriptHeight: 0, followEnd: true }), {
    liveStart: 0,
    followEnd: true,
  });
});

// ---------------------------------------------------------------------------
// trace replay through the inline pipeline
// ---------------------------------------------------------------------------

function assertReplayOk(result: InlineTraceReplayResult): void {
  if (!result.ok) assert.fail(`inline replay failed: ${JSON.stringify(result.failures.slice(0, 3))}`);
}

test('inline pipeline trace replay: core traces pass on unicode-ambiguous-narrow', async () => {
  const profile = getProfile('unicode-ambiguous-narrow');
  for (const name of ['welcome', 'assistant-stream', 'scroll', 'resize', 'sigcont', 'tool-lifecycle', 'overlay']) {
    const result = runInlineTraceReplay(await loadTrace(name), profile);
    assertReplayOk(result);
    assert.equal(result.frames, result.events, `${name}: one frame per event`);
  }
});

test('inline pipeline trace replay: inline-scrollback feeds settled lines into scrollback (two profiles)', async (t) => {
  for (const profileId of ['unicode-ambiguous-narrow', 'kitty-sync']) {
    await t.test(profileId, async () => {
      const result = runInlineTraceReplay(await loadTrace('inline-scrollback'), getProfile(profileId));
      assertReplayOk(result);
      assert.equal(result.fullRedraws, 2, 'initial + resize only');
      assert.ok(result.feedPatches > 0, 'append recipe fired at least once');
      assert.ok(result.scrollbackLines > 0, 'settled lines landed in scrollback');
    });
  }
});

test('inline pipeline trace replay: overlays are stripped, sigcont re-anchors', async () => {
  const profile = getProfile('unicode-ambiguous-narrow');
  const overlay = runInlineTraceReplay(await loadTrace('overlay'), profile);
  assertReplayOk(overlay);
  assert.ok(overlay.strippedOverlays > 0, 'overlay trace must strip visible overlays inline');
  const sigcont = runInlineTraceReplay(await loadTrace('sigcont'), profile);
  assertReplayOk(sigcont);
  assert.ok(sigcont.fullRedraws >= 2, 'suspend/resume re-anchors');
});

// ---------------------------------------------------------------------------
// coordinator-level overlay degradation (real dialogs controller + store)
// ---------------------------------------------------------------------------

class FakeStdin extends PassThrough {
  readonly isTTY = true;
  readonly rawModes: boolean[] = [];
  setRawMode(raw: boolean): void {
    this.rawModes.push(raw);
  }
}

class VtStream extends Writable {
  constructor(private readonly vt: VirtualTerminal) {
    super();
  }
  override _write(chunk: unknown, _enc: string, cb: (error?: Error | null) => void): void {
    this.vt.write(String(chunk));
    cb();
  }
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

async function waitForReal(condition: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitForReal deadline exceeded');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function screenText(vt: VirtualTerminal): string {
  const snapshot = vt.snapshot();
  const lines: string[] = [];
  for (let y = 0; y < snapshot.height; y++) {
    lines.push(
      snapshot.cells
        .slice(y * snapshot.width, (y + 1) * snapshot.width)
        .map((cell) => cell.grapheme)
        .join(''),
    );
  }
  return lines.join('\n');
}

interface InlineRig {
  readonly vt: VirtualTerminal;
  readonly stdin: FakeStdin;
  readonly channel: FakeChannel;
  readonly approvals: FakeApprovalStore;
  readonly coordinator: ReturnType<typeof createTuiV2Coordinator>;
  readonly diagnostics: string[];
}

function buildInlineRig(): InlineRig {
  const profile: TerminalProfile = { ...unknownConservativeDefaults(), columns: 120, rows: 40 };
  const stdin = new FakeStdin();
  const vt = new VirtualTerminal(profile);
  const stream = new VtStream(vt);
  const channel = createFakeChannel();
  const approvals = createFakeApprovalStore();
  const diagnostics: string[] = [];
  const coordinator = createTuiV2Coordinator({
    channel,
    stdin,
    stdout: { columns: 120, rows: 40, isTTY: true },
    stream,
    profile,
    clock: realClock,
    welcomeText: 'welcome-inline-overlay',
    attachProcessHandlers: false,
    approvalStore: approvals,
    onDiagnostic: (d) => diagnostics.push(d.code),
  });
  return { vt, stdin, channel, approvals, coordinator, diagnostics };
}

test('inline pipeline overlay degradation: hidden dialog warns once, keys still apply, re-arms on close', async () => {
  const rig = buildInlineRig();
  await rig.coordinator.start();
  assert.equal(rig.coordinator.state.terminal.mode, 'inline');
  await waitForReal(() => screenText(rig.vt).includes('welcome-inline-overlay'));

  // Park an approval: the overlay opens in state but is stripped from the frame.
  let outcome: string | null = null;
  void rig.approvals.park({ toolName: 'bash', reason: 'inline-overlay-probe-reason' }).then((value) => {
    outcome = value;
  });
  await waitForReal(() => rig.diagnostics.includes('overlay/unsupported'));
  const warningCount = () =>
    rig.channel.notifyLog.filter((entry) => entry.color === 'warning' && entry.text.includes('Inline mode cannot render overlay')).length;
  assert.equal(warningCount(), 1, 'one degradation warning per overlay');
  assert.ok(!screenText(rig.vt).includes('inline-overlay-probe-reason'), 'dialog content never reaches the inline screen');

  // Keys still route to the hidden dialog: Enter approves (focus index 0).
  rig.stdin.write('\r');
  await waitForReal(() => outcome !== null);
  assert.equal(outcome, 'allowed-once');
  await waitForReal(() => rig.coordinator.state.overlays.stack.length === 0);

  // Stack emptied -> the degradation warning re-arms for the next overlay.
  let second: string | null = null;
  void rig.approvals.park({ toolName: 'bash', reason: 'inline-overlay-probe-2' }).then((value) => {
    second = value;
  });
  await waitForReal(() => warningCount() === 2);
  rig.stdin.write('\r');
  await waitForReal(() => second !== null);

  await rig.coordinator.stop('user-exit');
  await rig.coordinator.awaitStop();
  assert.equal(rig.coordinator.phase, 'stopped');
});
