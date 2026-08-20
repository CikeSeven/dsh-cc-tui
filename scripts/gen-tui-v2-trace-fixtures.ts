/**
 * WP-02 fixture generator: builds the minimal event-trace corpus
 * (plan §WP-02 trace list) into fixtures/tui-v2/traces/*.jsonl.
 *
 * Deterministic by construction: fixed adapter/session identities, seq from 1
 * per adapter instance, `at` from a fixed base + 100 ms steps, per-source
 * sourceSeq counters, seed 42. Every trace is passed through redactTrace
 * semantics (payloads are pre-sanitized placeholder text; redactionVersion 1
 * is recorded in the header) and validated by writeTrace.
 *
 * All fixtures are `oracle: 'differential-only'` — no renderer exists yet to
 * produce golden grids (WP-04+ upgrades core traces to golden).
 *
 * Run: node --import tsx/esm scripts/gen-tui-v2-trace-fixtures.ts
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppEvent } from '../src/tui-v2/model/events.js'
import type { UiSurfaceView } from '../src/tui-v2/model/surfaces.js'
import type {
  SessionBrowserPayload,
  WorkspaceDialogPayload,
} from '../src/tui-v2/model/catalog-overlay-payloads.js'
import type {
  EffortDialogPayload,
  RoutingPickerPayload,
  SettingsDialogPayload,
} from '../src/tui-v2/model/settings-routing-overlay-payloads.js'
import type {
  EventSource,
  EventMeta,
  InputCommand,
  OverlayState,
  ResetReason,
  SerializableError,
  SerializableValue,
  UiRowSnapshot,
} from '../src/tui-v2/model/schema.js'
import { canonicalJson } from '../src/tui-v2/testkit/canonical.js'
import {
  DEFAULT_REDACTION_POLICY,
  redactTrace,
  writeTrace,
  TRACE_GENERATOR_VERSION,
  type RedactionPolicy,
  type Trace,
  type TraceBodyLine,
} from '../src/tui-v2/testkit/trace.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(repoRoot, 'fixtures', 'tui-v2', 'traces')

const SEED = 42
const BASE_AT = 1_700_000_000_000
const DURABLE_SESSION_ID = 'fixture-session-1'

/** Per-adapter-instance event identity: seq restarts on cross-process resume (§5.2). */
class EventFactory {
  private seqByAdapter = new Map<string, number>()
  private sourceSeqByScope = new Map<string, number>()
  private adapterInstanceId = 'fixture-adapter-1'
  private uiSessionGeneration = 'fixture-gen-1'
  private resetEpoch = 0

  /** Rewind keeps adapter+generation, bumps resetEpoch; resume adopts a new adapter+generation. */
  useIdentity(adapterInstanceId: string, uiSessionGeneration: string, resetEpoch: number): void {
    this.adapterInstanceId = adapterInstanceId
    this.uiSessionGeneration = uiSessionGeneration
    this.resetEpoch = resetEpoch
  }

  get sessionEpoch(): string {
    return `${this.uiSessionGeneration}:${this.resetEpoch}`
  }

  get generation(): string {
    return this.uiSessionGeneration
  }

  meta(source: EventSource): EventMeta {
    const seq = (this.seqByAdapter.get(this.adapterInstanceId) ?? 0) + 1
    this.seqByAdapter.set(this.adapterInstanceId, seq)
    const scope = `${this.adapterInstanceId}:${source}`
    const sourceN = (this.sourceSeqByScope.get(scope) ?? 0) + 1
    this.sourceSeqByScope.set(scope, sourceN)
    return {
      schemaVersion: 1,
      adapterInstanceId: this.adapterInstanceId,
      durableSessionId: DURABLE_SESSION_ID,
      uiSessionGeneration: this.uiSessionGeneration,
      resetEpoch: this.resetEpoch,
      sessionEpoch: this.sessionEpoch,
      source,
      sourceSeq: `${source}-${sourceN}`,
      seq,
      at: 0, // filled by stamp()
    }
  }

  private atCounter = 0
  stamp(event: AppEvent): AppEvent {
    this.atCounter += 1
    return { ...event, at: BASE_AT + this.atCounter * 100 }
  }
}

function snapshotHash(rows: readonly UiRowSnapshot[]): string {
  return `snap-${createHash('sha256').update(canonicalJson(rows), 'utf8').digest('hex').slice(0, 16)}`
}

function makeRow(fx: EventFactory, init: {
  source: UiRowSnapshot['source']
  sourceId: string
  sourceSeq?: string
  kind: string
  blocks?: readonly SerializableValue[]
  settled?: boolean
  revision?: number
  tool?: UiRowSnapshot['tool']
}): UiRowSnapshot {
  const sourceSeq = init.sourceSeq ?? `${init.source}-${init.sourceId}-1`
  return {
    rowId: `${fx.sessionEpoch}:${init.source}:${init.sourceId}:${sourceSeq}`,
    durableSessionId: DURABLE_SESSION_ID,
    uiSessionGeneration: fx.generation,
    sessionEpoch: fx.sessionEpoch,
    source: init.source,
    sourceId: init.sourceId,
    sourceSeq,
    revision: init.revision ?? 0,
    kind: init.kind,
    blocks: init.blocks ?? [],
    settled: init.settled ?? true,
    ...(init.tool !== undefined ? { tool: init.tool } : {}),
  }
}

function makeOverlay(init: Partial<OverlayState> & { overlayId: string }): OverlayState {
  return {
    revision: 0,
    anchor: 'center',
    visible: true,
    captureInput: true,
    nonCapturing: false,
    payload: {},
    ...init,
  }
}

interface TraceSpec {
  readonly terminalProfile: string
  readonly redactionPolicy?: RedactionPolicy
  readonly build: (fx: EventFactory) => TraceBodyLine[]
}

const traces: Record<string, TraceSpec> = {}

/**
 * New component fixtures may preserve only generator-owned placeholders and
 * structural discriminants. Every other payload keeps the default hash
 * redaction; existing traces do not opt in, so their bytes remain unchanged.
 */
const COMPONENT_TRACE_LITERALS = new Set(['markdown', 'text', 'diff', 'terminal'])
const COMPONENT_TRACE_REDACTION: RedactionPolicy = {
  redactPayload: (text) =>
    text.startsWith('[placeholder]') || COMPONENT_TRACE_LITERALS.has(text)
      ? undefined
      : DEFAULT_REDACTION_POLICY.redactPayload?.(text),
  redactCredential: DEFAULT_REDACTION_POLICY.redactCredential,
  redactOsc: DEFAULT_REDACTION_POLICY.redactOsc,
}

const INTERACTIVE_TRACE_LITERALS = new Set([
  'picker-dialog',
  'help-dialog',
  'history-search-dialog',
  'transcript-search-dialog',
  'markdown',
  'text',
])
const INTERACTIVE_TRACE_REDACTION: RedactionPolicy = {
  redactPayload: (text) =>
    text === '' || text.startsWith('[placeholder]') || INTERACTIVE_TRACE_LITERALS.has(text)
      ? undefined
      : DEFAULT_REDACTION_POLICY.redactPayload?.(text),
  redactCredential: DEFAULT_REDACTION_POLICY.redactCredential,
  redactOsc: DEFAULT_REDACTION_POLICY.redactOsc,
}

