/**
 * tui-v2 WP-06d fullscreen verification harness (plan §9.2 / WP-06 gate).
 *
 * Shared by `scripts/verify-tui-v2.ts --check fullscreen` and
 * `test/tui-v2/fullscreen-overlay-scan.test.ts` so the machine gate and the
 * CI test layer run ONE implementation (no drifting copies).
 *
 * Three runners:
 *   - `runGoldenPipelineReplay`: reproduces a WP-02 golden's oracle SCREEN
 *     through the v2 fullscreen pipeline (logical lines -> buildFrame ->
 *     compositeFrame -> FullscreenBackend.plan -> fixed writer encoder ->
 *     VirtualTerminal) and asserts it against the stored expected grid with
 *     compareGrid. Goldens are read-only. The oracle replay half (input bytes
 *     -> VirtualTerminal, incl. scrollback) stays with
 *     `evaluateGoldenFile` in testkit/conformance.ts — reused, not copied.
 *   - `runTraceDifferential`: replays a versioned trace through
 *     reducer -> selectors -> base-renderer -> frame-builder -> compositor ->
 *     FullscreenBackend, then per frame executes the §9.2 differential
 *     formula twice: canonical patch replay (applyPatchToCanonicalGrid) and
 *     byte-level VirtualTerminal replay of the encoded patch.
 *   - `runOverlayGhostingScan`: scripted overlay open/move/resize/nest/close
 *     (+ mid-overlay base mutation and resize) asserting the revealed region
 *     is cell-identical to the never-overlaid base, end-to-end through the
 *     compositor and the VirtualTerminal.
 *
 * Modes convention (locked in plan §15.1, WP-06d): frames carry a constant
 * VT-initial-equivalent snapshot (alternateScreen false, rawInput false,
 * scrollRegion {0, initialHeight-1}); only `cursorVisible` tracks the frame
 * cursor so the cursor op and the cursorVisible mode op never disagree.
 * Patch-level equivalence is screen-agnostic; alt-screen enter/exit bytes are
 * the lifecycle's and are asserted by terminal-lifecycle/walking-skeleton
 * tests. In the BYTE-level comparison `modes.scrollRegion` is projected from
 * the VirtualTerminal: the VT auto-tracks the full-region bottom across
 * resize while the fullscreen session deliberately never emits DECSTBM (a
 * DECSTBM would also home the physical cursor AFTER the patch's cursor op).
 * A second VT projection covers hyperlink cells: xterm (and the VT, mirroring
 * it) stores OSC 8 hyperlinks with the underline attribute in the buffer,
 * while the frame model keeps hyperlink/underline independent — expectations
 * compared against a VT snapshot project underline onto hyperlinked cells
 * (`vtBufferConvention`, plan §15.1 WP-06d).
 */
