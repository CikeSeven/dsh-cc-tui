/**
 * tui-v2 WP-06d fullscreen scan (plan §9.2/§9.3).
 *
 * Drives the REAL fullscreen pipeline — reducer/selectors → base renderer →
 * buildFrame → compositeFrame → FullscreenBackend.plan → encoder →
 * VirtualTerminal — and asserts, per frame, the §9.2 differential formula
 * (patch replay on both a canonical grid and a VT equals the freshly composed
 * frame) plus the overlay no-ghosting invariant (outside the overlay rects
 * the screen is cell-identical to the never-overlaid base).
 *
 * Top-level test names contain "fullscreen"/"width" so
 * `--test-name-pattern 'fullscreen|compositor|scroll|width'` selects this file.
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readGoldenFile, REQUIRED_GOLDENS } from '../../src/tui-v2/testkit/conformance.js'
import { readTrace } from '../../src/tui-v2/testkit/trace.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { canonicalizeFrame } from '../../src/tui-v2/testkit/canonical.js'
import { findLineWidthViolations } from '../../src/tui-v2/testkit/frame-assert.js'
import { buildFrame } from '../../src/tui-v2/renderer/frame-builder.js'
import { renderMarkdownLines } from '../../src/tui-v2/components/transcript/markdown.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import {
  harnessModes,
  runGoldenPipelineReplay,
  runOverlayGhostingScan,
  runTraceDifferential,
  type ScanFailure,
} from './helpers/fullscreen-harness.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const GOLDENS_DIR = path.join(HERE, 'goldens')
const TRACES_DIR = path.join(REPO_ROOT, 'fixtures', 'tui-v2', 'traces')

/** The differential scan covers exactly the profiles the goldens pin. */
const GOLDEN_PROFILE_IDS = ['unicode-ambiguous-narrow', 'kitty-sync'] as const

function formatFailures(failures: readonly ScanFailure[]): string {
  return failures
    .map((f) => `  [${f.scope}] ${f.frameId ?? ''} ${f.message} ${JSON.stringify(f.diffs ?? f.violations ?? '')}`)
    .join('\n')
}

test('fullscreen golden: every required scenario replays through the v2 fullscreen pipeline', async (t) => {
  const files = (await readdir(GOLDENS_DIR)).filter((f) => f.endsWith('.json')).sort()
  const names = files.map((f) => f.replace(/\.json$/, ''))
  for (const required of REQUIRED_GOLDENS) {
    assert.ok(names.includes(required), `missing required golden ${required}.json`)
  }
  for (const file of files) {
    const golden = await readGoldenFile(path.join(GOLDENS_DIR, file))
    await t.test(golden.name, () => {
      const result = runGoldenPipelineReplay(golden)
      assert.ok(result.ok, `golden ${golden.name} pipeline replay failed:\n${formatFailures(result.failures)}`)
    })
  }
})

test('fullscreen differential: every trace reproduces renderFull from patch replay', async (t) => {
  const files = (await readdir(TRACES_DIR)).filter((f) => f.endsWith('.jsonl')).sort()
  assert.ok(files.length > 0, 'no differential traces found')
  for (const file of files) {
    const trace = await readTrace(path.join(TRACES_DIR, file))
    for (const profileId of GOLDEN_PROFILE_IDS) {
      await t.test(`${trace.header.name} @ ${profileId}`, () => {
        const result = runTraceDifferential(trace, getProfile(profileId))
        assert.ok(
          result.ok,
          `trace ${trace.header.name} @ ${profileId} failed:\n${formatFailures(result.failures)}`,
        )
      })
    }
  }
})

test('fullscreen overlay: no ghosting across open/move/resize/nest/close', async (t) => {
  for (const profileId of GOLDEN_PROFILE_IDS) {
    await t.test(profileId, () => {
      const result = runOverlayGhostingScan(getProfile(profileId))
      assert.ok(result.ok, `overlay ghosting scan @ ${profileId} failed:\n${formatFailures(result.failures)}`)
    })
  }
})

test('fullscreen width: CJK markdown link boundaries never break the physical row width', (t) => {
  const text = '文档链接见 [文档链接](https://example.com/docs) 后续内容跟进'
  for (const width of [10, 11, 12, 13, 14, 15, 20, 21, 22, 23, 30, 48]) {
    t.test(`width ${width}`, () => {
      const profile = { ...getProfile('unicode-ambiguous-narrow'), id: `cjk-link-${width}`, columns: width, rows: 40 }
      const lines = renderMarkdownLines(text, { theme: DEFAULT_COMPONENT_THEME, profile }, width)
      assert.ok(lines.length > 0)
      const frame = buildFrame({
        frameId: `cjk-link-${width}`,
        stateRevision: 0,
        width,
        height: Math.max(lines.length, 4),
        lines,
        profile,
        modes: harnessModes(Math.max(lines.length, 4), false),
        generation: 0,
      })
      const grid = canonicalizeFrame(frame)
      const violations = findLineWidthViolations(grid)
      assert.deepEqual(violations, [])
      for (let y = 0; y < grid.height; y++) {
        const rowWidth = grid.cells
          .slice(y * grid.width, (y + 1) * grid.width)
          .reduce((sum, cell) => sum + (cell.width === 0 && cell.grapheme !== '' ? 0 : cell.width), 0)
        assert.ok(rowWidth <= width, `row ${y} physical width ${rowWidth} exceeds ${width}`)
      }
    })
  }
})