const CATALOG_TRACE_LITERALS = new Set([
  'session-browser-dialog',
  'workspace-dialog',
  'loading',
  'ready',
  'pending',
  'error',
  'idle',
  'project',
  'session',
  'root',
  'fork',
  'subagent',
  'renamed',
  'auto',
  'prompt',
  'fallback',
  'list',
  'confirm-delete',
  'rename',
  'user',
  'assistant',
  'tool',
  'targets',
  'choices',
  'target',
  'choice',
  'info',
  'success',
  'warning',
])
const CATALOG_TRACE_REDACTION: RedactionPolicy = {
  redactPayload: (text) =>
    text === '' || text.startsWith('[placeholder]') || CATALOG_TRACE_LITERALS.has(text)
      ? undefined
      : DEFAULT_REDACTION_POLICY.redactPayload?.(text),
  redactCredential: DEFAULT_REDACTION_POLICY.redactCredential,
  redactOsc: DEFAULT_REDACTION_POLICY.redactOsc,
}

const SETTINGS_ROUTING_TRACE_LITERALS = new Set([
  'settings-dialog',
  'routing-picker-dialog',
  'effort-dialog',
  'loading',
  'ready',
  'pending',
  'error',
  'sections',
  'fields',
  'list',
  'edit',
  'confirm-close',
  'confirm-reload',
  'section',
  'namespace',
  'live',
  'restart',
  'text',
  'number',
  'boolean',
  'select',
  'model',
  'preset',
  'info',
  'success',
  'warning',
])
const SETTINGS_ROUTING_TRACE_REDACTION: RedactionPolicy = {
  redactPayload: (text) =>
    text === '' || text.startsWith('[placeholder]') || SETTINGS_ROUTING_TRACE_LITERALS.has(text)
      ? undefined
      : DEFAULT_REDACTION_POLICY.redactPayload?.(text),
  redactCredential: DEFAULT_REDACTION_POLICY.redactCredential,
  redactOsc: DEFAULT_REDACTION_POLICY.redactOsc,
}

const SURFACE_TRACE_LITERALS = new Set([
  'trajectory', 'timeline', 'hotspot', 'compressed', 'duration', 'count',
  'active', 'blocked', 'complete', 'pending', 'in_progress', 'completed',
  'thinking', 'done', 'context-panel', 'ready', 'loading',
])
const SURFACE_TRACE_REDACTION: RedactionPolicy = {
  redactPayload: (text) =>
    text === '' || text.startsWith('[placeholder]') || SURFACE_TRACE_LITERALS.has(text)
      ? undefined
      : DEFAULT_REDACTION_POLICY.redactPayload?.(text),
  redactCredential: DEFAULT_REDACTION_POLICY.redactCredential,
  redactOsc: DEFAULT_REDACTION_POLICY.redactOsc,
}

function event(fx: EventFactory, source: EventSource, body: Omit<AppEvent, keyof EventMeta>): TraceBodyLine {
  return { kind: 'event', event: fx.stamp({ ...fx.meta(source), ...body } as AppEvent) }
}

function resetEvent(fx: EventFactory, reason: ResetReason, rows: readonly UiRowSnapshot[], resetId: string): TraceBodyLine {
  return event(fx, 'session', {
    type: 'session/rows-reset',
    resetId,
    rows,
    snapshotHash: snapshotHash(rows),
    revision: 1,
    ready: true,
    reason,
  })
}

const cmd = (command: InputCommand) => command

// --- startup: cold start, empty session, initial viewport -----------------
traces['startup'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-startup-1'),
    event(fx, 'terminal', { type: 'viewport/resize', width: 120, height: 40 }),
  ],
}

// --- welcome: local welcome banner row -------------------------------------
traces['welcome'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-welcome-1'),
    event(fx, 'session', {
      type: 'session/row-upsert',
      row: makeRow(fx, {
        source: 'local',
        sourceId: 'welcome',
        kind: 'welcome',
        blocks: ['[placeholder] welcome banner text'],
      }),
    }),
  ],
}

// --- user submit: editor inserts then submit, producing a user row ---------
traces['user-submit'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-user-submit-1'),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'insert', text: '[placeholder] user message part 1' }) }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'insert', text: ' part 2' }) }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'submit' }) }),
    event(fx, 'session', {
      type: 'session/row-upsert',
      row: makeRow(fx, {
        source: 'session',
        sourceId: 'user-msg-1',
        kind: 'user',
        blocks: ['[placeholder] user message part 1 part 2'],
      }),
    }),
  ],
}

// --- assistant stream chunks -----------------------------------------------
traces['assistant-stream'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => {
    const rowId = `${fx.sessionEpoch}:session:assistant-1:session-assistant-1-1`
    return [
      resetEvent(fx, 'new-session', [], 'reset-assistant-stream-1'),
      event(fx, 'session', {
        type: 'session/row-upsert',
        row: makeRow(fx, { source: 'session', sourceId: 'assistant-1', kind: 'assistant', blocks: [], settled: false }),
      }),
      event(fx, 'stream', { type: 'stream/chunk', rowId, text: '[placeholder] chunk one ' }),
      event(fx, 'stream', { type: 'stream/chunk', rowId, text: '[placeholder] chunk two ' }),
      event(fx, 'stream', { type: 'stream/chunk', rowId, text: '[placeholder] chunk three' }),
      event(fx, 'stream', { type: 'stream/settled', rowId, revision: 1 }),
      event(fx, 'session', { type: 'session/row-complete', rowId, revision: 1 }),
    ]
  },
}

// --- reasoning start/end -----------------------------------------------------
traces['reasoning'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => {
    const rowId = `${fx.sessionEpoch}:session:reasoning-1:session-reasoning-1-1`
    return [
      resetEvent(fx, 'new-session', [], 'reset-reasoning-1'),
      event(fx, 'session', {
        type: 'session/row-upsert',
        row: makeRow(fx, { source: 'session', sourceId: 'reasoning-1', kind: 'reasoning', blocks: [], settled: false }),
      }),
      event(fx, 'stream', { type: 'stream/chunk', rowId, text: '[placeholder] reasoning fragment 1 ' }),
      event(fx, 'stream', { type: 'stream/chunk', rowId, text: '[placeholder] reasoning fragment 2' }),
      event(fx, 'stream', { type: 'stream/settled', rowId, revision: 1 }),
      event(fx, 'session', { type: 'session/row-complete', rowId, revision: 1 }),
    ]
  },
}

// --- tool start/result/error -------------------------------------------------
traces['tool-lifecycle'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => {
    const toolOk = (phase: 'running' | 'result', revision: number, lifecycleRevision: number): UiRowSnapshot =>
      makeRow(fx, {
        source: 'session',
        sourceId: 'tool-call-1',
        kind: 'tool',
        revision,
        tool: {
          phase,
          lifecycleRevision,
          ...(phase === 'result'
            ? { durationMs: 120, resultView: '[placeholder] tool result payload' }
            : { callView: { name: '[placeholder-tool]', args: '[placeholder] tool args' } }),
        },
      })
    const toolErr = (phase: 'running' | 'error', revision: number, lifecycleRevision: number): UiRowSnapshot =>
      makeRow(fx, {
        source: 'session',
        sourceId: 'tool-call-2',
        kind: 'tool',
        revision,
        tool: {
          phase,
          lifecycleRevision,
          ...(phase === 'error'
            ? { durationMs: 40, error: { code: 'TOOL_FAILED', message: '[placeholder] tool error', recoverable: true } satisfies SerializableError }
            : { callView: { name: '[placeholder-tool-2]', args: '[placeholder] tool args' } }),
        },
      })
    return [
      resetEvent(fx, 'new-session', [], 'reset-tool-lifecycle-1'),
      event(fx, 'session', { type: 'session/row-upsert', row: toolOk('running', 0, 0) }),
      event(fx, 'session', { type: 'session/row-upsert', row: toolOk('result', 1, 1) }),
      event(fx, 'session', { type: 'session/row-upsert', row: toolErr('running', 0, 0) }),
      event(fx, 'session', { type: 'session/row-upsert', row: toolErr('error', 1, 1) }),
    ]
  },
}

