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
 *     (renderer/compositor.ts: business/utility overlay stack + visible-search
 *     highlights over the base frame) → backend.plan(prev, frame) → writer.write(patch)
 *
 * Design notes / registered deviations:
 *
 *  - WP-06b/WP-07: the fullscreen backend is `terminal/fullscreen-backend.ts`
 *    (v2-native cell-diff planner; capabilities per §6.4) and the inline
 *    backend is `terminal/inline-backend.ts` (main-screen append-only
 *    planner; capabilities per §15.1 WP-07). Their start()/stop() are
 *    generation gates only — takeover/restore bytes stay with the lifecycle
 *    orchestration. The coordinator calls them for BOTH backends. The old pi
 *    main-screen adapter no longer sits on this path (its vendored TUI would
 *    double-write around the patch channel). Inline-only wiring is
 *    capability-driven (`supportsInlineLiveRegion`): the frame metadata
 *    live-region hint, the foreign-output guard (third-party writes trigger
 *    a damage re-anchor), the exit park patch, and the overlay strip +
 *    notification degradation (`supportsNestedOverlay` false).
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
 *    capture), plus WP-08 utility/session/workspace/settings/route owners.
 *    Input routing:
 *    resize → lifecycle; mouse wheel → scrolling; WHILE
 *    `focus.target === 'overlay'` every key/paste goes only to the controller
 *    whose managed overlayId is focused (the overlay owns the keyboard);
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
  type SerializableValue,
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
import { createBaseRenderer, fallbackRowComponent, type BaseRenderer } from '../renderer/base-renderer.js';
import { compositeFrame } from '../renderer/compositor.js';
import { createImageStore } from '../renderer/image-store.js';
import type { Frame, ScreenBackend } from '../renderer/frame.js';
import {
  createRenderScheduler,
  type RenderPriority,
  type RenderScheduler,
  type ScheduledFrame,
} from '../renderer/scheduler.js';
import { createStatusLine } from '../components/chrome/status-line.js';
import { createActivityLine } from '../components/chrome/activity-line.js';
import { createContextBar } from '../components/chrome/context-bar.js';
import { createGoalTodoComponent } from '../components/panes/goal-todo.js';
import { createContextPanel } from '../components/panes/context-panel.js';
import { createPromptEditor, type PromptEditor } from '../components/editor/prompt-editor.js';
import { DEFAULT_COMPONENT_THEME } from '../components/theme.js';
import { createAssistantMessage } from '../components/transcript/assistant-message.js';
import { asRowBlocks } from '../components/transcript/row-view.js';
import { createToolRow } from '../components/transcript/tool-row.js';
import { createUserMessage } from '../components/transcript/user-message.js';
import { renderDialogOverlayLines } from '../components/overlays/render-dialog.js';
import { FullscreenBackend } from '../terminal/fullscreen-backend.js';
import { createForeignOutputGuard } from '../terminal/foreign-output.js';
import { InlineBackend, type InlineScreenBackend } from '../terminal/inline-backend.js';
import {
  createInputSource,
  type InputStdin,
  type KeyPayload,
  type ResizePayload,
} from '../terminal/input.js';
import {
  createTerminalLifecycle,
  type LifecycleStopReason,
  type ProcessSignalHost,
  type TerminalLifecycle,
} from '../terminal/lifecycle.js';
import { capabilitySupport, detectTerminalCapabilities, type TerminalCapabilitySnapshot } from '../terminal/capabilities.js';
import type { TerminalProfile } from '../terminal/profile.js';
import { createScreenTakeover } from '../terminal/takeover.js';
import { createQueryBroker } from '../terminal/query.js';
import { createKittyKeyboardNegotiator } from '../terminal/kitty-keyboard.js';
import { createTerminalWriter } from '../terminal/writer.js';
import { createPluginRowComponent } from '../scenes/row-component.js';
import { createPluginUIRuntime, type PluginUIRuntime, type PluginUIRuntimeDiagnostics } from '../scenes/runtime.js';
import { createTrajectoryController, type TrajectoryController } from '../controllers/trajectory.js';
import { createTrajectorySceneDescriptor } from '../scenes/trajectory.js';
import { sessionCwdMatches, type Channel } from '../../dsh-adapter/channel.js';
import { createLocalWorkspaceRuntime } from '../../dsh-adapter/workspaces.js';
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
import { createMouseController, type MouseController } from '../controllers/mouse.js';
import { createSurfaceController, type SurfaceController } from '../controllers/surfaces.js';
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
import {
  createInteractiveOverlaysController,
  type InteractiveOverlaysController,
} from '../controllers/interactive-overlays.js';
import {
  createChannelOptionsController,
  type ChannelOptionsController,
} from '../controllers/channel-options.js';
import {
  createSessionCatalogController,
  type SessionCatalogController,
} from '../controllers/session-catalog.js';
import {
  createWorkspaceFlowController,
  type WorkspaceFlowController,
  type WorkspaceHostCapability,
} from '../controllers/workspace-flow.js';
import {
  createSettingsFlowController,
  type SettingsFlowController,
} from '../controllers/settings-flow.js';
import { buildFrame } from '../renderer/frame-builder.js';
import { buildSearchHighlightRegions } from '../renderer/search-highlights.js';
import { computeInlineLiveRegion } from './inline-live-region.js';
import { selectTerminalMode } from './modes.js';
import type {
  ClipboardCapability,
  EditorRunner,
  ExternalActionTraceSink,
  LanguageCapability,
  PreferencePersistence,
  RestartRunner,
  ShellCapability,
} from '../capabilities/external-actions.js';
import { createShellController, type ShellController } from '../controllers/shell.js';
import { createClipboardController, type ClipboardController } from '../controllers/clipboard.js';
import { createExternalEditorController, type ExternalEditorController } from '../controllers/external-editor.js';
import { createUpdateController, type UpdateController, type UpdateRequest } from '../controllers/update.js';
import { createNotificationController, type NotificationController, type NotificationView } from '../controllers/notifications.js';
import { createPreferencesController, type PreferenceController } from '../controllers/preferences.js';
import { createThemeRegistry, resolveThemeForProfile, type ThemeDescriptor } from '../theme/registry.js';
import { isLanguageId } from '../i18n/catalog.js';

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
  Pick<
    Channel,
    | 'promptRewind'
    | 'interruptAndDeliver'
    | 'notify'
    | 'pushLocal'
    | 'agentId'
    | 'listSessions'
    | 'previewSession'
    | 'deleteSession'
    | 'renameSessionTo'
    | 'listWorkspaces'
    | 'resolveWorkspace'
    | 'switchWorkspace'
    | 'renameWorkspace'
    | 'workspaceCommands'
    | 'runWorkspaceCommand'
    | 'listModels'
    | 'switchModel'
    | 'agentPreset'
    | 'listPresets'
    | 'switchPreset'
    | 'listEfforts'
    | 'setEffort'
    | 'settingsHost'
    | 'settingsSections'
    | 'subscribeSettingsSections'
  >;

