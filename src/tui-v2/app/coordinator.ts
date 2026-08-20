/**
 * tui-v2 application coordinator (WP-04 walking skeleton).
 *
 * Assembles the full v2 pipeline around a legacy Channel:
 *
 *   Channel ──subscribe──▶ ChannelUiAdapter ──▶ StreamingController ──▶ dispatch
 *   stdin ──▶ InputSource ──▶ InputController / TerminalLifecycleController ──┘
 *   dispatch: validateAppEvent → deepFreeze → reducer.reduce → stateRevision++
 *     → (pendingReset? adapter.recoverSnapshotGap) → scheduler.requestRender
 *   scheduler render: selectors → base-renderer lines → buildFrame
 *     (renderer/frame-builder.ts, WP-06a) → compositeFrame
 *     (renderer/compositor.ts, WP-06b: overlay stack + highlight skeleton
 *     over the base frame) → backend.plan(prev, frame) → writer.write(patch)
 *
 * Design notes / registered deviations:
 *
 *  - WP-06b: the fullscreen backend is `terminal/fullscreen-backend.ts`
 *    (v2-native cell-diff planner; capabilities per §6.4). Its
 *    start()/stop() are generation gates only — alt-screen enter/exit bytes
 *    stay with the lifecycle orchestration. The coordinator calls them for
 *    the fullscreen backend; the inline path keeps the pi main-screen
 *    backend as a pure Frame → TerminalPatch planner whose start() is
 *    deliberately NOT called (it would run the vendored TUI's own
 *    timer-driven render loop and input ownership, double-writing the
 *    terminal around the patch channel; inline semantics are WP-07).
 *  - Full-redraw triggers (§6.4, WP-06b): resize → scheduler resize
 *    transaction ('resize'); SIGCONT → terminal/resumed journal +
 *    markFullRedraw ('resume'); Ctrl+L → input controller onRedrawRequest
 *    ('damage'); app/error → 'cleanup' marker for any frame rendered on the
 *    abnormal-teardown path; reducer-driven needsFullRedraw without a
 *    specific cause keeps the 'unknown-mode' default. A patch the writer
 *    did not land (stale/dropped) invalidates previousFrame: the physical
 *    screen no longer provably matches it, so the next frame is a 'damage'
 *    full redraw.
 *  - The input source's onEvent is wired to the coordinator's own routing
 *    (NOT `createPiTerminalStack`, whose fixed wiring forwards raw input to
 *    the vendored TUI): resize → lifecycle controller, key/paste → input
 *    controller, signal/query-response → counted and dropped (WP-05 surface).
 *  - Model editor state is never written by events (WP-05b seam): the
 *    coordinator mirrors the editor text (`editorMirror`) and the TRUE
 *    cursor (the vendored editor's UTF-16 offset) and syncs the singleton
 *    PromptEditor from `{...selectEditorView(state), text, cursor}`.
 *  - Dock dynamics (status/notifications/pending) are NOT AppEvents: the
 *    adapter publishes a deduped DockStoreView via onDockChange and the
 *    coordinator merges that mirror into the DockView at render time (the
 *    canonical state deliberately excludes them, §5.2).
 *  - Every event producer shares one EventMetaFactory seq space; the
 *    streaming controller re-sequences onto the contiguous outgoing order
 *    (cancel drops would otherwise gap the reducer's seq check).
 *  - WP-05 controllers: replay (session navigation/rewind/update-restart),
 *    commands (slash routing), scrolling (wheel/keys/loadOlder anchor),
 *    dialogs (WP-05b: approval/question/plugin-dialog overlay priority +
 *    capture). Input routing order: resize → lifecycle; mouse wheel →
 *    scrolling; WHILE `focus.target === 'overlay'` every key/paste goes to
 *    the dialogs controller (the overlay owns the keyboard; legacy: Chat's
 *    global handler early-returns while a dialog snapshot is pending);
 *    otherwise scroll keys (pageUp/pageDown/ctrl+home/ctrl+end) → scrolling
 *    BEFORE the editor (the vendored editor's own pageScroll yields to
 *    transcript scrolling); everything else → input controller.
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
  type DockView,
  type EditorView,
  type StatusLineView,
} from '../model/selectors.js';
import { initialUiState, type UiState } from '../model/state.js';
import { createBaseRenderer, type BaseRenderer } from '../renderer/base-renderer.js';
import { compositeFrame } from '../renderer/compositor.js';
import type { Frame, ScreenBackend } from '../renderer/frame.js';
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
import { renderDialogOverlayLines } from '../components/overlays/render-dialog.js';
import { FullscreenBackend } from '../terminal/fullscreen-backend.js';
import {
  createInputSource,
  type InputStdin,
  type KeyPayload,
  type MousePayload,
  type ResizePayload,
} from '../terminal/input.js';
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
import type { Channel } from '../../dsh-adapter/channel.js';
import {
  createChannelUiAdapter,
  createEventMetaFactory,
  type ChannelCommands,
  type ChannelUiAdapter,
  type ChannelUiChannel,
  type DockStoreView,
} from '../controllers/session-events.js';
import { createInputController, type InputEditorBinding } from '../controllers/input.js';
import { createStreamingController } from '../controllers/streaming.js';
import { createTerminalLifecycleController } from '../controllers/terminal-lifecycle.js';
import { createReplayController, type ReplayController } from '../controllers/replay.js';
import { createScrollingController, type ScrollingController } from '../controllers/scrolling.js';
import {
  createCommandsController,
  type CommandChannel,
  type CommandsController,
} from '../controllers/commands.js';
import {
  createDialogsController,
  type ApprovalStoreLike,
  type DialogsController,
  type PluginDialogStoreLike,
  type QuestionStoreLike,
} from '../controllers/dialogs.js';
import { buildFrame } from '../renderer/frame-builder.js';
import { selectTerminalMode } from './modes.js';

export type CoordinatorPhase = 'created' | 'starting' | 'active' | 'stopping' | 'stopped' | 'failed';

export interface CoordinatorDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Channel surface the coordinator needs: the adapter's narrow UI channel plus
 * the WP-05 command/dock/notify seams (still a structural subset of Channel).
 */
