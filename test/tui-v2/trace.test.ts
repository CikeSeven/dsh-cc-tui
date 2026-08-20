/**
 * tui-v2 WP-02 contract tests: schema/events JSON round-trip, versioned
 * trace read/write, redaction, canonical grid comparison, terminal profiles
 * and the fixture corpus.
 *
 * Top-level test names deliberately contain "trace"/"redaction" so
 * `--test-name-pattern 'trace|virtual terminal|redaction'` selects this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  deepCopySerializable,
  deepFreeze,
  isSerializableValue,
  validateOverlayState,
  type EventMeta,
  type OverlayState,
  type UiRowSnapshot,
} from '../../src/tui-v2/model/schema.js'
import {
  parseAppEvent,
  serializeAppEvent,
  validateAppEvent,
  type AppEvent,
} from '../../src/tui-v2/model/events.js'
import { parseInteractiveOverlayPayload } from '../../src/tui-v2/model/interactive-overlay-payloads.js'
import type { Frame, TerminalModeSnapshot } from '../../src/tui-v2/renderer/frame.js'
import {
  canonicalJson,
  canonicalizeFrame,
  compareGrid,
  gridSha256,
  type CanonicalGridV1,
  type GoldenGrid,
} from '../../src/tui-v2/testkit/canonical.js'
import {
  readTrace,
  redactTrace,
  validateTrace,
  writeTrace,
  writeTraceFailure,
  type Trace,
} from '../../src/tui-v2/testkit/trace.js'
import { getProfile, PROFILES } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { UNKNOWN_CONSERVATIVE_PROFILE_ID } from '../../src/tui-v2/terminal/profile.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixturesDir = path.join(repoRoot, 'fixtures', 'tui-v2', 'traces')

// ---------------------------------------------------------------------------
// Fixtures/helpers
// ---------------------------------------------------------------------------

let metaSeq = 0
function meta(overrides: Partial<EventMeta> = {}): EventMeta {
  metaSeq += 1
  return {
    schemaVersion: 1,
    adapterInstanceId: 'test-adapter-1',
    durableSessionId: 'test-session-1',
    uiSessionGeneration: 'test-gen-1',
    resetEpoch: 0,
    sessionEpoch: 'test-gen-1:0',
    source: 'session',
    sourceSeq: `session-${metaSeq}`,
    seq: metaSeq,
    at: 1_700_000_000_000 + metaSeq * 100,
    ...overrides,
  }
}

function sampleRow(overrides: Partial<UiRowSnapshot> = {}): UiRowSnapshot {
  return {
    rowId: 'test-gen-1:0:session:row-1:session-row-1-1',
    durableSessionId: 'test-session-1',
    uiSessionGeneration: 'test-gen-1',
    sessionEpoch: 'test-gen-1:0',
    source: 'session',
    sourceId: 'row-1',
    sourceSeq: 'session-row-1-1',
    revision: 0,
    kind: 'assistant',
    blocks: ['hello'],
    settled: true,
    ...overrides,
  }
}

function sampleOverlay(overrides: Partial<OverlayState> = {}): OverlayState {
  return {
    overlayId: 'overlay-1',
    revision: 0,
    anchor: 'center',
    visible: true,
    captureInput: true,
    nonCapturing: false,
    payload: { kind: 'approval' },
    ...overrides,
  }
}

/** One representative event per AppEvent variant (§5.2). */
function variantEvents(): AppEvent[] {
  return [
    { ...meta(), type: 'session/row-upsert', row: sampleRow() },
    { ...meta(), type: 'session/row-complete', rowId: 'row-1', revision: 3 },
    {
      ...meta(),
      type: 'session/rows-reset',
      resetId: 'reset-1',
      rows: [sampleRow()],
      snapshotHash: 'snap-abc',
      revision: 1,
      ready: true,
      reason: 'new-session',
    },
    { ...meta(), type: 'stream/chunk', rowId: 'row-1', text: 'chunk' },
    { ...meta(), type: 'stream/settled', rowId: 'row-1', revision: 2 },
    { ...meta(), type: 'input/command', command: { type: 'editor', command: 'insert', text: 'x' } },
    { ...meta(), type: 'viewport/resize', width: 120, height: 40 },
    { ...meta(), type: 'overlay/open', overlay: sampleOverlay() },
    { ...meta(), type: 'overlay/close', overlayId: 'overlay-1' },
    { ...meta(), type: 'search/update', search: { query: 'x', active: true, current: 0, matches: ['row-1'] } },
    { ...meta(), type: 'terminal/suspended' },
    { ...meta(), type: 'terminal/resumed' },
    { ...meta(), type: 'app/error', error: { code: 'E_X', message: 'boom', recoverable: false } },
  ]
}

