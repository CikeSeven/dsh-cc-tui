/**
 * tui-v2 application coordinator (WP-04 walking skeleton).
 *
 * Assembles the full v2 pipeline around a legacy Channel:
 *
 *   Channel ──subscribe──▶ ChannelUiAdapter ──▶ StreamingController ──▶ dispatch
 *   stdin ──▶ InputSource ──▶ InputController / TerminalLifecycleController ──┘
 *   dispatch: validateAppEvent → deepFreeze → reducer.reduce → stateRevision++
 *     → (pendingReset? adapter.recoverSnapshotGap) → scheduler.requestRender
 *   scheduler render: selectors → base-renderer lines → linesToFrame
 *     → backend.plan(prev, frame) → writer.write(patch)
 *
 * Design notes / registered deviations:
 *
 *  - The screen backend's `start()` is deliberately NOT called: it would run
 *    the vendored TUI's own timer-driven render loop and input ownership,
 *    double-writing the terminal around the patch channel. Takeover/cleanup
 *    are driven by the lifecycle module; the backend is used as a pure
 *    Frame → TerminalPatch planner (generation checks are inert until the
 *    backend is started, which WP-06 revisits).
 *  - The input source's onEvent is wired to the coordinator's own routing
 *    (NOT `createPiTerminalStack`, whose fixed wiring forwards raw input to
 *    the vendored TUI): resize → lifecycle controller, key/paste → input
 *    controller, signal/query-response → counted and dropped (WP-05 surface).
 *  - Model editor state is never written by events (WP-05 seam): the
 *    coordinator mirrors the editor text (`editorMirror`) and syncs the
 *    singleton PromptEditor from `{...selectEditorView(state), text: mirror}`.
 *  - Every event producer shares one EventMetaFactory seq space; the
 *    streaming controller re-sequences onto the contiguous outgoing order
 *    (cancel drops would otherwise gap the reducer's seq check).
 */
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

import { validateAppEvent, type AppEvent } from '../model/events.js';
import { createReducer, type Reducer } from '../model/reducer.js';
import {
  deepFreeze,
  type Clock,
  type ResetReason,
  type TerminalMode,
} from '../model/schema.js';
import {
  selectDockView,
  selectEditorView,
  selectStatusLine,
  selectTranscriptView,
  type EditorView,
} from '../model/selectors.js';
import { initialUiState, type UiState } from '../model/state.js';
import { createBaseRenderer, type BaseRenderer } from '../renderer/base-renderer.js';
import type { Frame } from '../renderer/frame.js';
import {
  createRenderScheduler,
  type RenderPriority,
  type RenderScheduler,
  type ScheduledFrame,
} from '../renderer/scheduler.js';
import { createStatusLine } from '../components/chrome/status-line.js';
import { createPromptEditor, type PromptEditor } from '../components/editor/prompt-editor.js';
import { DEFAULT_COMPONENT_THEME } from '../components/theme.js';
import { createAssistantMessage } from '../components/transcript/assistant-message.js';
import { asRowBlocks } from '../components/transcript/row-view.js';
import { createToolRow } from '../components/transcript/tool-row.js';
import { createUserMessage } from '../components/transcript/user-message.js';
import { PiTuiAltScreenBackend } from '../terminal/alt-screen.js';
import { createInputSource, type InputStdin, type ResizePayload } from '../terminal/input.js';
import {
  createTerminalLifecycle,
  type LifecycleStopReason,
  type ProcessSignalHost,
  type TerminalLifecycle,
} from '../terminal/lifecycle.js';
import { PiTuiMainScreenBackend } from '../terminal/main-screen.js';
import { createPiTerminalAdapter, type PiTerminalStack } from '../terminal/pi-adapter.js';
import type { TerminalProfile } from '../terminal/profile.js';
import { createTerminalWriter } from '../terminal/writer.js';
import {
  createChannelUiAdapter,
  createEventMetaFactory,
  type ChannelCommands,
  type ChannelUiAdapter,
  type ChannelUiChannel,
} from '../controllers/session-events.js';
import { createInputController, type InputEditorBinding } from '../controllers/input.js';
import { createStreamingController } from '../controllers/streaming.js';
import { createTerminalLifecycleController } from '../controllers/terminal-lifecycle.js';
import { linesToFrame } from './lines-frame.js';
import { selectTerminalMode } from './modes.js';