import type { AppEvent } from '../../../src/tui-v2/model/events.js'
import { validateAppEvent } from '../../../src/tui-v2/model/events.js'
import { createReducer, type Reducer } from '../../../src/tui-v2/model/reducer.js'
import type { Clock, OverlayState, UiRowSnapshot } from '../../../src/tui-v2/model/schema.js'
import {
  selectDockView,
  selectEditorView,
  selectStatusLine,
  selectTranscriptView,
} from '../../../src/tui-v2/model/selectors.js'
import { initialUiState, type UiState } from '../../../src/tui-v2/model/state.js'
import { createBaseRenderer, type BaseRenderer } from '../../../src/tui-v2/renderer/base-renderer.js'
import { compositeFrame, type OverlayRect } from '../../../src/tui-v2/renderer/compositor.js'
import { buildFrame } from '../../../src/tui-v2/renderer/frame-builder.js'
import type { Frame, TerminalModeSnapshot } from '../../../src/tui-v2/renderer/frame.js'
import { cellsToString, lineStyle, styleText, type LineCell } from '../../../src/tui-v2/renderer/lines.js'
import { renderDialogOverlayLines } from '../../../src/tui-v2/components/overlays/render-dialog.js'
import { DEFAULT_COMPONENT_THEME } from '../../../src/tui-v2/components/theme.js'
import { createPromptEditor } from '../../../src/tui-v2/components/editor/prompt-editor.js'
import { createStatusLine } from '../../../src/tui-v2/components/chrome/status-line.js'
import { createAssistantMessage } from '../../../src/tui-v2/components/transcript/assistant-message.js'
import { asRowBlocks } from '../../../src/tui-v2/components/transcript/row-view.js'
import { createToolRow } from '../../../src/tui-v2/components/transcript/tool-row.js'
import { createUserMessage } from '../../../src/tui-v2/components/transcript/user-message.js'
import { FullscreenBackend } from '../../../src/tui-v2/terminal/fullscreen-backend.js'
import type { TerminalProfile } from '../../../src/tui-v2/terminal/profile.js'
import { encodePatchOperationsSync } from '../../../src/tui-v2/terminal/writer.js'
import {
  canonicalizeFrame,
  canonicalJson,
  compareGrid,
  gridSha256,
  type CanonicalCell,
  type CanonicalGridV1,
  type GridDiff,
} from '../../../src/tui-v2/testkit/canonical.js'
import type { GoldenFile } from '../../../src/tui-v2/testkit/conformance.js'
import { getProfile } from '../../../src/tui-v2/testkit/terminal-profiles.js'
import { applyPatchToCanonicalGrid, findLineWidthViolations } from '../../../src/tui-v2/testkit/frame-assert.js'
import type { Trace } from '../../../src/tui-v2/testkit/trace.js'
import { VirtualTerminal } from '../../../src/tui-v2/testkit/virtual-terminal.js'

export const FULLSCREEN_SCAN_WIDTH = 120
export const FULLSCREEN_SCAN_HEIGHT = 40
/** Failures are capped per run so the artifact stays bounded. */
const MAX_FAILURES_PER_RUN = 8

const ZERO_CLOCK: Clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }

// ---------------------------------------------------------------------------
// shared result shapes
// ---------------------------------------------------------------------------

export interface ScanFailure {
  readonly scope: string
  readonly frameId?: string
  readonly eventIndex?: number
  readonly message: string
  /** Sanitized diffs (coordinates + hashes only, never graphemes). */
  readonly diffs?: readonly GridDiff[]
  readonly violations?: readonly string[]
}

interface RunStats {
  frames: number
  fullRedraws: number
  modeOps: number
  bytes: number
  maxRowWidth: number
}

export interface GoldenPipelineReplayResult extends RunStats {
  readonly name: string
  readonly profile: string
  readonly ok: boolean
  readonly gridHash: string
  /** Documented projections applied to the screen-only expectation. */
  readonly projections: readonly string[]
  readonly failures: readonly ScanFailure[]
}

export interface TraceDifferentialResult extends RunStats {
  readonly trace: string
  readonly profile: string
  readonly events: number
  readonly ok: boolean
  readonly gridHash: string
  readonly vtHash: string
  readonly failures: readonly ScanFailure[]
}

export interface OverlayGhostingResult extends RunStats {
  readonly profile: string
  readonly scenario: string
  readonly steps: number
  readonly ok: boolean
  readonly gridHash: string
  readonly vtHash: string
  readonly failures: readonly ScanFailure[]
}

// ---------------------------------------------------------------------------
// modes / canonical grid helpers
// ---------------------------------------------------------------------------

/**
 * Constant VT-initial-equivalent mode snapshot (see the header note). Only
 * `cursorVisible` tracks the frame cursor; `scrollRegion` is pinned to the
 * initial height exactly like the production lifecycle's static profile.
 */
export function harnessModes(height: number, cursorVisible: boolean): TerminalModeSnapshot {
  return {
    alternateScreen: false,
    rawInput: false,
    mouse: 'off',
    bracketedPaste: false,
    syncOutput: false,
    autowrap: true,
    wrapPending: false,
    scrollRegion: { top: 0, bottom: Math.max(0, height - 1) },
    cursorStyle: 'block',
    cursorVisible,
    kittyKeyboard: false,
    modifyOtherKeys: false,
    focusReporting: false,
    windowsDec9001: false,
    osc133: false,
    title: null,
    progress: { state: 'none' },
  }
}

const DEFAULT_STYLE = Object.freeze({
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
})