function makeModes(): TerminalModeSnapshot {
  return {
    alternateScreen: true,
    rawInput: true,
    mouse: 'sgr-1006',
    bracketedPaste: true,
    syncOutput: false,
    autowrap: true,
    wrapPending: false,
    scrollRegion: { top: 0, bottom: 24 },
    cursorStyle: 'block',
    cursorVisible: true,
    kittyKeyboard: false,
    modifyOtherKeys: false,
    focusReporting: true,
    windowsDec9001: false,
    osc133: false,
    title: null,
    progress: { state: 'none' },
  }
}

function makeFrame(graphemes: string[]): Frame {
  const width = graphemes.length
  return {
    frameId: 'frame-1',
    stateRevision: 1,
    width,
    height: 1,
    stride: width,
    cells: graphemes.map((grapheme) => ({ grapheme, width: 1 as const, styleId: 0 })),
    cursor: { x: 0, y: 0, visible: true },
    modes: makeModes(),
    resources: {
      styles: [{
        id: 0,
        foreground: null,
        background: null,
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        inverse: false,
        strike: false,
      }],
      hyperlinks: [],
    },
    images: [],
    layers: [],
    generation: 0,
    fullRedraw: false,
    metadata: { changedRows: 1, renderMs: 0, diffMs: 0, terminalProfileId: 'unicode-ambiguous-narrow' },
  }
}

function sampleTrace(overrides: Partial<Trace['header']> = {}): Trace {
  return {
    header: {
      kind: 'header',
      traceVersion: 1,
      generatorVersion: '1.0.0',
      seed: 42,
      terminalProfile: 'unicode-ambiguous-narrow',
      oracle: 'differential-only',
      redactionVersion: 1,
      name: 'test-trace',
      ...overrides,
    },
    lines: variantEvents().map((event) => ({ kind: 'event' as const, event })),
  }
}

// ---------------------------------------------------------------------------
// schema helpers
// ---------------------------------------------------------------------------

test('trace schema: isSerializableValue rejects non-serializable shapes', () => {
  assert.equal(isSerializableValue('s'), true)
  assert.equal(isSerializableValue(3.5), true)
  assert.equal(isSerializableValue(null), true)
  assert.equal(isSerializableValue([1, { a: [true] }]), true)
  assert.equal(isSerializableValue(undefined), false)
  assert.equal(isSerializableValue(() => 1), false)
  assert.equal(isSerializableValue(Symbol('x')), false)
  assert.equal(isSerializableValue(10n), false)
  assert.equal(isSerializableValue(Number.NaN), false)
  assert.equal(isSerializableValue(new Date()), false)
  assert.equal(isSerializableValue(new Map()), false)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(isSerializableValue(cyclic), false)
})

test('trace schema: deepFreeze freezes nested structures; deepCopySerializable copies', () => {
  const value = { a: [1, { b: 'x' }], c: { d: null } }
  const frozen = deepFreeze(value)
  assert.ok(Object.isFrozen(frozen))
  assert.ok(Object.isFrozen(frozen.a))
  assert.ok(Object.isFrozen(frozen.a[1]))
  assert.ok(Object.isFrozen(frozen.c))
  assert.throws(() => {
    ;(frozen as { a: unknown }).a = []
  }, TypeError)

  const copy = deepCopySerializable({ list: [{ v: 1 }] })
  assert.deepEqual(copy, { list: [{ v: 1 }] })
  assert.notEqual(copy.list, undefined)
  assert.throws(() => deepCopySerializable({ bad: (() => 1) as unknown as string }), TypeError)
})

test('trace schema: validateOverlayState rejects contradictory capture flags', () => {
  assert.doesNotThrow(() => validateOverlayState(sampleOverlay()))
  assert.throws(
    () => validateOverlayState(sampleOverlay({ captureInput: true, nonCapturing: true })),
    /captureInput/,
  )
  assert.throws(
    () => validateOverlayState(sampleOverlay({ captureInput: false, nonCapturing: false })),
    /captureInput/,
  )
  assert.throws(() => validateOverlayState(sampleOverlay({ payload: { f: (() => 1) as unknown as string } })), /payload/)
})

// ---------------------------------------------------------------------------
// events round-trip
// ---------------------------------------------------------------------------