export type CoordinatorPhase = 'created' | 'starting' | 'active' | 'stopping' | 'stopped' | 'failed';

export interface CoordinatorDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface TuiV2CoordinatorOptions {
  readonly channel: ChannelUiChannel;
  readonly stdin: InputStdin;
  /** Dimensions (+ TTY flag) source; `process.stdout` in production. */
  readonly stdout: { readonly columns?: number | undefined; readonly rows?: number | undefined; readonly isTTY?: boolean };
  /** The single byte sink (the ONLY place frames leave the process). */
  readonly stream: Writable;
  readonly profile: TerminalProfile;
  readonly clock: Clock;
  readonly mode?: TerminalMode;
  readonly theme?: string;
  readonly language?: string;
  readonly welcomeText?: string;
  readonly initialResetReason?: ResetReason;
  readonly adapterInstanceId?: string;
  readonly durableSessionId?: string;
  readonly uiSessionGeneration?: string;
  readonly processHost?: ProcessSignalHost;
  /** Default true; tests disable to keep synthetic signal hosts inert. */
  readonly attachProcessHandlers?: boolean;
  readonly streamWindowMs?: number;
  readonly onDiagnostic?: (diagnostic: CoordinatorDiagnostic) => void;
}

export interface CoordinatorDiagnostics {
  readonly phase: CoordinatorPhase;
  readonly stateRevision: number;
  readonly framesRendered: number;
  readonly patchesWritten: number;
  readonly writtenBytes: number;
  readonly eventsApplied: number;
  readonly eventsRejected: number;
  readonly snapshotGapRecoveries: number;
  readonly adapter: ReturnType<ChannelUiAdapter['diagnostics']>;
  readonly streaming: ReturnType<ReturnType<typeof createStreamingController>['diagnostics']>;
  readonly input: ReturnType<ReturnType<typeof createInputController>['diagnostics']>;
  readonly terminal: ReturnType<ReturnType<typeof createTerminalLifecycleController>['diagnostics']>;
}

export interface TuiV2Coordinator {
  readonly phase: CoordinatorPhase;
  start(): Promise<void>;
  stop(reason?: LifecycleStopReason): Promise<void>;
  awaitStop(): Promise<void>;
  readonly adapter: ChannelUiAdapter;
  readonly commands: ChannelCommands;
  /** Current immutable UiState (test/verify introspection). */
  readonly state: UiState;
  diagnostics(): CoordinatorDiagnostics;
}

/** Start failure with a stable machine-readable code. */
export class CoordinatorStartError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoordinatorStartError';
    this.code = code;
  }
}

/** Event → scheduler priority (§5.7). viewport/resize renders via the resize transaction. */
function priorityFor(event: AppEvent): RenderPriority | null {
  switch (event.type) {
    case 'input/command':
      return 'input';
    case 'stream/chunk':
    case 'stream/settled':
      return 'stream';
    case 'session/row-upsert':
    case 'session/row-complete':
    case 'session/rows-reset':
      return 'sync';
    case 'terminal/suspended':
    case 'terminal/resumed':
      return 'resize';
    case 'app/error':
      return 'exit';
    case 'viewport/resize':
      return null;
    default:
      return 'notify';
  }
}

const MAX_GAP_RECOVERIES = 8;