const BLANK: CanonicalCell = Object.freeze({
  grapheme: '',
  width: 1,
  continuation: false,
  resolvedStyle: DEFAULT_STYLE,
  hyperlink: null,
})

export function emptyCanonicalGrid(width: number, height: number, modes: TerminalModeSnapshot): CanonicalGridV1 {
  return {
    width,
    height,
    cells: Array.from({ length: width * height }, () => BLANK),
    cursor: { x: 0, y: 0, visible: false },
    modes,
    scrollback: [],
    images: [],
  }
}

/** VT-conformant resize (no reflow): crop/pad rows and columns with blanks. */
export function resizeCanonicalGrid(grid: CanonicalGridV1, width: number, height: number): CanonicalGridV1 {
  const cells: CanonicalCell[] = Array.from({ length: width * height }, () => BLANK)
  for (let y = 0; y < Math.min(height, grid.height); y++) {
    for (let x = 0; x < Math.min(width, grid.width); x++) {
      cells[y * width + x] = grid.cells[y * grid.width + x] as CanonicalCell
    }
  }
  return { ...grid, width, height, cells }
}

/**
 * Canonical screen cells -> trusted logical lines (one per row), reusing the
 * component-side replay builder `cellsToString` (reset-first SGR + OSC 8
 * close, §6.1). Unwritten oracle blanks (grapheme '') materialize as
 * default-styled spaces — the v2 cell grid always publishes full rows.
 * Hyperlink params cannot be expressed by the logical-line pipeline (dropped
 * at tokenize since WP-04) and refuse loudly instead of silently mismatching.
 */
export function logicalLinesFromCanonicalGrid(grid: CanonicalGridV1): string[] {
  const lines: string[] = []
  for (let y = 0; y < grid.height; y++) {
    const row = grid.cells.slice(y * grid.width, (y + 1) * grid.width)
    const lineCells: LineCell[] = row.map((cell) => {
      if (cell.hyperlink !== null && cell.hyperlink.params !== undefined) {
        throw new TypeError('logicalLinesFromCanonicalGrid: hyperlink params cannot round-trip through logical lines')
      }
      return {
        grapheme: cell.width === 1 && cell.grapheme === '' ? ' ' : cell.grapheme,
        width: cell.width,
        style: cell.resolvedStyle,
        hyperlink: cell.hyperlink === null ? null : cell.hyperlink.uri,
      }
    })
    lines.push(cellsToString(lineCells))
  }
  return lines
}

// ---------------------------------------------------------------------------
// assertion plumbing (compareGrid is the only grid assertion entry, §9.2)
// ---------------------------------------------------------------------------

function pushFailure(failures: ScanFailure[], failure: ScanFailure): void {
  if (failures.length < MAX_FAILURES_PER_RUN) failures.push(failure)
}

/** compareGrid + the physical-line-width invariant on `actual`. */
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

function rowWidth(row: readonly CanonicalCell[]): number {
  return row.reduce((sum, cell) => sum + (cell.width === 0 && cell.grapheme !== '' ? 0 : cell.width), 0)
}

function maxGridRowWidth(grid: CanonicalGridV1): number {
  let max = 0
  for (let y = 0; y < grid.height; y++) {
    max = Math.max(max, rowWidth(grid.cells.slice(y * grid.width, (y + 1) * grid.width)))
  }
  return max
}

/**
 * xterm buffer convention (VirtualTerminal.printGrapheme mirrors it): an
 * OSC 8 hyperlink cell carries the underline attribute in the buffer. The v2
 * frame model keeps hyperlink and underline independent, so expectations
 * compared against a VT snapshot project underline onto hyperlinked cells.
 */
function vtBufferConvention(grid: CanonicalGridV1): CanonicalGridV1 {
  if (!grid.cells.some((cell) => cell.hyperlink !== null)) return grid
  return {
    ...grid,
    cells: grid.cells.map((cell) =>
      cell.hyperlink !== null && !cell.resolvedStyle.underline
        ? { ...cell, resolvedStyle: { ...cell.resolvedStyle, underline: true } }
        : cell,
    ),
  }
}