test('trace events: every AppEvent variant survives a JSON round-trip', () => {
  const variants = variantEvents()
  assert.equal(new Set(variants.map((e) => e.type)).size, 13, 'expected one example per variant')
  for (const event of variants) {
    const parsed = parseAppEvent(serializeAppEvent(event))
    assert.deepEqual(parsed, event, `round-trip mismatch for ${event.type}`)
  }
})

test('trace events: malformed events are rejected', () => {
  const good = variantEvents()[0]
  // Missing meta.
  const noMeta = { type: 'session/row-complete', rowId: 'r', revision: 0 }
  assert.throws(() => validateAppEvent(noMeta), /schemaVersion/)
  // schemaVersion != 1.
  assert.throws(() => validateAppEvent({ ...good, schemaVersion: 2 }), /schemaVersion/)
  // captureInput/nonCapturing contradiction inside overlay/open.
  assert.throws(
    () =>
      validateAppEvent({
        ...meta(),
        type: 'overlay/open',
        overlay: sampleOverlay({ captureInput: true, nonCapturing: true }),
      }),
    /captureInput/,
  )
  // blocks containing a function.
  assert.throws(
    () =>
      validateAppEvent({
        ...meta(),
        type: 'session/row-upsert',
        row: sampleRow({ blocks: [(() => 1) as unknown as string] }),
      }),
    /blocks\[0\]/,
  )
  // rows-reset requires ready: true.
  assert.throws(
    () =>
      validateAppEvent({
        ...meta(),
        type: 'session/rows-reset',
        resetId: 'r',
        rows: [],
        snapshotHash: 's',
        revision: 1,
        ready: false,
        reason: 'clear',
      }),
    /ready/,
  )
  // Unknown variant.
  assert.throws(() => validateAppEvent({ ...meta(), type: 'nope/unknown' }), /type/)
})

// ---------------------------------------------------------------------------
// trace file round-trip
// ---------------------------------------------------------------------------

test('trace file: write/read round-trip preserves the trace exactly', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-trace-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const trace = sampleTrace()
  const filePath = path.join(dir, 'sample.jsonl')
  await writeTrace(filePath, trace)
  const loaded = await readTrace(filePath)
  assert.deepEqual(loaded, trace)
})

test('trace file: a corrupt line fails with its line number', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-trace-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const trace = sampleTrace()
  const filePath = path.join(dir, 'corrupt.jsonl')
  await writeTrace(filePath, trace)
  const content = await readFile(filePath, 'utf8')
  const lines = content.split('\n')
  lines[2] = '{"kind":"event","event":{' // corrupt the third line (1-based line 3)
  await writeFile(filePath, lines.join('\n'), 'utf8')
  await assert.rejects(readTrace(filePath), /corrupt\.jsonl:3:/)

  const badShape = path.join(dir, 'badshape.jsonl')
  const badLines = content.split('\n')
  badLines[1] = '{"kind":"event","event":{"type":"session/row-complete"}}'
  await writeFile(badShape, badLines.join('\n'), 'utf8')
  await assert.rejects(readTrace(badShape), /badshape\.jsonl:2:/)
})

test('trace validation: golden oracle without expectedGrid is rejected; differential-only warns', () => {
  const goldenMissing = sampleTrace({ oracle: 'golden' })
  const result = validateTrace(goldenMissing)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('expectedGrid')))

  const exploratory = validateTrace(sampleTrace({ oracle: 'differential-only' }))
  assert.equal(exploratory.ok, true)
  assert.ok(exploratory.warnings.some((w) => w.includes('release gate')))
})

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

