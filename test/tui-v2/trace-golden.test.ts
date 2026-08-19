/**
 * tui-v2 WP-02 golden grid runner (plan §9.2 second class).
 *
 * Replays each golden file's recorded input steps through the local
 * VirtualTerminal and asserts the stored xterm-generated expected grid via
 * `compareGrid` (inside evaluateGoldenFile — the only assertion entry
 * point). All five required scenario classes must be present.
 *
 * Top-level test names contain "trace" so
 * `--test-name-pattern 'trace|virtual terminal|redaction'` selects this file.
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateGoldenFile,
  readGoldenFile,
  REQUIRED_GOLDENS,
  type GoldenFile,
} from '../../src/tui-v2/testkit/conformance.js'

const GOLDENS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'goldens')

async function loadGoldens(): Promise<Map<string, GoldenFile>> {
  const files = (await readdir(GOLDENS_DIR)).filter((f) => f.endsWith('.json')).sort()
  const goldens = new Map<string, GoldenFile>()
  for (const file of files) {
    const golden = await readGoldenFile(path.join(GOLDENS_DIR, file))
    goldens.set(golden.name, golden)
  }
  return goldens
}

test('trace golden: all five required scenario classes exist', async () => {
  const goldens = await loadGoldens()
  for (const required of REQUIRED_GOLDENS) {
    assert.ok(goldens.has(required), `missing required golden ${required}.json`)
  }
})

test('trace golden: every stored grid matches the VirtualTerminal replay', async (t) => {
  const goldens = await loadGoldens()
  for (const [name, golden] of goldens) {
    await t.test(name, () => {
      const evaluation = evaluateGoldenFile(golden)
      assert.ok(
        evaluation.ok,
        [
          `golden ${name} failed:`,
          ...evaluation.errors,
          ...(evaluation.diffs ?? []).map((d) => `  diff: ${JSON.stringify(d)}`),
          `  gridHash=${evaluation.gridHash}`,
        ].join('\n'),
      )
    })
  }
})