// --- WP-08b Markdown + complete tool-card rendering -------------------------
traces['markdown-tool-rendering'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  redactionPolicy: COMPONENT_TRACE_REDACTION,
  build: (fx) => {
    const editTool = (phase: 'running' | 'result', revision: number): UiRowSnapshot =>
      makeRow(fx, {
        source: 'session',
        sourceId: 'tool-render-edit-1',
        kind: 'tool',
        revision,
        blocks: [{ type: 'text', text: '[placeholder] Edit src/配置.ts' }],
        tool: {
          phase,
          lifecycleRevision: revision,
          ...(phase === 'running'
            ? {
                callView: {
                  card: 'diff',
                  title: '[placeholder] Edit src/配置.ts',
                  diffs: [{
                    path: '[placeholder] src/配置.ts',
                    oldText: '[placeholder] const oldName = 1',
                    newText: '[placeholder] const newName = 2 👨‍👩‍👧',
                  }],
                },
              }
            : {
                durationMs: 320,
                resultView: {
                  card: 'diff',
                  title: '[placeholder] Edit src/配置.ts',
                  diffs: [
                    {
                      path: '[placeholder] src/配置.ts',
                      oldText: '[placeholder] const oldName = 1',
                      newText: '[placeholder] const newName = 2 👨‍👩‍👧',
                    },
                    {
                      path: '[placeholder] src/配置.ts',
                      oldText: '[placeholder] return oldName',
                      newText: '[placeholder] return newName',
                    },
                  ],
                },
              }),
        },
      })

    return [
      resetEvent(fx, 'new-session', [], 'reset-markdown-tool-rendering-1'),
      event(fx, 'terminal', { type: 'viewport/resize', width: 120, height: 30 }),
      event(fx, 'session', {
        type: 'session/row-upsert',
        row: makeRow(fx, {
          source: 'session',
          sourceId: 'assistant-markdown-rich-1',
          kind: 'assistant',
          blocks: [{
            type: 'markdown',
            text: [
              '[placeholder] soft paragraph',
              'continues with _italic **nested bold**_ and [docs][ref].',
              '',
              'Setext heading',
              '===',
              '---',
              '| Name | 状态 |',
              '| :--- | ---: |',
              '| renderer | ready 👨‍👩‍👧 |',
              '',
              '~~~ typescript title=fixture',
              'const answer = 42 // highlighted',
              '~~~',
              '[ref]: https://example.invalid/docs',
            ].join('\n'),
          }],
        }),
      }),
      event(fx, 'session', { type: 'session/row-upsert', row: editTool('running', 0) }),
      event(fx, 'session', { type: 'session/row-upsert', row: editTool('result', 1) }),
      event(fx, 'session', {
        type: 'session/row-upsert',
        row: makeRow(fx, {
          source: 'session',
          sourceId: 'tool-render-output-1',
          kind: 'tool',
          blocks: [{ type: 'text', text: '[placeholder] Bash(long-output)' }],
          tool: {
            phase: 'result',
            lifecycleRevision: 1,
            durationMs: 1500,
            resultView: {
              card: 'terminal',
              output: '[placeholder] line one\nline two\n你好 👨‍👩‍👧\nline four\nline five',
              exitCode: 0,
            },
          },
        }),
      }),
      event(fx, 'session', {
        type: 'session/row-upsert',
        row: makeRow(fx, {
          source: 'session',
          sourceId: 'tool-render-error-1',
          kind: 'tool',
          blocks: [{ type: 'text', text: '[placeholder] Bash(false)' }],
          tool: {
            phase: 'error',
            lifecycleRevision: 1,
            durationMs: 20,
            error: {
              code: 'TOOL_RENDER_FAILED',
              message: '[placeholder] command failed',
              recoverable: true,
              details: { stderr: '[placeholder] failure details' },
            } satisfies SerializableError,
          },
        }),
      }),
    ]
  },
}

// --- approval open/accept/reject ---------------------------------------------
traces['approval'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-approval-1'),
    event(fx, 'session', {
      type: 'session/row-upsert',
      row: makeRow(fx, {
        source: 'session',
        sourceId: 'tool-approval-1',
        kind: 'tool',
        tool: { phase: 'running', lifecycleRevision: 0, callView: { name: '[placeholder-tool]', args: '[placeholder] tool args' } },
      }),
    }),
    event(fx, 'overlay', {
      type: 'overlay/open',
      overlay: makeOverlay({ overlayId: 'approval-1', payload: { kind: 'approval', question: '[placeholder] approval prompt' } }),
    }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'overlay', command: 'close', overlayId: 'approval-1' }) }),
    event(fx, 'overlay', { type: 'overlay/close', overlayId: 'approval-1' }),
    event(fx, 'session', {
      type: 'session/row-upsert',
      row: makeRow(fx, {
        source: 'session',
        sourceId: 'tool-approval-1',
        kind: 'tool',
        revision: 1,
        tool: { phase: 'result', lifecycleRevision: 1, durationMs: 900, resultView: '[placeholder] approved' },
      }),
    }),
    event(fx, 'overlay', {
      type: 'overlay/open',
      overlay: makeOverlay({ overlayId: 'approval-2', payload: { kind: 'approval', question: '[placeholder] approval prompt 2' } }),
    }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'overlay', command: 'close', overlayId: 'approval-2' }) }),
    event(fx, 'overlay', { type: 'overlay/close', overlayId: 'approval-2' }),
  ],
}

// --- question open/answer/cancel ---------------------------------------------
traces['question'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-question-1'),
    event(fx, 'overlay', {
      type: 'overlay/open',
      overlay: makeOverlay({ overlayId: 'question-1', payload: { kind: 'question', prompt: '[placeholder] question prompt' } }),
    }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'insert', text: '[placeholder] answer text' }) }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'submit' }) }),
    event(fx, 'overlay', { type: 'overlay/close', overlayId: 'question-1' }),
    event(fx, 'overlay', {
      type: 'overlay/open',
      overlay: makeOverlay({ overlayId: 'question-2', payload: { kind: 'question', prompt: '[placeholder] question prompt 2' } }),
    }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'cancel' }) }),
    event(fx, 'overlay', { type: 'overlay/close', overlayId: 'question-2' }),
  ],
}