test('trace redaction: credentials, prompts and OSC payloads never reach disk', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-redaction-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const secret = 'sk-testsecret123456'
  const prompt = 'delete the production database now'
  const osc = '\x1b]8;;https://example.invalid/secret\u0007'
  const trace: Trace = {
    header: { ...sampleTrace().header, name: 'redaction-test' },
    lines: [
      {
        kind: 'event',
        event: {
          ...meta(),
          type: 'session/row-upsert',
          row: sampleRow({ blocks: [`leaked ${secret} in a block`] }),
        },
      },
      {
        kind: 'event',
        event: { ...meta(), type: 'input/command', command: { type: 'editor', command: 'insert', text: prompt } },
      },
      { kind: 'event', event: { ...meta(), type: 'stream/chunk', rowId: 'row-1', text: osc } },
      {
        kind: 'event',
        event: {
          ...meta(),
          type: 'search/update',
          search: { query: prompt, active: true, current: 0, matches: ['row-1'] },
        },
      },
    ],
  }
  const redacted = redactTrace(trace)
  const filePath = path.join(dir, 'redacted.jsonl')
  await writeTrace(filePath, redacted)
  const bytes = await readFile(filePath, 'utf8')
  assert.ok(!bytes.includes(secret), 'credential must not appear on disk')
  assert.ok(!bytes.includes(prompt), 'prompt must not appear on disk')
  assert.ok(!bytes.includes('https://example.invalid/secret'), 'OSC payload must not appear on disk')
  assert.ok(bytes.includes('<redacted:osc>'), 'OSC payload replaced by placeholder')
  assert.equal(redacted.header.redactionVersion, 1)

  // Determinism: same input -> identical placeholder bytes.
  const again = redactTrace(trace)
  assert.deepEqual(again, redacted)
  const blockText = (redacted.lines[0] as { event: AppEvent & { row: UiRowSnapshot } }).event.row.blocks[0]
  assert.match(blockText as string, /^<redacted:text [0-9a-f]{8}>$/)
  const search = (redacted.lines[3] as { event: Extract<AppEvent, { type: 'search/update' }> }).event.search
  assert.match(search.query, /^<redacted:text [0-9a-f]{8}>$/)
  assert.deepEqual(search.matches, ['row-1'], 'structural row ids remain replayable')
})

// ---------------------------------------------------------------------------
// canonical grid
// ---------------------------------------------------------------------------

test('canonical grid: canonicalJson key order is stable and code-point sorted', () => {
  const a = { b: 1, a: 2, '\u00e9': 3, z: 4 }
  const shuffled = { z: 4, '\u00e9': 3, a: 2, b: 1 }
  assert.equal(canonicalJson(a), canonicalJson(shuffled))
  assert.equal(canonicalJson(a), '{"a":2,"b":1,"z":4,"\u00e9":3}')
  assert.equal(canonicalJson({ list: [1, 'x', null, true], n: 0.1 + 0.2 }), '{"list":[1,"x",null,true],"n":0.30000000000000004}')
  assert.throws(() => canonicalJson({ bad: undefined }), TypeError)
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), TypeError)
})

test('canonical grid: canonicalizeFrame expands frame-local ids and flags continuation', () => {
  const frame = makeFrame(['a', 'b'])
  const grid = canonicalizeFrame(frame)
  assert.equal(grid.width, 2)
  assert.equal(grid.cells.length, 2)
  assert.equal(grid.cells[0].resolvedStyle.bold, false)
  assert.equal(grid.cells[0].hyperlink, null)
  assert.equal(grid.cells[0].continuation, false)
  assert.deepEqual(grid.scrollback, [])

  const continuationCell: Frame = {
    ...makeFrame(['a']),
    width: 2,
    stride: 2,
    cells: [
      { grapheme: '好', width: 2, styleId: 0 },
      { grapheme: '', width: 0, styleId: 0 },
    ],
  }
  const wide = canonicalizeFrame(continuationCell)
  assert.equal(wide.cells[0].continuation, false)
  assert.equal(wide.cells[1].continuation, true)

  const broken = makeFrame(['a'])
  const missing: Frame = { ...broken, cells: [{ grapheme: 'a', width: 1, styleId: 99 }] }
  assert.throws(() => canonicalizeFrame(missing), /missing styleId 99/)
})

test('canonical grid: compareGrid is the only assertion entry (readable + sha256-v1)', () => {
  const actual = canonicalizeFrame(makeFrame(['a', 'b']))

  // readable path: identical grid passes.
  const readable: GoldenGrid = { gridEncoding: 'readable', value: structuredClone(actual) }
  assert.deepEqual(compareGrid(actual, readable), { ok: true })

  // sha256-v1 path: hash of canonical bytes passes.
  const hashed: GoldenGrid = { gridEncoding: 'sha256-v1', value: gridSha256(actual) }
  assert.deepEqual(compareGrid(actual, hashed), { ok: true })

  // Tamper with one cell: readable reports a sanitized cell diff.
  const tamperedCells = actual.cells.map((cell, i) => (i === 1 ? { ...cell, grapheme: 'Z' } : cell))
  const tampered: CanonicalGridV1 = { ...actual, cells: tamperedCells }
  const failed = compareGrid(tampered, readable)
  assert.equal(failed.ok, false)
  if (!failed.ok) {
    const cellDiff = failed.diffs.find((d) => d.kind === 'cell')
    assert.ok(cellDiff, 'expected a cell diff')
    if (cellDiff.kind === 'cell') {
      assert.equal(cellDiff.x, 1)
      assert.equal(cellDiff.y, 0)
    }
    assert.ok(!JSON.stringify(failed.diffs).includes('"Z"'), 'diff must not contain the original grapheme')
  }

  // sha256-v1 mismatch reports a grid-level hash diff.
  const hashFailed = compareGrid(tampered, hashed)
  assert.equal(hashFailed.ok, false)
  if (!hashFailed.ok) {
    assert.equal(hashFailed.diffs[0].kind, 'grid')
    assert.equal(hashFailed.diffs[0].expectedHash, gridSha256(actual))
    assert.equal(hashFailed.diffs[0].actualHash, gridSha256(tampered))
  }
})

