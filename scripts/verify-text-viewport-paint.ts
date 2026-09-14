/**
 * Partially visible long Text nodes must reuse preparation while scrolling.
 * Run: node --import tsx/esm scripts/verify-text-viewport-paint.ts
 * Operation counts, not wall-clock thresholds, guard the hot path.
 */
process.env.FORCE_COLOR = '3'
import assert from 'node:assert/strict'
import type { Screen } from '../src/ink/screen.js'

const [{
  appendChildNode, createNode, createTextNode, markTreeDirty,
  removeChildNode, setAttribute, setStyle, setTextNodeValue, setTextStyles,
}, { default: Output }, { default: renderNode }, {
  cellAtIndex, CharPool, createScreen, HyperlinkPool, StylePool,
}] = await Promise.all([
  import('../src/ink/dom.js'), import('../src/ink/output.js'),
  import('../src/ink/render-node-to-output.js'), import('../src/ink/screen.js'),
])

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()
const node = createNode('ink-text')
let source = Array.from({ length: 1_000 }, (_, i) =>
  `\x1b[32mline ${i}: 中文 e\u0301 👩‍💻 ${'long code with spaces '.repeat(5)}\x1b[0m`,
).join('\n')
const leaf = createTextNode(source)
appendChildNode(node, leaf)
let reads = 0
Object.defineProperty(leaf, 'nodeValue', {
  get() { reads++; return source },
  set(value: string) { source = value },
})
const layout = (width: number) => {
  node.yogaNode!.setWidth(width)
  node.yogaNode!.calculateLayout(width)
}
const paint = (offsetY: number, width = 60, background?: string): Screen => {
  const screen = createScreen(width, 12, stylePool, charPool, hyperlinkPool)
  const output = new Output({ width, height: 12, stylePool, screen })
  output.clip({ x1: 0, x2: width, y1: 0, y2: 12 })
  renderNode(node, output, { offsetY, prevScreen: undefined, inheritedBackgroundColor: background })
  output.unclip()
  return output.get()
}
const snapshot = (screen: Screen) => ({
  cells: Array.from({ length: screen.width * screen.height }, (_, i) => cellAtIndex(screen, i)),
  softWrap: Array.from(screen.softWrap),
})
const matchesCold = (offsetY: number, width = 60, background?: string) => {
  const warm = snapshot(paint(offsetY, width, background))
  markTreeDirty(node)
  assert.deepEqual(warm, snapshot(paint(offsetY, width, background)), 'cached paint must match a cold preparation')
}

try {
  layout(60)
  paint(0)
  reads = 0
  for (const y of [-1, -11, -500, -1_500]) paint(y)
  assert.equal(reads, 0, 'scrolling unchanged text must not squash, wrap or restyle the whole block')
  matchesCold(-1_500)

  // An offscreen mutation consumes the paint dirty bit without preparing
  // text. Re-entry must not resurrect the preparation from before the edit.
  setTextNodeValue(leaf, 'changed 中文 e\u0301 👩‍💻 text '.repeat(20))
  layout(60)
  paint(30)
  matchesCold(0)
  assert.ok(snapshot(paint(0)).cells.some(cell => cell.char === 'c'))
  setTextNodeValue(leaf, source.replace('changed', 'UPDATED'))
  layout(60)
  matchesCold(0)

  // Width changes need not dirty the leaf (a parent can resize it).
  for (const width of [31, 60, 31]) {
    layout(width)
    matchesCold(-1, width)
  }
  layout(60)
  for (const background of ['#123456', '#654321', undefined]) matchesCold(0, 60, background)
  assert.notDeepEqual(snapshot(paint(0, 60, '#123456')), snapshot(paint(0, 60, '#654321')),
    'an inherited background change must actually recolor cached text')
  setTextStyles(node, { color: '#ff0000', bold: true })
  matchesCold(0)
  for (const textWrap of ['wrap-trim', 'truncate', 'wrap'] as const) {
    setStyle(node, { textWrap })
    layout(60)
    matchesCold(0)
  }

  const link = createNode('ink-link')
  const linkedText = createTextNode(' linked tail')
  appendChildNode(link, linkedText)
  setAttribute(link, 'href', 'https://example.test/one')
  appendChildNode(node, link)
  layout(60)
  matchesCold(0)
  setAttribute(link, 'href', 'https://example.test/two')
  matchesCold(0)
  setTextNodeValue(linkedText, ' updated link')
  layout(60)
  matchesCold(0)
  removeChildNode(node, link)
  layout(60)
  matchesCold(0)
} finally {
  node.yogaNode!.freeRecursive()
}

// A tall prepared block should read only the viewport and, for copy joins,
// its one preceding soft-wrapped line. Nested clips and screen-only clips
// must have the same bounded work, including content above the screen.
const lines = Array.from({ length: 20_000 }, (_, i) => `\x1b[32m${i} 中文 👩‍💻 ${'x'.repeat(80)}\x1b[0m`)
const text = lines.join('\n')
const softWrap = lines.map(() => true)
for (const clipped of [false, true]) {
  let lineReads = 0
  const prepared = new Proxy(lines, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) lineReads++
      return Reflect.get(target, key, receiver)
    },
  })
  const screen = createScreen(20, 12, stylePool, charPool, hyperlinkPool)
  const output = new Output({ width: 20, height: 12, stylePool, screen })
  if (clipped) {
    output.clip({ x1: 0, x2: 20, y1: 0, y2: 12 })
    output.clip({ x1: 2, x2: 18, y1: 2, y2: 10 })
  }
  output.write(0, -10_000, text, softWrap, prepared)
  output.get()
  assert.equal(lineReads, (clipped ? 8 : 12) + 1, 'only visible lines and one copy-join predecessor may be read')
  assert.ok(screen.softWrap[clipped ? 2 : 0]! > 0, 'clipped soft-wrap continuation keeps its join')
}

{
  const screen = createScreen(12, 6, stylePool, charPool, hyperlinkPool)
  const output = new Output({ width: 12, height: 6, stylePool, screen })
  output.clip({ x1: 0, x2: 12, y1: 0, y2: 6 })
  output.clip({ x1: 2, x2: 8, y1: 1, y2: 5 })
  const rows = ['ignored', 'ignored', '0123456789', '\x1b[31mAB中文CD\x1b[0m', '\x1b]8;;https://example.test\x07click\x1b]8;;\x07']
  output.write(0, -2, rows.join('\n'), [false, false, false, true, false], rows)
  output.get()
  assert.equal(screen.softWrap[1], 8, 'join uses the horizontally clipped predecessor end')
  assert.equal(screen.softWrap[2], 0, 'hard newline stays a hard newline')
  assert.equal(cellAtIndex(screen, 12 + 2).char, '中')
  assert.equal(cellAtIndex(screen, 12 + 8).char.trim(), '', 'wide content cannot escape the right clip')
  assert.ok(cellAtIndex(screen, 2 * 12 + 2).hyperlink, 'clipping retains OSC 8 links')
}

console.log('text viewport paint passed (warm scroll, invalidation, styles, links, clipped work and copy joins)')