// --- WP-08c picker/help/history/transcript-search overlays -------------------
traces['interactive-overlays'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  redactionPolicy: INTERACTIVE_TRACE_REDACTION,
  build: (fx) => {
    const first = makeRow(fx, {
      source: 'session',
      sourceId: 'interactive-search-row-1',
      kind: 'assistant',
      blocks: [{ type: 'markdown', text: '[placeholder] searchable transcript one' }],
    })
    const second = makeRow(fx, {
      source: 'session',
      sourceId: 'interactive-search-row-2',
      kind: 'user',
      blocks: [{ type: 'text', text: '[placeholder] searchable transcript two' }],
    })
    const pickerQuery = '[placeholder] filter'
    const list = (query: string, items: readonly SerializableValue[]) => ({
      query,
      cursor: [...query].length,
      activeIndex: 0,
      windowStart: 0,
      windowEnd: items.length,
      items,
      sourceCount: 2,
      emptyMessage: '[placeholder] empty',
      noResultsMessage: '[placeholder] no results',
      hint: '[placeholder] list hint',
    })
    const pickerItems = [
      { id: '[placeholder] alpha-id', label: '[placeholder] Alpha', description: '[placeholder] first item' },
      {
        id: '[placeholder] beta-id',
        label: '[placeholder] Beta',
        disabled: true,
        disabledReason: '[placeholder] unavailable',
      },
    ]
    return [
      resetEvent(fx, 'new-session', [first, second], 'reset-interactive-overlays-1'),
      event(fx, 'overlay', {
        type: 'overlay/open',
        overlay: makeOverlay({
          overlayId: 'utility/picker/fixture',
          revision: 1,
          width: '80%',
          maxHeight: '80%',
          payload: {
            kind: 'picker-dialog',
            key: '[placeholder] picker-key',
            title: '[placeholder] picker title',
            subtitle: '[placeholder] generic picker boundary',
            list: list('', pickerItems),
          },
        }),
      }),
      event(fx, 'overlay', {
        type: 'overlay/open',
        overlay: makeOverlay({
          overlayId: 'utility/picker/fixture',
          revision: 2,
          width: '80%',
          maxHeight: '80%',
          payload: {
            kind: 'picker-dialog',
            key: '[placeholder] picker-key',
            title: '[placeholder] picker title',
            list: list(pickerQuery, [pickerItems[0] as SerializableValue]),
          },
        }),
      }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/picker/fixture' }),
      event(fx, 'overlay', {
        type: 'overlay/open',
        overlay: makeOverlay({
          overlayId: 'utility/help',
          revision: 1,
          width: '80%',
          maxHeight: '80%',
          payload: {
            kind: 'help-dialog',
            key: '[placeholder] help-key',
            title: '[placeholder] Help',
            shortcuts: [{ keys: '[placeholder] Ctrl+R', label: '[placeholder] history search' }],
            list: list('', pickerItems),
          },
        }),
      }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/help' }),
      event(fx, 'overlay', {
        type: 'overlay/open',
        overlay: makeOverlay({
          overlayId: 'utility/history',
          revision: 1,
          width: '80%',
          maxHeight: '80%',
          payload: {
            kind: 'history-search-dialog',
            key: '[placeholder] history-key',
            title: '[placeholder] Prompt history',
            placeholder: '[placeholder] type to search',
            list: list('', pickerItems),
          },
        }),
      }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/history' }),
      event(fx, 'overlay', {
        type: 'overlay/open',
        overlay: makeOverlay({
          overlayId: 'utility/search',
          revision: 1,
          width: '80%',
          maxHeight: '80%',
          payload: {
            kind: 'transcript-search-dialog',
            key: '[placeholder] search-key',
            title: '[placeholder] Search transcript',
            query: '[placeholder] searchable',
            cursor: [...'[placeholder] searchable'].length,
            current: 0,
            total: 2,
            noResultsMessage: '[placeholder] no transcript matches',
            hint: '[placeholder] search hint',
          },
        }),
      }),
      event(fx, 'overlay', {
        type: 'search/update',
        search: { query: '[placeholder] searchable', active: true, current: 0, matches: [first.rowId, second.rowId] },
      }),
      event(fx, 'overlay', {
        type: 'search/update',
        search: { query: '[placeholder] searchable', active: true, current: 1, matches: [first.rowId, second.rowId] },
      }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/search' }),
      event(fx, 'overlay', {
        type: 'search/update',
        search: { query: '[placeholder] searchable', active: false, current: 1, matches: [first.rowId, second.rowId] },
      }),
    ]
  },
}

// --- WP-08d1 session browser + workspace provider/local flows ----------------
traces['session-workspace'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  redactionPolicy: CATALOG_TRACE_REDACTION,
  build: (fx) => {
    const sessionId = '[placeholder] resumable-session'
    const currentSessionId = '[placeholder] current-session'
    const filterText = '[placeholder] session filter'
    const sessionRows: SessionBrowserPayload['rows'] = [
      {
        kind: 'project',
        key: '[placeholder] project-row',
        cwd: '[placeholder] /workspace/project',
        count: 1,
      },
      {
        kind: 'session',
        id: sessionId,
        sessionKind: 'fork',
        title: '[placeholder] renamed session',
        titleSource: 'renamed',
        cwd: '[placeholder] /workspace/project',
        createdAt: BASE_AT - 20_000,
        updatedAt: BASE_AT - 1_000,
        depth: 1,
        bytes: 4_096,
        model: '[placeholder] model id',
        branch: '[placeholder] branch name',
        childCount: 1,
      },
    ]
    const sessionView = (
      phase: SessionBrowserPayload['phase'],
      query: string,
      preview: SessionBrowserPayload['preview'],
    ): SessionBrowserPayload => ({
      kind: 'session-browser-dialog',
      key: '[placeholder] session-browser-key',
      title: '[placeholder] Resume session',
      phase,
      now: BASE_AT,
      filter: {
        query,
        cursor: [...query].length,
        allProjects: true,
        branchOnly: false,
        showSubagents: true,
      },
      rows: phase === 'loading' ? [] : sessionRows,
      ...(phase === 'loading' ? {} : { selectedId: sessionId }),
      hasMoreAbove: false,
      hasMoreBelow: false,
      sourceCount: phase === 'loading' ? 0 : 3,
      shownCount: phase === 'loading' ? 0 : 1,
      hiddenSubagents: phase === 'loading' ? 0 : 1,
      emptyCount: phase === 'loading' ? 0 : 1,
      current: { id: currentSessionId, title: '[placeholder] Current session' },
      mode: 'list',
      preview,
      hint: '[placeholder] session browser keys',
    })
    const idlePreview: SessionBrowserPayload['preview'] = {
      open: false,
      phase: 'idle',
      entries: [],
    }
    const loadingPreview: SessionBrowserPayload['preview'] = {
      open: true,
      phase: 'loading',
      sessionId,
      title: '[placeholder] renamed session',
      cwd: '[placeholder] /workspace/project',
      entries: [],
    }
    const readyPreview: SessionBrowserPayload['preview'] = {
      ...loadingPreview,
      phase: 'ready',
      entries: [
        { role: 'user', text: '[placeholder] user preview' },
        { role: 'assistant', text: '[placeholder] assistant preview' },
        { role: 'tool', text: '[placeholder] tool/call preview' },
      ],
    }
    const sessionOverlay = (revision: number, payload: SessionBrowserPayload): OverlayState => makeOverlay({
      overlayId: 'utility/session-browser',
      revision,
      width: '96%',
      maxHeight: '90%',
      margin: 1,
      payload: payload as unknown as SerializableValue,
    })

    const choiceOne = '[placeholder] provider-choice-one'
    const choiceTwo = '[placeholder] provider-choice-two'
    const targetId = '[placeholder] provider-target'
    const workspaceOverlay = (revision: number, payload: WorkspaceDialogPayload): OverlayState => makeOverlay({
      overlayId: 'utility/workspace',
      revision,
      width: '80%',
      maxHeight: '80%',
      margin: 1,
      payload: payload as unknown as SerializableValue,
    })
    const providerChoices: WorkspaceDialogPayload = {
      kind: 'workspace-dialog',
      key: '[placeholder] provider-workspace-key',
      title: '[placeholder] Provider workspace',
      phase: 'ready',
      view: 'choices',
      query: '',
      cursor: 0,
      items: [
        {
          kind: 'choice',
          id: choiceOne,
          label: '[placeholder] Create provider workspace',
          description: '[placeholder] provider input choice',
          badge: '[placeholder] remote',
          hasInput: true,
        },
        {
          kind: 'choice',
          id: choiceTwo,
          label: '[placeholder] Resume provider workspace',
        },
      ],
      selectedId: choiceOne,
      hasMoreAbove: false,
      hasMoreBelow: false,
      sourceCount: 2,
      filteredCount: 2,
      degraded: false,
      hint: '[placeholder] workspace choice keys',
    }
    const providerPending: WorkspaceDialogPayload = {
      ...providerChoices,
      phase: 'pending',
      notice: { text: '[placeholder] provider operation pending', tone: 'info' },
      hint: '[placeholder] cancel pending provider work',
    }
    const providerTarget: WorkspaceDialogPayload = {
      kind: 'workspace-dialog',
      key: '[placeholder] provider-workspace-key',
      title: '[placeholder] Provider target',
      phase: 'pending',
      view: 'targets',
      query: '',
      cursor: 0,
      items: [{
        kind: 'target',
        id: targetId,
        label: '[placeholder] Provider target workspace',
        description: '[placeholder] resolved provider target',
        badge: '[placeholder] remote',
      }],
      selectedId: targetId,
      hasMoreAbove: false,
      hasMoreBelow: false,
      sourceCount: 1,
      filteredCount: 1,
      degraded: false,
      notice: { text: '[placeholder] switching provider target', tone: 'info' },
      hint: '[placeholder] cancel target switch',
    }
    const localTargetId = '[placeholder] local-target'
    const degradedLocal: WorkspaceDialogPayload = {
      kind: 'workspace-dialog',
      key: '[placeholder] local-workspace-key',
      title: '[placeholder] Switch workspace',
      phase: 'ready',
      view: 'targets',
      query: '',
      cursor: 0,
      items: [{
        kind: 'target',
        id: localTargetId,
        label: '[placeholder] Local workspace',
        description: '[placeholder] local-only fallback target',
        badge: '[placeholder] local',
        current: true,
      }],
      selectedId: localTargetId,
      hasMoreAbove: false,
      hasMoreBelow: false,
      sourceCount: 1,
      filteredCount: 1,
      degraded: true,
      notice: { text: '[placeholder] local-only fallback', tone: 'warning' },
      hint: '[placeholder] workspace target keys',
    }

    const lines: TraceBodyLine[] = [
      resetEvent(fx, 'new-session', [], 'reset-session-workspace-1'),
      event(fx, 'overlay', { type: 'overlay/open', overlay: sessionOverlay(1, sessionView('loading', '', idlePreview)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: sessionOverlay(2, sessionView('ready', '', idlePreview)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: sessionOverlay(3, sessionView('ready', filterText, idlePreview)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: sessionOverlay(4, sessionView('ready', filterText, loadingPreview)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: sessionOverlay(5, sessionView('ready', filterText, readyPreview)) }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/session-browser' }),
    ]

    // A real resume adopts the replay controller's new adapter/generation
    // identity before the reset and all subsequent workspace interactions.
    fx.useIdentity('fixture-adapter-2', 'fixture-gen-2', 0)
    const resumedRow = makeRow(fx, {
      source: 'session',
      sourceId: 'resumed-assistant-1',
      kind: 'assistant',
      blocks: ['[placeholder] resumed transcript'],
    })
    lines.push(
      resetEvent(fx, 'resume', [resumedRow], 'reset-session-workspace-resume-1'),
      event(fx, 'overlay', { type: 'overlay/open', overlay: workspaceOverlay(1, providerChoices) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: workspaceOverlay(2, providerPending) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: workspaceOverlay(3, providerTarget) }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/workspace' }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: workspaceOverlay(1, degradedLocal) }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/workspace' }),
    )
    return lines
  },
}

// --- WP-08d2 settings + model/preset/effort capability routing --------------
traces['settings-routing'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  redactionPolicy: SETTINGS_ROUTING_TRACE_REDACTION,
  build: (fx) => {
    const settingsSection: SettingsDialogPayload['sections'][number] = {
      id: '[placeholder] settings-section-demo',
      ns: '[placeholder] demo-settings',
      title: '[placeholder] Demo settings 你好😀',
      source: 'section',
      available: true,
      applies: 'restart',
      dirty: false,
      invalid: false,
      saving: false,
      failed: false,
      conflicted: false,
      fieldsCount: 3,
    }
    const settingsFields: SettingsDialogPayload['fields'] = [
      {
        id: '[placeholder] enabled-field',
        label: '[placeholder] Enabled',
        kind: 'boolean',
        text: '[placeholder] true',
        staged: false,
        overridden: true,
        invalid: false,
        secret: false,
      },
      {
        id: '[placeholder] limit-field',
        label: '[placeholder] Retry limit',
        hint: '[placeholder] Attempts before giving up',
        kind: 'number',
        text: '[placeholder] 3',
        staged: false,
        overridden: false,
        invalid: false,
        secret: false,
      },
      {
        id: '[placeholder] token-field',
        label: '[placeholder] API token',
        kind: 'text',
        text: '[placeholder] ••••',
        staged: false,
        overridden: false,
        invalid: false,
        secret: true,
        configured: true,
      },
    ]
    const settingsView = (
      phase: SettingsDialogPayload['phase'],
      revision: number,
      override: Partial<SettingsDialogPayload> = {},
    ): SettingsDialogPayload => ({
      kind: 'settings-dialog',
      key: '[placeholder] settings-key',
      title: '[placeholder] Settings',
      phase,
      pane: 'fields',
      mode: 'list',
      sections: [{
        ...settingsSection,
        dirty: revision >= 3 && revision <= 5,
        invalid: revision === 4,
        saving: phase === 'pending',
        conflicted: revision === 6,
      }],
      sectionWindowStart: 0,
      sectionWindowEnd: 1,
      selectedSectionId: settingsSection.id,
      fields: settingsFields.map((field, index) => ({
        ...field,
        ...(revision >= 3 && index === 1 ? { staged: true, text: revision === 4 ? '[placeholder] invalid-number' : '[placeholder] 10' } : {}),
        ...(revision === 4 && index === 1 ? { invalid: true } : {}),
      })),
      fieldWindowStart: 0,
      fieldWindowEnd: settingsFields.length,
      selectedFieldId: settingsFields[1]!.id,
      hint: '[placeholder] settings keys',
      ...override,
    })
    const settingsOverlay = (revision: number, payload: SettingsDialogPayload): OverlayState => makeOverlay({
      overlayId: 'utility/settings',
      revision,
      width: '96%',
      maxHeight: '94%',
      margin: 1,
      payload: payload as unknown as SerializableValue,
    })

    const modelItems: RoutingPickerPayload['list']['items'] = [
      {
        id: '[placeholder] model-current',
        label: '[placeholder] provider-a / Current model',
        provider: '[placeholder] provider-a',
        description: '[placeholder] text model',
        metadata: [{ label: '[placeholder] input', value: '[placeholder] text' }],
        current: true,
      },
      {
        id: '[placeholder] model-target',
        label: '[placeholder] provider-b / Vision model 你好😀',
        provider: '[placeholder] provider-b',
        description: '[placeholder] image input model',
        metadata: [
          { label: '[placeholder] input', value: '[placeholder] text' },
          { label: '[placeholder] input', value: '[placeholder] image' },
        ],
      },
    ]
    const routingView = (
      route: RoutingPickerPayload['route'],
      phase: RoutingPickerPayload['phase'],
      items: RoutingPickerPayload['list']['items'],
      activeIndex: number,
      pendingId?: string,
    ): RoutingPickerPayload => ({
      kind: 'routing-picker-dialog',
      key: `[placeholder] ${route}-key`,
      title: `[placeholder] Choose ${route}`,
      route,
      phase,
      list: {
        query: '',
        cursor: 0,
        activeIndex,
        windowStart: 0,
        windowEnd: items.length,
        items,
        sourceCount: items.length,
        emptyMessage: '[placeholder] no options',
        noResultsMessage: '[placeholder] no matching options',
      },
      ...(pendingId === undefined ? {} : { pendingId }),
      hint: '[placeholder] picker keys',
    })
    const routingOverlay = (kind: 'model' | 'preset', revision: number, payload: RoutingPickerPayload): OverlayState => makeOverlay({
      overlayId: `utility/${kind}`,
      revision,
      width: '92%',
      maxHeight: '86%',
      margin: 1,
      payload: payload as unknown as SerializableValue,
    })

    const presetItems: RoutingPickerPayload['list']['items'] = [
      {
        id: '[placeholder] preset-current',
        label: '[placeholder] Standard',
        description: '[placeholder] Full tool set',
        badges: ['[placeholder] default'],
        current: true,
      },
      {
        id: '[placeholder] preset-minimal',
        label: '[placeholder] Minimal',
        description: '[placeholder] Minimal two-tool roster',
        badges: ['[placeholder] minimal'],
      },
      {
        id: '[placeholder] preset-broken',
        label: '[placeholder] Broken preset',
        description: '[placeholder] manifest missing',
        badges: ['[placeholder] unavailable'],
        disabled: true,
        disabledReason: '[placeholder] manifest missing',
      },
    ]

    const effortOptions: EffortDialogPayload['options'] = [
      { id: '[placeholder] effort-off', name: '[placeholder] Off' },
      { id: '[placeholder] effort-high', name: '[placeholder] High', current: true, default: true },
      { id: '[placeholder] effort-max', name: '[placeholder] Max' },
    ]
    const effortView = (
      phase: EffortDialogPayload['phase'],
      current: number,
      pendingId?: string,
    ): EffortDialogPayload => ({
      kind: 'effort-dialog',
      key: '[placeholder] effort-key',
      title: '[placeholder] Reasoning effort',
      phase,
      options: effortOptions.map((option, index) => ({ ...option, current: index === current })),
      activeIndex: current,
      currentId: current === 1 ? '[placeholder] high' : '[placeholder] max',
      defaultId: '[placeholder] high',
      ...(pendingId === undefined ? {} : { pendingId }),
      hint: '[placeholder] effort keys',
    })
    const effortOverlay = (revision: number, payload: EffortDialogPayload): OverlayState => makeOverlay({
      overlayId: 'utility/effort',
      revision,
      width: '90%',
      maxHeight: '86%',
      margin: 1,
      payload: payload as unknown as SerializableValue,
    })
    const loadingSettings: SettingsDialogPayload = {
      kind: 'settings-dialog',
      key: '[placeholder] settings-key',
      title: '[placeholder] Settings',
      phase: 'loading',
      pane: 'sections',
      mode: 'list',
      sections: [],
      sectionWindowStart: 0,
      sectionWindowEnd: 0,
      fields: [],
      fieldWindowStart: 0,
      fieldWindowEnd: 0,
      hint: '[placeholder] settings keys',
    }

    const welcomeRow = makeRow(fx, {
      source: 'local',
      sourceId: 'settings-routing-welcome',
      kind: 'welcome',
      blocks: ['[placeholder] single startup welcome'],
    })
    const conversationRow = makeRow(fx, {
      source: 'session',
      sourceId: 'settings-routing-conversation',
      kind: 'assistant',
      blocks: ['[placeholder] existing conversation before model switch'],
    })
    const lines: TraceBodyLine[] = [
      resetEvent(fx, 'new-session', [welcomeRow, conversationRow], 'reset-settings-routing-1'),
      event(fx, 'overlay', { type: 'overlay/open', overlay: settingsOverlay(1, loadingSettings) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: settingsOverlay(2, settingsView('ready', 2)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: settingsOverlay(3, settingsView('ready', 3, {
        mode: 'edit',
        editing: { fieldId: settingsFields[1]!.id, text: '[placeholder] 10', cursor: 16 },
      })) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: settingsOverlay(4, settingsView('ready', 4, {
        error: '[placeholder] Fix invalid fields before saving.',
      })) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: settingsOverlay(5, settingsView('pending', 5)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: settingsOverlay(6, settingsView('ready', 6, {
        notice: { text: '[placeholder] Concurrent revision detected; saved against latest revision.', tone: 'warning' },
      })) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: settingsOverlay(7, settingsView('loading', 7)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: settingsOverlay(8, settingsView('ready', 8, {
        notice: { text: '[placeholder] Settings reloaded.', tone: 'success' },
      })) }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/settings' }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: routingOverlay('model', 1, routingView('model', 'loading', [], 0)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: routingOverlay('model', 2, routingView('model', 'ready', modelItems, 0)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: routingOverlay('model', 3, routingView('model', 'pending', modelItems, 1, modelItems[1]!.id)) }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/model' }),
    ]

    // switchModel is the sole route side effect. The adapter's durable row
    // identities remain compatible, so the wakeup needs no second rows-reset
    // and cannot append a second startup/welcome row. The process-local call is
    // recorded as a sanitized trace marker; controller tests prove its exact API.
    lines.push(
      {
        kind: 'expectedState',
        value: {
          modelRouteEffect: {
            provider: '[placeholder] provider-b',
            model: '[placeholder] vision-model',
            atomicCalls: 1,
            startupRows: 1,
            additionalRowsReset: 0,
          },
        },
      },
      event(fx, 'overlay', { type: 'overlay/open', overlay: routingOverlay('preset', 1, routingView('preset', 'ready', presetItems, 0)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: routingOverlay('preset', 2, routingView('preset', 'pending', presetItems, 1, presetItems[1]!.id)) }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/preset' }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: effortOverlay(1, effortView('loading', 1)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: effortOverlay(2, effortView('ready', 1)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: effortOverlay(3, effortView('pending', 2, effortOptions[2]!.id)) }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: effortOverlay(4, effortView('ready', 2, undefined)) }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/effort' }),
    )
    return lines
  },
}

// --- overlay open/move/shrink/close ------------------------------------------
traces['overlay'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-overlay-1'),
    event(fx, 'overlay', {
      type: 'overlay/open',
      overlay: makeOverlay({ overlayId: 'palette-1', width: 60, row: '20%', payload: { kind: 'palette' } }),
    }),
    event(fx, 'overlay', {
      type: 'overlay/open',
      overlay: makeOverlay({ overlayId: 'palette-1', revision: 1, width: 60, row: '30%', payload: { kind: 'palette' } }),
    }),
    event(fx, 'overlay', {
      type: 'overlay/open',
      overlay: makeOverlay({ overlayId: 'palette-1', revision: 2, width: 40, row: '30%', payload: { kind: 'palette' } }),
    }),
    event(fx, 'overlay', { type: 'overlay/close', overlayId: 'palette-1' }),
  ],
}

// --- scroll up/down/sticky restore -------------------------------------------
traces['scroll'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => {
    const rows = [1, 2, 3].map((n) =>
      makeRow(fx, { source: 'session', sourceId: `assistant-${n}`, kind: 'assistant', blocks: [`[placeholder] scroll row ${n}`] }),
    )
    return [
      resetEvent(fx, 'new-session', rows, 'reset-scroll-1'),
      event(fx, 'input', { type: 'input/command', command: cmd({ type: 'scroll', delta: -5 }) }),
      event(fx, 'input', { type: 'input/command', command: cmd({ type: 'scroll', delta: 3 }) }),
      event(fx, 'input', { type: 'input/command', command: cmd({ type: 'scroll', delta: 999 }) }),
    ]
  },
}

// --- editor insert/delete/cursor/history/submit -------------------------------
traces['editor'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-editor-1'),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'insert', text: '[placeholder] draft' }) }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'delete' }) }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'move' }) }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'submit' }) }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'move' }) }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'editor', command: 'submit' }) }),
  ],
}

// --- selection start/update/clear --------------------------------------------
// AppEvent has no dedicated selection variant (§5.2 union); selection store
// snapshots ride in expectedState markers between the driving events.
traces['selection'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-selection-1'),
    event(fx, 'session', {
      type: 'session/row-upsert',
      row: makeRow(fx, { source: 'session', sourceId: 'assistant-1', kind: 'assistant', blocks: ['[placeholder] selectable text'] }),
    }),
    { kind: 'expectedState', value: { selection: { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } } } },
    { kind: 'expectedState', value: { selection: { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 12 } } } },
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'scroll', delta: -1 }) }),
    { kind: 'expectedState', value: { selection: null } },
  ],
}

// --- notification/status/shortcut changes -------------------------------------
traces['notification-status'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-notification-status-1'),
    event(fx, 'session', {
      type: 'session/row-upsert',
      row: makeRow(fx, { source: 'notice', sourceId: 'notice-1', kind: 'notification', blocks: ['[placeholder] notification text'] }),
    }),
    event(fx, 'session', {
      type: 'session/row-upsert',
      row: makeRow(fx, { source: 'activity', sourceId: 'activity-1', kind: 'status', blocks: ['[placeholder] status text'] }),
    }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'app', command: 'redraw' }) }),
    { kind: 'expectedState', value: { status: { shortcuts: ['[placeholder] shortcut hint'] } } },
  ],
}