/** Byte-level expectation: frame grid with the host-tracked scrollRegion projected from the VT. */
function vtExpectedOf(frame: Frame, vt: VirtualTerminal): CanonicalGridV1 {
  const expected = vtBufferConvention(canonicalizeFrame(frame))
  return { ...expected, modes: { ...expected.modes, scrollRegion: vt.snapshot().modes.scrollRegion } }
}

// ---------------------------------------------------------------------------
// golden pipeline replay (screen half)
// ---------------------------------------------------------------------------

/**
 * Reproduce a golden's expected SCREEN through the v2 fullscreen pipeline.
 * The frame is built from the golden's own canonical cells (never from the
 * pipeline's own output), so a round-trip loss anywhere in
 * frame-builder/compositor/backend/encoder breaks the comparison.
 */
export function runGoldenPipelineReplay(golden: GoldenFile): GoldenPipelineReplayResult {
  const failures: ScanFailure[] = []
  const expected = golden.expected.gridEncoding === 'readable' ? golden.expected.value : null
  if (expected === null) {
    throw new TypeError(`golden ${golden.name}: pipeline replay requires a readable golden (§9.2)`)
  }
  const profile: TerminalProfile = {
    // Geometry comes from the golden grid, capability surface from its profile.
    ...getProfile(golden.profile),
    id: `golden-replay-${golden.name}`,
    columns: expected.width,
    rows: expected.height,
  }
  const projections: string[] = [
    'blank cells: unwritten oracle blanks (grapheme "") materialize as written default-style spaces in the v2 cell grid',
    'scrollback: not reachable through an alt-screen patch; asserted by the oracle replay half (evaluateGoldenFile)',
    'hyperlink cells: VT buffer convention underlines hyperlinked cells (xterm-aligned); the frame model keeps hyperlink/underline independent',
  ]

  const lines = logicalLinesFromCanonicalGrid(expected)
  const cursorVisible = (expected.cursor as { visible?: boolean }).visible === true
  const modes = harnessModes(expected.height, cursorVisible)
  const frame = buildFrame({
    frameId: `golden-${golden.name}`,
    stateRevision: 0,
    width: expected.width,
    height: expected.height,
    lines,
    profile,
    modes,
    cursor: expected.cursor as { x: number; y: number; visible: boolean },
    generation: 0,
  })
  const composed = compositeFrame({ base: frame, profile, overlays: [], previous: null }).frame

  const backend = new FullscreenBackend()
  const patch = backend.plan(null, composed)
  if (!patch.fullRedraw) {
    pushFailure(failures, { scope: 'golden-pipeline', frameId: composed.frameId, message: 'first patch is not a full redraw' })
  }
  if (patch.operations[0]?.kind !== 'resources') {
    pushFailure(failures, { scope: 'golden-pipeline', frameId: composed.frameId, message: 'resources op is not first' })
  }
  const { encoded, bytes } = encodePatchOperationsSync(patch.operations)
  if (bytes !== patch.bytes) {
    pushFailure(failures, { scope: 'golden-pipeline', frameId: composed.frameId, message: 'patch.bytes accounting mismatch' })
  }

  // Screen-only expectation: materialized blanks, patch-reachable modes,
  // empty scrollback (a first alt-screen frame emits no mode ops; the golden
  // `title` field — set by input bytes — is a lifecycle/OSC concern).
  const materializedCells = expected.cells.map((cell) =>
    cell.width === 1 && cell.grapheme === '' ? { ...cell, grapheme: ' ' } : cell,
  )
  if (expected.modes.title !== null) {
    projections.push('modes.title: a first-frame fullscreen patch carries no title op (lifecycle/OSC domain)')
  }
  const screenExpectation: CanonicalGridV1 = {
    width: expected.width,
    height: expected.height,
    cells: materializedCells,
    cursor: expected.cursor,
    modes,
    scrollback: [],
    images: [],
  }

  // Frame-builder fidelity: the re-parsed frame must equal the golden screen.
  assertGridEquals(failures, { scope: 'golden-frame', frameId: composed.frameId }, canonicalizeFrame(composed), screenExpectation)

  // End-to-end: encoded patch bytes into a fresh VirtualTerminal.
  const vt = new VirtualTerminal(profile)
  vt.write(encoded)
  const snapshot = vt.snapshot()
  assertGridEquals(failures, { scope: 'golden-vt', frameId: composed.frameId }, snapshot, vtBufferConvention(screenExpectation))

  return {
    name: golden.name,
    profile: golden.profile,
    frames: 1,
    fullRedraws: patch.fullRedraw ? 1 : 0,
    modeOps: patch.operations.filter((op) => op.kind === 'mode').length,
    bytes,
    maxRowWidth: maxGridRowWidth(snapshot),
    ok: failures.length === 0,
    gridHash: gridSha256(snapshot),
    projections,
    failures,
  }
}

