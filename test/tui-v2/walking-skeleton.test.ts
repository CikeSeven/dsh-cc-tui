/**
 * tui-v2 WP-04 walking skeleton: the first end-to-end app slice (plan §WP-04).
 *
 * Full chain under test:
 *
 *   FakeChannel → ChannelUiAdapter → StreamingController → reducer → selectors
 *     → base-renderer → linesToFrame → ScreenBackend.plan → TerminalWriter
 *     → VirtualTerminal
 *
 * plus the input path (stdin → InputSource → InputController → PromptEditor /
 * channel commands / exit) and teardown (VT modes back to defaults, stdin raw
 * mode restored).
 *
 * Runs twice: kitty-sync (fullscreen, alt screen) and unknown-conservative
 * (inline degradation). Controller/adapter units run on a ManualClock; the
 * end-to-end tests use the real clock and poll the VT with deadlines.
 *
 * Top-level names carry "walking skeleton"/"input"/"stream" so
 * `--test-name-pattern 'walking skeleton|input|stream'` selects this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { AppEvent } from '../../src/tui-v2/model/events.js';
import type { Clock, EventMeta } from '../../src/tui-v2/model/schema.js';
import { createTuiV2Coordinator } from '../../src/tui-v2/app/coordinator.js';
import { createInputController } from '../../src/tui-v2/controllers/input.js';
import {
  createChannelUiAdapter,
  createEventMetaFactory,
} from '../../src/tui-v2/controllers/session-events.js';
import { createStreamingController } from '../../src/tui-v2/controllers/streaming.js';
import { unknownConservativeDefaults, type TerminalProfile } from '../../src/tui-v2/terminal/profile.js';
import type { TerminalInputEvent } from '../../src/tui-v2/terminal/input.js';
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js';
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js';
import { findLineWidthViolations } from '../../src/tui-v2/testkit/frame-assert.js';
import { createFakeChannel, type FakeChannel } from './helpers/fake-channel.js';
import { runSkeletonChild } from './helpers/run-skeleton-child.js';

// ---------------------------------------------------------------------------
// doubles (mirrors of the pi-fork-integration rig)
// ---------------------------------------------------------------------------

class ManualClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers: Array<{ id: number; at: number; cb: () => void }> = [];
  now(): number {
    return this.t;
  }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, delayMs), cb: callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.t = due.at;
      due.cb();
    }
    this.t = target;
  }
}

class FakeStdin extends PassThrough {
  readonly isTTY = true;
  readonly rawModes: boolean[] = [];
  override setRawMode(raw: boolean): void {
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

function keyEvent(key: string | null, raw: string): TerminalInputEvent {
  return { kind: 'key', sequence: 0, generation: 0, payload: { key, raw, text: null, eventType: 'press' } };
}

function testMeta(seq: number, source: EventMeta['source'] = 'session'): EventMeta {
  return {
    schemaVersion: 1,
    adapterInstanceId: 'test-adapter',
    durableSessionId: 'test-session',
    uiSessionGeneration: 'gen-1',
    resetEpoch: 0,
    sessionEpoch: 'gen-1:0',
    source,
    sourceSeq: `s-${seq}`,
    seq,
    at: 0,
  };
}

// ---------------------------------------------------------------------------
// end-to-end rig
// ---------------------------------------------------------------------------

interface Rig {
  profile: TerminalProfile;
  stdin: FakeStdin;
  vt: VirtualTerminal;
  channel: FakeChannel;
  coordinator: ReturnType<typeof createTuiV2Coordinator>;
  diagnostics: string[];
}

function buildRig(profileId: 'kitty-sync' | 'unknown-conservative'): Rig {
  const base = profileId === 'kitty-sync' ? getProfile('kitty-sync') : unknownConservativeDefaults();
  const profile: TerminalProfile = { ...base, columns: 120, rows: 40 };
  const stdin = new FakeStdin();
  const stdout = { columns: 120, rows: 40, isTTY: true };
  const vt = new VirtualTerminal(profile);
  const stream = new VtStream(vt);
  const channel = createFakeChannel();
  const diagnostics: string[] = [];
  const coordinator = createTuiV2Coordinator({
    channel,
    stdin,
    stdout,
    stream,
    profile,
    clock: realClock,
    welcomeText: 'welcome-to-skeleton',
    attachProcessHandlers: false,
    onDiagnostic: (d) => diagnostics.push(d.code),
  });
  return { profile, stdin, vt, channel, coordinator, diagnostics };
}

async function runConversation(rig: Rig): Promise<void> {
  const { channel, stdin, vt } = rig;
  await waitForReal(() => screenText(vt).includes('welcome-to-skeleton'));

  // Editor echo through the real stdin decode path.
  stdin.write('hello skeleton');
  await waitForReal(() => screenText(vt).includes('hello skeleton'));

  // Enter submits to the channel; the fake answers with a streaming row.
  channel.onSubmit = () => {
    channel.startAssistant('Hello');
  };
  stdin.write('\r');
  await waitForReal(() => channel.submitted.includes('hello skeleton'));

  // Stream growth lands in the VT (merged through the streaming controller).
  for (const chunk of [', ', 'stream', ' grows', ' here']) {
    channel.appendAssistant(chunk);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  channel.settleAssistant();
  await waitForReal(() => screenText(vt).includes('stream grows here'));

  // Tool card: running -> result transitions through settled-row republish.
  const tool = channel.addToolRow('bash', '{"cmd":"ls"}');
  await waitForReal(() => screenText(vt).includes('bash'));
  channel.settleTool(tool, 'file-a.txt');
  await waitForReal(() => screenText(vt).includes('file-a.txt'));
}

function assertTeardown(rig: Rig): void {
  const modes = rig.vt.snapshot().modes;
  assert.equal(modes.alternateScreen === true, false, 'alternate screen restored');
  assert.equal(modes.rawInput === true, false, 'raw input restored');
  assert.equal(modes.bracketedPaste === true, false, 'bracketed paste restored');
  assert.equal(modes.kittyKeyboard === true, false, 'kitty keyboard restored');
  assert.equal(modes.syncOutput === true, false, 'sync output restored');
  assert.equal(rig.stdin.rawModes.length > 0, true, 'raw mode was toggled');
  assert.equal(rig.stdin.rawModes[rig.stdin.rawModes.length - 1], false, 'raw mode restored last');
  assert.equal(
    findLineWidthViolations(rig.vt.snapshot()).length,
    0,
    'no physical line exceeds the viewport',
  );
}

test('walking skeleton (kitty-sync fullscreen): welcome, input echo, stream growth, tool card, ctrl+c exit, clean teardown', async () => {
  const rig = buildRig('kitty-sync');
  await rig.coordinator.start();
  assert.equal(rig.coordinator.phase, 'active');

  await runConversation(rig);

  // Ctrl+C rule 2: non-empty editor draft is cleared (no exit).
  rig.stdin.write('draft text');
  await waitForReal(() => screenText(rig.vt).includes('draft text'));
  rig.stdin.write('\x03');
  await waitForReal(() => !screenText(rig.vt).includes('draft text'));
  assert.equal(rig.coordinator.phase, 'active');

  // Ctrl+C rule 3/4: empty editor arms; the second press exits.
  rig.stdin.write('\x03');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(rig.coordinator.phase, 'active');
  rig.stdin.write('\x03');
  await rig.coordinator.awaitStop();
  assert.equal(rig.coordinator.phase, 'stopped');
  assertTeardown(rig);
});

test('walking skeleton (unknown-conservative inline): degraded mode renders the full chain', async () => {
  const rig = buildRig('unknown-conservative');
  await rig.coordinator.start();
  assert.equal(rig.coordinator.phase, 'active');
  assert.equal(rig.coordinator.state.terminal.mode, 'inline');
  assert.ok(rig.diagnostics.includes('mode/degraded-inline'));

  await runConversation(rig);

  await rig.coordinator.stop('user-exit');
  await rig.coordinator.awaitStop();
  assert.equal(rig.coordinator.phase, 'stopped');
  assertTeardown(rig);
});

test('walking skeleton input: ctrl+c cancels a working turn (no exit, no clear)', async () => {
  const rig = buildRig('kitty-sync');
  await rig.coordinator.start();
  rig.channel.startAssistant('working');
  await waitForReal(() => screenText(rig.vt).includes('working'));

  rig.stdin.write('\x03');
  await waitForReal(() => rig.channel.cancelCount === 1);
  assert.equal(rig.coordinator.phase, 'active');
  const journal = rig.coordinator.state.pendingCommands.map((entry) => entry.command);
  assert.ok(
    journal.some((command) => command.type === 'app' && command.command === 'interrupt'),
    'app interrupt journaled',
  );

  await rig.coordinator.stop('user-exit');
  await rig.coordinator.awaitStop();
  assertTeardown(rig);
});

// ---------------------------------------------------------------------------
// child-process scenarios (normal exit / SIGTERM / injected fault)
// ---------------------------------------------------------------------------

test('walking skeleton child: normal exit, SIGTERM, injected error all restore the terminal', async () => {
  const reportDir = await mkdtemp(join(tmpdir(), 'tui-v2-skeleton-'));
  const normal = await runSkeletonChild('normal', { reportDir });
  assert.equal(normal.exitCode, 0, `normal child failed: ${normal.stderrTail}`);
  assert.equal(normal.report.checks.welcomeSeen, true);
  assert.equal(normal.report.checks.streamSeen, true);
  assert.equal(normal.report.checks.toolResultSeen, true);
  assert.equal(normal.report.checks.modesRestored, true);
  assert.equal(normal.report.stdinRawModes[normal.report.stdinRawModes.length - 1], false);

  const sigterm = await runSkeletonChild('sigterm', { reportDir });
  assert.equal(sigterm.exitCode, 0, `sigterm child failed: ${sigterm.stderrTail}`);
  assert.equal(sigterm.report.checks.sigtermStopped, true);
  assert.equal(sigterm.report.vtModesAfterStop.alternateScreen, false);

  const fault = await runSkeletonChild('error', { reportDir });
  assert.equal(fault.exitCode, 3, `error child exit: ${fault.stderrTail}`);
  assert.equal(fault.report.checks.errorStopped, true);
  assert.equal(fault.report.vtModesAfterStop.alternateScreen, false);
});

// ---------------------------------------------------------------------------
// streaming controller units (ManualClock)
// ---------------------------------------------------------------------------

test('streaming controller: merges a chunk burst into one windowed stream event', () => {
  const clock = new ManualClock();
  const out: AppEvent[] = [];
  const controller = createStreamingController({ clock, windowMs: 16, dispatch: (event) => out.push(event) });

  controller.ingest({ ...testMeta(1), type: 'stream/chunk', rowId: 'r1', text: 'a' });
  controller.ingest({ ...testMeta(2), type: 'stream/chunk', rowId: 'r1', text: 'b' });
  controller.ingest({ ...testMeta(3), type: 'stream/chunk', rowId: 'r2', text: 'x' });
  assert.equal(out.length, 0, 'chunks buffered inside the window');
  clock.advance(16);
  assert.equal(out.length, 2);
  const [first, second] = out as [
    Extract<AppEvent, { type: 'stream/chunk' }>,
    Extract<AppEvent, { type: 'stream/chunk' }>,
  ];
  assert.equal(first.type, 'stream/chunk');
  assert.equal(first.text, 'ab', 'burst text merged into the first carrier');
  assert.equal(first.rowId, 'r1');
  assert.equal(second.rowId, 'r2');
  // Re-sequenced contiguously; upstream seq preserved as causalSeq.
  assert.equal(first.seq, 1);
  assert.equal(first.causalSeq, 1);
  assert.equal(second.seq, 2);
  assert.equal(second.causalSeq, 3);
  assert.equal(controller.diagnostics().mergedChunks, 1);
  assert.equal(controller.diagnostics().windowsFlushed, 1);
});

test('streaming controller: non-chunk events flush first and keep causal order', () => {
  const clock = new ManualClock();
  const out: AppEvent[] = [];
  const controller = createStreamingController({ clock, dispatch: (event) => out.push(event) });

  controller.ingest({ ...testMeta(1), type: 'stream/chunk', rowId: 'r1', text: 'a' });
  controller.ingest({ ...testMeta(2), type: 'stream/settled', rowId: 'r1', revision: 3 });
  assert.equal(out.length, 2, 'settled barrier flushed the pending chunk immediately');
  assert.equal(out[0]?.type, 'stream/chunk');
  assert.equal(out[1]?.type, 'stream/settled');
  assert.deepEqual(
    out.map((event) => event.seq),
    [1, 2],
  );
});

test('streaming controller: cancelStream drops stream chunks (counted), settle releases', () => {
  const clock = new ManualClock();
  const out: AppEvent[] = [];
  const controller = createStreamingController({ clock, dispatch: (event) => out.push(event) });

  controller.cancelStream('r1');
  controller.ingest({ ...testMeta(1), type: 'stream/chunk', rowId: 'r1', text: 'a' });
  clock.advance(33);
  assert.equal(out.length, 0, 'cancelled chunk dropped');
  assert.equal(controller.diagnostics().droppedChunks, 1);

  controller.ingest({ ...testMeta(2), type: 'stream/settled', rowId: 'r1', revision: 1 });
  controller.ingest({ ...testMeta(3), type: 'stream/chunk', rowId: 'r1', text: 'b' });
  clock.advance(33);
  assert.equal(out.length, 2, 'settled released the mark; later chunks flow again');
  assert.equal(out[1]?.type, 'stream/chunk');
});

// ---------------------------------------------------------------------------
// input controller units (ManualClock)
// ---------------------------------------------------------------------------

function buildInputRig(overrides: { working?: boolean } = {}) {
  const clock = new ManualClock();
  const journal: AppEvent[] = [];
  const editor = {
    text: '',
    fed: [] as string[],
    cleared: 0,
  };
  const calls = { submit: [] as string[], cancel: 0, exit: 0 };
  let seq = 0;
  const controller = createInputController({
    clock,
    dispatch: (event) => journal.push(event),
    nextMeta: (sourceSeq) => ({ ...testMeta(++seq, 'input'), sourceSeq }),
    editor: {
      handleRawInput: (raw) => {
        editor.fed.push(raw);
        if (raw === '\r') {
          controller.handleEditorCommand({ type: 'editor', command: 'submit', text: editor.text });
          editor.text = '';
        } else {
          editor.text += raw;
        }
      },
      getText: () => editor.text,
      clearText: () => {
        editor.cleared += 1;
        editor.text = '';
      },
    },
    commands: {
      submit: (text) => calls.submit.push(text),
      cancel: () => {
        calls.cancel += 1;
      },
    },
    isWorking: () => overrides.working === true,
    onExitRequest: () => {
      calls.exit += 1;
    },
  });
  return { clock, journal, editor, calls, controller };
}

test('input controller: ctrl+c rules — cancel while working, clear draft, arm, exit', () => {
  const working = buildInputRig({ working: true });
  working.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  assert.equal(working.calls.cancel, 1, 'working turn cancelled');
  assert.equal(working.editor.cleared, 0);
  assert.ok(
    working.journal.some(
      (event) => event.type === 'input/command' && event.command.type === 'app' && event.command.command === 'interrupt',
    ),
  );

  const idle = buildInputRig();
  idle.editor.text = 'draft';
  idle.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  assert.equal(idle.editor.cleared, 1, 'non-empty draft cleared');
  assert.equal(idle.calls.exit, 0);
  assert.equal(idle.editor.text, '');

  // Empty editor: first press arms, second inside the window exits.
  idle.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  assert.equal(idle.calls.exit, 0, 'first press only arms');
  idle.clock.advance(500);
  idle.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  assert.equal(idle.calls.exit, 1, 'second press exits');
  assert.ok(
    idle.journal.some(
      (event) => event.type === 'input/command' && event.command.type === 'app' && event.command.command === 'exit',
    ),
  );

  // Outside the window the arm expires.
  const expired = buildInputRig();
  expired.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  expired.clock.advance(3000);
  expired.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  assert.equal(expired.calls.exit, 0, 'arm window expired: still armed, no exit');
});

test('input controller: keys route to the editor; enter submits non-empty text', () => {
  const rig = buildInputRig();
  rig.controller.handleEvent(keyEvent(null, 'h'));
  rig.controller.handleEvent(keyEvent(null, 'i'));
  assert.equal(rig.editor.text, 'hi');
  rig.controller.handleEvent(keyEvent('enter', '\r'));
  assert.deepEqual(rig.calls.submit, ['hi']);
  assert.equal(rig.editor.text, '', 'editor cleared after submit');

  // Empty submit is journaled but not forwarded to the channel.
  rig.controller.handleEditorCommand({ type: 'editor', command: 'submit', text: '   ' });
  assert.equal(rig.calls.submit.length, 1);
  assert.equal(rig.controller.diagnostics().keyEvents, 3);
});

// ---------------------------------------------------------------------------
// session-events adapter units (no terminal)
// ---------------------------------------------------------------------------

test('session-events adapter: initial reset + stream diff + settle + structural reset + gap recovery', () => {
  const channel = createFakeChannel();
  const clock = new ManualClock();
  const meta = createEventMetaFactory({
    adapterInstanceId: 'a1',
    durableSessionId: 's1',
    uiSessionGeneration: 'g1',
    clock,
  });
  const events: AppEvent[] = [];
  const adapter = createChannelUiAdapter({
    channel,
    meta,
    dispatch: (event) => events.push(event),
    welcomeText: 'welcome-to-skeleton',
  });

  adapter.start();
  assert.equal(events[0]?.type, 'session/rows-reset', 'initial reset published');
  assert.equal(events[1]?.type, 'session/row-upsert', 'welcome row published');
  const welcome = (events[1] as Extract<AppEvent, { type: 'session/row-upsert' }>).row;
  assert.equal(welcome.kind, 'local');

  // Streaming growth diffs to stream/chunk with only the delta text.
  channel.startAssistant('Hel');
  channel.appendAssistant('lo');
  channel.settleAssistant();
  const types = events.map((event) => event.type);
  const chunk = events.find((event) => event.type === 'stream/chunk') as
    | Extract<AppEvent, { type: 'stream/chunk' }>
    | undefined;
  assert.ok(chunk !== undefined, 'stream/chunk emitted');
  assert.equal(chunk.text, 'lo');
  assert.ok(types.includes('stream/settled'), 'settle pinned');

  // Structural break (rows dropped) forces a snapshot-gap reset.
  const resetsBefore = events.filter((event) => event.type === 'session/rows-reset').length;
  channel.clear();
  const resets = events.filter((event) => event.type === 'session/rows-reset');
  assert.equal(resets.length, resetsBefore + 1);
  assert.equal(resets[resets.length - 1]?.reason, 'snapshot-gap');

  // recoverSnapshotGap answers the reducer's pendingReset marker.
  adapter.recoverSnapshotGap();
  const after = events.filter((event) => event.type === 'session/rows-reset');
  assert.equal(after.length, resets.length + 1);
  assert.equal(after[after.length - 1]?.reason, 'snapshot-gap');
  adapter.stop();
});
