/**
 * tui-v2 WP-06b fullscreen trigger tests (plan §6.4): the full-redraw
 * trigger points wired onto the coordinator/terminal-lifecycle events.
 *
 *   - first frame          → fullRedraw, reason 'initial'
 *   - Ctrl+L               → input controller journals app/redraw and the
 *                            coordinator forces fullRedraw, reason 'damage'
 *   - SIGWINCH/resize      → scheduler resize transaction, reason 'resize'
 *   - SIGCONT              → terminal/resumed + markFullRedraw, 'resume'
 *
 * The coordinator runs against a VirtualTerminal over the real byte stream;
 * frame-level fullRedraw/reason are observed via coordinator diagnostics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { createTuiV2Coordinator } from '../../src/tui-v2/app/coordinator.js';
import type { ApprovalStoreLike } from '../../src/tui-v2/controllers/dialogs.js';
import type { ApprovalSnapshot } from '../../src/dsh-adapter/approvals.js';
import type { Clock } from '../../src/tui-v2/model/schema.js';
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js';
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js';
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js';
import { createFakeChannel } from './helpers/fake-channel.js';

/**
 * Minimal ApprovalStoreLike: one pending ask at a time; `ask` parks a
 * snapshot and notifies, `decide` settles (clears + notifies) — the dialogs
 * controller's own subscribe/sync/close pipeline does the rest.
 */
function createFakeApprovalStore(): ApprovalStoreLike & {
  ask(input: { toolName: string; command?: string }): void;
  readonly decisions: readonly ('allowed-once' | 'rejected')[];
} {
  let snapshot: ApprovalSnapshot | null = null;
  let seq = 0;
  const decisions: ('allowed-once' | 'rejected')[] = [];
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    decisions,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    decide(outcome) {
      decisions.push(outcome);
      snapshot = null;
      emit();
    },
    ask(input) {
      seq += 1;
      snapshot = { key: `ask-${seq}`, ...input };
      emit();
    },
  };
}

class FakeStdin extends PassThrough {
  readonly isTTY = true;
  override setRawMode(_raw: boolean): void {
    /* synthetic */
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

async function waitFor(condition: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor deadline exceeded');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function buildRig(options?: { approvalStore?: ApprovalStoreLike }) {
  const profile: TerminalProfile = { ...getProfile('kitty-sync'), columns: 100, rows: 30 };
  const stdin = new FakeStdin();
  const stdout = { columns: 100, rows: 30, isTTY: true };
  const vt = new VirtualTerminal(profile);
  const processHost = new EventEmitter();
  const channel = createFakeChannel();
  const coordinator = createTuiV2Coordinator({
    channel,
    stdin,
    stdout,
    stream: new VtStream(vt),
    profile,
    clock: realClock,
    processHost,
    attachProcessHandlers: true,
    ...(options?.approvalStore !== undefined ? { approvalStore: options.approvalStore } : {}),
  });
  return { profile, stdin, stdout, vt, processHost, channel, coordinator };
}

test('fullscreen trigger: initial frame, Ctrl+L (damage), resize transaction (resize), SIGCONT (resume)', async () => {
  const rig = buildRig();
  await rig.coordinator.start();
  assert.equal(rig.coordinator.phase, 'active');

  // --- initial ---
  await waitFor(() => rig.coordinator.diagnostics().framesRendered >= 1);
  assert.equal(rig.coordinator.diagnostics().lastFrameFullRedraw, true);
  assert.equal(rig.coordinator.diagnostics().lastFrameFullRedrawReason, 'initial');

  // --- Ctrl+L: journaled as app/redraw, forced full redraw with 'damage' ---
  rig.stdin.write('\x0c');
  await waitFor(() => rig.coordinator.diagnostics().lastFrameFullRedrawReason === 'damage');
  assert.equal(rig.coordinator.diagnostics().lastFrameFullRedraw, true);
  const lastCommand = rig.coordinator.state.pendingCommands.at(-1)?.command;
  assert.deepEqual(lastCommand, { type: 'app', command: 'redraw' });
  // The editor never saw the control byte.
  assert.equal(rig.coordinator.state.dock.editor.text, '');
  assert.equal(rig.coordinator.controllers.input.diagnostics().redrawRequests, 1);

  // --- resize transaction ---
  rig.stdout.columns = 80;
  rig.stdout.rows = 24;
  rig.processHost.emit('SIGWINCH');
  await waitFor(() => rig.coordinator.diagnostics().lastFrameFullRedrawReason === 'resize');
  assert.equal(rig.coordinator.diagnostics().lastFrameFullRedraw, true);
  assert.equal(rig.coordinator.state.viewport.width, 80);
  assert.equal(rig.coordinator.state.viewport.height, 24);

  // --- SIGCONT recovery ---
  rig.processHost.emit('SIGCONT');
  await waitFor(() => rig.coordinator.diagnostics().lastFrameFullRedrawReason === 'resume');
  assert.equal(rig.coordinator.diagnostics().lastFrameFullRedraw, true);
  assert.equal(rig.coordinator.controllers.terminal.diagnostics().resumes, 1);

  await rig.coordinator.stop('user-exit');
  await rig.coordinator.awaitStop();
  assert.equal(rig.coordinator.phase, 'stopped');
  // Clean teardown: the alt screen is left and raw mode restored.
  const modes = rig.vt.snapshot().modes;
  assert.equal(modes.alternateScreen, false);
});

test('fullscreen trigger: overlay opens over the live base and closes without residue (end to end)', async () => {
  const approvals = createFakeApprovalStore();
  const rig = buildRig({ approvalStore: approvals });
  await rig.coordinator.start();
  await waitFor(() => rig.coordinator.diagnostics().framesRendered >= 1);

  const screenText = (): string => {
    const snapshot = rig.vt.snapshot();
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
  };

  // Put distinctive base content on screen through the transcript.
  rig.channel.onSubmit = () => {
    rig.channel.startAssistant('BASE-MARKER');
  };
  rig.stdin.write('hi');
  rig.stdin.write('\r');
  await waitFor(() => screenText().includes('BASE-MARKER'));

  // Open an approval dialog through the WP-05b store seam.
  approvals.ask({ toolName: 'Bash', command: 'rm -rf /' });
  await waitFor(() => screenText().includes('Approval required'));
  assert.equal(rig.coordinator.state.focus.target, 'overlay');

  // Close it (cancel ⇒ reject). Ctrl+C rather than Esc: both land in the
  // same cancelActive path, but a lone ESC byte would wait out the vendored
  // StdinBuffer's real-timer escape timeout, while \x03 decodes immediately.
  rig.stdin.write('\x03');
  await waitFor(() => rig.coordinator.state.focus.target === 'editor');
  assert.deepEqual(approvals.decisions, ['rejected']);
  await waitFor(() => !screenText().includes('Approval required'));
  // The revealed region shows the CURRENT base: the marker is intact and no
  // dialog glyphs remain anywhere on screen.
  assert.ok(screenText().includes('BASE-MARKER'));
  assert.ok(!screenText().includes('rm -rf /'));

  await rig.coordinator.stop('user-exit');
  await rig.coordinator.awaitStop();
});
