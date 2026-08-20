/**
 * tui-v2 WP-07 third-party output tests (plan §WP-07).
 *
 * A main-screen session shares the terminal with foreign writers (console.log
 * from a plugin, a stray child process). Two layers:
 *  1. `runThirdPartyOutputReanchor` (the same runner `--check inline` uses):
 *     a real ForeignOutputGuard + TerminalWriter over a VT-backed stream —
 *     writer-owned writes never count as foreign, a direct `stream.write` is
 *     detected exactly once, and the damage re-anchor restores frame = screen
 *     without touching scrollback; detach restores the original write.
 *  2. Coordinator level: an inline rig whose underlying stream receives
 *     foreign bytes directly — the coordinator must diagnose `output/foreign`,
 *     force a damage full redraw, and keep the frame content on screen.
 *
 * Top-level names carry "third-party output" so
 * `--test-name-pattern 'inline|scrollback|third-party output'` selects them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { createTuiV2Coordinator } from '../../src/tui-v2/app/coordinator.js';
import type { Clock } from '../../src/tui-v2/model/schema.js';
import { unknownConservativeDefaults, type TerminalProfile } from '../../src/tui-v2/terminal/profile.js';
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js';
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js';
import { createFakeChannel } from './helpers/fake-channel.js';
import { runThirdPartyOutputReanchor } from './helpers/inline-harness.js';

test('inline third-party output: guard detects foreign writes and the re-anchor restores the screen (harness)', async (t) => {
  for (const profile of [unknownConservativeDefaults(), getProfile('unicode-ambiguous-narrow')]) {
    await t.test(profile.id, async () => {
      const result = await runThirdPartyOutputReanchor(profile);
      if (!result.ok) assert.fail(`reanchor failed: ${JSON.stringify(result.failures)}`);
      assert.equal(result.foreignWrites, 1, 'exactly one foreign write detected');
      assert.equal(result.scrollbackDeltaDuringReanchor, 0, 're-anchor never feeds scrollback');
      assert.ok(result.detachRestored, 'detach restores the underlying stream.write');
    });
  }
});

// ---------------------------------------------------------------------------
// coordinator level
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

test('inline third-party output: coordinator diagnoses foreign bytes and re-anchors (damage)', async () => {
  const profile: TerminalProfile = { ...unknownConservativeDefaults(), columns: 120, rows: 40 };
  const stdin = new FakeStdin();
  const vt = new VirtualTerminal(profile);
  const stream = new VtStream(vt);
  const channel = createFakeChannel();
  const diagnostics: string[] = [];
  const coordinator = createTuiV2Coordinator({
    channel,
    stdin,
    stdout: { columns: 120, rows: 40, isTTY: true },
    stream,
    profile,
    clock: realClock,
    welcomeText: 'welcome-inline-third-party',
    attachProcessHandlers: false,
    onDiagnostic: (d) => diagnostics.push(d.code),
  });
  await coordinator.start();
  assert.equal(coordinator.state.terminal.mode, 'inline');
  await waitForReal(() => screenText(vt).includes('welcome-inline-third-party'));

  // Third-party write: bypasses the writer (and its guard proxy) entirely.
  stream.write('\r\nFOREIGN-PLUGIN-LOG-LINE\r\n');
  await waitForReal(() => diagnostics.includes('output/foreign'));
  await waitForReal(
    () =>
      coordinator.diagnostics().lastFrameFullRedraw === true &&
      coordinator.diagnostics().lastFrameFullRedrawReason === 'damage',
    6000,
  );
  assert.ok(
    screenText(vt).includes('welcome-inline-third-party'),
    'frame content restored on screen after the damage re-anchor',
  );

  await coordinator.stop('user-exit');
  await coordinator.awaitStop();
  assert.equal(coordinator.phase, 'stopped');
});
