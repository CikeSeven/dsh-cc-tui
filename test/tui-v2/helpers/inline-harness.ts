/**
 * tui-v2 WP-07 inline verification harness (plan §WP-07 / §9.2).
 *
 * Shared by `scripts/verify-tui-v2.ts --check inline` and the inline test
 * files so the machine gate and the CI test layer run ONE implementation.
 *
 * Three runners:
 *   - `runInlineTraceReplay`: replays a versioned trace through reducer ->
 *     selectors -> base-renderer -> frame-builder (+ WP-07 inline hint) ->
 *     compositor -> InlineBackend, then per frame executes the differential
 *     formula twice (canonical patch replay + byte-level VirtualTerminal
 *     replay) AND asserts the append-only scrollback invariants:
 *     scrollback grows by exactly the patch's `line-feed` count, the new
 *     lines are the previous screen's top rows, the old scrollback is a
 *     strict prefix of the new one, and the encoded bytes never carry the
 *     dangerous ED 3 or a DECSTBM.
 *   - `runThirdPartyOutputReanchor`: a real ForeignOutputGuard +
 *     TerminalWriter over a VT-backed stream; a direct `stream.write`
 *     (third-party output) is detected and the next frame must be a damage
 *     re-anchor (erase + absolute rewrite, no feed ops) that restores the
 *     frame = screen invariant without growing scrollback.
 *   - `runInlineCleanup`: in-process lifecycle + InlineBackend + synthetic
 *     process host; after SIGTERM / error stop the VT modes are restored,
 *     stdin raw mode is back, and the parked cursor survives cleanup (the
 *     writer bundle must not home it — §15.1 WP-07).
 *
 * Modes convention: same as the fullscreen harness (constant
 * VT-initial-equivalent snapshot via `harnessModes`; scrollRegion projected
 * in expectations). Inline-specific projections (documented, §15.1 WP-07):
 *   - canonical/VT scroll regions re-clamp to the CURRENT height across
 *     resize (the VirtualTerminal does this on its own; the frame model
 *     keeps the lifecycle's static profile geometry, like fullscreen);
 *   - hyperlink cells compared against a VT snapshot project underline
 *     (vtBufferConvention, extended here to scrollback lines);
 *   - the VT resizes existing scrollback lines on resize (crop/pad) while
 *     the canonical grid keeps them — the VT-side expectation resizes them
 *     the same way.
 */
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

import type { AppEvent } from '../../../src/tui-v2/model/events.js'
import { validateAppEvent } from '../../../src/tui-v2/model/events.js'
import { createReducer, type Reducer } from '../../../src/tui-v2/model/reducer.js'
import type { Clock, UiRowSnapshot } from '../../../src/tui-v2/model/schema.js'
import {
  selectDockView,
  selectEditorView,
  selectStatusLine,
  selectTranscriptView,
} from '../../../src/tui-v2/model/selectors.js'
import { initialUiState, type UiState } from '../../../src/tui-v2/model/state.js'
import { computeInlineLiveRegion } from '../../../src/tui-v2/app/inline-live-region.js'
import { createBaseRenderer, type BaseRenderer } from '../../../src/tui-v2/renderer/base-renderer.js'
import { compositeFrame } from '../../../src/tui-v2/renderer/compositor.js'
import { buildFrame } from '../../../src/tui-v2/renderer/frame-builder.js'
import type { Frame } from '../../../src/tui-v2/renderer/frame.js'
import { createPromptEditor } from '../../../src/tui-v2/components/editor/prompt-editor.js'
import { createStatusLine } from '../../../src/tui-v2/components/chrome/status-line.js'
import { DEFAULT_COMPONENT_THEME } from '../../../src/tui-v2/components/theme.js'
import { createAssistantMessage } from '../../../src/tui-v2/components/transcript/assistant-message.js'
import { asRowBlocks } from '../../../src/tui-v2/components/transcript/row-view.js'
import { createToolRow } from '../../../src/tui-v2/components/transcript/tool-row.js'
import { createUserMessage } from '../../../src/tui-v2/components/transcript/user-message.js'
import { createForeignOutputGuard } from '../../../src/tui-v2/terminal/foreign-output.js'
import { InlineBackend } from '../../../src/tui-v2/terminal/inline-backend.js'
import { createInputSource } from '../../../src/tui-v2/terminal/input.js'
import {
  createTerminalLifecycle,
  type LifecycleStopReason,
  type ProcessSignalHost,
  type TerminalLifecycle,
} from '../../../src/tui-v2/terminal/lifecycle.js'
import type { TerminalProfile } from '../../../src/tui-v2/terminal/profile.js'
import { createTerminalWriter, encodePatchOperationsSync } from '../../../src/tui-v2/terminal/writer.js'
import {
  canonicalizeFrame,
  canonicalJson,
  compareGrid,
  gridSha256,
  type CanonicalCell,
  type CanonicalGridV1,
} from '../../../src/tui-v2/testkit/canonical.js'
import { applyPatchToCanonicalGrid, findLineWidthViolations } from '../../../src/tui-v2/testkit/frame-assert.js'
import type { Trace } from '../../../src/tui-v2/testkit/trace.js'
import { VirtualTerminal } from '../../../src/tui-v2/testkit/virtual-terminal.js'
import {
  emptyCanonicalGrid,
  harnessModes,
  resizeCanonicalGrid,
  type ScanFailure,
} from './fullscreen-harness.js'

