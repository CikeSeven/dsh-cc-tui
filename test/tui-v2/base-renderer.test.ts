/**
 * tui-v2 WP-04b base-renderer tests (plan §6.2): HeightIndex prefix sums,
 * measurement caps (600 rows / 2M cells), overscan page sizing, the
 * row-render cache identity (revision/width/theme/profile), scroll-anchor
 * capture/restore/fallback, unseen indicator, cursor mapping and the
 * per-line width hard guard with CJK content at odd widths.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { UiRowSnapshot } from '../../src/tui-v2/model/schema.js'
import type {
  DockView,
  EditorView,
  StatusLineView,
  TranscriptView,
} from '../../src/tui-v2/model/selectors.js'
import {
  MAX_MEASURED_ROWS,
  buildHeightIndex,
  createBaseRenderer,
  overscanRows,
  type BaseRenderInput,
  type RowComponentRegistry,
} from '../../src/tui-v2/renderer/base-renderer.js'
import type { Component } from '../../src/tui-v2/renderer/component.js'
import { measureLineWidth } from '../../src/tui-v2/renderer/lines.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { createUserMessage } from '../../src/tui-v2/components/transcript/user-message.js'
import { asRowBlocks } from '../../src/tui-v2/components/transcript/row-view.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'

const PROFILE = getProfile('unicode-ambiguous-narrow')

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let rowCounter = 0
function row(id: string, text: string, overrides: Partial<UiRowSnapshot> = {}): UiRowSnapshot {
  rowCounter += 1
  return {
    rowId: `epoch-1:user:${id}:${rowCounter}`,
    durableSessionId: 'session-1',
    uiSessionGeneration: 'gen-1',
    sessionEpoch: 'epoch-1',
    source: 'session',
    sourceId: id,
    sourceSeq: String(rowCounter),
    revision: 1,
    kind: 'user',
    blocks: [{ type: 'text', text }],
    settled: true,
    ...overrides,
  }
}

function transcriptView(rows: readonly UiRowSnapshot[], overrides: Partial<TranscriptView> = {}): TranscriptView {
  return {
    visibleRows: rows,
    totalRows: rows.length,
    windowStart: 0,
    windowEnd: rows.length,
    streamingRowId: null,
    showUnseenIndicator: false,
    unseenCount: 0,
    ...overrides,
  }
}

const dockView = (overrides: Partial<DockView> = {}): DockView => ({
  editor: { text: '', cursor: 0, history: [], historyIndex: null },
  status: {},
  activity: null,
  pendingMessages: [],
  notifications: [],
  ...overrides,
})

const editorView = (text = '', focused = true): EditorView => ({
  text,
  cursor: text.length,
  history: [],
  historyIndex: null,
  focused,
})

const statusView = (): StatusLineView => ({ model: null, tokens: null, cwd: null, branch: null, mode: null, extras: {} })

/** Echo row component: one line per text-block line, prefixed with rowId tag. */
function echoRegistry(calls: string[] = []): RowComponentRegistry {
  return {
    componentFor: () => (r) => ({
      render(width: number): string[] {
        calls.push(`${r.rowId}@${width}`)
        const text = r.blocks
          .map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : ''))
          .join('\n')
        return text.split('\n').map((line) => line.slice(0, Math.max(0, width)))
      },
      invalidate() {},
    }),
  }
}

function makeRenderer(opts: {
  registry?: RowComponentRegistry
  editorCursor?: { x: number; y: number; visible: boolean }
  editorLines?: number
} = {}) {
  const editorLines = opts.editorLines ?? 1
  return createBaseRenderer({
    profile: PROFILE,
    theme: 'default',
    registry: opts.registry ?? echoRegistry(),
    dock: {
      editor: (view) => ({
        render: (width: number) =>
          Array.from({ length: editorLines }, (_, i) => (i === 0 ? `ed:${view.text}` : '~')),
        invalidate() {},
        focused: view.focused,
        cursor: opts.editorCursor,
      }),
      status: () => ({ render: () => ['status'], invalidate() {} }),
    },
  })
}