export type CoordinatorChannel = ChannelUiChannel &
  CommandChannel &
  Pick<Channel, 'promptRewind' | 'interruptAndDeliver' | 'notify'>;

export interface TuiV2CoordinatorOptions {
  readonly channel: CoordinatorChannel;
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
  /**
   * WP-05b dialog stores (approval/question/managed plugin dialog). Absent
   * stores are simply never pending — the dialogs controller stays inert.
   * Production wiring hands the plugin.ts instances in; tests hand fakes.
   */
  readonly approvalStore?: ApprovalStoreLike;
  readonly questionStore?: QuestionStoreLike;
  readonly pluginDialogStore?: PluginDialogStoreLike;
  readonly onDiagnostic?: (diagnostic: CoordinatorDiagnostic) => void;
}

export interface CoordinatorDiagnostics {
  readonly phase: CoordinatorPhase;
  readonly stateRevision: number;
  readonly framesRendered: number;
  readonly patchesWritten: number;
  readonly writtenBytes: number;
  /** Last composed frame's fullRedraw flag (null before the first render). */
  readonly lastFrameFullRedraw: boolean | null;
  /** Last composed frame's fullRedrawReason (null when none/not rendered). */
  readonly lastFrameFullRedrawReason: string | null;
  readonly eventsApplied: number;
  readonly eventsRejected: number;
  readonly snapshotGapRecoveries: number;
  readonly adapter: ReturnType<ChannelUiAdapter['diagnostics']>;
  readonly streaming: ReturnType<ReturnType<typeof createStreamingController>['diagnostics']>;
  readonly input: ReturnType<ReturnType<typeof createInputController>['diagnostics']>;
  readonly terminal: ReturnType<ReturnType<typeof createTerminalLifecycleController>['diagnostics']>;
  readonly replay: ReturnType<ReplayController['diagnostics']>;
  readonly scrolling: ReturnType<ScrollingController['diagnostics']>;
  readonly commands: ReturnType<CommandsController['diagnostics']>;
  readonly dialogs: ReturnType<DialogsController['diagnostics']>;
}

