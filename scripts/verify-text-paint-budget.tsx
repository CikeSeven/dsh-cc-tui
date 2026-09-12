/**
 * Offscreen text and scroll repair must not format a whole long transcript.
 * Run: node --import tsx/esm scripts/verify-text-paint-budget.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
import assert from 'node:assert/strict'

const [React, { PassThrough, Writable }, { Box, Text, ScrollBox, AlternateScreen, render }, { default: Output }, { createNode, createTextNode, insertBeforeNode }, { default: renderNode, resetLayoutShifted, didLayoutShift }, { createScreen, StylePool, CharPool, HyperlinkPool }, { scanPositions }, { default: instances }, { settled }] = await Promise.all([
  import('react'), import('node:stream'), import('../src/ui.js'),
  import('../src/ink/output.js'), import('../src/ink/dom.js'), import('../src/ink/render-node-to-output.js'),
  import('../src/ink/screen.js'), import('../src/ink/render-to-screen.js'),
  import('../src/ink/instances.js'), import('./lib/term-test.mjs'),
])
import type { Frame } from '../src/ink/frame.js'

const node = createNode('ink-text')
const leaf = createTextNode('VISIBLE-TEXT')
insertBeforeNode(node, leaf, node.childNodes[0])
node.yogaNode!.setWidth(40)
node.yogaNode!.calculateLayout(40)
let reads = 0
Object.defineProperty(leaf, 'nodeValue', { get() { reads++; return 'VISIBLE-TEXT' } })
const stylePool = new StylePool()
const blank = createScreen(40, 20, stylePool, new CharPool(), new HyperlinkPool())
const output = new Output({ width: 40, height: 20, stylePool, screen: blank })
try {
  renderNode(node, output, { offsetY: 30, prevScreen: undefined })
  assert.equal(reads, 0, 'a fully offscreen text leaf must not be read for paint')
  output.get()
  const next = createScreen(40, 20, stylePool, blank.charPool, blank.hyperlinkPool)
  output.reset(40, 20, next)
  renderNode(node, output, { offsetY: 0, prevScreen: blank })
  assert.ok(reads > 0, 'a re-entering text leaf must paint instead of blitting its old blank area')
  const visible = output.get()
  assert.equal(scanPositions(visible, 'VISIBLE-TEXT').length, 1)
  output.reset(40, 20, createScreen(40, 20, stylePool, blank.charPool, blank.hyperlinkPool))
  resetLayoutShifted()
  renderNode(node, output, { offsetY: 30, prevScreen: visible })
  assert.ok(didLayoutShift(), 'culling moved text must retain old-position invalidation')
} finally {
  node.yogaNode!.freeRecursive()
}

class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Sink extends Writable {
  isTTY = true
  columns = 40
  rows = 20
  _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) { done() }
}
const stdout = new Sink()
const text = Array.from({ length: 1000 }, (_, i) => `history ${i}`).join('\n')
const tree = (tail: string) => (
  <AlternateScreen>
    <ScrollBox height={20} flexDirection="column" stickyScroll>
      <Box flexDirection="column"><Text>{text}</Text><Text>{tail}</Text></Box>
    </ScrollBox>
  </AlternateScreen>
)
const app = await render(tree('TAIL-0'), {
  stdout: stdout as unknown as NodeJS.WriteStream, stdin: new Input() as unknown as NodeJS.ReadStream,
  stderr: new Sink() as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
})
const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as { frontFrame: Frame }
const originalWrite = Output.prototype.write
let largestBlankFill = 0
try {
  assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, 'TAIL-0').length === 1))
  Output.prototype.write = function (x, y, value, softWrap) {
    if (value !== '' && value.trim() === '') largestBlankFill = Math.max(largestBlankFill, value.split('\n').length)
    return originalWrite.call(this, x, y, value, softWrap)
  }
  app.rerender(tree('TAIL-0\nTAIL-1'))
  assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, 'TAIL-1').length === 1))
  assert.ok(largestBlankFill <= 20, `scroll repair allocated ${largestBlankFill} blank rows for a 20-row viewport`)
} finally {
  Output.prototype.write = originalWrite
  await app.unmount()
}

console.log('text paint budget passed (offscreen culling, re-entry and bounded scroll repair)')