// ---------------------------------------------------------------------------
// terminal profiles
// ---------------------------------------------------------------------------

test('terminal profiles: the 13 deterministic emulator profiles are complete', () => {
  const expectedIds = [
    'ascii-narrow',
    'unicode-ambiguous-narrow',
    'unicode-ambiguous-wide',
    'kitty-sync',
    'tmux',
    'ssh',
    'windows-conpty',
    'windows-terminal-powershell',
    'windows-terminal-cmd',
    'classic-conhost-cp65001',
    'classic-conhost-cp936',
    'vscode-terminal',
    'unknown-conservative',
  ]
  assert.deepEqual([...PROFILES.keys()].sort(), expectedIds.sort())
  for (const id of expectedIds) {
    const profile = getProfile(id)
    assert.equal(profile.id, id)
    assert.equal(typeof profile.term, 'string')
    assert.ok(Number.isInteger(profile.columns) && profile.columns > 0)
    assert.ok(Number.isInteger(profile.rows) && profile.rows > 0)
    assert.ok(profile.ambiguousWidth === 1 || profile.ambiguousWidth === 2 || profile.ambiguousWidth === 'unknown')
    assert.ok(typeof profile.platform === 'string' && profile.platform.length > 0)
    for (const key of Object.keys(profile)) {
      assert.notEqual(profile[key as keyof typeof profile], undefined, `${id}.${key} must be set`)
    }
  }
  assert.throws(() => getProfile('no-such-profile'), RangeError)
})

test('terminal profiles: unknown-conservative keeps §5.4 conservative defaults', () => {
  const profile = getProfile(UNKNOWN_CONSERVATIVE_PROFILE_ID)
  assert.equal(profile.ambiguousWidth, 1)
  assert.equal(profile.unicodeLevel, 'unknown')
  assert.equal(profile.imageProtocol, 'unknown')
  assert.equal(profile.multiplexer, 'unknown')
  for (const key of Object.keys(profile)) {
    if (key.startsWith('supports')) {
      assert.equal(profile[key as keyof typeof profile], 'unknown', `${key} must stay 'unknown'`)
    }
  }
})

// ---------------------------------------------------------------------------
// failure artifacts
// ---------------------------------------------------------------------------

test('trace failure artifact: replayable JSONL with sanitized diffs and bounded events', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tui-v2-failure-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const events = Array.from({ length: 200 }, () => variantEvents()[0])
  const filePath = await writeTraceFailure(dir, {
    traceId: 'trace-abc',
    generatorVersion: '1.0.0',
    seed: 42,
    terminalProfile: 'unicode-ambiguous-narrow',
    frameId: 'frame-9',
    stateRevision: 7,
    generation: 3,
    diffs: [{ kind: 'cell', x: 4, y: 2, expectedHash: 'aaaa', actualHash: 'bbbb' }],
    events,
    recentEventLimit: 1000, // clamped to 128
  })
  const loaded = await readTrace(filePath)
  const eventLines = loaded.lines.filter((l) => l.kind === 'event')
  assert.equal(eventLines.length, 128)
  const failure = loaded.lines.find((l) => l.kind === 'failure')
  assert.ok(failure && failure.kind === 'failure')
  if (failure.kind === 'failure') {
    assert.equal(failure.traceId, 'trace-abc')
    assert.equal(failure.frameId, 'frame-9')
    assert.equal(failure.diffs?.[0].kind, 'cell')
  }
})

// ---------------------------------------------------------------------------
// fixture corpus
// ---------------------------------------------------------------------------