function renderInput(rows: readonly UiRowSnapshot[], width: number, height: number, overrides: Partial<BaseRenderInput> = {}): BaseRenderInput {
  return {
    transcript: transcriptView(rows),
    dock: dockView(),
    editor: editorView(),
    status: statusView(),
    width,
    height,
    sessionEpoch: 'epoch-1',
    sticky: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// HeightIndex
// ---------------------------------------------------------------------------

test('base-renderer: HeightIndex prefix sums / offsetOf / rowAtLine', () => {
  const index = buildHeightIndex([
    { rowId: 'a', height: 2 },
    { rowId: 'b', height: 3 },
    { rowId: 'c', height: 1 },
  ])
  assert.deepEqual([...index.lineOffsets], [0, 2, 5, 6])
  assert.equal(index.totalHeight, 6)
  assert.equal(index.offsetOf('b'), 2)
  assert.equal(index.offsetOf('missing'), undefined)
  assert.equal(index.rowAtLine(0), 0)
  assert.equal(index.rowAtLine(2), 1)
  assert.equal(index.rowAtLine(5), 2)
  assert.equal(index.rowAtLine(6), -1)
})

test('base-renderer: overscan is max(2*viewportHeight, 64) rows', () => {
  assert.equal(overscanRows(10), 64)
  assert.equal(overscanRows(40), 80)
  assert.equal(overscanRows(0), 64)
})

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

test('base-renderer: sticky layout bottom-aligns transcript above the dock', () => {
  const renderer = makeRenderer()
  const rows = [row('a', 'first'), row('b', 'second')]
  const out = renderer.render(renderInput(rows, 20, 10))
  assert.equal(out.lines.length, 10)
  assert.equal(out.diagnostics.dockHeight, 2) // editor + status
  assert.equal(out.diagnostics.transcriptHeight, 8)
  // Content is bottom-aligned: the two rows sit right above the dock.
  assert.equal(out.lines[6], 'first')
  assert.equal(out.lines[7], 'second')
  assert.equal(out.lines[8], 'ed:')
  assert.equal(out.lines[9], 'status')
  assert.equal(out.lines[0], '')
})

test('base-renderer: dock taller than the viewport is clipped from the top', () => {
  const renderer = makeRenderer({ editorLines: 5 })
  const out = renderer.render(renderInput([row('a', 'x')], 20, 3))
  assert.equal(out.lines.length, 3)
  assert.equal(out.diagnostics.transcriptHeight, 0)
  assert.equal(out.lines[2], 'status')
})

test('base-renderer: notifications and activity render above the editor', () => {
  const renderer = makeRenderer()
  const out = renderer.render(
    renderInput([row('a', 'x')], 30, 10, {
      dock: dockView({
        notifications: [{ notificationId: 'n1', text: 'disk full', color: 'error' }],
      }),
    }),
  )
  assert.equal(out.diagnostics.dockHeight, 3)
  assert.ok(out.lines[7]?.includes('disk full'))
  assert.equal(out.lines[8], 'ed:')
})

// ---------------------------------------------------------------------------
// measurement caps + loadOlder data interface
// ---------------------------------------------------------------------------

test('base-renderer: measurement is capped at 600 rows', () => {
  const many = Array.from({ length: 700 }, (_, i) => row(`r${i}`, `line ${i}`))
  const renderer = makeRenderer()
  const out = renderer.render(renderInput(many, 20, 10))
  assert.equal(out.diagnostics.measuredRows, MAX_MEASURED_ROWS)
  assert.equal(out.diagnostics.unmeasuredRows, 700 - MAX_MEASURED_ROWS)
})

test('base-renderer: canLoadOlder / loadOlderRange page one overscan deep', () => {
  const renderer = makeRenderer()
  const view = transcriptView([], { windowStart: 100, visibleRows: [] })
  assert.equal(renderer.canLoadOlder(view), true)
  // overscan rows for an empty visible window: max(2*0, 64) = 64
  assert.deepEqual(renderer.loadOlderRange(view), { start: 36, count: 64 })
  assert.equal(renderer.canLoadOlder(transcriptView([])), false)
})

// ---------------------------------------------------------------------------
// cache identity (§5.3): revision/width/theme/profile
// ---------------------------------------------------------------------------

test('base-renderer: settled rows are cached by (rowId, revision, width, theme, profile)', () => {
  const calls: string[] = []
  const renderer = makeRenderer({ registry: echoRegistry(calls) })
  const rows = [row('a', 'hello')]
  renderer.render(renderInput(rows, 20, 10))
  renderer.render(renderInput(rows, 20, 10))
  assert.equal(calls.length, 1, 'second render hits the row cache')
  renderer.render(renderInput(rows, 21, 10)) // width change -> new cache key
  assert.equal(calls.length, 2)
  const revised = [row('a', 'hello', { revision: 2 })]
  renderer.render(renderInput(revised, 21, 10))
  assert.equal(calls.length, 3, 'revision bump re-renders')
})

test('base-renderer: streaming rows bypass the render cache', () => {
  const calls: string[] = []
  const renderer = makeRenderer({ registry: echoRegistry(calls) })
  const streamingRow = row('s', 'partial', { settled: false })
  renderer.render(renderInput([streamingRow], 20, 10, { transcript: transcriptView([streamingRow], { streamingRowId: streamingRow.rowId }) }))
  renderer.render(renderInput([streamingRow], 20, 10, { transcript: transcriptView([streamingRow], { streamingRowId: streamingRow.rowId }) }))
  assert.equal(calls.length, 2, 'streaming rows always re-render')
})

test('base-renderer: applyEnvironmentChange clears caches and forces full redraw', () => {
  const calls: string[] = []
  const renderer = makeRenderer({ registry: echoRegistry(calls) })
  const rows = [row('a', 'hello')]
  renderer.render(renderInput(rows, 20, 10))
  renderer.applyEnvironmentChange({ widthChanged: true })
  const out = renderer.render(renderInput(rows, 20, 10))
  assert.equal(calls.length, 2, 'pool + caches cleared on width transaction')
  assert.equal(out.diagnostics.fullRedraw, true)
  const out2 = renderer.render(renderInput(rows, 20, 10))
  assert.equal(out2.diagnostics.fullRedraw, false)
})

test('base-renderer: theme/profile transactions clear the row caches too', () => {
  for (const changes of [{ themeChanged: true }, { profileChanged: true }]) {
    const calls: string[] = []
    const renderer = makeRenderer({ registry: echoRegistry(calls) })
    const rows = [row('a', 'hello')]
    renderer.render(renderInput(rows, 20, 10))
    renderer.render(renderInput(rows, 20, 10))
    assert.equal(calls.length, 1, 'cache hit before the transaction')
    renderer.applyEnvironmentChange(changes)
    const out = renderer.render(renderInput(rows, 20, 10))
    assert.equal(calls.length, 2, `re-render after ${JSON.stringify(changes)}`)
    assert.equal(out.diagnostics.fullRedraw, true)
  }
})

// ---------------------------------------------------------------------------
// scroll anchor (§6.2)
// ---------------------------------------------------------------------------

test('base-renderer: follow-end moves only the tail (sticky)', () => {
  const renderer = makeRenderer()
  const rows = Array.from({ length: 12 }, (_, i) => row(`r${i}`, `row-${i}`))
  const out = renderer.render(renderInput(rows, 20, 6)) // transcriptHeight 4
  assert.deepEqual(out.lines.slice(0, 4), ['row-8', 'row-9', 'row-10', 'row-11'])
  const rows2 = [...rows, row('r12', 'row-12')]
  const out2 = renderer.render(renderInput(rows2, 20, 6))
  assert.equal(out2.lines[3], 'row-12')
})

test('base-renderer: off-bottom viewport does not jump on new rows; unseen indicator shows', () => {
  const renderer = makeRenderer()
  const rows = Array.from({ length: 12 }, (_, i) => row(`r${i}`, `row-${i}`))
  // Establish the index, then anchor on the top visible line of a non-sticky view.
  renderer.render(renderInput(rows, 20, 6, { sticky: false }))
  renderer.captureAnchorAt(2) // inside row r2 (each row is 1 line)
  const out = renderer.render(renderInput(rows, 20, 6, { sticky: false }))
  assert.equal(out.lines[0], 'row-2', 'anchor pins the top line to row 2')
  const rows2 = [...rows, row('new', 'row-new')]
  const out2 = renderer.render(
    renderInput(rows2, 20, 6, {
      sticky: false,
      transcript: transcriptView(rows2, { showUnseenIndicator: true, unseenCount: 1 }),
    }),
  )
  assert.equal(out2.lines[0], 'row-2', 'no jump while off-bottom')
  assert.ok(out2.lines[3]?.includes('1 new message'), 'unseen indicator at region bottom')
})

test('base-renderer: anchor restores after a prepend (loadOlder)', () => {
  const renderer = makeRenderer()
  // Row b is 3 lines tall; enough rows after it keep maxScroll from clamping.
  const tallRows = [
    row('a', 'A'),
    row('b', 'B0\nB1\nB2'),
    row('c', 'C'),
    row('d', 'D'),
    row('e', 'E'),
    row('f', 'F'),
  ]
  renderer.render(renderInput(tallRows, 20, 6, { sticky: false }))
  renderer.captureAnchorAt(2) // line 2 = row b's second line (B1); a=0, b=1..3
  const anchor = renderer.anchor
  assert.ok(anchor !== null && anchor.rowId.includes(':b:'), 'anchor on row b')
  assert.equal(anchor.intraRowOffset, 1)
  // Prepend two rows (the controller's loadOlder result lands in the window).
  const prepended = [row('x', 'X'), row('y', 'Y'), ...tallRows]
  const out = renderer.render(renderInput(prepended, 20, 6, { sticky: false }))
  assert.equal(out.diagnostics.scrollTopLine, 2 + 1 + 1, 'X,Y prepend + row-b base + intraRowOffset')
  assert.equal(out.lines[0], 'B1', 'the anchored line stays at the top')
})

test('base-renderer: unrecoverable anchor falls back to policy + diagnostic', () => {
  const renderer = makeRenderer()
  const rows = [row('a', 'A'), row('b', 'B')]
  renderer.render(renderInput(rows, 20, 6, { sticky: false }))
  renderer.captureAnchorAt(1)
  // Anchor row evicted from the window entirely.
  const out = renderer.render(renderInput([row('c', 'C'), row('d', 'D')], 20, 6, { sticky: false }))
  assert.equal(out.diagnostics.anchorFallbacks, 1)
  assert.equal(renderer.diagnostics.anchorFallbacks, 1)
  // 'bottom' policy: newest content pinned to the region bottom.
  assert.equal(out.lines[3], 'D')
})

test('base-renderer: epoch change resets anchor and caches', () => {
  const calls: string[] = []
  const renderer = makeRenderer({ registry: echoRegistry(calls) })
  const rows = [row('a', 'A')]
  renderer.render(renderInput(rows, 20, 6))
  renderer.captureAnchorAt(0)
  const epoch2 = rows.map((r) => ({ ...r, sessionEpoch: 'epoch-2' }))
  const out = renderer.render(renderInput(epoch2, 20, 6, { sessionEpoch: 'epoch-2', sticky: false }))
  assert.equal(renderer.anchor, null)
  assert.equal(calls.length, 2, 'row caches cleared on epoch change')
  assert.equal(out.diagnostics.measuredRows, 1)
})

test('base-renderer scroll: epoch reset with a live anchor records the fallback and applies the policy', () => {
  const renderer = createBaseRenderer({
    profile: PROFILE,
    theme: 'default',
    registry: echoRegistry(),
    anchorFallback: 'top',
    dock: {
      editor: () => ({ render: () => ['ed'], invalidate() {} }),
      status: () => ({ render: () => ['st'], invalidate() {} }),
    },
  })
  const rows = Array.from({ length: 12 }, (_, i) => row(`r${i}`, `row-${i}`))
  renderer.render(renderInput(rows, 20, 6, { sticky: false }))
  renderer.captureAnchorAt(3) // anchor on row r3
  assert.ok(renderer.anchor !== null)
  // Epoch reset while off-bottom: the anchor is unrecoverable (§6.2) — one
  // diagnostic, explicit 'top' policy on the same render.
  const epoch2 = rows.map((r) => ({ ...r, sessionEpoch: 'epoch-2' }))
  const out = renderer.render(renderInput(epoch2, 20, 6, { sessionEpoch: 'epoch-2', sticky: false }))
  assert.equal(renderer.anchor, null)
  assert.equal(out.diagnostics.anchorFallbacks, 1)
  assert.equal(out.diagnostics.scrollTopLine, 0, "'top' policy pins the region top")
  assert.equal(out.lines[0], 'row-0')
  // Consumed: the next render is plain non-sticky (no anchor) => bottom.
  const out2 = renderer.render(renderInput(epoch2, 20, 6, { sessionEpoch: 'epoch-2', sticky: false }))
  assert.equal(out2.diagnostics.anchorFallbacks, 1, 'no repeated fallback')
  // Sticky epoch resets drop the anchor silently (follow-end semantics win).
  const stickyRenderer = makeRenderer()
  stickyRenderer.render(renderInput(rows, 20, 6, { sticky: false }))
  stickyRenderer.captureAnchorAt(3)
  const epoch3 = rows.map((r) => ({ ...r, sessionEpoch: 'epoch-3' }))
  const stickyOut = stickyRenderer.render(renderInput(epoch3, 20, 6, { sessionEpoch: 'epoch-3', sticky: true }))
  assert.equal(stickyOut.diagnostics.anchorFallbacks, 0, 'sticky reset is follow-end, not a fallback')
  assert.equal(stickyRenderer.anchor, null)
})

test('base-renderer scroll: oversized windows center measurement on a live anchor', () => {
  const renderer = makeRenderer()
  // One stable row list (rowIds must be identical across renders).
  const many = Array.from({ length: 700 }, (_, i) => row(`r${i}`, `row-${i}`))
  renderer.render(renderInput(many.slice(0, 100), 20, 6, { sticky: false }))
  renderer.captureAnchorAt(10) // anchor on row r10
  // The controller then hands over an oversized 700-row window (cap breach):
  // tail-biasing would drop the anchor row; centering keeps it recoverable.
  const out = renderer.render(renderInput(many, 20, 6, { sticky: false }))
  assert.equal(out.diagnostics.measuredRows, MAX_MEASURED_ROWS)
  assert.equal(out.diagnostics.unmeasuredRows, 700 - MAX_MEASURED_ROWS)
  assert.equal(out.diagnostics.anchorFallbacks, 0, 'anchor row stayed measured')
  assert.equal(out.diagnostics.scrollTopLine, 10, 'anchor restored inside the centered slice')
  assert.equal(out.lines[0], 'row-10')
  // Without an anchor the same oversized window is tail-biased (follow-end).
  const tail = makeRenderer()
  const tailOut = tail.render(renderInput(many, 20, 6))
  assert.equal(tailOut.lines[3], 'row-699')
})

test('base-renderer scroll: loadOlderRange pages one viewport-overscan deep', () => {
  const renderer = makeRenderer()
  // Before any render the page size derives from the provided window length.
  const cold = transcriptView([], { windowStart: 200, visibleRows: [] })
  assert.deepEqual(renderer.loadOlderRange(cold), { start: 136, count: 64 })
  // After a render with a 40-line transcript region: overscan = max(2*40, 64) = 80.
  renderer.render(renderInput([row('a', 'x')], 20, 42))
  const view = transcriptView([], { windowStart: 200, visibleRows: [] })
  assert.deepEqual(renderer.loadOlderRange(view), { start: 120, count: 80 })
  // Never crosses the transcript start.
  const near = transcriptView([], { windowStart: 30, visibleRows: [] })
  assert.deepEqual(renderer.loadOlderRange(near), { start: 0, count: 30 })
})

// ---------------------------------------------------------------------------
// cursor + width hard guard
// ---------------------------------------------------------------------------

test('base-renderer: focused editor cursor maps into dock coordinates', () => {
  const renderer = makeRenderer({ editorCursor: { x: 4, y: 0, visible: true } })
  const out = renderer.render(renderInput([row('a', 'x')], 20, 10))
  assert.deepEqual(out.cursor, { x: 4, y: 8, visible: true }) // transcriptHeight 8 + editor y 0
  const hidden = renderer.render(renderInput([row('a', 'x')], 20, 10, { editor: editorView('', false) }))
  assert.equal(hidden.cursor, undefined)
})

test('base-renderer: every emitted line passes the width hard guard (CJK, odd width)', () => {
  const renderer = createBaseRenderer({
    profile: PROFILE,
    theme: 'default',
    registry: {
      componentFor: (kind) =>
        kind === 'user'
          ? (r) =>
              createUserMessage(
                {
                  rowId: r.rowId,
                  revision: r.revision,
                  blocks: asRowBlocks(r.blocks),
                  streaming: !r.settled,
                  theme: DEFAULT_COMPONENT_THEME,
                },
                PROFILE,
              )
          : undefined,
    },
    dock: {
      editor: (view) => ({ render: () => ['ed'], invalidate() {}, focused: false }),
      status: () => ({ render: () => ['st'], invalidate() {} }),
    },
  })
  const rows = [row('cjk', '你好世界，这是一个比较长的中文句子用来触折叠行行为')]
  for (const width of [1, 2, 3, 21, 40]) {
    const out = renderer.render(renderInput(rows, width, 12))
    for (const line of out.lines) {
      assert.ok(
        measureLineWidth(line, PROFILE) <= width,
        `line exceeds width ${width}: ${JSON.stringify(line)}`,
      )
    }
  }
})

test('base-renderer: degenerate viewport renders nothing, never throws', () => {
  const renderer = makeRenderer()
  assert.deepEqual(renderer.render(renderInput([row('a', 'x')], 0, 10)).lines, [])
  assert.deepEqual(renderer.render(renderInput([row('a', 'x')], 20, 0)).lines, [])
})