export interface TuiV2CoordinatorOptions {
  readonly channel: CoordinatorChannel;
  readonly stdin: InputStdin;
  /** Dimensions (+ TTY flag) source; `process.stdout` in production. */
  readonly stdout: { readonly columns?: number | undefined; readonly rows?: number | undefined; readonly isTTY?: boolean };
  /** The single byte sink (the ONLY place frames leave the process). */
  readonly stream: Writable;
  readonly profile: TerminalProfile;
  readonly capabilities?: TerminalCapabilitySnapshot;
  readonly clock: Clock;
  readonly mode?: TerminalMode;
  readonly theme?: string;
  readonly themeDescriptors?: readonly ThemeDescriptor[];
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
  /**
   * WP-08a plugin UI runtime (scenes + row renderers, plan §7.4). When
   * present, the coordinator attaches it at start (it then owns scene
   * takeover leases, the `focus.target === 'scene'` input route and the
   * scene frame path) and detaches it at stop.
   */
  readonly scenes?: PluginUIRuntime;
  /** Enable the built-in trajectory SceneV2 registration. */
  readonly trajectory?: boolean;
  /** WP-08f host capabilities. Every field is optional for existing embedders. */
  readonly shellCapability?: ShellCapability;
  readonly clipboardCapability?: ClipboardCapability;
  readonly editorRunner?: EditorRunner;
  readonly restartRunner?: RestartRunner;
  readonly languageCapability?: LanguageCapability;
  readonly preferencePersistence?: PreferencePersistence;
  readonly actionTrace?: ExternalActionTraceSink;
  readonly editorArgv?: () => readonly string[] | undefined;
  readonly confirmUpdate?: (request: { sessionId: string; profile: string; targetVersion?: string }) => Promise<boolean> | boolean;
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
  readonly mouse: ReturnType<MouseController['diagnostics']>;
  readonly commands: ReturnType<CommandsController['diagnostics']>;
  readonly dialogs: ReturnType<DialogsController['diagnostics']>;
  readonly interactiveOverlays: ReturnType<InteractiveOverlaysController['diagnostics']>;
  readonly sessionCatalog: ReturnType<SessionCatalogController['diagnostics']>;
  readonly workspaceFlow: ReturnType<WorkspaceFlowController['diagnostics']>;
  readonly settingsFlow: ReturnType<SettingsFlowController['diagnostics']>;
  readonly channelOptions: ReturnType<ChannelOptionsController['diagnostics']>;
  readonly surfaces: ReturnType<SurfaceController['activity']['diagnostics']>;
  /** WP-08a plugin scene runtime counters (absent when no runtime is wired). */
  readonly scenes?: PluginUIRuntimeDiagnostics;
  readonly shell?: ReturnType<ShellController['diagnostics']>;
  readonly clipboard?: ReturnType<ClipboardController['diagnostics']>;
  readonly externalEditor?: ReturnType<ExternalEditorController['diagnostics']>;
  readonly update?: ReturnType<UpdateController['diagnostics']>;
  readonly preferences?: ReturnType<PreferenceController['diagnostics']>;
  readonly notifications?: ReturnType<NotificationController['diagnostics']>;
}

/** WP-05 controller handles (tests/verify introspection). */
export interface CoordinatorControllers {
  readonly input: ReturnType<typeof createInputController>;
  readonly streaming: ReturnType<typeof createStreamingController>;
  readonly terminal: ReturnType<typeof createTerminalLifecycleController>;
  readonly replay: ReplayController;
  readonly scrolling: ScrollingController;
  readonly mouse: MouseController;
  readonly commands: CommandsController;
  readonly dialogs: DialogsController;
  readonly interactiveOverlays: InteractiveOverlaysController;
  readonly sessionCatalog: SessionCatalogController;
  readonly workspaceFlow: WorkspaceFlowController;
  readonly settingsFlow: SettingsFlowController;
  readonly channelOptions: ChannelOptionsController;
  readonly surfaces: SurfaceController;
  readonly shell: ShellController;
  readonly clipboard: ClipboardController | null;
  readonly externalEditor: ExternalEditorController | null;
  readonly update: UpdateController;
  readonly preferences: PreferenceController;
  readonly notifications: NotificationController;
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
    case 'scene/open':
    case 'scene/close':
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
  /** WP-08a plugin scene runtime plus the optional built-in trajectory scene. */
  const pluginRuntime: PluginUIRuntime | null = options.scenes ?? (options.trajectory !== false ? createPluginUIRuntime() : null);
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
  const capabilities = options.capabilities ?? detectTerminalCapabilities({
    profile,
    generation: 0,
    stdinIsTTY: options.stdin.isTTY === true,
    rawModeAvailable: typeof options.stdin.setRawMode === 'function',
  });
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
  /** Bytes stay process-local; AppEvents/trace receive only hash metadata. */
  const imageStore = createImageStore();
  const queryBroker = createQueryBroker({ clock });

  const reducer: Reducer = createReducer({ clock });
  const meta = createEventMetaFactory({
    adapterInstanceId: options.adapterInstanceId ?? randomUUID(),
    durableSessionId: options.durableSessionId ?? randomUUID(),
    uiSessionGeneration: options.uiSessionGeneration ?? randomUUID(),
    clock,
  });

  // ------------------------------------------------------- editor binding

  const themeRegistry = createThemeRegistry({
    initial: [
      { id: 'default', displayName: 'Default', base: 'default', roles: DEFAULT_COMPONENT_THEME.roles },
      ...(options.themeDescriptors ?? []),
    ],
  })
  const initialThemeResolution = resolveThemeForProfile(themeRegistry, options.theme ?? 'default', profile)
  let theme = initialThemeResolution.theme
  if (initialThemeResolution.degraded) diagnostic('theme/degraded', 'custom theme truecolor was quantized for the host profile', { reason: initialThemeResolution.reason ?? 'truecolor-unsupported', profileId: profile.id })
  const editorMirror = { text: '' };
  /** Renderer reference used by preference changes to invalidate caches. */
  let baseRendererForTheme: BaseRenderer | null = null
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