// --- scene open/close/error and plugin contribution ---------------------------
// WP-08a: scenes are first-class model events (scene/open carries the
// immutable SceneViewModel; typed commands re-open with revision+1);
// plugin rows use source 'plugin'; boundary failures surface as app/error
// with the PLUGIN_SCENE_ERROR code and the plugin/scene identity.
traces['scene'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-scene-1'),
    event(fx, 'plugin', {
      type: 'scene/open',
      scene: { sceneId: 'settings', revision: 0, data: '[placeholder] scene data' },
    }),
    // A validated typed command makes its payload the next view (revision+1).
    event(fx, 'plugin', {
      type: 'scene/open',
      scene: { sceneId: 'settings', revision: 1, data: '[placeholder] scene data updated' },
    }),
    event(fx, 'plugin', { type: 'scene/focus', sceneId: 'settings', target: 'scene' }),
    event(fx, 'plugin', { type: 'scene/close', sceneId: 'settings', reason: 'user' }),
    event(fx, 'plugin', {
      type: 'session/row-upsert',
      row: makeRow(fx, { source: 'plugin', sourceId: 'plugin-1', kind: 'plugin-contribution', blocks: ['[placeholder] plugin row'] }),
    }),
    event(fx, 'app', {
      type: 'app/error',
      error: {
        code: 'PLUGIN_SCENE_ERROR',
        message: '[placeholder] scene error',
        recoverable: true,
        details: { pluginId: 'demo-plugin', instanceId: 'scene-ins-1', sceneId: 'settings', phase: 'render' },
      },
    }),
  ],
}