// ---------------------------------------------------------------------------
// trace differential scan
// ---------------------------------------------------------------------------

export interface TraceDifferentialOptions {
  readonly width?: number
  readonly height?: number
  readonly theme?: string
}

/**
 * One trace through the fullscreen pipeline, both replay halves per frame.
 * Mirrors the coordinator's render path (selectors -> base renderer ->
 * buildFrame -> compositeFrame -> backend.plan) with the overlay bridge and
 * component registry wired exactly like production.
 */
export function runTraceDifferential(
  trace: Trace,
  profileBase: TerminalProfile,
  options: TraceDifferentialOptions = {},
): TraceDifferentialResult {
  const width0 = options.width ?? FULLSCREEN_SCAN_WIDTH
  const height0 = options.height ?? FULLSCREEN_SCAN_HEIGHT
  const themeName = options.theme ?? 'verify-fullscreen'
  const profile: TerminalProfile = {
    ...profileBase,
    id: `fullscreen-scan-${profileBase.id}`,
    columns: width0,
    rows: height0,
  }
  const theme = DEFAULT_COMPONENT_THEME
  const failures: ScanFailure[] = []
  const stats: RunStats & { events: number } = { frames: 0, fullRedraws: 0, modeOps: 0, bytes: 0, maxRowWidth: 0, events: 0 }

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
  })

  const backend = new FullscreenBackend()
  let previousFrame: Frame | null = null
  let grid: CanonicalGridV1 | null = null
  const vt = new VirtualTerminal(profile)
  let pendingFullRedraw = true
  let fullRedrawReason: 'initial' | 'resize' | 'resume' | 'damage' | 'unknown-mode' | 'cleanup' = 'initial'
  let eventIndex = 0

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

    const output = renderer.render({
      transcript: selectTranscriptView(state),
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
    const base = buildFrame({
      frameId: `${trace.header.name}-${eventIndex}`,
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
    })
    const frame = compositeFrame({
      base,
      profile,
      overlays: state.overlays.stack,
      renderOverlay: (overlay, overlayWidth) =>
        renderDialogOverlayLines(overlay.payload, overlayWidth, { profile, theme }),
      previous: previousFrame,
    }).frame

    const patch = backend.plan(previousFrame, frame)
    stats.frames += 1
    if (patch.fullRedraw) stats.fullRedraws += 1
    stats.modeOps += patch.operations.filter((op) => op.kind === 'mode').length
    stats.bytes += patch.bytes
    const { encoded, bytes } = encodePatchOperationsSync(patch.operations)
    if (bytes !== patch.bytes) {
      pushFailure(failures, {
        scope: 'patch-bytes',
        frameId: frame.frameId,
        eventIndex,
        message: 'patch.bytes accounting mismatch',
      })
    }

    // §9.2 differential equivalence, canonical replay half.
    const geometryChanged = grid !== null && (grid.width !== width || grid.height !== height)
    if (grid === null) grid = emptyCanonicalGrid(width, height, frame.modes)
    else if (geometryChanged) grid = resizeCanonicalGrid(grid, width, height)
    grid = applyPatchToCanonicalGrid(grid, patch)
    const expected = canonicalizeFrame(frame)
    assertGridEquals(
      failures,
      { scope: 'canonical-replay', frameId: frame.frameId, eventIndex },
      grid,
      expected,
    )

    // Byte-level half: the fixed encoder's bytes into the VirtualTerminal.
    if (geometryChanged) vt.resize(width, height)
    vt.write(encoded)
    const snapshot = vt.snapshot()
    assertGridEquals(
      failures,
      { scope: 'vt-replay', frameId: frame.frameId, eventIndex },
      snapshot,
      vtExpectedOf(frame, vt),
    )
    stats.maxRowWidth = Math.max(stats.maxRowWidth, maxGridRowWidth(snapshot))

    previousFrame = frame
    pendingFullRedraw = false
    fullRedrawReason = 'unknown-mode'
  }

  return {
    trace: trace.header.name,
    profile: profileBase.id,
    events: stats.events,
    frames: stats.frames,
    fullRedraws: stats.fullRedraws,
    modeOps: stats.modeOps,
    bytes: stats.bytes,
    maxRowWidth: stats.maxRowWidth,
    ok: failures.length === 0,
    gridHash: grid === null ? '' : gridSha256(grid),
    vtHash: gridSha256(vt.snapshot()),
    failures,
  }
}

