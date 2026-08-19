/**
 * tui-v2 WP-02 conformance corpus runner (plan §9.2/WP-02).
 *
 * Replays every fixture in fixtures/tui-v2/conformance/*.jsonl through the
 * local VirtualTerminal and asserts the stored expected grid via
 * `compareGrid` (inside evaluateConformanceCase — the only assertion entry
 * point). xterm-cross-check fixtures additionally replay the pinned
 * @xterm/headless oracle and require both parsers to agree on the projected
 * surface.
 *
 * Top-level test names contain "virtual terminal" so
 * `--test-name-pattern 'trace|virtual terminal|redaction'` selects this file.
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateConformanceCase,
  readConformance,
  type ConformanceCase,
} from '../../src/tui-v2/testkit/conformance.js'

const CONFORMANCE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/tui-v2/conformance',
)
const MIN_CASES = 34

async function loadCases(): Promise<ConformanceCase[]> {
  const files = (await readdir(CONFORMANCE_DIR)).filter((f) => f.endsWith('.jsonl')).sort()
  const cases: ConformanceCase[] = []
  for (const file of files) {
    cases.push(await readConformance(path.join(CONFORMANCE_DIR, file)))
  }
  return cases
}

test('virtual terminal conformance: corpus is present and well-formed', async () => {
  const cases = await loadCases()
  assert.ok(
    cases.length >= MIN_CASES,
    `expected at least ${MIN_CASES} conformance cases, found ${cases.length}`,
  )
  const conservativeWithoutGrid = cases.filter(
    (kase) =>
      kase.header.oracle === 'conservative-only' &&
      !kase.lines.some((line) => line.kind === 'expectedGrid'),
  )
  assert.ok(
    conservativeWithoutGrid.length >= 1,
    'expected at least one conservative-only case without an expectedGrid (diagnostics-only)',
  )
})

test('virtual terminal conformance: every corpus case replays clean', async (t) => {
  const cases = await loadCases()
  for (const kase of cases) {
    await t.test(`${kase.header.name} [${kase.header.oracle}]`, async () => {
      const evaluation = await evaluateConformanceCase(kase)
      assert.ok(
        evaluation.ok,
        [
          `conformance case ${kase.header.name} failed:`,
          ...evaluation.errors,
          ...(evaluation.diffs ?? []).map((d) => `  diff: ${JSON.stringify(d)}`),
          `  vtHash=${evaluation.vtHash}${evaluation.xtermHash ? ` xtermHash=${evaluation.xtermHash}` : ''}`,
        ].join('\n'),
      )
    })
  }
})
