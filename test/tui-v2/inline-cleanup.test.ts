/**
 * tui-v2 WP-07 inline cleanup tests (plan §WP-07).
 *
 * `runInlineCleanup` (the same runner `--check inline` uses) drives a real
 * in-process lifecycle + InlineBackend over a VT-backed stream and a synthetic
 * process host. After a SIGTERM or error stop the terminal must be restored:
 * modes back to defaults, stdin raw mode off, and — the WP-07 contract — the
 * parked cursor survives the writer cleanup bundle (no scroll-region reset
 * homing it to (0,0)).
 *
 * Top-level names carry "inline" so
 * `--test-name-pattern 'inline|scrollback|third-party output'` selects them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js';
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js';
import { runInlineCleanup } from './helpers/inline-harness.js';

test('inline cleanup: modes restored and cursor parked below the frame (sigterm + error)', async (t) => {
  for (const profile of [unknownConservativeDefaults(), getProfile('unicode-ambiguous-narrow')]) {
    for (const scenario of ['sigterm', 'error'] as const) {
      await t.test(`${profile.id} / ${scenario}`, async () => {
        const result = await runInlineCleanup(profile, scenario);
        if (!result.ok) assert.fail(`cleanup failed: ${JSON.stringify(result.failures)}`);
        assert.equal(result.stopReason, scenario);
        assert.ok(result.modesRestored, 'terminal modes restored to defaults');
        assert.ok(result.rawModeRestored, 'stdin raw mode restored');
        assert.ok(result.cursorParked, 'cursor parked below the frame survives cleanup');
      });
    }
  }
});