export const INLINE_SCAN_WIDTH = 120
export const INLINE_SCAN_HEIGHT = 40
const MAX_FAILURES_PER_RUN = 8

const ZERO_CLOCK: Clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
}

// ---------------------------------------------------------------------------
// shared result shapes
// ---------------------------------------------------------------------------

interface InlineRunStats {
  frames: number
  fullRedraws: number
  /** Patches carrying at least one line-feed op (append recipe scrolled). */
  feedPatches: number
  /** Total lines pushed into scrollback by line-feed ops. */
  scrollbackFeeds: number
  bytes: number
  maxRowWidth: number
}

export interface InlineTraceReplayResult extends InlineRunStats {
  readonly trace: string
  readonly profile: string
  readonly events: number
  readonly strippedOverlays: number
  readonly ok: boolean
  readonly gridHash: string
  readonly vtHash: string
  readonly scrollbackLines: number
  readonly failures: readonly ScanFailure[]
}

export interface ThirdPartyReanchorResult {
  readonly profile: string
  readonly ok: boolean
  readonly foreignWrites: number
  readonly reanchorBytes: number
  readonly scrollbackDeltaDuringReanchor: number
  readonly detachRestored: boolean
  readonly failures: readonly ScanFailure[]
}

export interface InlineCleanupResult {
  readonly profile: string
  readonly scenario: string
  readonly ok: boolean
  readonly stopReason: LifecycleStopReason | null
  readonly modesRestored: boolean
  readonly rawModeRestored: boolean
  readonly cursorParked: boolean
  readonly failures: readonly ScanFailure[]
}

// ---------------------------------------------------------------------------
// small local helpers
// ---------------------------------------------------------------------------

function pushFailure(failures: ScanFailure[], failure: ScanFailure): void {
  if (failures.length < MAX_FAILURES_PER_RUN) failures.push(failure)
}

function assertGridEquals(
  failures: ScanFailure[],
  meta: { scope: string; frameId?: string; eventIndex?: number },
  actual: CanonicalGridV1,
  expected: CanonicalGridV1,
): void {
  const comparison = compareGrid(actual, { gridEncoding: 'readable', value: expected })
  const violations = findLineWidthViolations(actual)
  if (comparison.ok && violations.length === 0) return
  pushFailure(failures, {
    scope: meta.scope,
    ...(meta.frameId !== undefined ? { frameId: meta.frameId } : {}),
    ...(meta.eventIndex !== undefined ? { eventIndex: meta.eventIndex } : {}),
    message: comparison.ok ? 'line-width violations' : 'grid mismatch',
    ...(comparison.ok ? {} : { diffs: comparison.diffs.slice(0, 8) }),
    ...(violations.length === 0 ? {} : { violations: violations.slice(0, 8) }),
  })
}

function maxGridRowWidth(grid: CanonicalGridV1): number {
  let max = 0
  for (let y = 0; y < grid.height; y++) {
    let width = 0
    for (const cell of grid.cells.slice(y * grid.width, (y + 1) * grid.width)) {
      width += cell.width === 0 && cell.grapheme !== '' ? 0 : cell.width
    }
    max = Math.max(max, width)
  }
  return max
}