// --- resize width/height changes ----------------------------------------------
traces['resize'] = {
  terminalProfile: 'unicode-ambiguous-wide',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-resize-1'),
    event(fx, 'terminal', { type: 'viewport/resize', width: 120, height: 40 }),
    event(fx, 'terminal', { type: 'viewport/resize', width: 100, height: 40 }),
    event(fx, 'terminal', { type: 'viewport/resize', width: 100, height: 30 }),
    event(fx, 'terminal', { type: 'viewport/resize', width: 80, height: 24 }),
  ],
}

// --- resume/rewind/new session -------------------------------------------------
traces['resume-rewind'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => {
    fx.useIdentity('fixture-adapter-1', 'fixture-gen-1', 0)
    const rowA = makeRow(fx, { source: 'session', sourceId: 'user-1', kind: 'user', blocks: ['[placeholder] first message'] })
    const lines: TraceBodyLine[] = [
      resetEvent(fx, 'new-session', [rowA], 'reset-initial-1'),
      event(fx, 'session', {
        type: 'session/row-upsert',
        row: makeRow(fx, { source: 'session', sourceId: 'assistant-1', kind: 'assistant', blocks: ['[placeholder] first reply'] }),
      }),
    ]
    // Rewind: same adapter + generation, resetEpoch bumps -> new sessionEpoch.
    fx.useIdentity('fixture-adapter-1', 'fixture-gen-1', 1)
    const rowARewind = makeRow(fx, { source: 'session', sourceId: 'user-1', kind: 'user', blocks: ['[placeholder] first message'] })
    lines.push(resetEvent(fx, 'rewind', [rowARewind], 'reset-rewind-1'))
    // Resume: new adapterInstanceId + uiSessionGeneration, same durable session.
    fx.useIdentity('fixture-adapter-2', 'fixture-gen-2', 0)
    const rowAResumed = makeRow(fx, { source: 'session', sourceId: 'user-1', kind: 'user', blocks: ['[placeholder] first message'] })
    lines.push(resetEvent(fx, 'resume', [rowAResumed], 'reset-resume-1'))
    return lines
  },
}