// ---------------------------------------------------------------------------
// overlay no-ghosting scan
// ---------------------------------------------------------------------------

interface GhostStep {
  readonly id: string
  /** Base lines for this step (defaults to the previous step's). */
  readonly base?: readonly string[]
  /** Overlay stack after this step (back -> front). */
  readonly overlays: readonly OverlayState[]
  /** Geometry change applied BEFORE building this step's frame. */
  readonly resizeTo?: { readonly width: number; readonly height: number }
}

function makeScanOverlay(partial: Partial<OverlayState> & { overlayId: string }): OverlayState {
  return {
    revision: 1,
    anchor: 'center',
    visible: true,
    captureInput: true,
    nonCapturing: false,
    payload: {},
    ...partial,
  }
}

function scanOverlayRenderer(overlay: OverlayState): readonly string[] {
  const payload = overlay.payload as { lines?: readonly string[] }
  return Array.isArray(payload.lines) ? payload.lines : []
}

function coveredIndices(rects: readonly OverlayRect[], width: number): Set<number> {
  const out = new Set<number>()
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) out.add(y * width + x)
    }
  }
  return out
}

/** Cells an overlay edge may legitimately heal (blank one half of a wide pair). */
function edgeNeighborIndices(rects: readonly OverlayRect[], width: number, height: number): Set<number> {
  const out = new Set<number>()
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      if (rect.x > 0) out.add(y * width + rect.x - 1)
      if (rect.x + rect.width < width) out.add(y * width + rect.x + rect.width)
    }
  }
  return out
}

function cellKey(cell: CanonicalCell): string {
  return canonicalJson(cell)
}

/** Base grid with covered/healed positions replaced by the replayed cells. */
function maskGrid(baseGrid: CanonicalGridV1, actual: CanonicalGridV1, masked: ReadonlySet<number>): CanonicalGridV1 {
  if (masked.size === 0) return baseGrid
  const cells = baseGrid.cells.map((cell, index) => (masked.has(index) ? (actual.cells[index] as CanonicalCell) : cell))
  return { ...baseGrid, cells }
}

const SCAN_WIDTH = 48
const SCAN_HEIGHT = 14

function scanBaseLines(variant: 'a' | 'b'): readonly string[] {
  const link = '\x1b]8;;https://example.com/docs\x07docs link\x1b]8;;\x07'
  const lines = [
    `${styleText('base header ' + (variant === 'a' ? 'A' : 'B'), lineStyle({ bold: true }))} tail`,
    '123456789_你好了_world', // wide head at col 10; continuation straddles the centered overlay edge
    'ab你好 cd ef gh ij kl', // wide head at col 2; straddles the top-left inner overlay edge
    `${styleText('styled run', lineStyle({ foreground: 'ansi256:39' }))} plain`,
    `see ${link} here`,
    'row five   ' + variant,
    'row six — em-dash · middle',
    'row seven',
    'row eight',
    'row nine',
    'row ten',
    'row eleven',
    `row twelve ${variant}`,
    'row thirteen',
  ]
  return variant === 'a'
    ? lines
    : lines.map((line, index) => (index === 5 || index === 12 ? `${line} [mutated]` : line))
}

