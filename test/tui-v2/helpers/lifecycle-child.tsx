/**
 * tui-v2 lifecycle child (WP-01 clean-stop smoke).
 *
 * Renders the real Chat against the headless harness, feeds stdin, unmounts,
 * then writes a JSON report to the path given as argv[2] and exits 0:
 *   { frames, plainChecks: {...}, unmounted: true, stderrFrames }
 *
 * Spawned as: process.execPath --import tsx/esm <this file> <reportPath>
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const reportPath = process.argv[2]
if (!reportPath) {
  console.error('lifecycle-child: missing report path argument')
  process.exit(2)
}

const [{ writeFile, mkdir }, path, { createChatHarness }] = await Promise.all([
  import('node:fs/promises'),
  import('node:path'),
  import('./harness.js'),
])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const USER_TEXT = 'hello from the tui-v2 lifecycle mock'
const harness = await createChatHarness({
  seedRows: [{ id: 0, kind: 'user', text: USER_TEXT }],
})

const instance = await harness.render()

// Wait for the first frames, then assert the transcript shows the mock user message.
await sleep(600)
const plainChecks: Record<string, boolean> = {
  userMessageVisible: harness.screenHas(USER_TEXT),
}

// Type a few characters through the real stdin path, then verify they render.
harness.stdin.write('abc')
await sleep(400)
plainChecks.typedTextVisible = harness.screenHas('abc')

await instance.unmount()
plainChecks.unmountedClean = true

const report = {
  frames: harness.stdout.frames,
  plainChecks,
  unmounted: true,
  stderrFrames: harness.stderr.frames,
}
await mkdir(path.dirname(reportPath), { recursive: true })
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')

const failed = Object.values(plainChecks).some(ok => !ok)
process.exit(failed ? 1 : 0)