// --- interrupt ------------------------------------------------------------------
traces['interrupt'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => {
    const rowId = `${fx.sessionEpoch}:session:assistant-1:session-assistant-1-1`
    return [
      resetEvent(fx, 'new-session', [], 'reset-interrupt-1'),
      event(fx, 'session', {
        type: 'session/row-upsert',
        row: makeRow(fx, { source: 'session', sourceId: 'assistant-1', kind: 'assistant', blocks: [], settled: false }),
      }),
      event(fx, 'stream', { type: 'stream/chunk', rowId, text: '[placeholder] partial chunk' }),
      event(fx, 'input', { type: 'input/command', command: cmd({ type: 'app', command: 'interrupt' }) }),
      event(fx, 'stream', { type: 'stream/settled', rowId, revision: 1 }),
      event(fx, 'session', { type: 'session/row-complete', rowId, revision: 1 }),
    ]
  },
}

// --- SIGCONT (suspend/resume) ----------------------------------------------------
traces['sigcont'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-sigcont-1'),
    event(fx, 'terminal', { type: 'terminal/suspended' }),
    event(fx, 'terminal', { type: 'terminal/resumed' }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'app', command: 'redraw' }) }),
  ],
}

// --- exit/error --------------------------------------------------------------------
traces['exit-error'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => [
    resetEvent(fx, 'new-session', [], 'reset-exit-error-1'),
    event(fx, 'app', {
      type: 'app/error',
      error: { code: 'FATAL', message: '[placeholder] fatal error', recoverable: false },
    }),
    event(fx, 'input', { type: 'input/command', command: cmd({ type: 'app', command: 'exit' }) }),
  ],
}