function scanSteps(): readonly GhostStep[] {
  const outer = (revision: number, extra: Partial<OverlayState> = {}) =>
    makeScanOverlay({
      overlayId: 'outer',
      revision,
      anchor: 'center',
      width: 26,
      payload: { lines: ['OUTER panel 你好', styleText('second', lineStyle({ bold: true })), 'third line'] },
      ...extra,
    })
  const inner = (revision: number, extra: Partial<OverlayState> = {}) =>
    makeScanOverlay({
      overlayId: 'inner',
      revision,
      anchor: 'top-left',
      offsetX: 2,
      offsetY: 1,
      width: 16,
      payload: { lines: ['INNER', '你好'] },
      ...extra,
    })
  return [
    { id: 'baseline', overlays: [] },
    { id: 'open-outer-center', overlays: [outer(1)] },
    { id: 'move-outer-absolute', overlays: [outer(2, { row: 2, col: 4 })] },
    { id: 'resize-outer-percent', overlays: [outer(3, { width: '50%', maxHeight: 2 })] },
    // Base mutates while the overlay is open: revealed cells must track THIS frame's base.
    { id: 'open-inner-nested+base-mutation', base: scanBaseLines('b'), overlays: [outer(3, { width: '50%', maxHeight: 2 }), inner(1)] },
    { id: 'move-inner-bottom-right', overlays: [outer(3, { width: '50%', maxHeight: 2 }), inner(2, { anchor: 'bottom-right', offsetX: -1, offsetY: -1 })] },
    { id: 'resize-narrow-with-overlays', resizeTo: { width: 36, height: 10 }, overlays: [outer(3, { width: '50%', maxHeight: 2 }), inner(2, { anchor: 'bottom-right', offsetX: -1, offsetY: -1 })] },
    { id: 'resize-restore', resizeTo: { width: SCAN_WIDTH, height: SCAN_HEIGHT }, overlays: [outer(3, { width: '50%', maxHeight: 2 }), inner(2, { anchor: 'bottom-right', offsetX: -1, offsetY: -1 })] },
    { id: 'close-inner', overlays: [outer(3, { width: '50%', maxHeight: 2 })] },
    { id: 'close-outer', overlays: [] },
    { id: 'reopen-edge-anchor-percent', overlays: [outer(4, { anchor: 'right-center', width: '30%', row: undefined, col: undefined })] },
    { id: 'close-final', overlays: [] },
  ]
}

/**
 * Scripted overlay open/move/resize/nest/close (+ mid-overlay base mutation
 * and viewport resize). Per step, through compositor + backend + BOTH replay
 * halves: (1) the patch stream must reproduce the freshly composed frame;
 * (2) outside the union of current overlay rects (plus legal wide-pair edge
 * healing), the screen must be cell-identical to the never-overlaid base;
 * (3) whenever the stack is empty the whole screen must equal the base —
 * zero ghosting.
 */