/** WP-05 controller handles (tests/verify introspection). */
export interface CoordinatorControllers {
  readonly input: ReturnType<typeof createInputController>;
  readonly streaming: ReturnType<typeof createStreamingController>;
  readonly terminal: ReturnType<typeof createTerminalLifecycleController>;
  readonly replay: ReplayController;
  readonly scrolling: ScrollingController;
  readonly commands: CommandsController;
  readonly dialogs: DialogsController;
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
  /** WP-05 controller handles. */
  readonly controllers: CoordinatorControllers;
  /** Latest dock mirror published by the adapter (null until first flush). */
  readonly dockMirror: DockStoreView | null;
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
  let lastFrameFullRedraw: boolean | null = null;
  let lastFrameFullRedrawReason: string | null = null;

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
    // True cursor (WP-05): the vendored editor owns it; the WP-04
    // `text.length` fudge is gone.
    cursor: promptEditor.getCursorUtf16Offset(),
  });

  const syncEditor = (): void => {
    syncingEditorView = true;
    try {
      promptEditor.syncFromView(editorView());
    } finally {
      syncingEditorView = false;
    }
  };

  const editorBinding: InputEditorBinding = {
    handleRawInput: (raw) => promptEditor.handleInput?.(raw),
    getText: () => promptEditor.getText(),
    clearText: () => {
      editorMirror.text = '';
      syncEditor();
    },
    insertPaste: (text) => {
      promptEditor.insertText(text);
      editorMirror.text = promptEditor.getText();
    },
    getCursorOffset: () => promptEditor.getCursorUtf16Offset(),
    addToHistory: (text) => promptEditor.addToHistory(text),
    setDraft: (text) => {
      editorMirror.text = text;
      promptEditor.setDraft(text);
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
        void view; // the mirrored text/cursor come from editorView()
        syncEditor();
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
  let fullRedrawReason: 'initial' | 'resize' | 'resume' | 'damage' | 'unknown-mode' | 'cleanup' = 'initial';
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
    if (validated.type === 'app/error') {
      // Abnormal path (§6.4): any frame rendered from here on cannot trust
      // the physical screen — mark the cleanup full-redraw reason.
      pendingFullRedraw = true;
      fullRedrawReason = 'cleanup';
    }
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

  let dockMirror: DockStoreView | null = null;

  const adapter = createChannelUiAdapter({
    channel,
    meta,
    dispatch: (event) => streamingController.ingest(event),
    ...(options.initialResetReason !== undefined ? { initialResetReason: options.initialResetReason } : {}),
    ...(options.welcomeText !== undefined ? { welcomeText: options.welcomeText } : {}),
    onDockChange: (dock) => {
      dockMirror = dock;
      if (phase === 'active') scheduler.requestRender('notify', getScheduledState);
    },
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

  // ----------------------------------------------------- WP-05 controllers

  const notify = (text: string, notifyOptions?: { color?: 'error' | 'warning' | 'success' }): void => {
    channel.notify(text, notifyOptions);
  };

  const replayController = createReplayController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('session', sourceSeq),
    commands: adapter.commands,
    chatRowForRowId: (rowId) => adapter.chatRowForRowId(rowId),
    promptRewind: (row) => channel.promptRewind(row),
    getState: () => state,
    setEditorDraft: (text) => editorBinding.setDraft?.(text),
    notify,
    requestStop: (reason) => {
      void stop(reason);
    },
  });

  const commandsController = createCommandsController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('input', sourceSeq),
    channel,
    replay: replayController,
    submitToModel: (text) => adapter.commands.submit(text),
    steerToModel: (text) => adapter.commands.steer(text),
    notify,
  });

  const scrollingController = createScrollingController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('input', sourceSeq),
    getState: () => state,
    commands: adapter.commands,
    bridge: {
      // Pin the render anchor to the current top visible line; the renderer's
      // HeightIndex resolves it across the loadOlder prepend (WP-06 refines
      // this to physical-line precision).
      captureAnchor: () => baseRenderer.captureAnchorAt(0),
    },
    onDiagnostic: (d) => diagnostic(`scroll/${d.code}`, d.message),
  });

  const dialogsController = createDialogsController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('overlay', sourceSeq),
    getState: () => state,
    ...(options.approvalStore !== undefined ? { approvals: options.approvalStore } : {}),
    ...(options.questionStore !== undefined ? { questions: options.questionStore } : {}),
    ...(options.pluginDialogStore !== undefined ? { dialogs: options.pluginDialogStore } : {}),
    onDiagnostic: (code, message) => diagnostic(`dialogs/${code}`, message),
  });

  const inputController = createInputController({
    clock,
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('input', sourceSeq),
    editor: editorBinding,
    commands: {
      submit: (text) => {
        commandsController.handleSubmittedText(text);
      },
      cancel: () => adapter.commands.cancel(),
      interrupt: () => {
        // v1 Esc semantics: pending queued messages are delivered with the
        // abort; otherwise a plain cancel.
        const texts = channel.pending.map((message) => message.text);
        if (texts.length > 0) {
          const delivered = channel.interruptAndDeliver(texts);
          channel.notify(`Interrupted — delivered ${delivered} queued message(s)`);
        } else {
          adapter.commands.cancel();
        }
      },
    },
    isWorking: () => channel.working === true,
    onExitRequest: () => {
      void stop('user-exit');
    },
    onInterrupt: () => {
      const rowId = state.session.streamingRowId;
      if (rowId !== null) streamingController.cancelStream(rowId);
    },
    onExitArm: () => {
      channel.notify('Press Ctrl+C again to exit', { color: 'warning' });
    },
    onRedrawRequest: () => {
      // Ctrl+L (§6.4): user-forced full redraw. The journaled app/redraw
      // command already scheduled an 'input'-priority render; these flags are
      // read when it executes.
      pendingFullRedraw = true;
      fullRedrawReason = 'damage';
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
        } else if (event.kind === 'mouse') {
          const payload = event.payload as MousePayload;
          // Wheel events scroll the transcript; other mouse events are
          // counted-and-dropped (WP-05b surface).
          if (payload.action === 'wheel' && (payload.wheel === 'up' || payload.wheel === 'down')) {
            if (!scrollingController.handleWheel(payload.wheel)) inputController.handleEvent(event);
          } else {
            inputController.handleEvent(event);
          }
        } else if (event.kind === 'key') {
          const payload = event.payload as KeyPayload;
          // While an overlay holds focus it owns the keyboard entirely
          // (WP-05b; legacy: Chat's global handler early-returns while a
          // dialog snapshot is pending) — ctrl+c/escape included: the dialog
          // maps them to its own cancel semantics.
          if (state.focus.target === 'overlay') {
            dialogsController.handleInput(event);
            return;
          }
          // Scroll keys are transcript-bound and preempt the editor (the
          // vendored editor's pageScroll yields); ctrl+c/escape stay with
          // the input controller.
          if (payload.eventType !== 'release' && scrollingController.handleKey(payload.key)) return;
          inputController.handleEvent(event);
        } else if (event.kind === 'paste' && state.focus.target === 'overlay') {
          // Only text-bearing dialogs (plugin input / optionless question)
          // consume pastes; other dialogs count-and-drop them.
          dialogsController.handleInput(event);
        } else {
          inputController.handleEvent(event);
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

  const backend: ScreenBackend =
    modeSelection.ok && modeSelection.mode === 'fullscreen'
      ? new FullscreenBackend()
      : new PiTuiMainScreenBackend(stack);

  // ------------------------------------------------------------ render loop

  /**
   * Merge the adapter's dock mirror over the model dock state. The model dock
   * is only ever cleared by resets (canonical state excludes dock dynamics,
   * §5.2); the mirror carries live status/notifications/pending (WP-05).
   */
  const mergedStatusLine = (): StatusLineView => {
    const base = selectStatusLine(state);
    if (dockMirror === null) return base;
    return {
      ...base,
      model: dockMirror.status.model === '' ? base.model : dockMirror.status.model,
      tokens: dockMirror.status.tokens,
      cwd: dockMirror.status.cwd === '' ? base.cwd : dockMirror.status.cwd,
      branch: dockMirror.status.branch ?? base.branch,
      extras: {
        ...base.extras,
        status: dockMirror.status.status,
        working: dockMirror.status.working,
      },
    };
  };

  const mergedDockView = (): DockView => {
    const base = selectDockView(state);
    if (dockMirror === null) return base;
    return {
      ...base,
      status: {
        model: dockMirror.status.model === '' ? undefined : dockMirror.status.model,
        tokens: dockMirror.status.tokens,
        cwd: dockMirror.status.cwd === '' ? undefined : dockMirror.status.cwd,
        ...(dockMirror.status.branch !== null ? { branch: dockMirror.status.branch } : {}),
        extras: { status: dockMirror.status.status, working: dockMirror.status.working },
      },
      pendingMessages: dockMirror.pending.map((message) => message.text),
      notifications: dockMirror.notifications,
    };
  };

  async function renderOnce(_scheduled: ScheduledFrame, _priority: RenderPriority): Promise<void> {
    // The scheduler serializes renders; a thrown render would strand its
    // pump (and reject an unhandled promise), so this callback never throws.
    try {
      const startedAt = clock.now();
      const dock = mergedDockView();
      const status = mergedStatusLine();
      const output = baseRenderer.render({
        transcript: selectTranscriptView(state),
        dock,
        editor: editorView(),
        status,
        width: state.viewport.width,
        height: state.viewport.height,
        sessionEpoch: state.session.sessionEpoch,
        sticky: state.viewport.sticky,
      });
      framesRendered += 1;
      const fullRedraw = pendingFullRedraw || output.diagnostics.fullRedraw;
      const baseFrame = buildFrame({
        frameId: `frame-${++frameSeq}`,
        stateRevision,
        width: state.viewport.width,
        height: state.viewport.height,
        lines: output.lines,
        profile,
        modes: lifecycle.currentModeSnapshot(),
        cursor: output.cursor,
        generation: lifecycle.generation(),
        fullRedraw,
        fullRedrawReason: fullRedraw ? fullRedrawReason : undefined,
        renderMs: Math.max(0, clock.now() - startedAt),
      });
      // WP-06b: composite the overlay stack (back -> front) over THIS frame's
      // base; no overlays = the base frame passes through unchanged (the
      // base-only degradation path stays byte-equivalent to WP-06a).
      const frame = compositeFrame({
        base: baseFrame,
        profile,
        overlays: state.overlays.stack,
        renderOverlay: (overlay, width) =>
          renderDialogOverlayLines(overlay.payload, width, { profile, theme }),
        previous: previousFrame,
      }).frame;
      lastFrameFullRedraw = frame.fullRedraw;
      lastFrameFullRedrawReason = frame.metadata.fullRedrawReason ?? null;
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
        previousFrame = frame;
        pendingFullRedraw = false;
        fullRedrawReason = 'unknown-mode';
        return;
      }
      // The patch did not land (stale/dropped): the physical screen no longer
      // provably matches previousFrame — the next frame must be a full redraw.
      previousFrame = null;
      pendingFullRedraw = true;
      fullRedrawReason = 'damage';
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
      if (backend.mode === 'fullscreen') {
        // Generation gate for the fullscreen backend; the physical
        // alt-screen entry already ran inside lifecycle.start (§6.4).
        await backend.start(lifecycle.generation());
      }
      if (options.attachProcessHandlers !== false) lifecycle.attachProcessHandlers();
      scheduler.start();
      adapter.start();
      dialogsController.start();
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
      // Unsubscribe the dialog stores first: a teardown settleAll must not
      // dispatch overlay/close into a streaming controller that is stopping.
      dialogsController.dispose();
      scheduler.stop();
      if (backend.mode === 'fullscreen') {
        // Backend generation gate closes before the lifecycle teardown emits
        // the alt-screen exit bytes (§6.4; backend.stop emits nothing).
        await backend.stop(lifecycle.generation());
      }
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
    get dockMirror() {
      return dockMirror;
    },
    start,
    stop,
    awaitStop: () => stopPromise ?? Promise.resolve(),
    adapter,
    get commands() {
      return adapter.commands;
    },
    controllers: {
      input: inputController,
      streaming: streamingController,
      terminal: lifecycleController,
      replay: replayController,
      scrolling: scrollingController,
      commands: commandsController,
      dialogs: dialogsController,
    },
    diagnostics: () => ({
      phase,
      stateRevision,
      framesRendered,
      patchesWritten,
      writtenBytes,
      lastFrameFullRedraw,
      lastFrameFullRedrawReason,
      eventsApplied,
      eventsRejected,
      snapshotGapRecoveries,
      adapter: adapter.diagnostics(),
      streaming: streamingController.diagnostics(),
      input: inputController.diagnostics(),
      terminal: lifecycleController.diagnostics(),
      replay: replayController.diagnostics(),
      scrolling: scrollingController.diagnostics(),
      commands: commandsController.diagnostics(),
      dialogs: dialogsController.diagnostics(),
    }),
  };
}