// --- WP-08e1 trajectory + goal/todo + activity + context ---------------------
traces['trajectory-goal-activity-context@v1'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  redactionPolicy: SURFACE_TRACE_REDACTION,
  build: (fx) => {
    const context = {
      available: true,
      loading: false,
      sections: [{ name: '[placeholder] system identity', text: '[placeholder] safe system context 你好😀' }],
      contexts: [{ name: '[placeholder] runtime cwd', text: '[placeholder] /workspace/project' }],
      files: [{ displayPath: '[placeholder] ./AGENTS.md' }],
      skills: [{ name: '[placeholder] review', description: '[placeholder] review code' }],
      tools: [{ name: '[placeholder] bash', description: '[placeholder] run commands' }],
      summary: '[placeholder] sections 1 · runtime 1 · files 1 · skills 1 · tools 1',
    }
    const surface = (revision: number, phase: 'active' | 'blocked' | 'complete', activityPhase: 'thinking' | 'done'): UiSurfaceView => ({
      revision,
      sessionEpoch: fx.sessionEpoch,
      activityEnabled: true,
      contextBarEnabled: true,
      goalTodo: {
        goal: {
          id: '[placeholder] goal-1', revision, objective: '[placeholder] ship renderer 你好😀', phase,
          maxGoalRounds: 5, roundsStarted: revision,
          ...(phase === 'blocked' ? { blockedReason: { code: '[placeholder] WAIT', message: '[placeholder] awaiting approval' } } : {}),
        },
        todos: phase === 'complete'
          ? []
          : [
              { content: '[placeholder] migrate trajectory', status: revision > 1 ? 'completed' : 'in_progress' },
              { content: '[placeholder] add context tests', status: 'pending' },
            ],
        hiddenTodos: 0,
      },
      activity: {
        phase: activityPhase,
        line: activityPhase === 'done' ? '[placeholder] completed renderer migration' : '[placeholder] rendering trajectory',
        preset: 'claude', frame: '✻', frameIndex: revision, intervalMs: 150, startedAt: BASE_AT, updatedAt: BASE_AT + revision * 100,
      },
      context,
      contextSegments: { system: 300, prompt: 250, assistant: 400, thinking: 120, tools: 180 },
      contextWindow: 2_000,
      usage: { input: 900, cacheRead: 100, cacheWrite: 20 },
    })
    const contextOverlay = (revision: number): OverlayState => makeOverlay({
      overlayId: 'utility/context', revision, anchor: 'top-center', width: '90%', maxHeight: '80%',
      payload: { kind: 'context-panel', context, open: true } as unknown as SerializableValue,
    })
    return [
      resetEvent(fx, 'new-session', [], 'reset-trajectory-surface-1'),
      event(fx, 'session', { type: 'surface/update', surface: surface(1, 'active', 'thinking') }),
      event(fx, 'overlay', { type: 'overlay/open', overlay: contextOverlay(1) }),
      event(fx, 'overlay', { type: 'overlay/close', overlayId: 'utility/context' }),
      event(fx, 'plugin', { type: 'scene/open', scene: { sceneId: 'trajectory', revision: 0, data: { status: 'loading' } } }),
      event(fx, 'plugin', { type: 'scene/open', scene: { sceneId: 'trajectory', revision: 1, data: { status: 'ready', view: 'timeline', projection: 'compressed', query: '' } } }),
      event(fx, 'plugin', { type: 'scene/open', scene: { sceneId: 'trajectory', revision: 2, data: { status: 'ready', view: 'timeline', projection: 'compressed', query: '[placeholder] tool filter', cursor: 1 } } }),
      event(fx, 'plugin', { type: 'scene/open', scene: { sceneId: 'trajectory', revision: 3, data: { status: 'ready', view: 'hotspot', sort: 'duration', cursor: 0 } } }),
      event(fx, 'session', { type: 'surface/update', surface: surface(2, 'blocked', 'thinking') }),
      event(fx, 'session', { type: 'surface/update', surface: surface(3, 'complete', 'done') }),
      event(fx, 'plugin', { type: 'scene/close', sceneId: 'trajectory', reason: 'user' }),
    ]
  },
}

// --- inline scrollback (WP-07): end-growth past a small viewport feeds settled
// lines into scrollback; browsing must never feed; appends resume afterwards.
traces['inline-scrollback'] = {
  terminalProfile: 'unicode-ambiguous-narrow',
  build: (fx) => {
    const settledRows = [1, 2, 3, 4, 5, 6].map((n) =>
      makeRow(fx, { source: 'session', sourceId: `assistant-${n}`, kind: 'assistant', blocks: [`[placeholder] inline scrollback row ${n}`] }),
    )
    const streamRowId = `${fx.sessionEpoch}:session:assistant-7:session-assistant-7-1`
    const streamRow2Id = `${fx.sessionEpoch}:session:assistant-8:session-assistant-8-1`
    return [
      resetEvent(fx, 'new-session', settledRows, 'reset-inline-scrollback-1'),
      // Shrink the viewport so the transcript overflows (windowing active).
      event(fx, 'terminal', { type: 'viewport/resize', width: 60, height: 10 }),
      // Streaming growth at follow-end: settled lines depart into scrollback.
      event(fx, 'session', {
        type: 'session/row-upsert',
        row: makeRow(fx, { source: 'session', sourceId: 'assistant-7', kind: 'assistant', blocks: [], settled: false }),
      }),
      event(fx, 'stream', { type: 'stream/chunk', rowId: streamRowId, text: '[placeholder] stream chunk one' }),
      event(fx, 'stream', { type: 'stream/chunk', rowId: streamRowId, text: '[placeholder] stream chunk two' }),
      event(fx, 'stream', { type: 'stream/settled', rowId: streamRowId, revision: 1 }),
      event(fx, 'session', { type: 'session/row-complete', rowId: streamRowId, revision: 1 }),
      // Browsing breaks follow-end: internal scroll never feeds scrollback.
      event(fx, 'input', { type: 'input/command', command: cmd({ type: 'scroll', delta: -3 }) }),
      event(fx, 'input', { type: 'input/command', command: cmd({ type: 'scroll', delta: 999 }) }),
      // Growth resumes after the browse: back at follow-end, appends continue.
      event(fx, 'session', {
        type: 'session/row-upsert',
        row: makeRow(fx, { source: 'session', sourceId: 'assistant-8', kind: 'assistant', blocks: [], settled: false }),
      }),
      event(fx, 'stream', { type: 'stream/chunk', rowId: streamRow2Id, text: '[placeholder] later chunk' }),
      event(fx, 'stream', { type: 'stream/settled', rowId: streamRow2Id, revision: 1 }),
      event(fx, 'session', { type: 'session/row-complete', rowId: streamRow2Id, revision: 1 }),
    ]
  },
}

async function main(): Promise<void> {
  const names = Object.keys(traces).sort()
  for (const name of names) {
    const fx = new EventFactory()
    const spec = traces[name]
    const trace: Trace = {
      header: {
        kind: 'header',
        traceVersion: 1,
        generatorVersion: TRACE_GENERATOR_VERSION,
        seed: SEED,
        terminalProfile: spec.terminalProfile,
        oracle: 'differential-only',
        redactionVersion: 1,
        name,
        source: 'scripts/gen-tui-v2-trace-fixtures.ts',
      },
      lines: spec.build(fx),
    }
    const redacted = redactTrace(trace, spec.redactionPolicy)
    const filePath = path.join(outDir, `${name}.jsonl`)
    await writeTrace(filePath, redacted)
    console.log(`wrote ${path.relative(repoRoot, filePath)} (${redacted.lines.length} lines)`)
  }
}

await main()