export function runOverlayGhostingScan(profileBase: TerminalProfile): OverlayGhostingResult {
  const scenario = 'overlay-open-move-resize-nest-close'
  const profile: TerminalProfile = {
    ...profileBase,
    id: `ghost-scan-${profileBase.id}`,
    columns: SCAN_WIDTH,
    rows: SCAN_HEIGHT,
  }
  const failures: ScanFailure[] = []
  const stats: RunStats = { frames: 0, fullRedraws: 0, modeOps: 0, bytes: 0, maxRowWidth: 0 }

  const backend = new FullscreenBackend()
  const vt = new VirtualTerminal(profile)
  let previousFrame: Frame | null = null
  let grid: CanonicalGridV1 | null = null
  let width = SCAN_WIDTH
  let height = SCAN_HEIGHT
  let baseLines: readonly string[] = scanBaseLines('a')
  let frameSeq = 0

  for (const step of scanSteps()) {
    if (step.base !== undefined) baseLines = step.base
    if (step.resizeTo !== undefined) {
      width = step.resizeTo.width
      height = step.resizeTo.height
      previousFrame = null // coordinator resize-transaction semantics
    }
    const base = buildFrame({
      frameId: `ghost-${++frameSeq}-${step.id}`,
      stateRevision: frameSeq,
      width,
      height,
      lines: baseLines,
      profile,
      modes: harnessModes(SCAN_HEIGHT, false),
      generation: 0,
      fullRedraw: step.resizeTo !== undefined,
      fullRedrawReason: step.resizeTo !== undefined ? 'resize' : undefined,
    })
    const composed = compositeFrame({
      base,
      profile,
      overlays: step.overlays,
      renderOverlay: scanOverlayRenderer,
      previous: previousFrame,
    }).frame
    const baseOnly = compositeFrame({ base, profile, overlays: [], previous: null }).frame

    const patch = backend.plan(previousFrame, composed)
    stats.frames += 1
    if (patch.fullRedraw) stats.fullRedraws += 1
    stats.modeOps += patch.operations.filter((op) => op.kind === 'mode').length
    stats.bytes += patch.bytes
    const { encoded } = encodePatchOperationsSync(patch.operations)

    // Differential half: the patch stream reproduces the composed frame.
    const geometryChanged = grid !== null && (grid.width !== width || grid.height !== height)
    if (grid === null) grid = emptyCanonicalGrid(width, height, composed.modes)
    else if (geometryChanged) grid = resizeCanonicalGrid(grid, width, height)
    grid = applyPatchToCanonicalGrid(grid, patch)
    const composedGrid = canonicalizeFrame(composed)
    assertGridEquals(failures, { scope: 'ghost-differential', frameId: composed.frameId }, grid, composedGrid)

    if (geometryChanged) vt.resize(width, height)
    vt.write(encoded)
    const vtSnapshot = vt.snapshot()
    assertGridEquals(failures, { scope: 'ghost-vt', frameId: composed.frameId }, vtSnapshot, vtExpectedOf(composed, vt))
    stats.maxRowWidth = Math.max(stats.maxRowWidth, maxGridRowWidth(vtSnapshot))

    // No-ghost half: composed vs never-overlaid base outside the overlays.
    const rects = composed.layers
      .filter((layer) => layer.id !== 'base' && layer.clip !== undefined)
      .map((layer) => layer.clip as OverlayRect)
    const covered = coveredIndices(rects, width)
    const baseGrid = canonicalizeFrame(baseOnly)
    const baseKeys = baseGrid.cells.map(cellKey)
    const outsideChanged = new Set<number>()
    for (let index = 0; index < baseGrid.cells.length; index++) {
      if (covered.has(index)) continue
      if (baseKeys[index] !== cellKey(composedGrid.cells[index] as CanonicalCell)) {
        outsideChanged.add(index)
      }
    }
    const legalEdge = edgeNeighborIndices(rects, width, height)
    for (const index of outsideChanged) {
      if (!legalEdge.has(index)) {
        pushFailure(failures, {
          scope: 'ghost-outside-overlay',
          frameId: composed.frameId,
          message: `composed frame diverges from the base outside overlay rects at x${index % width} y${Math.floor(index / width)}`,
        })
      }
    }
    const masked = new Set<number>([...covered, ...outsideChanged])
    assertGridEquals(failures, { scope: 'ghost-reveal', frameId: composed.frameId }, grid, maskGrid(baseGrid, grid, masked))
    const vtRevealBase = maskGrid(vtBufferConvention(baseGrid), vtSnapshot, masked)
    // The host pins scrollRegion to the initial geometry; the VT re-clamps it
    // on resize, so project the VT's region like vtExpectedOf does.
    const vtRevealExpected = {
      ...vtRevealBase,
      modes: { ...vtRevealBase.modes, scrollRegion: vtSnapshot.modes.scrollRegion },
    }
    assertGridEquals(failures, { scope: 'ghost-reveal-vt', frameId: composed.frameId }, vtSnapshot, vtRevealExpected)

    previousFrame = composed
  }

  return {
    profile: profileBase.id,
    scenario,
    steps: scanSteps().length,
    frames: stats.frames,
    fullRedraws: stats.fullRedraws,
    modeOps: stats.modeOps,
    bytes: stats.bytes,
    maxRowWidth: stats.maxRowWidth,
    ok: failures.length === 0,
    gridHash: grid === null ? '' : gridSha256(grid),
    vtHash: gridSha256(vt.snapshot()),
    failures,
  }
}