  // Created after the Channel adapter below; factories close over this slot.
  let surfaceController: SurfaceController | null = null
  let trajectoryController: TrajectoryController | null = null
  let trajectoryRegistration: { dispose(): void } | null = null

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
            // WP-08a plugin rows (§7.4): a row with source 'plugin' whose
            // sourceId has a registered row renderer renders through it;
            // every other unknown kind keeps the base-renderer fallback.
            if (pluginRuntime === null) return undefined;
            return (row) => createPluginRowComponent(row, profile, pluginRuntime);
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
      activity: (_activity, surface) => createActivityLine(
        surfaceController?.activity.view(surface?.activity ?? null) ?? surface?.activity ?? null,
        profile,
      ),
      goalTodo: (surface) => surface.goal === null && surface.todos.length === 0
        ? null
        : createGoalTodoComponent(surface, profile),
      contextSummary: (context) => context.available
        ? createContextPanel(context, profile, false)
        : null,
      contextBar: (surface) => surface !== undefined && surface.contextBarEnabled
        ? createContextBar({
            contextSegments: surface.contextSegments,
            contextWindow: surface.contextWindow,
            usage: surface.usage,
          }, profile)
        : null,
    },
  });
  baseRendererForTheme = baseRenderer

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
  /** WP-07 inline: whether the PREVIOUS written frame's window was follow-end. */
  let prevFollowEnd = false;
  /** Overlay ids already notified as unsupported (re-armed when the stack empties). */
  const overlayUnsupportedNotified = new Set<string>();

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
    if (validated.type === 'surface/update') surfaceController?.refresh(validated.surface)
    if (state.terminal.needsFullRedraw) {
      // Consume the pulse on read: the reducer flag is an edge trigger, not a
      // level. Left set, it would force a full redraw on EVERY later frame
      // (WP-07 wiring fix; the inline backend's incremental recipes depend on
      // ordinary frames NOT being full redraws).
      pendingFullRedraw = true;
      state = { ...state, terminal: { ...state.terminal, needsFullRedraw: false } };
    }
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
    storeStagedImage: async (input, metadata) => {
      const protocol = profile.imageProtocol
      if (protocol !== 'kitty' && protocol !== 'iterm2') {
        diagnostic('image/unsupported-profile', 'unsupported-image', {
          payloadHash: metadata.payloadHash,
          profileId: profile.id,
          protocol: String(protocol),
        });
        return {
          status: 'fallback',
          token: metadata.token,
          metadata,
          placeholder: `[Image unavailable: unsupported-profile ${metadata.payloadHash.slice(0, 12)}]`,
          reason: 'unsupported-profile',
        } as const;
      }
      try {
        const stored = await imageStore.put(metadata.payloadHash, input.data, protocol);
        return { status: 'stored', token: metadata.token, metadata, storeKey: stored.storeKey, protocol } as const;
      } catch (error) {
        const reason = error instanceof RangeError ? 'store-over-budget' : 'store-error';
        diagnostic(`image/${reason}`, 'unsupported-image', {
          payloadHash: metadata.payloadHash,
          protocol,
        });
        return {
          status: 'fallback',
          token: metadata.token,
          metadata,
          placeholder: `[Image unavailable: ${reason} ${metadata.payloadHash.slice(0, 12)}]`,
          reason,
        } as const;
      }
    },
    onDockChange: (dock) => {
      dockMirror = dock;
      surfaceController?.refresh(dock.surface);
      if (trajectoryController !== null && pluginRuntime?.activeView()?.sceneId === 'trajectory') void trajectoryController.refresh();
      if (phase === 'active') scheduler.requestRender('notify', getScheduledState);
    },
    onSurfaceChange: (surface) => {
      streamingController.ingest({
        ...meta.next('session', `surface-${surface.revision}`),
        type: 'surface/update',
        surface,
      });
    },
    onDiagnostic: (d) => diagnostic(`adapter/${d.code}`, d.message),
  });

  surfaceController = createSurfaceController({
    adapter: adapter.surfaces,
    clock,
    onRender: () => {
      if (phase === 'active') scheduler.requestRender('stream', getScheduledState)
    },
    onDiagnostic: (code, details) => diagnostic(code, code, details),
  });
  if (options.trajectory !== false && pluginRuntime !== null) {
    trajectoryController = createTrajectoryController({
      adapter: adapter.surfaces,
      clock,
      degradedNotice: modeSelection.ok && modeSelection.mode === 'inline'
        ? 'Inline mode: fixed viewport and scrollback parity are degraded; keys remain owned by trajectory.'
        : undefined,
      onView: () => {
        if (phase === 'active') scheduler.requestRender('sync', getScheduledState)
      },
      onDiagnostic: (code, details) => diagnostic(code, code, details),
    });
    const registration = pluginRuntime.register(createTrajectorySceneDescriptor(
      trajectoryController,
      profile,
    ), { pluginId: 'dsh-tui' });
    if (registration.result.status === 'accepted') trajectoryRegistration = registration;
    else diagnostic('trajectory/register-rejected', registration.result.code);
  }

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

  const notificationController = createNotificationController({
    clock,
    trace: options.actionTrace,
    onChange: () => {
      if (phase === 'active') scheduler.requestRender('notify', getScheduledState)
    },
  })
  const notify = (text: string, notifyOptions?: { color?: 'error' | 'warning' | 'success' }): void => {
    channel.notify(text, notifyOptions)
    const severity = notifyOptions?.color ?? 'info'
    notificationController.enqueue({ text, severity, timeoutMs: 4000 })
    if (phase === 'active') scheduler.requestRender('notify', getScheduledState)
  }
  const languageCapability: LanguageCapability = options.languageCapability ?? {
    supported: ['zh', 'en'],
    set: async (language) => isLanguageId(language)
      ? { status: 'changed' as const, language }
      : { status: 'unsupported' as const },
  }
  const preferencesController = createPreferencesController({
    themes: themeRegistry,
    languages: languageCapability,
    ...(options.preferencePersistence === undefined ? {} : { persistence: options.preferencePersistence }),
    notify,
    onChange: (change) => {
      streamingController.ingest({
        ...meta.next('input', `preference-${change.kind}-${change.value}`),
        type: 'preferences/update',
        ...(change.kind === 'theme' ? { theme: change.value } : { language: change.value }),
      })
      if (change.kind === 'theme') {
        const resolution = resolveThemeForProfile(themeRegistry, change.value, profile)
        theme = resolution.theme
        if (resolution.degraded) {
          diagnostic('theme/degraded', 'custom theme truecolor was quantized for the host profile', { reason: resolution.reason ?? 'truecolor-unsupported', profileId: profile.id })
          notify('Theme colors were degraded for this terminal', { color: 'warning' })
        }
        const rendererForTheme = baseRendererForTheme as BaseRenderer | null
        rendererForTheme?.applyEnvironmentChange({ themeChanged: true })
        if (phase === 'active') scheduler.requestRender('sync', getScheduledState)
      }
    },
    trace: options.actionTrace,
  })
  let shellController: ShellController | null = options.shellCapability === undefined ? null : createShellController({
    capability: options.shellCapability,
    cwd: () => channel.cwd,
    notify,
    appendTranscript: (title, lines) => channel.pushLocal(title, lines),
    includeInContext: (text) => channel.submit(`<bash-stdout>\n${text}\n</bash-stdout>`),
    trace: options.actionTrace,
  })
  let clipboardController: ClipboardController | null = null
  let externalEditorController: ExternalEditorController | null = null
  let updateController: UpdateController | null = null
  const shellProxy: ShellController = {
    run: (text) => {
      if (!text.trim().startsWith('!')) return false
      if (shellController !== null) return shellController.run(text)
      notify('Local shell capability is unavailable', { color: 'warning' })
      return true
    },
    cancel: () => shellController?.cancel() ?? false,
    phase: () => shellController?.phase() ?? 'idle',
    activeOperationId: () => shellController?.activeOperationId() ?? null,
    diagnostics: () => shellController?.diagnostics() ?? { started: 0, completed: 0, failed: 0, cancelled: 0, timedOut: 0, ignored: 0, superseded: 0, outputChunks: 0, outputChars: 0, truncatedOutput: 0 },
  }
  const updateProxy: UpdateController = {
    request: (request) => updateController?.request(request) ?? (notify('Update capability is unavailable', { color: 'warning' }), Promise.resolve(false)),
    cancel: () => updateController?.cancel() ?? false,
    phase: () => updateController?.phase() ?? 'idle',
    activeOperationId: () => updateController?.activeOperationId() ?? null,
    diagnostics: () => updateController?.diagnostics() ?? { requested: 0, confirmed: 0, rejected: 0, started: 0, succeeded: 0, failed: 0, cancelled: 0, late: 0, restoreErrors: 0 },
  }

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

  let interactiveOverlaysController: InteractiveOverlaysController;
  let sessionCatalogController: SessionCatalogController;
  let workspaceFlowController: WorkspaceFlowController;
  let settingsFlowController: SettingsFlowController;
  let channelOptionsController: ChannelOptionsController;

  type UtilityOwner = 'interactive' | 'session' | 'workspace' | 'settings' | 'channel-options';
  let contextOverlayRevision = 0
  const closeContextOverlay = (): void => {
    if (!state.overlays.stack.some((overlay) => overlay.overlayId === 'utility/context')) return
    streamingController.ingest({
      ...meta.next('overlay', `context-close-${++contextOverlayRevision}`),
      type: 'overlay/close',
      overlayId: 'utility/context',
    })
  }
  const openContextOverlay = (): boolean => {
    const context = state.surface.context
    if (!context.available || context.loading) {
      notify('Loaded context is not available yet', { color: 'warning' })
      return true
    }
    if (state.session.rowOrder.length > 0) {
      channel.pushLocal('/context', [
        context.summary || 'Loaded context',
        'Expanded context details are available before the first transcript row with Ctrl+P or /context.',
      ])
      return true
    }
    closeUtilitiesExcept('interactive')
    streamingController.ingest({
      ...meta.next('overlay', `context-open-${++contextOverlayRevision}`),
      type: 'overlay/open',
      overlay: {
        overlayId: 'utility/context',
        revision: contextOverlayRevision,
        anchor: 'top-center',
        width: '90%',
        maxHeight: '80%',
        margin: 1,
        visible: true,
        captureInput: true,
        nonCapturing: false,
        payload: { kind: 'context-panel', context, open: true } as unknown as SerializableValue,
      },
    })
    return true
  }

  const closeUtilitiesExcept = (owner: UtilityOwner): void => {
    if (owner !== 'interactive') interactiveOverlaysController.close();
    if (owner !== 'session') sessionCatalogController.close();
    if (owner !== 'workspace') workspaceFlowController.close();
    if (owner !== 'settings') settingsFlowController.close();
    if (owner !== 'channel-options') channelOptionsController.close();
  };

  const commandsController = createCommandsController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('input', sourceSeq),
    channel,
    replay: replayController,
    overlays: {
      openSessionBrowser: () => {
        closeUtilitiesExcept('session');
        return sessionCatalogController.open();
      },
      openTrajectory: () => {
        if (trajectoryController === null || pluginRuntime === null) return false
        closeContextOverlay()
        void trajectoryController.open()
        return pluginRuntime.open('trajectory')
      },
      openContext: openContextOverlay,
      openActivity: (rawInput) => {
        const parts = rawInput.trim().split(/\s+/u).filter(Boolean)
        if (parts[0] === 'frames' && parts[1] !== undefined) {
          const ok = surfaceController?.setActivityPreset(parts[1].toLowerCase()) ?? false
          if (!ok) notify(`Unknown activity preset: ${parts[1]}`, { color: 'warning' })
          return true
        }
        if (parts[0] === 'toggle') {
          const enabled = surfaceController?.toggleActivity() ?? false
          notify(`Activity line ${enabled ? 'enabled' : 'disabled'}`)
          return true
        }
        if (parts[0] === 'status') {
          notify(`Activity line ${surfaceController?.activityEnabled() === false ? 'disabled' : 'enabled'} · ${state.surface.activity?.preset ?? 'claude'}`)
          return true
        }
        notify('Use /activity frames <preset>, /activity toggle, or /activity status')
        return true
      },
      openWorkspace: (rawInput) => {
        closeUtilitiesExcept('workspace');
        return workspaceFlowController.handleCommand(rawInput);
      },
      openSettings: () => {
        closeUtilitiesExcept('settings');
        return settingsFlowController.open();
      },
      openModel: (query) => {
        closeUtilitiesExcept('channel-options');
        return channelOptionsController.openModel(query);
      },
      openPreset: (query) => {
        closeUtilitiesExcept('channel-options');
        return channelOptionsController.openPreset(query);
      },
      openEffort: () => {
        closeUtilitiesExcept('channel-options');
        return channelOptionsController.openEffort();
      },
      switchPreset: (id) => {
        void channel.switchPreset(id).catch((error: unknown) => {
          diagnostic('preset/switch-error', error instanceof Error ? error.message : String(error));
        });
      },
      setEffort: (id) => {
        void channel.setEffort(id).catch((error: unknown) => {
          diagnostic('effort/set-error', error instanceof Error ? error.message : String(error));
        });
      },
      showPresetStatus: () => channel.pushLocal('/preset', [
        `Current preset: ${channel.agentPreset ?? 'roster unavailable'}`,
        'Use /preset <id> to switch directly, or bare /preset to browse.',
      ]),
      showEffortStatus: () => channel.pushLocal('/effort', [
        `Current effort: ${channel.reasoningEffort ?? '—'}`,
        'Use /effort <id> to set directly, or bare /effort for the slider.',
      ]),
      openHelp: (query) => {
        closeUtilitiesExcept('interactive');
        return interactiveOverlaysController.openHelp({
        key: 'help',
        title: 'Help',
        query,
        shortcuts: [
          { keys: '?', label: 'Open help from an empty editor' },
          { keys: 'Ctrl+R', label: 'Search prompt history' },
          { keys: '/search', label: 'Search visible transcript' },
        ],
        items: channel.commandList.map((command) => ({
          id: command.name,
          label: `/${command.name}`,
          ...(command.description !== undefined ? { description: command.description } : {}),
          keywords: [command.name],
        })),
        emptyMessage: 'No commands are registered.',
          noResultsMessage: 'No commands match this search.',
          onSelect: (name) => editorBinding.setDraft?.(`/${name} `),
        });
      },
      openHistorySearch: (query) => {
        closeUtilitiesExcept('interactive');
        const history = inputController.history();
        const values = new Map<string, string>();
        const items = history.map((text, index) => {
          const id = `history-${index}`;
          values.set(id, text);
          return { id, label: text, keywords: [text] };
        });
        return interactiveOverlaysController.openHistory({
          key: 'history',
          title: 'Prompt history',
          query,
          placeholder: 'type to search submitted prompts',
          items,
          emptyMessage: 'No submitted prompts yet.',
          noResultsMessage: 'No history entries match this search.',
          onSelect: (id) => {
            const text = values.get(id);
            if (text !== undefined) editorBinding.setDraft?.(text);
          },
        });
      },
      openTranscriptSearch: (query) => {
        closeUtilitiesExcept('interactive');
        return interactiveOverlaysController.openTranscriptSearch({
          key: 'transcript',
          title: 'Search visible transcript',
          query,
          findMatches: (needle) => {
            const folded = needle.toLocaleLowerCase('en-US');
            if (folded === '') return [];
            return selectTranscriptView(state).visibleRows
              .filter((row) => asRowBlocks(row.blocks).some((block) =>
                'text' in block && block.text.toLocaleLowerCase('en-US').includes(folded)))
              .map((row) => row.rowId);
          },
        });
      },
    },
    submitToModel: (text) => adapter.commands.submit(text),
    steerToModel: (text) => adapter.commands.steer(text),
    notify,
    shell: shellProxy,
    preferences: preferencesController,
    update: updateProxy,
    ...(options.restartRunner === undefined ? {} : {
      updateRequest: { sessionId: channel.agentId, profile: profile.id },
    }),
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
  const mouseController = createMouseController({
    mode: modeSelection.ok ? modeSelection.mode : 'inline',
    enabled: capabilitySupport(capabilities, 'mouse'),
    supportedProtocols: capabilities.mouse.supportedProtocols.map((protocol) => protocol === 'sgr-1006' ? 'sgr-1006' : protocol === 'urxvt-1015' ? 'urxvt-1015' : 'x10'),
    scrolling: scrollingController,
    hitTest: () => state.focus.target === 'overlay' ? 'overlay' : state.focus.target === 'scene' ? 'cursor' : 'selection',
    onDiagnostic: (d) => diagnostic(d.code, d.message, { mode: d.mode, ...(d.protocol === undefined ? {} : { protocol: d.protocol }) }),
  });

  const dialogsController = createDialogsController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('overlay', sourceSeq),
    getState: () => state,
    ...(options.approvalStore !== undefined ? { approvals: options.approvalStore } : {}),
    ...(options.questionStore !== undefined ? { questions: options.questionStore } : {}),
    ...(options.pluginDialogStore !== undefined ? { dialogs: options.pluginDialogStore } : {}),
    onQuestionSummary: (title, lines) => channel.pushLocal(title, lines),
    onDiagnostic: (code, message) => diagnostic(`dialogs/${code}`, message),
  });

  interactiveOverlaysController = createInteractiveOverlaysController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('overlay', sourceSeq),
    getState: () => state,
    isBusinessDialogActive: () => dialogsController.activeOverlayId() !== null,
    onDiagnostic: (code, message) => diagnostic(`interactive-overlays/${code}`, message),
  });

  sessionCatalogController = createSessionCatalogController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('overlay', sourceSeq),
    getState: () => state,
    catalog: {
      list: (signal) => channel.listSessions(signal),
      preview: (sessionId, signal) => channel.previewSession(sessionId, signal),
      delete: (sessionId) => channel.deleteSession(sessionId),
      rename: (sessionId, title) => channel.renameSessionTo(sessionId, title),
    },
    replay: replayController,
    context: () => ({
      cwd: channel.cwd,
      branch: channel.gitBranch,
      currentSessionId: channel.agentId,
    }),
    sameProject: sessionCwdMatches,
    now: () => clock.now(),
    isBusinessDialogActive: () => dialogsController.activeOverlayId() !== null,
    onDiagnostic: (code, message) => diagnostic(`session-catalog/${code}`, message),
  });

  const localWorkspaceFallback: WorkspaceHostCapability = createLocalWorkspaceRuntime();
  const workspaceHost: WorkspaceHostCapability | undefined =
    typeof channel.listWorkspaces === 'function'
    && typeof channel.resolveWorkspace === 'function'
    && typeof channel.workspaceCommands === 'function'
    && typeof channel.runWorkspaceCommand === 'function'
      ? {
          list: (_currentCwd, signal) => channel.listWorkspaces(signal),
          resolve: (reference, _currentCwd, signal) => channel.resolveWorkspace(reference, signal),
          commands: () => channel.workspaceCommands(),
          runCommand: (name, input, _cwd, signal) => channel.runWorkspaceCommand(name, input, signal),
        }
      : undefined;
  workspaceFlowController = createWorkspaceFlowController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('overlay', sourceSeq),
    getState: () => state,
    ...(workspaceHost !== undefined ? { host: workspaceHost } : {}),
    fallback: localWorkspaceFallback,
    actions: {
      currentCwd: () => channel.cwd,
      switchTarget: (target) => channel.switchWorkspace(target),
      renameCurrent: (title) => channel.renameWorkspace(title),
    },
    isBusinessDialogActive: () => dialogsController.activeOverlayId() !== null,
    notify,
    onDiagnostic: (code, message) => diagnostic(`workspace-flow/${code}`, message),
  });

  const settingsHost = channel.settingsHost();
  settingsFlowController = createSettingsFlowController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('overlay', sourceSeq),
    getState: () => state,
    ...(settingsHost !== undefined ? { host: settingsHost } : {}),
    sections: {
      list: () => channel.settingsSections(),
      subscribe: (listener) => channel.subscribeSettingsSections(listener),
    },
    isBusinessDialogActive: () => dialogsController.activeOverlayId() !== null,
    language: options.language ?? 'en',
    onDiagnostic: (code, message) => diagnostic(`settings-flow/${code}`, message),
  });

  channelOptionsController = createChannelOptionsController({
    dispatch: (event) => streamingController.ingest(event),
    nextMeta: (sourceSeq) => meta.next('overlay', sourceSeq),
    getState: () => state,
    capability: {
      listModels: (_signal) => channel.listModels(),
      switchModel: (provider, model) => channel.switchModel(provider, model),
      listPresets: (_signal) => channel.listPresets(),
      switchPreset: (id) => channel.switchPreset(id),
      listEfforts: (_signal) => channel.listEfforts(),
      setEffort: (id) => channel.setEffort(id),
      currentModel: () => ({ provider: channel.provider, model: channel.model }),
      currentPreset: () => channel.agentPreset,
      currentEffort: () => channel.reasoningEffort,
      working: () => channel.working,
      subscribe: (listener) => channel.subscribe(listener),
    },
    isBusinessDialogActive: () => dialogsController.activeOverlayId() !== null,
    onDiagnostic: (code, message) => diagnostic(`channel-options/${code}`, message),
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
    onHelpRequest: () => {
      commandsController.handleSubmittedText('/help');
    },
    onHistorySearchRequest: () => {
      commandsController.handleSubmittedText('/history');
    },
    onPasteRequest: () => {
      if (clipboardController === null) notify('Clipboard capability is unavailable', { color: 'warning' })
      else void clipboardController.paste()
    },
    onExternalEditorRequest: () => {
      if (externalEditorController === null) notify('External editor capability is unavailable', { color: 'warning' })
      else externalEditorController.open()
    },
  });

  const input = createInputSource({
    stdin: options.stdin,
    generation: 0,
    clock,
    profile,
    queryBroker,
    onEvent: (event) => {
      try {
        if (event.kind === 'resize') {
          const payload = event.payload as ResizePayload;
          lifecycleController.handleResize(payload.columns, payload.rows);
        } else if (event.kind === 'mouse') {
          // The mouse controller owns pointer routing; scene focus remains an
          // explicit owner and never falls through to the editor.
          if (state.focus.target === 'scene') {
            pluginRuntime?.handleInput(event);
            return;
          }
          mouseController.handleEvent(event);
        } else if (event.kind === 'key') {
          const payload = event.payload as KeyPayload;
          if (payload.eventType !== 'release' && payload.key === 'ctrl+t' && state.focus.target !== 'scene') {
            commandsController.handleSubmittedText('/trace')
            return
          }
          if (payload.eventType !== 'release' && payload.key === 'ctrl+p' && state.session.rowOrder.length === 0) {
            if (state.overlays.stack.some((overlay) => overlay.overlayId === 'utility/context')) closeContextOverlay()
            else openContextOverlay()
            return
          }
          // Route by the focused overlay id. Unknown/foreign overlays never
          // leak keys into a dialog, utility controller or editor.
          if (state.focus.target === 'overlay') {
            const overlayId = state.focus.overlayId ?? '';
            if (overlayId === 'utility/context') {
              if (payload.eventType !== 'release' && (payload.key === 'escape' || payload.key === 'ctrl+p')) closeContextOverlay()
              return
            }
            if (overlayId === dialogsController.activeOverlayId()) {
              dialogsController.handleInput(event);
            } else if (sessionCatalogController.isManagedOverlay(overlayId)) {
              sessionCatalogController.handleInput(event);
            } else if (workspaceFlowController.isManagedOverlay(overlayId)) {
              workspaceFlowController.handleInput(event);
            } else if (settingsFlowController.isManagedOverlay(overlayId)) {
              settingsFlowController.handleInput(event);
            } else if (channelOptionsController.isManagedOverlay(overlayId)) {
              channelOptionsController.handleInput(event);
            } else if (interactiveOverlaysController.isManagedOverlay(overlayId)) {
              interactiveOverlaysController.handleInput(event);
            } else {
              diagnostic('input/unknown-overlay', `no input owner for ${overlayId}`);
            }
            return;
          }
          // While a plugin scene holds focus it owns the keyboard entirely
          // (WP-08a §7.4; legacy: Chat's early-return handed every key to the
          // scene, Esc/Ctrl+C included).
          if (state.focus.target === 'scene') {
            pluginRuntime?.handleInput(event);
            return;
          }
          // Scroll keys are transcript-bound and preempt the editor (the
          // vendored editor's pageScroll yields); ctrl+c/escape stay with
          // the input controller.
          if (payload.eventType !== 'release' && scrollingController.handleKey(payload.key)) return;
          inputController.handleEvent(event);
        } else if (event.kind === 'paste' && state.focus.target === 'overlay') {
          const overlayId = state.focus.overlayId ?? '';
          if (overlayId === dialogsController.activeOverlayId()) {
            dialogsController.handleInput(event);
          } else if (sessionCatalogController.isManagedOverlay(overlayId)) {
            sessionCatalogController.handleInput(event);
          } else if (workspaceFlowController.isManagedOverlay(overlayId)) {
            workspaceFlowController.handleInput(event);
          } else if (settingsFlowController.isManagedOverlay(overlayId)) {
            settingsFlowController.handleInput(event);
          } else if (channelOptionsController.isManagedOverlay(overlayId)) {
            channelOptionsController.handleInput(event);
          } else if (interactiveOverlaysController.isManagedOverlay(overlayId)) {
            interactiveOverlaysController.handleInput(event);
          } else {
            diagnostic('input/unknown-overlay', `no paste owner for ${overlayId}`);
          }
        } else if (event.kind === 'paste' && state.focus.target === 'scene') {
          pluginRuntime?.handleInput(event);
        } else {
          inputController.handleEvent(event);
        }
      } catch (error) {
        diagnostic('input/route-error', error instanceof Error ? error.message : String(error));
      }
    },
  });

  // WP-07: backend choice follows the mode selection; everything below keys
  // off its CAPABILITIES, never a mode string. The inline backend shares only
  // the contract with fullscreen (plan: no `if (mode === 'inline')` copies of
  // fullscreen logic). The pi main-screen adapter is gone from this path.
  const onImageDiagnostic = (imageDiagnostic: { readonly code: string; readonly reason: string; readonly imageId?: string; readonly payloadHash?: string; readonly protocol?: string }): void => {
    diagnostic(`image/${imageDiagnostic.reason}`, imageDiagnostic.code, imageDiagnostic as unknown as Record<string, unknown>);
  };
  const backend: ScreenBackend =
    modeSelection.ok && modeSelection.mode === 'fullscreen'
      ? new FullscreenBackend({ profile, imageStore, onDiagnostic: onImageDiagnostic })
      : new InlineBackend({ profile, onDiagnostic: onImageDiagnostic });

  const onForeignOutput = (bytes: number): void => {
    diagnostic('output/foreign', 'foreign write on the main screen; scheduling a damage re-anchor', { bytes });
    if (phase !== 'active') return;
    // Foreign bytes may have moved cursor/screen arbitrarily: the next frame
    // re-anchors (erase + absolute rewrite, never a scrollback clear).
    pendingFullRedraw = true;
    fullRedrawReason = 'damage';
    scheduler.requestRender('sync', getScheduledState);
  };

  // Inline shares the main screen with third-party writes; the guard detects
  // bytes that bypass the writer. Fullscreen owns the alternate screen — no
  // guard needed (capability-driven, §15.1 WP-07).
  const foreignGuard = backend.capabilities.supportsInlineLiveRegion
    ? createForeignOutputGuard(options.stream, onForeignOutput)
    : null;

  const writer = createTerminalWriter({
    stream: foreignGuard?.writerStream ?? options.stream,
    clock,
    profile,
    queryBroker,
    queryTokenSink: (token) => input.registerQueryToken(token),
    imageStore,
  });
  let lifecycle!: TerminalLifecycle;
  const kittyKeyboardNegotiator = createKittyKeyboardNegotiator({
    writer,
    clock,
    generation: () => lifecycle.generation(),
    setInputActive: (active) => input.setKittyKeyboardActive(active),
    onDiagnostic: (entry) => diagnostic(entry.code, entry.reason, { generation: entry.generation }),
  });

  lifecycle = createTerminalLifecycle({
    writer,
    input,
    profile,
    clock,
    stdin: options.stdin,
    stdout: options.stdout,
    kittyKeyboardNegotiator,
    ...(options.processHost !== undefined ? { processHost: options.processHost } : {}),
    onRequestStop: (reason) => lifecycleController.handleStopRequest(reason),
    onResume: () => lifecycleController.handleResume(),
    onProcessError: (error, origin) => lifecycleController.handleProcessError(error, origin),
  });

  // WP-08a (§6.6/§7.4): the scene runtime's ScreenTakeover. In-band scenes
  // keep rendering through the writer (the lease barrier is a settled
  // watermark, not a held quiesce); restore bumps the generation and marks
  // the next frame a 'resume' full redraw.
  const sceneTakeover = createScreenTakeover({
    lifecycle,
    writer,
    onRestore: (lease) => {
      imageStore.clearGeneration(lease.generation);
      pendingFullRedraw = true;
      fullRedrawReason = 'resume';
      previousFrame = null;
      prevFollowEnd = false;
    },
    onDiagnostic: (code, message, details) => diagnostic(code, message, details),
  });

  if (options.clipboardCapability !== undefined) {
    clipboardController = createClipboardController({
      capability: options.clipboardCapability,
      generation: () => lifecycle.generation(),
      profileSupportsOsc52: () => capabilitySupport(capabilities, 'osc52'),
      writer,
      insertText: (text) => editorBinding.insertPaste?.(text),
      stageImage: async (input) => {
        const result = await adapter.commands.stageImage(input as Parameters<ChannelCommands['stageImage']>[0])
        return result.status === 'stored'
          ? { token: result.token }
          : { placeholder: result.placeholder }
      },
      notify,
      trace: options.actionTrace,
    });
  }
  if (options.editorRunner !== undefined) {
    externalEditorController = createExternalEditorController({
      runner: options.editorRunner,
      takeover: sceneTakeover,
      cwd: () => channel.cwd,
      draft: () => editorBinding.getText(),
      setDraft: (text) => editorBinding.setDraft?.(text),
      resolveArgv: options.editorArgv ?? (() => undefined),
      notify,
      trace: options.actionTrace,
    });
  }
  if (options.restartRunner !== undefined) {
    updateController = createUpdateController({
      runner: options.restartRunner,
      takeover: sceneTakeover,
      confirm: options.confirmUpdate ?? (() => true),
      cleanup: async () => {
        notificationController.clear()
      },
      notify,
      trace: options.actionTrace,
    });
  }

  const scheduler: RenderScheduler<ScheduledFrame> = createRenderScheduler<ScheduledFrame>({
    clock,
    ...(options.streamWindowMs !== undefined ? { streamWindowMs: options.streamWindowMs } : {}),
    render: renderOnce,
    onDiagnostic: (event) => diagnostic(`scheduler/${event.kind}`, event.kind),
  });
  scheduler.onResize(() => {
    baseRenderer.applyEnvironmentChange({ widthChanged: true });
    imageStore.clearGeneration(lifecycle.generation());
    previousFrame = null;
    prevFollowEnd = false;
    pendingFullRedraw = true;
    fullRedrawReason = 'resize';
  });

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
        effort: dockMirror.status.effort,
      },
    };
  };

  const mergedDockView = (): DockView => {
    const base = selectDockView(state);
    const actionNotifications = notificationController.view().map((item) => ({
      notificationId: item.notificationId,
      text: item.text,
      ...(item.severity === 'info' ? {} : { color: item.severity }),
    }))
    if (dockMirror === null) return { ...base, notifications: actionNotifications.length > 0 ? actionNotifications : base.notifications }
    const notifications = [...dockMirror.notifications]
    const seenText = new Set(notifications.map((item) => item.text))
    for (const item of actionNotifications) {
      if (seenText.has(item.text)) continue
      notifications.push(item)
      seenText.add(item.text)
    }
    return {
      ...base,
      status: {
        model: dockMirror.status.model === '' ? undefined : dockMirror.status.model,
        tokens: dockMirror.status.tokens,
        cwd: dockMirror.status.cwd === '' ? undefined : dockMirror.status.cwd,
        ...(dockMirror.status.branch !== null ? { branch: dockMirror.status.branch } : {}),
        extras: { status: dockMirror.status.status, working: dockMirror.status.working, effort: dockMirror.status.effort },
      },
      pendingMessages: dockMirror.pending.map((message) => message.text),
      notifications,
      surface: dockMirror.surface,
    };
  };

  async function renderOnce(_scheduled: ScheduledFrame, _priority: RenderPriority): Promise<void> {
    // The scheduler serializes renders; a thrown render would strand its
    // pump (and reject an unhandled promise), so this callback never throws.
    try {
      const startedAt = clock.now();
      // WP-08a scene frame path (§7.4): while the model holds an open plugin
      // scene, the whole viewport comes from the scene's adapter instead of
      // the base renderer (whole-terminal takeover; the overlay stack still
      // composites above it). The adapter never throws (error boundary).
      const sceneAdapter = (() => {
        if (state.scene === null || pluginRuntime === null) return null;
        const adapter = pluginRuntime.activeAdapter();
        return adapter !== null && adapter.scene.sceneId === state.scene.view.sceneId ? adapter : null;
      })();
      let lines: string[];
      let cursor: { readonly x: number; readonly y: number; readonly visible: boolean } | undefined;
      let baseFullRedraw = false;
      let baseDiagnostics: { transcriptHeight: number; scrollTopLine: number } | null = null;
      if (sceneAdapter !== null) {
        sceneAdapter.focused = state.focus.target === 'scene';
        // Frame-builder blank-fills missing rows and drops extras (§5.5), so
        // the scene's logical lines pass through unpadded.
        lines = sceneAdapter.render(state.viewport.width);
        const sceneCursor = sceneAdapter.cursor;
        cursor =
          sceneAdapter.focused && sceneCursor !== undefined && sceneCursor.visible
            ? { x: sceneCursor.x, y: sceneCursor.y, visible: true }
            : undefined;
      } else {
        const dock = mergedDockView();
        const status = mergedStatusLine();
        const transcript = selectTranscriptView(state);
        const output = baseRenderer.render({
          transcript,
          dock,
          editor: editorView(),
          status,
          width: state.viewport.width,
          height: state.viewport.height,
          sessionEpoch: state.session.sessionEpoch,
          sticky: state.viewport.sticky,
        });
        lines = [...output.lines];
        cursor = output.cursor;
        baseFullRedraw = output.diagnostics.fullRedraw;
        baseDiagnostics = {
          transcriptHeight: output.diagnostics.transcriptHeight,
          scrollTopLine: output.diagnostics.scrollTopLine,
        };
      }
      framesRendered += 1;
      const fullRedraw = pendingFullRedraw || baseFullRedraw;
      // WP-07: the inline live-region hint (append-only boundary) is computed
      // from THIS render's own layout diagnostics and row mutability. A scene
      // frame has no append-only region: the hint stays undefined and the
      // inline backend takes the whole-frame diff path (capability-driven).
      const inlineHint =
        backend.capabilities.supportsInlineLiveRegion && sceneAdapter === null && baseDiagnostics !== null
          ? computeInlineLiveRegion({
              transcriptHeight: baseDiagnostics.transcriptHeight,
              scrollTopLine: baseDiagnostics.scrollTopLine,
              heightIndex: baseRenderer.heightIndex,
              isMutableRow: (rowId) => {
                const transcript = selectTranscriptView(state);
                if (transcript.streamingRowId === rowId) return true;
                const row = transcript.visibleRows.find((candidate) => candidate.rowId === rowId);
                return row === undefined ? true : !row.settled; // unknown id: conservatively mutable
              },
              showUnseenIndicator: selectTranscriptView(state).showUnseenIndicator,
              followEnd: (state.viewport.sticky || baseRenderer.anchor === null) && prevFollowEnd,
            })
          : undefined;
      const baseFrame = buildFrame({
        frameId: `frame-${++frameSeq}`,
        stateRevision,
        width: state.viewport.width,
        height: state.viewport.height,
        lines,
        profile,
        modes: lifecycle.currentModeSnapshot(),
        cursor,
        generation: lifecycle.generation(),
        fullRedraw,
        fullRedrawReason: fullRedraw ? fullRedrawReason : undefined,
        renderMs: Math.max(0, clock.now() - startedAt),
        ...(inlineHint !== undefined ? { inlineHint } : {}),
      });
      // WP-07 overlay degradation: a backend without nested-overlay support
      // gets an EMPTY stack (the frame pipeline itself never branches on
      // mode); each newly visible overlay is surfaced ONCE through the dock
      // notification lane (append-only, consistent degradation feedback).
      let overlayStack = state.overlays.stack;
      if (overlayStack.length === 0) {
        overlayUnsupportedNotified.clear();
      } else if (!backend.capabilities.supportsNestedOverlay) {
        for (const overlay of overlayStack) {
          if (!overlay.visible || overlayUnsupportedNotified.has(overlay.overlayId)) continue;
          overlayUnsupportedNotified.add(overlay.overlayId);
          notify('Inline mode cannot render overlay dialogs; the dialog is hidden and keys still apply', {
            color: 'warning',
          });
          diagnostic('overlay/unsupported', 'overlay stripped by backend capability', {
            overlayId: overlay.overlayId,
            mode: backend.mode,
          });
        }
        overlayStack = [];
      }
      // WP-08c search is intentionally visible-transcript only: scan current
      // transcript cells (not the dock), then compose matches above overlays.
      const highlights = state.search.active
        ? buildSearchHighlightRegions(baseFrame, state.search.query, state.search.current, {
            match: theme.roles.searchMatch,
            current: theme.roles.searchCurrent,
          }, baseDiagnostics?.transcriptHeight ?? 0)
        : [];
      const frame = compositeFrame({
        base: baseFrame,
        profile,
        overlays: overlayStack,
        renderOverlay: (overlay, width) =>
          renderDialogOverlayLines(overlay.payload, width, { profile, theme }),
        highlights,
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
        prevFollowEnd = state.viewport.sticky || baseRenderer.anchor === null;
        pendingFullRedraw = false;
        fullRedrawReason = 'unknown-mode';
        return;
      }
      // The patch did not land (stale/dropped): the physical screen no longer
      // provably matches previousFrame — the next frame must be a full redraw.
      previousFrame = null;
      prevFollowEnd = false;
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
        bracketedPaste: capabilitySupport(capabilities, 'bracketedPaste'),
        mouse: capabilities.mouse.enabled !== 'yes' || capabilities.mouse.encoding === 'none'
          ? false
          : capabilities.mouse.encoding === 'x10'
            ? { tracking: 'x10-1000', encoding: 'x10' }
            : capabilities.mouse.encoding === 'urxvt-1015'
              ? { tracking: 'button-1002', encoding: 'urxvt-1015' }
              : { tracking: 'button-1002', encoding: 'sgr-1006' },
        focusReporting: capabilitySupport(capabilities, 'focusReporting'),
        kittyKeyboard: capabilitySupport(capabilities, 'kittyKeyboard'),
        syncOutput: capabilitySupport(capabilities, 'syncOutput'),
        hideCursor: true,
      });
      if (result.status !== 'active') {
        throw new CoordinatorStartError(result.error.code, result.error.message);
      }
      // Backend generation gate (both backends): the physical takeover bytes
      // (alt-screen entry for fullscreen) already ran inside lifecycle.start
      // (§6.4); the inline backend's start emits nothing by construction.
      await backend.start(lifecycle.generation());
      foreignGuard?.attach();
      if (options.attachProcessHandlers !== false) lifecycle.attachProcessHandlers();
      scheduler.start();
      adapter.start();
      dialogsController.start();
      // WP-08a: bind the plugin scene runtime (registration lives on the
      // Cordis facade; this coordinator session owns open/close/takeover).
      pluginRuntime?.attach({
        dispatch: applyEvent,
        nextMeta: (sourceSeq) => meta.next('plugin', sourceSeq),
        takeover: sceneTakeover,
        requestRender: () => {
          if (phase === 'active') scheduler.requestRender('notify', getScheduledState);
        },
        onDiagnostic: (code, message, details) => diagnostic(`scene/${code}`, message, details),
      });
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
      // Close utility overlays while the event pipeline is still alive, then
      // unsubscribe business stores before teardown can emit again.
      sessionCatalogController.dispose();
      workspaceFlowController.dispose();
      settingsFlowController.dispose();
      channelOptionsController.dispose();
      surfaceController?.dispose();
      trajectoryController?.dispose();
      trajectoryRegistration?.dispose();
      interactiveOverlaysController.dispose();
      dialogsController.dispose();
      // WP-08a: tear down the open plugin scene (reason 'teardown') before
      // the terminal stack stops; close/teardown run at most once (§7.4).
      if (pluginRuntime?.attached === true) {
        try {
          await pluginRuntime.detach();
        } catch (error) {
          diagnostic('scene/detach-error', error instanceof Error ? error.message : String(error));
        }
      }
      scheduler.stop();
      // WP-07: park the cursor below the frame so the returning shell prompt
      // lands under the dock instead of overwriting it (best-effort, inline
      // only — fullscreen's alt-screen exit restores the shell screen).
      if (backend.capabilities.supportsInlineLiveRegion) {
        try {
          const park = (backend as InlineScreenBackend).planExitPark(lifecycle.generation());
          if (park !== null) {
            const parkResult = await writer.write(park);
            if (parkResult.status === 'error') {
              diagnostic('writer/error', parkResult.error.message);
            }
          }
        } catch (error) {
          diagnostic('inline/park-error', error instanceof Error ? error.message : String(error));
        }
      }
      imageStore.clearGeneration(lifecycle.generation());
      // Backend generation gate closes before the lifecycle teardown emits
      // any physical restore bytes (§6.4; backend.stop emits nothing).
      await backend.stop(lifecycle.generation());
      foreignGuard?.detach();
      streamingController.stop();
      adapter.stop();
      clipboardController?.stop();
      notificationController.stop();
      lifecycle.detachProcessHandlers();
      try {
        await lifecycle.stop(reason);
      } catch (error) {
        diagnostic('lifecycle/stop-error', error instanceof Error ? error.message : String(error));
      } finally {
        imageStore.clear();
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
      mouse: mouseController,
      commands: commandsController,
      dialogs: dialogsController,
      interactiveOverlays: interactiveOverlaysController,
      sessionCatalog: sessionCatalogController,
      workspaceFlow: workspaceFlowController,
      settingsFlow: settingsFlowController,
      channelOptions: channelOptionsController,
      surfaces: surfaceController as SurfaceController,
      shell: shellProxy,
      clipboard: clipboardController,
      externalEditor: externalEditorController,
      update: updateProxy,
      preferences: preferencesController,
      notifications: notificationController,
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
      mouse: mouseController.diagnostics(),
      commands: commandsController.diagnostics(),
      dialogs: dialogsController.diagnostics(),
      interactiveOverlays: interactiveOverlaysController.diagnostics(),
      sessionCatalog: sessionCatalogController.diagnostics(),
      workspaceFlow: workspaceFlowController.diagnostics(),
      settingsFlow: settingsFlowController.diagnostics(),
      channelOptions: channelOptionsController.diagnostics(),
      surfaces: surfaceController?.activity.diagnostics() ?? { ticks: 0, stalls: 0, invalidPresets: 0 },
      shell: shellProxy.diagnostics(),
      ...(clipboardController !== null ? { clipboard: clipboardController.diagnostics() } : {}),
      ...(externalEditorController !== null ? { externalEditor: externalEditorController.diagnostics() } : {}),
      update: updateProxy.diagnostics(),
      preferences: preferencesController.diagnostics(),
      notifications: notificationController.diagnostics(),
      ...(pluginRuntime !== null ? { scenes: pluginRuntime.diagnostics() } : {}),
    }),
  };
}