test('trace fixtures: every corpus file loads, validates and is redacted', async () => {
  const files = (await readdir(fixturesDir)).filter((f) => f.endsWith('.jsonl')).sort()
  assert.deepEqual(
    files,
    [
      'approval.jsonl',
      'assistant-stream.jsonl',
      'editor.jsonl',
      'exit-error.jsonl',
      'inline-scrollback.jsonl',
      'interactive-overlays.jsonl',
      'interrupt.jsonl',
      'markdown-tool-rendering.jsonl',
      'notification-status.jsonl',
      'overlay.jsonl',
      'question.jsonl',
      'reasoning.jsonl',
      'resize.jsonl',
      'resume-rewind.jsonl',
      'scene.jsonl',
      'scroll.jsonl',
      'selection.jsonl',
      'sigcont.jsonl',
      'startup.jsonl',
      'tool-lifecycle.jsonl',
      'user-submit.jsonl',
      'welcome.jsonl',
    ],
  )
  for (const file of files) {
    const trace = await readTrace(path.join(fixturesDir, file))
    assert.equal(trace.header.traceVersion, 1, file)
    assert.equal(trace.header.seed, 42, file)
    assert.equal(trace.header.generatorVersion, '1.0.0', file)
    assert.equal(trace.header.redactionVersion, 1, file)
    assert.equal(trace.header.oracle, 'differential-only', file)
    assert.equal(trace.header.name, file.replace(/\.jsonl$/, ''), file)
    assert.ok(PROFILES.has(trace.header.terminalProfile as string), `${file}: known profile`)
    assert.ok(trace.lines.length >= 1, `${file}: at least one body line`)
    const events = trace.lines.filter((l) => l.kind === 'event')
    assert.ok(events.length >= 1, `${file}: at least one event`)
    // Fixture text must already be redacted placeholder material.
    const raw = JSON.stringify(trace)
    assert.ok(!/sk-[A-Za-z0-9_-]{4,}/.test(raw), `${file}: no credential-shaped strings`)
  }
})

test('trace fixtures: WP-08b scenario preserves safe Markdown/tool discriminants', async () => {
  const trace = await readTrace(path.join(fixturesDir, 'markdown-tool-rendering.jsonl'))
  const upserts = trace.lines
    .filter((line) => line.kind === 'event' && line.event.type === 'session/row-upsert')
    .map((line) => (line as { event: AppEvent & { type: 'session/row-upsert' } }).event.row)
  const assistant = upserts.find((row) => row.sourceId === 'assistant-markdown-rich-1')
  const markdown = assistant?.blocks[0] as { readonly type?: string; readonly text?: string } | undefined
  assert.equal(markdown?.type, 'markdown')
  assert.ok(markdown?.text?.includes('| :--- | ---: |'))
  assert.ok(markdown?.text?.includes('~~~ typescript title=fixture'))

  const running = upserts.find((row) => row.sourceId === 'tool-render-edit-1' && row.tool?.phase === 'running')
  assert.equal((running?.tool?.callView as { readonly card?: string } | undefined)?.card, 'diff')
  const output = upserts.find((row) => row.sourceId === 'tool-render-output-1')
  assert.equal((output?.tool?.resultView as { readonly card?: string } | undefined)?.card, 'terminal')
  assert.ok(upserts.some((row) => row.sourceId === 'tool-render-error-1' && row.tool?.phase === 'error'))
})

test('trace fixtures: WP-08c interactive overlay payloads and search state remain replayable', async () => {
  const trace = await readTrace(path.join(fixturesDir, 'interactive-overlays.jsonl'))
  const opens = trace.lines
    .filter((line) => line.kind === 'event' && line.event.type === 'overlay/open')
    .map((line) => (line as { event: Extract<AppEvent, { type: 'overlay/open' }> }).event.overlay)
  const kinds = opens.map((overlay) => parseInteractiveOverlayPayload(overlay.payload)?.kind)
  assert.deepEqual([...new Set(kinds)], [
    'picker-dialog',
    'help-dialog',
    'history-search-dialog',
    'transcript-search-dialog',
  ])
  const searchUpdates = trace.lines.filter(
    (line) => line.kind === 'event' && line.event.type === 'search/update',
  )
  assert.equal(searchUpdates.length, 3)
  assert.equal(
    (searchUpdates[1] as { event: Extract<AppEvent, { type: 'search/update' }> }).event.search.current,
    1,
  )
  assert.equal(
    (searchUpdates[2] as { event: Extract<AppEvent, { type: 'search/update' }> }).event.search.active,
    false,
  )
  const raw = JSON.stringify(trace)
  assert.ok(!raw.includes('super-secret'))
  assert.ok(!raw.includes('\u001b]'))
})