export function createTuiV2Coordinator(options: TuiV2CoordinatorOptions): TuiV2Coordinator {
  const { channel, profile, clock } = options;
  const diagnostic = (code: string, message: string, details?: Record<string, unknown>): void => {
    try {
      options.onDiagnostic?.({ code, message, ...(details !== undefined ? { details } : {}) });
    } catch {
      /* diagnostics never break the pipeline */
    }
  };

  // ------------------------------------------------------------ model core

  const width0 = options.stdout.columns ?? profile.columns;
  const height0 = options.stdout.rows ?? profile.rows;
  const modeSelection = selectTerminalMode(profile, options.mode);

  let state: UiState = initialUiState({
    width: width0,
    height: height0,
    profileId: profile.id,
    theme: options.theme ?? 'default',
    language: options.language ?? 'en',
    mode: modeSelection.ok ? modeSelection.mode : 'inline',
  });
  let stateRevision = 0;
  let eventsApplied = 0;
  let eventsRejected = 0;
  let snapshotGapRecoveries = 0;
  let framesRendered = 0;
  let patchesWritten = 0;
  let writtenBytes = 0;
  let frameSeq = 0;

  const reducer: Reducer = createReducer({ clock });
  const meta = createEventMetaFactory({
    adapterInstanceId: options.adapterInstanceId ?? randomUUID(),
    durableSessionId: options.durableSessionId ?? randomUUID(),
    uiSessionGeneration: options.uiSessionGeneration ?? randomUUID(),
    clock,
  });

  // ------------------------------------------------------- editor binding

  const theme = DEFAULT_COMPONENT_THEME;
  const editorMirror = { text: '' };
  /** Guard: repaint hints emitted from syncFromView (mid-render) are inert. */
  let syncingEditorView = false;

  const promptEditor: PromptEditor = createPromptEditor({
    profile,
    theme,
    terminalRows: height0,
    onCommand: (command) => {
      if (command.command === 'insert' || command.command === 'delete') {
        editorMirror.text = command.text ?? editorMirror.text;
      }
      inputController.handleEditorCommand(command);
    },
    onRepaint: () => {
      if (syncingEditorView) return;
      if (phase !== 'active') return;
      scheduler.requestRender('input', getScheduledState);
    },
  });

  const editorView = (): EditorView => ({
    ...selectEditorView(state),
    text: editorMirror.text,
    cursor: editorMirror.text.length,
  });

  const editorBinding: InputEditorBinding = {
    handleRawInput: (raw) => promptEditor.handleInput?.(raw),
    getText: () => promptEditor.getText(),
    clearText: () => {
      editorMirror.text = '';
      syncingEditorView = true;
      try {
        promptEditor.syncFromView(editorView());
      } finally {
        syncingEditorView = false;
      }
    },
  };

  // ------------------------------------------------------------- renderer

  const baseRenderer: BaseRenderer = createBaseRenderer({
    profile,
    theme: options.theme ?? 'default',
    registry: {
      componentFor: (kind) => {
        switch (kind) {
          case 'user':
            return (row) => createUserMessage(rowViewOf(row, false), profile);
          case 'assistant':
            return (row, streaming) => createAssistantMessage(rowViewOf(row, streaming), profile);
          case 'tool':
            return (row, streaming) => createToolRow(rowViewOf(row, streaming), profile);
          default:
            return undefined; // base-renderer fallback row component
        }
      },
    },
    dock: {
      editor: (view) => {
        syncingEditorView = true;
        try {
          promptEditor.syncFromView({ ...view, text: editorMirror.text, cursor: editorMirror.text.length });
        } finally {
          syncingEditorView = false;
        }
        return promptEditor;
      },
      status: (view) => createStatusLine(view, { profile, theme }),
      activity: () => null,
    },
  });

  const rowViewOf = (row: UiState['session']['rowsById'][string], streaming: boolean) => ({
    rowId: row.rowId,
    revision: row.revision,
    blocks: asRowBlocks(row.blocks),
    streaming,
    ...(row.tool !== undefined ? { tool: row.tool } : {}),
    theme,
  });

  // ------------------------------------------------------ dispatch pipeline

  let phase: CoordinatorPhase = 'created';
  let stopPromise: Promise<void> | null = null;
  let pendingFullRedraw = true;
  let fullRedrawReason: 'initial' | 'resize' | 'resume' | 'unknown-mode' = 'initial';
  let previousFrame: Frame | null = null;

  const getScheduledState = (): ScheduledFrame => ({ stateRevision });

  const applyEvent = (event: AppEvent): void => {
    let validated: AppEvent;
    try {
      validated = validateAppEvent(event);
    } catch (error) {
      eventsRejected += 1;
      diagnostic('event/invalid', error instanceof Error ? error.message : String(error));
      return;
    }
    try {
      state = reducer.reduce(state, deepFreeze(validated));
    } catch (error) {
      eventsRejected += 1;
      diagnostic('event/reduce-error', error instanceof Error ? error.message : String(error));
      return;
    }
    eventsApplied += 1;
    stateRevision += 1;
    if (state.terminal.needsFullRedraw) pendingFullRedraw = true;
    // Reducer gap marker → adapter heals with a fresh rows-reset (§5.2).
    if (
      state.session.pendingReset !== null &&
      validated.type !== 'session/rows-reset' &&
      snapshotGapRecoveries < MAX_GAP_RECOVERIES
    ) {
      snapshotGapRecoveries += 1;
      adapter.recoverSnapshotGap();
    }
    const priority = priorityFor(validated);
    if (priority !== null && phase === 'active') {
      scheduler.requestRender(priority, getScheduledState);
    }
  };

  const streamingController = createStreamingController({
    clock,
    ...(options.streamWindowMs !== undefined ? { windowMs: options.streamWindowMs } : {}),
    dispatch: applyEvent,
    onDiagnostic: (code, data) => diagnostic(`stream/${code}`, code, data),
  });

  const adapter = createChannelUiAdapter({
    channel,
    meta,
    dispatch: (event) => streamingController.ingest(event),
    ...(options.initialResetReason !== undefined ? { initialResetReason: options.initialResetReason } : {}),
    ...(options.welcomeText !== undefined ? { welcomeText: options.welcomeText } : {}),
    onDiagnostic: (d) => diagnostic(`adapter/${d.code}`, d.message),
  });

  // -------------------------------------------------------- terminal stack

  const lifecycleController = createTerminalLifecycleController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('terminal', sourceSeq),
    callbacks: {
      beginResizeTransaction: () => {
        if (phase !== 'active') return;
        scheduler.beginResizeTransaction(getScheduledState);
      },
      markFullRedraw: () => {
        pendingFullRedraw = true;
        fullRedrawReason = 'resume';
      },
      requestStop: (reason) => {
        void stop(reason);
      },
    },
  });

  const inputController = createInputController({
    clock,
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('input', sourceSeq),
    editor: editorBinding,
    commands: {
      submit: (text) => adapter.commands.submit(text),
      cancel: () => adapter.commands.cancel(),
    },
    isWorking: () => channel.working === true,
    onExitRequest: () => {
      void stop('user-exit');
    },
  });

  const input = createInputSource({
    stdin: options.stdin,
    generation: 0,
    clock,
    profile,
    onEvent: (event) => {
      try {
        if (event.kind === 'resize') {
          const payload = event.payload as ResizePayload;
          lifecycleController.handleResize(payload.columns, payload.rows);
        } else if (event.kind === 'key' || event.kind === 'paste') {
          inputController.handleEvent(event);
        } else {
          inputController.handleEvent(event); // counted as ignored
        }
      } catch (error) {
        diagnostic('input/route-error', error instanceof Error ? error.message : String(error));
      }
    },
  });

  const writer = createTerminalWriter({ stream: options.stream, clock, profile });

  const lifecycle: TerminalLifecycle = createTerminalLifecycle({
    writer,
    input,
    profile,
    clock,
    stdin: options.stdin,
    stdout: options.stdout,
    ...(options.processHost !== undefined ? { processHost: options.processHost } : {}),
    onRequestStop: (reason) => lifecycleController.handleStopRequest(reason),
    onResume: () => lifecycleController.handleResume(),
    onProcessError: (error, origin) => lifecycleController.handleProcessError(error, origin),
  });

  const piAdapter = createPiTerminalAdapter({ writer, lifecycle, input, profile, stdout: options.stdout });
  const stack: PiTerminalStack = { adapter: piAdapter, writer, input, lifecycle };

  const scheduler: RenderScheduler<ScheduledFrame> = createRenderScheduler<ScheduledFrame>({
    clock,
    ...(options.streamWindowMs !== undefined ? { streamWindowMs: options.streamWindowMs } : {}),
    render: renderOnce,
    onDiagnostic: (event) => diagnostic(`scheduler/${event.kind}`, event.kind),
  });
  scheduler.onResize(() => {
    baseRenderer.applyEnvironmentChange({ widthChanged: true });
    previousFrame = null;
    pendingFullRedraw = true;
    fullRedrawReason = 'resize';
  });

  const backend =
    modeSelection.ok && modeSelection.mode === 'fullscreen'
      ? new PiTuiAltScreenBackend(stack)
      : new PiTuiMainScreenBackend(stack);

  // ------------------------------------------------------------ render loop

  async function renderOnce(_scheduled: ScheduledFrame, _priority: RenderPriority): Promise<void> {
    // The scheduler serializes renders; a thrown render would strand its
    // pump (and reject an unhandled promise), so this callback never throws.
    try {
      const startedAt = clock.now();
      const output = baseRenderer.render({
        transcript: selectTranscriptView(state),
        dock: selectDockView(state),
        editor: editorView(),
        status: selectStatusLine(state),
        width: state.viewport.width,
        height: state.viewport.height,
        sessionEpoch: state.session.sessionEpoch,
        sticky: state.viewport.sticky,
      });
      framesRendered += 1;
      const fullRedraw = pendingFullRedraw || output.diagnostics.fullRedraw;
      const frame = linesToFrame(output.lines, {
        profile,
        width: state.viewport.width,
        height: state.viewport.height,
        stateRevision,
        generation: lifecycle.generation(),
        modes: lifecycle.currentModeSnapshot(),
        cursor: output.cursor ?? { x: 0, y: 0, visible: false },
        fullRedraw,
        renderMs: Math.max(0, clock.now() - startedAt),
        fullRedrawReason: fullRedraw ? fullRedrawReason : undefined,
        frameSeq: ++frameSeq,
      });
      const patch = backend.plan(previousFrame, frame);
      const result = await writer.write(patch);
      if (result.status === 'error') {
        diagnostic('writer/error', result.error.message);
        void stop('error');
        return;
      }
      if (result.status === 'written') {
        patchesWritten += 1;
        writtenBytes += result.bytes ?? 0;
      }
      previousFrame = frame;
      pendingFullRedraw = false;
      fullRedrawReason = 'unknown-mode';
    } catch (error) {
      diagnostic('render/error', error instanceof Error ? error.message : String(error));
      void stop('error');
    }
  }

  // ------------------------------------------------------------ lifecycle

  async function start(): Promise<void> {
    if (phase !== 'created') throw new CoordinatorStartError('bad-phase', `start() in phase '${phase}'`);
    phase = 'starting';
    try {
      if (options.stdin.isTTY !== true || options.stdout.isTTY !== true) {
        throw new CoordinatorStartError('not-a-tty', 'tui-v2 requires a TTY on stdin and stdout');
      }
      if (!modeSelection.ok) {
        throw new CoordinatorStartError(modeSelection.error.code, modeSelection.error.message);
      }
      if (modeSelection.degraded) {
        diagnostic('mode/degraded-inline', `profile '${profile.id}': alternate screen unknown/absent, inline mode`);
      }
      const result = await lifecycle.start({
        alternateScreen: modeSelection.mode === 'fullscreen',
        bracketedPaste: profile.supportsBracketedPaste === 'yes',
        mouse: false,
        focusReporting: false,
        kittyKeyboard: profile.supportsKittyKeyboard === 'yes',
        syncOutput: profile.supportsSyncOutput === 'yes',
        hideCursor: true,
      });
      if (result.status !== 'active') {
        throw new CoordinatorStartError(result.error.code, result.error.message);
      }
      if (options.attachProcessHandlers !== false) lifecycle.attachProcessHandlers();
      scheduler.start();
      adapter.start();
      phase = 'active';
      scheduler.requestRender('sync', getScheduledState);
    } catch (error) {
      phase = 'failed';
      throw error;
    }
  }

  function stop(reason: LifecycleStopReason = 'user-exit'): Promise<void> {
    if (stopPromise !== null) return stopPromise;
    if (phase === 'created' || phase === 'failed') {
      phase = 'stopped';
      stopPromise = Promise.resolve();
      return stopPromise;
    }
    phase = 'stopping';
    stopPromise = (async () => {
      scheduler.stop();
      streamingController.stop();
      adapter.stop();
      lifecycle.detachProcessHandlers();
      try {
        await lifecycle.stop(reason);
      } catch (error) {
        diagnostic('lifecycle/stop-error', error instanceof Error ? error.message : String(error));
      }
      phase = 'stopped';
    })();
    return stopPromise;
  }

  return {
    get phase() {
      return phase;
    },
    get state() {
      return state;
    },
    start,
    stop,
    awaitStop: () => stopPromise ?? Promise.resolve(),
    adapter,
    get commands() {
      return adapter.commands;
    },
    diagnostics: () => ({
      phase,
      stateRevision,
      framesRendered,
      patchesWritten,
      writtenBytes,
      eventsApplied,
      eventsRejected,
      snapshotGapRecoveries,
      adapter: adapter.diagnostics(),
      streaming: streamingController.diagnostics(),
      input: inputController.diagnostics(),
      terminal: lifecycleController.diagnostics(),
    }),
  };
}