/** vtBufferConvention, extended to scrollback lines (same xterm buffer rule). */
function vtBufferConventionDeep(grid: CanonicalGridV1): CanonicalGridV1 {
  const project = (cell: CanonicalCell): CanonicalCell =>
    cell.hyperlink !== null && !cell.resolvedStyle.underline
      ? { ...cell, resolvedStyle: { ...cell.resolvedStyle, underline: true } }
      : cell
  return {
    ...grid,
    cells: grid.cells.map(project),
    scrollback: grid.scrollback.map((line) => line.map(project)),
  }
}

/** The VT crops/pads existing scrollback lines on resize; mirror that. */
function resizeScrollbackLine(line: readonly CanonicalCell[], width: number): CanonicalCell[] {
  const blank = emptyCanonicalGrid(width, 1, harnessModes(1, false)).cells[0] as CanonicalCell
  const out = line.slice(0, width).map((cell) => cell)
  while (out.length < width) out.push(blank)
  return out
}

function topRowsOf(grid: CanonicalGridV1, count: number): CanonicalCell[][] {
  const rows: CanonicalCell[][] = []
  for (let y = 0; y < count; y++) {
    rows.push(grid.cells.slice(y * grid.width, (y + 1) * grid.width))
  }
  return rows
}

/** DECSTBM (set scroll region) must never appear in inline patch bytes. */
const DECSTBM_PATTERN = /\x1b\[[\d;]*r/

// ---------------------------------------------------------------------------
// runner 1: trace replay through the inline pipeline
// ---------------------------------------------------------------------------

export interface InlineTraceReplayOptions {
  readonly width?: number
  readonly height?: number
  readonly theme?: string
}

/**
 * One trace through the inline pipeline. Mirrors the coordinator's render
 * path including the WP-07 pieces the coordinator adds: the live-region hint
 * (`computeInlineLiveRegion`, follow-end gated) and the overlay strip
 * (`supportsNestedOverlay === false` — overlays never composite inline).
 */
export function runInlineTraceReplay(
  trace: Trace,
  profileBase: TerminalProfile,
  options: InlineTraceReplayOptions = {},
): InlineTraceReplayResult {
  const width0 = options.width ?? INLINE_SCAN_WIDTH
  const height0 = options.height ?? INLINE_SCAN_HEIGHT
  const themeName = options.theme ?? 'verify-inline'
  const profile: TerminalProfile = {
    ...profileBase,
    id: `inline-scan-${profileBase.id}`,
    columns: width0,
    rows: height0,
  }
  const theme = DEFAULT_COMPONENT_THEME
  const failures: ScanFailure[] = []
  const stats: InlineRunStats & { events: number; strippedOverlays: number } = {
    frames: 0,
    fullRedraws: 0,
    feedPatches: 0,
    scrollbackFeeds: 0,
    bytes: 0,
    maxRowWidth: 0,
    events: 0,
    strippedOverlays: 0,
  }

  const editor = createPromptEditor({ profile, theme, terminalRows: height0 })
  const viewOf = (row: UiRowSnapshot, streaming: boolean) => ({
    rowId: row.rowId,
    revision: row.revision,
    blocks: asRowBlocks(row.blocks),
    streaming,
    ...(row.tool !== undefined ? { tool: row.tool } : {}),
    theme,
  })
  const renderer: BaseRenderer = createBaseRenderer({
    profile,
    theme: themeName,
    registry: {
      componentFor: (kind) => {
        if (kind === 'user') return (row) => createUserMessage(viewOf(row, false), profile)
        if (kind === 'assistant') return (row, streaming) => createAssistantMessage(viewOf(row, streaming), profile)
        if (kind === 'tool') return (row, streaming) => createToolRow(viewOf(row, streaming), profile)
        return undefined
      },
    },
    dock: {
      editor: (view) => {
        editor.syncFromView(view)
        return editor
      },
      status: (view) => createStatusLine(view, { profile, theme }),
      activity: () => null,
    },
  })

  const reducer: Reducer = createReducer({ clock: ZERO_CLOCK })
  let state: UiState = initialUiState({
    width: width0,
    height: height0,
    profileId: profile.id,
    theme: themeName,
    language: 'en',
    mode: 'inline',
  })

  const backend = new InlineBackend()
  let previousFrame: Frame | null = null
  let grid: CanonicalGridV1 | null = null
  const vt = new VirtualTerminal(profile)
  let pendingFullRedraw = true
  let fullRedrawReason: 'initial' | 'resize' | 'resume' | 'damage' | 'unknown-mode' | 'cleanup' = 'initial'
  let eventIndex = 0
  /** Append-only expectation: lines pushed by line-feed ops, in order. */
  let expectedScrollback: readonly (readonly CanonicalCell[])[] = []
  let prevFollowEnd = false

  for (const line of trace.lines) {
    if (line.kind !== 'event') continue
    eventIndex += 1
    stats.events += 1
    const event: AppEvent = validateAppEvent(line.event)
    state = reducer.reduce(state, event)

    // Full-redraw trigger mapping mirrors app/coordinator.ts.
    if (event.type === 'viewport/resize') {
      renderer.applyEnvironmentChange({ widthChanged: true })
      previousFrame = null
      prevFollowEnd = false
      pendingFullRedraw = true
      fullRedrawReason = 'resize'
    }
    if (event.type === 'terminal/resumed') {
      pendingFullRedraw = true
      fullRedrawReason = 'resume'
    }
    if (event.type === 'app/error') {
      pendingFullRedraw = true
      fullRedrawReason = 'cleanup'
    }
    // Consume-on-read mirrors app/coordinator.ts (the reducer flag is an edge
    // trigger; leaving it set would full-redraw every later frame).
    if (state.terminal.needsFullRedraw) {
      pendingFullRedraw = true
      state = { ...state, terminal: { ...state.terminal, needsFullRedraw: false } }
    }

    const transcript = selectTranscriptView(state)
    const output = renderer.render({
      transcript,
      dock: selectDockView(state),
      editor: selectEditorView(state),
      status: selectStatusLine(state),
      width: state.viewport.width,
      height: state.viewport.height,
      sessionEpoch: state.session.sessionEpoch,
      sticky: state.viewport.sticky,
    })

    const width = state.viewport.width
    const height = state.viewport.height
    const cursor = output.cursor ?? { x: 0, y: 0, visible: false }
    const followEndNow = state.viewport.sticky || renderer.anchor === null
    const hint = computeInlineLiveRegion({
      transcriptHeight: output.diagnostics.transcriptHeight,
      scrollTopLine: output.diagnostics.scrollTopLine,
      heightIndex: renderer.heightIndex,
      isMutableRow: (rowId) => {
        if (transcript.streamingRowId === rowId) return true
        const row = transcript.visibleRows.find((candidate) => candidate.rowId === rowId)
        return row === undefined ? true : !row.settled
      },
      showUnseenIndicator: transcript.showUnseenIndicator,
      followEnd: followEndNow && prevFollowEnd,
    })
    const base = buildFrame({
      frameId: `${trace.header.name}-inline-${eventIndex}`,
      stateRevision: eventIndex,
      width,
      height,
      lines: output.lines,
      profile,
      modes: harnessModes(height0, cursor.visible),
      cursor,
      generation: 0,
      fullRedraw: pendingFullRedraw,
      fullRedrawReason: pendingFullRedraw ? fullRedrawReason : undefined,
      inlineHint: hint,
    })
    // Overlay degradation (capability-driven, mirrors the coordinator): the
    // inline backend strips the stack; the frame pipeline never branches.
    const visibleOverlays = state.overlays.stack.filter((overlay) => overlay.visible).length
    stats.strippedOverlays += visibleOverlays
    const frame = compositeFrame({ base, profile, overlays: [], previous: previousFrame }).frame

    const patch = backend.plan(previousFrame, frame)
    stats.frames += 1
    if (patch.fullRedraw) stats.fullRedraws += 1
    stats.bytes += patch.bytes
    const feedCount = patch.operations.reduce(
      (sum, op) => sum + (op.kind === 'line-feed' ? op.count : 0),
      0,
    )
    if (patch.operations.some((op) => op.kind === 'line-feed')) stats.feedPatches += 1
    stats.scrollbackFeeds += feedCount
    const { encoded, bytes } = encodePatchOperationsSync(patch.operations)
    if (bytes !== patch.bytes) {
      pushFailure(failures, { scope: 'patch-bytes', frameId: frame.frameId, eventIndex, message: 'patch.bytes accounting mismatch' })
    }
    // The dangerous scrollback clear and DECSTBM are banned in inline bytes.
    if (encoded.includes('\x1b[3J')) {
      pushFailure(failures, { scope: 'dangerous-bytes', frameId: frame.frameId, eventIndex, message: 'patch bytes contain ED 3 (scrollback clear)' })
    }
    if (DECSTBM_PATTERN.test(encoded)) {
      pushFailure(failures, { scope: 'dangerous-bytes', frameId: frame.frameId, eventIndex, message: 'patch bytes contain DECSTBM' })
    }

    // Canonical replay half, with append-only scrollback assertions.
    const geometryChanged = grid !== null && (grid.width !== width || grid.height !== height)
    if (grid === null) grid = emptyCanonicalGrid(width, height, frame.modes)
    else if (geometryChanged) {
      grid = resizeCanonicalGrid(grid, width, height)
      // The VT re-clamps a full-height scroll region on resize; mirror it so
      // the canonical line-feed semantics track the physical terminal.
      grid = { ...grid, modes: { ...grid.modes, scrollRegion: { top: 0, bottom: Math.max(0, height - 1) } } }
    }
    const preScrollbackJson = canonicalJson(grid.scrollback)
    const preScrollbackLength = grid.scrollback.length
    const preTopRows = topRowsOf(grid, Math.min(feedCount, grid.height))
    grid = applyPatchToCanonicalGrid(grid, patch)
    const growth = grid.scrollback.length - preScrollbackLength
    if (growth !== feedCount) {
      pushFailure(failures, {
        scope: 'scrollback-feed-count',
        frameId: frame.frameId,
        eventIndex,
        message: `scrollback grew by ${growth}, patch feeds ${feedCount}`,
      })
    }
    if (canonicalJson(grid.scrollback.slice(0, preScrollbackLength)) !== canonicalJson(JSON.parse(preScrollbackJson))) {
      pushFailure(failures, {
        scope: 'scrollback-prefix',
        frameId: frame.frameId,
        eventIndex,
        message: 'existing scrollback was mutated (append-only violated)',
      })
    }
    if (growth > 0) {
      const appended = grid.scrollback.slice(preScrollbackLength)
      if (canonicalJson(appended) !== canonicalJson(preTopRows.slice(0, growth))) {
        pushFailure(failures, {
          scope: 'scrollback-content',
          frameId: frame.frameId,
          eventIndex,
          message: 'pushed scrollback lines are not the previous screen top rows',
        })
      }
      expectedScrollback = [...expectedScrollback, ...appended]
    }

    const expected: CanonicalGridV1 = {
      ...canonicalizeFrame(frame),
      modes: { ...frame.modes, scrollRegion: { top: 0, bottom: Math.max(0, height - 1) } },
      scrollback: expectedScrollback,
    }
    assertGridEquals(failures, { scope: 'canonical-replay', frameId: frame.frameId, eventIndex }, grid, expected)

    // Byte-level half: the fixed encoder's bytes into the VirtualTerminal.
    if (geometryChanged) vt.resize(width, height)
    vt.write(encoded)
    const snapshot = vt.snapshot()
    const vtExpected = vtBufferConventionDeep({
      ...expected,
      scrollback: expectedScrollback.map((lineCells) => resizeScrollbackLine(lineCells, width)),
    })
    assertGridEquals(failures, { scope: 'vt-replay', frameId: frame.frameId, eventIndex }, snapshot, {
      ...vtExpected,
      modes: { ...vtExpected.modes, scrollRegion: snapshot.modes.scrollRegion },
    })
    stats.maxRowWidth = Math.max(stats.maxRowWidth, maxGridRowWidth(snapshot))

    previousFrame = frame
    prevFollowEnd = followEndNow
    pendingFullRedraw = false
    fullRedrawReason = 'unknown-mode'
  }

  return {
    trace: trace.header.name,
    profile: profileBase.id,
    events: stats.events,
    frames: stats.frames,
    fullRedraws: stats.fullRedraws,
    feedPatches: stats.feedPatches,
    scrollbackFeeds: stats.scrollbackFeeds,
    bytes: stats.bytes,
    maxRowWidth: stats.maxRowWidth,
    strippedOverlays: stats.strippedOverlays,
    ok: failures.length === 0,
    gridHash: grid === null ? '' : gridSha256(grid),
    vtHash: gridSha256(vt.snapshot()),
    scrollbackLines: expectedScrollback.length,
    failures,
  }
}

// ---------------------------------------------------------------------------
// runner 2: third-party output detection + damage re-anchor
// ---------------------------------------------------------------------------

class FakeStdin extends PassThrough {
  readonly isTTY = true
  readonly rawModes: boolean[] = []
  setRawMode(raw: boolean): void {
    this.rawModes.push(raw)
  }
}

class VtStream extends Writable {
  constructor(private readonly vt: VirtualTerminal) {
    super()
  }
  override _write(chunk: unknown, _enc: string, cb: (error?: Error | null) => void): void {
    this.vt.write(String(chunk))
    cb()
  }
}

function simpleInlineFrame(
  frameId: string,
  stateRevision: number,
  lines: readonly string[],
  profile: TerminalProfile,
  options: { fullRedraw?: boolean; fullRedrawReason?: 'initial' | 'damage'; liveStart: number },
): Frame {
  return buildFrame({
    frameId,
    stateRevision,
    width: profile.columns,
    height: profile.rows,
    lines,
    profile,
    modes: harnessModes(profile.rows, false),
    cursor: { x: 0, y: 0, visible: false },
    generation: 0,
    fullRedraw: options.fullRedraw ?? false,
    fullRedrawReason: options.fullRedrawReason,
    inlineHint: { liveStart: options.liveStart, followEnd: true },
  })
}

/**
 * Foreign writes on the shared main screen are detected by the guard and the
 * next frame re-anchors (erase + absolute rewrite; never a feed, never ED 3).
 * Writer-owned writes through the guarded proxy must NOT count as foreign.
 */
export async function runThirdPartyOutputReanchor(profileBase: TerminalProfile): Promise<ThirdPartyReanchorResult> {
  const profile: TerminalProfile = {
    ...profileBase,
    id: `inline-thirdparty-${profileBase.id}`,
    columns: 80,
    rows: 24,
  }
  const failures: ScanFailure[] = []
  const vt = new VirtualTerminal(profile)
  const stream = new VtStream(vt)
  let foreignNotifications = 0
  const guard = createForeignOutputGuard(stream, () => {
    foreignNotifications += 1
  })
  const writer = createTerminalWriter({ stream: guard.writerStream, clock: ZERO_CLOCK, profile })
  const backend = new InlineBackend()
  await backend.start(0)
  guard.attach()

  const lines: string[] = []
  for (let i = 0; i < 20; i++) lines.push(`transcript line ${i + 1}`)
  lines.push('> editor', '', 'status ready', '')
  const frame1 = simpleInlineFrame('tp-1', 0, lines, profile, { fullRedraw: true, fullRedrawReason: 'initial', liveStart: 20 })
  const patch1 = backend.plan(null, frame1)
  const write1 = await writer.write(patch1)
  if (write1.status !== 'written') {
    pushFailure(failures, { scope: 'third-party-initial', message: `initial patch not written: ${write1.status}` })
  }
  if (guard.foreignWrites !== 0) {
    pushFailure(failures, { scope: 'third-party-guard', message: `writer-owned writes counted as foreign (${guard.foreignWrites})` })
  }

  // Third-party output: bypasses the writer entirely (console.log style).
  stream.write('\r\nFOREIGN-THIRD-PARTY-OUTPUT\r\n')
  if (guard.foreignWrites !== 1 || foreignNotifications !== 1) {
    pushFailure(failures, {
      scope: 'third-party-guard',
      message: `foreign write not detected exactly once (guard=${guard.foreignWrites}, callback=${foreignNotifications})`,
    })
  }

  // The coordinator turns the detection into a damage full-redraw frame.
  const frame2 = simpleInlineFrame('tp-2', 1, lines, profile, { fullRedraw: true, fullRedrawReason: 'damage', liveStart: 20 })
  const patch2 = backend.plan(frame1, frame2)
  if (!patch2.fullRedraw) {
    pushFailure(failures, { scope: 'third-party-reanchor', message: 're-anchor patch is not a full redraw' })
  }
  if (!patch2.operations.some((op) => op.kind === 'erase')) {
    pushFailure(failures, { scope: 'third-party-reanchor', message: 're-anchor patch carries no erase op' })
  }
  if (patch2.operations.some((op) => op.kind === 'append' || op.kind === 'line-feed' || op.kind === 'scroll')) {
    pushFailure(failures, {
      scope: 'third-party-reanchor',
      message: 're-anchor patch carries append/line-feed/scroll (re-anchor must be absolute only)',
    })
  }
  const { encoded, bytes } = encodePatchOperationsSync(patch2.operations)
  if (bytes !== patch2.bytes) {
    pushFailure(failures, { scope: 'third-party-reanchor', message: 'patch.bytes accounting mismatch' })
  }
  if (encoded.includes('\x1b[3J')) {
    pushFailure(failures, { scope: 'third-party-reanchor', message: 're-anchor bytes contain ED 3 (scrollback clear)' })
  }
  const scrollbackBeforeReanchor = vt.snapshot().scrollback.length
  const write2 = await writer.write(patch2)
  if (write2.status !== 'written') {
    pushFailure(failures, { scope: 'third-party-reanchor', message: `re-anchor patch not written: ${write2.status}` })
  }
  const snapshot = vt.snapshot()
  const scrollbackDeltaDuringReanchor = snapshot.scrollback.length - scrollbackBeforeReanchor
  if (scrollbackDeltaDuringReanchor !== 0) {
    pushFailure(failures, {
      scope: 'third-party-reanchor',
      message: `re-anchor pushed ${scrollbackDeltaDuringReanchor} line(s) into scrollback (must be 0)`,
    })
  }

  // Screen restored to the frame (frame = screen invariant re-asserted).
  const expected = vtBufferConventionDeep({
    ...canonicalizeFrame(frame2),
    modes: { ...frame2.modes, scrollRegion: snapshot.modes.scrollRegion },
    scrollback: snapshot.scrollback, // foreign bytes own scrollback here; the screen is the assertion
  })
  const comparison = compareGrid(snapshot, { gridEncoding: 'readable', value: expected })
  if (!comparison.ok) {
    pushFailure(failures, {
      scope: 'third-party-screen',
      message: 'screen does not match the re-anchored frame after third-party output',
      diffs: comparison.diffs.slice(0, 8),
    })
  }

  guard.detach()
  const writeCountAtDetach = guard.foreignWrites
  stream.write('after-detach\n')
  const detachRestored = guard.foreignWrites === writeCountAtDetach
  if (!detachRestored) {
    pushFailure(failures, { scope: 'third-party-detach', message: 'detach did not restore the underlying stream.write' })
  }
  await writer.stop({ preserveCursor: true })

  return {
    profile: profileBase.id,
    ok: failures.length === 0,
    foreignWrites: guard.foreignWrites,
    reanchorBytes: patch2.bytes,
    scrollbackDeltaDuringReanchor,
    detachRestored,
    failures,
  }
}

// ---------------------------------------------------------------------------
// runner 3: inline cleanup (modes restored, cursor parked) under signals
// ---------------------------------------------------------------------------

/**
 * In-process lifecycle + InlineBackend + synthetic process host. After the
 * stop reason lands (SIGTERM via the host, or a direct error stop), VT modes
 * and stdin raw mode must be restored and the parked cursor must survive the
 * writer's cleanup bundle (no scroll-region-reset home).
 */
export async function runInlineCleanup(
  profileBase: TerminalProfile,
  scenario: 'sigterm' | 'error',
): Promise<InlineCleanupResult> {
  const profile: TerminalProfile = {
    ...profileBase,
    id: `inline-cleanup-${profileBase.id}`,
    columns: 100,
    rows: 30,
  }
  const failures: ScanFailure[] = []
  const stdin = new FakeStdin()
  const vt = new VirtualTerminal(profile)
  const stream = new VtStream(vt)
  const host = new EventEmitter()
  let stopReason: LifecycleStopReason | null = null

  const input = createInputSource({ stdin, generation: 0, clock: realClock, profile, onEvent: () => {} })
  const writer = createTerminalWriter({ stream, clock: realClock, profile })
  const lifecycle: TerminalLifecycle = createTerminalLifecycle({
    writer,
    input,
    profile,
    clock: realClock,
    stdin,
    stdout: { columns: profile.columns, rows: profile.rows },
    processHost: host as unknown as ProcessSignalHost,
    onRequestStop: (reason) => {
      stopReason = reason
      void (async () => {
        // Mirror the coordinator's stop order: park -> backend gate -> lifecycle.
        const park = backend.planExitPark(lifecycle.generation())
        if (park !== null) await writer.write(park)
        await backend.stop(lifecycle.generation())
        await lifecycle.stop(reason)
      })()
    },
  })

  const backend = new InlineBackend()
  const started = await lifecycle.start({
    alternateScreen: false,
    bracketedPaste: profile.supportsBracketedPaste === 'yes',
    mouse: false,
    focusReporting: false,
    kittyKeyboard: profile.supportsKittyKeyboard === 'yes',
    syncOutput: profile.supportsSyncOutput === 'yes',
    hideCursor: true,
  })
  if (started.status !== 'active') {
    pushFailure(failures, { scope: 'cleanup-start', message: `lifecycle start failed: ${started.error.code}` })
  }
  await backend.start(lifecycle.generation())

  const lines: string[] = []
  for (let i = 0; i < 26; i++) lines.push(`session transcript line ${i + 1}`)
  lines.push('> editor', 'status ready', '', '')
  const frame = simpleInlineFrame('cleanup-1', 0, lines, profile, {
    fullRedraw: true,
    fullRedrawReason: 'initial',
    liveStart: 26,
  })
  const patch = backend.plan(null, frame)
  const writeResult = await writer.write(patch)
  if (writeResult.status !== 'written') {
    pushFailure(failures, { scope: 'cleanup-frame', message: `frame patch not written: ${writeResult.status}` })
  }

  if (scenario === 'sigterm') {
    lifecycle.attachProcessHandlers()
    host.emit('SIGTERM')
  } else {
    stopReason = 'error'
    const park = backend.planExitPark(lifecycle.generation())
    if (park !== null) await writer.write(park)
    await backend.stop(lifecycle.generation())
    await lifecycle.stop('error')
  }
  // Wait for the async stop chain to settle.
  const deadline = Date.now() + 6000
  while (
    lifecycle.lifecycleState() !== 'stopped' &&
    lifecycle.lifecycleState() !== 'failed-after-takeover' &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const snapshot = vt.snapshot()
  const modesRestored =
    snapshot.modes.alternateScreen === false &&
    snapshot.modes.bracketedPaste === false &&
    snapshot.modes.kittyKeyboard === false &&
    snapshot.modes.syncOutput === false &&
    snapshot.modes.cursorVisible === true
  if (!modesRestored) {
    pushFailure(failures, { scope: 'cleanup-modes', message: 'VT modes not restored to defaults after stop' })
  }
  const rawModeRestored = stdin.rawModes.length > 0 && stdin.rawModes[stdin.rawModes.length - 1] === false
  if (!rawModeRestored) {
    pushFailure(failures, { scope: 'cleanup-raw', message: 'stdin raw mode not restored' })
  }
  // The exit park fed one blank line and rested the cursor at its left edge;
  // the cleanup bundle (no scroll-region reset for inline) must not home it.
  const parkedCursor = snapshot.cursor as { x: number; y: number; visible: boolean }
  const cursorParked =
    parkedCursor.visible === true && parkedCursor.x === 0 && parkedCursor.y === profile.rows - 1
  if (!cursorParked) {
    pushFailure(failures, {
      scope: 'cleanup-park',
      message: `cursor not parked below the frame (at ${parkedCursor.x},${parkedCursor.y} visible=${parkedCursor.visible})`,
    })
  }
  if (findLineWidthViolations(snapshot).length > 0) {
    pushFailure(failures, { scope: 'cleanup-width', message: 'line-width violations after cleanup' })
  }

  return {
    profile: profileBase.id,
    scenario,
    ok: failures.length === 0,
    stopReason,
    modesRestored,
    rawModeRestored,
    cursorParked,
    failures,
  }
}
