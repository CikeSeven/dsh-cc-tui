/**
 * tui-v2 lifecycle clean-stop smoke (WP-01).
 *
 * Spawns helpers/lifecycle-child.tsx three times as
 *   process.execPath --import tsx/esm <child> <reportPath>
 * and asserts each run exits 0 with a well-formed report: frames were
 * committed, the mock user message rendered, stdin input rendered, the
 * instance unmounted and nothing leaked to stderr.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const childPath = fileURLToPath(new URL('./helpers/lifecycle-child.tsx', import.meta.url))

function runChild(reportPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', childPath, reportPath], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
}

test('tui-v2 lifecycle: Chat renders and cleanly stops across repeated child runs', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-lifecycle-'))
  try {
    for (let run = 1; run <= 3; run++) {
      await t.test(`lifecycle child run ${run}/3`, async () => {
        const reportPath = path.join(dir, `report-${run}.json`)
        const { code, signal } = await runChild(reportPath)
        assert.equal(signal, null, `run ${run}: child must not be killed by a signal`)
        assert.equal(code, 0, `run ${run}: child must exit 0`)

        const report = JSON.parse(await readFile(reportPath, 'utf8'))
        assert.equal(typeof report.frames, 'number', `run ${run}: report.frames must be a number`)
        assert.ok(report.frames > 0, `run ${run}: at least one frame must be committed`)
        assert.equal(report.unmounted, true, `run ${run}: report.unmounted must be true`)
        assert.equal(report.stderrFrames, 0, `run ${run}: nothing may be written to stderr`)
        assert.equal(
          report.plainChecks?.userMessageVisible,
          true,
          `run ${run}: mock user message must appear in the transcript`,
        )
        assert.equal(
          report.plainChecks?.typedTextVisible,
          true,
          `run ${run}: typed stdin text must appear in the transcript`,
        )
      })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
