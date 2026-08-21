/**
 * tui-v2 bootstrap: the single production/test entry point for the v2
 * coordinator. It assembles the coordinator from real process streams while
 * keeping stores, extension hosts, lifecycle hosts and capabilities structural.
 *
 * Defaults use the real wall clock and resolve a conservative production
 * profile from the actual TTY/environment; tests may inject deterministic
 * profiles, capabilities, clocks and process hosts.
 */

import type { Writable } from 'node:stream';

import type { Clock } from '../model/schema.js';
import type {
  ClipboardCapability,
  EditorRunner,
  ExternalActionTraceSink,
  LanguageCapability,
  PreferencePersistence,
  RestartRunner,
  ShellCapability,
} from '../capabilities/external-actions.js';
import {
  createNodeClipboardCapability,
  createNodeEditorRunner,
  createNodeRestartRunner,
  createNodeShellCapability,
} from '../capabilities/node.js';
import { resolveEditorCommand } from '../../utils/externalEditor.js';
import { readThemePref, writeThemePref } from '../../themePrefs.js';
import { readLangPref, writeLangPref, setLang, isLang } from '../../i18n.js';
import type { TerminalMode } from '../model/schema.js';
import type { ChannelCommands, ChannelUiAdapter } from '../controllers/session-events.js';
import type { InputStdin } from '../terminal/input.js';
import type { LifecycleStopReason, ProcessSignalHost } from '../terminal/lifecycle.js';
import { detectTerminalCapabilities, type TerminalCapabilitySnapshot } from '../terminal/capabilities.js';
import { unknownConservativeDefaults, type TerminalProfile } from '../terminal/profile.js';
import { resolveProductionTerminalProfile } from '../terminal/production-profile.js';
import type {
  ApprovalStoreLike,
  PluginDialogStoreLike,
  QuestionStoreLike,
} from '../controllers/dialogs.js';
import type { PluginUIRuntime } from '../scenes/runtime.js';
import {
  createTuiV2Coordinator,
  type CoordinatorChannel,
  type CoordinatorDiagnostic,
  type CoordinatorShortcutHost,
  type CoordinatorStatusHost,
  type TuiV2Coordinator,
} from './coordinator.js';
import type { ThemeDescriptor } from '../theme/registry.js';

export interface TuiV2AppOptions {
  readonly channel: CoordinatorChannel;
  readonly stdin?: InputStdin;
  readonly stdout?: NodeJS.WriteStream;
  /** Present for interface completeness; the skeleton does not write it. */
  readonly stderr?: NodeJS.WriteStream;
  readonly profile?: TerminalProfile;
  /** Optional precomputed snapshot for embedders; production derives one safely. */
  readonly capabilities?: TerminalCapabilitySnapshot;
  readonly clock?: Clock;
  readonly mode?: TerminalMode;
  readonly processHost?: ProcessSignalHost;
  readonly onExitRequest?: () => void;
  readonly onStopRequest?: (reason: import('../terminal/lifecycle.js').LifecycleStopReason) => void;
  readonly attachProcessHandlers?: boolean;
  readonly theme?: string;
  readonly themeDescriptors?: readonly ThemeDescriptor[];
  readonly language?: string;
  readonly welcomeText?: string;
  readonly approvalStore?: ApprovalStoreLike;
  readonly questionStore?: QuestionStoreLike;
  readonly pluginDialogStore?: PluginDialogStoreLike;
  readonly scenes?: PluginUIRuntime;
  readonly statusHost?: CoordinatorStatusHost;
  readonly shortcutHost?: CoordinatorShortcutHost;
  readonly trajectory?: boolean;
  readonly shellCapability?: ShellCapability;
  readonly clipboardCapability?: ClipboardCapability;
  readonly editorRunner?: EditorRunner;
  /** `null` disables the generic update controller for a production funnel. */
  readonly restartRunner?: RestartRunner | null;
  readonly updateProfile?: string;
  readonly onUpdateRequest?: () => void;
  readonly languageCapability?: LanguageCapability;
  readonly preferencePersistence?: PreferencePersistence;
  readonly actionTrace?: ExternalActionTraceSink;
  readonly editorArgv?: () => readonly string[] | undefined;
  readonly confirmUpdate?: (request: { sessionId: string; profile: string; targetVersion?: string }) => Promise<boolean> | boolean;
  readonly onDiagnostic?: (diagnostic: CoordinatorDiagnostic) => void;
}

export interface TuiV2App {
  start(): Promise<void>;
  stop(reason?: LifecycleStopReason): Promise<void>;
  awaitStop(): Promise<void>;
  readonly adapter: ChannelUiAdapter;
  readonly commands: ChannelCommands;
  readonly coordinator: TuiV2Coordinator;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export function createTuiV2App(options: TuiV2AppOptions): TuiV2App {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const resolvedProduction = options.profile === undefined && options.capabilities === undefined
    ? resolveProductionTerminalProfile({
        stdout,
        stdin,
        environment: process.env,
        platform: process.platform,
      })
    : undefined
  const profile: TerminalProfile = {
    ...(options.profile ?? resolvedProduction?.profile ?? unknownConservativeDefaults()),
    columns: stdout.columns ?? options.profile?.columns ?? resolvedProduction?.profile.columns ?? 80,
    rows: stdout.rows ?? options.profile?.rows ?? resolvedProduction?.profile.rows ?? 24,
  };
  const capabilities = options.capabilities ?? resolvedProduction?.capabilities ?? detectTerminalCapabilities({
    profile,
    generation: 0,
    stdinIsTTY: stdin.isTTY === true,
    rawModeAvailable: typeof stdin.setRawMode === 'function',
    environment: process.env,
  })
  const startupTheme = options.theme ?? process.env.DSH_TUI_THEME ?? readThemePref() ?? 'default'
  const startupLanguage = isLang(process.env.DSH_TUI_LANG)
    ? process.env.DSH_TUI_LANG
    : options.language ?? readLangPref() ?? 'en'
  const coordinator = createTuiV2Coordinator({
    channel: options.channel,
    stdin,
    stdout,
    stream: stdout as unknown as Writable,
    profile,
    capabilities,
    clock: options.clock ?? realClock,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.processHost !== undefined ? { processHost: options.processHost } : {}),
    ...(options.onExitRequest !== undefined ? { onExitRequest: options.onExitRequest } : {}),
    ...(options.onStopRequest !== undefined ? { onStopRequest: options.onStopRequest } : {}),
    ...(options.attachProcessHandlers !== undefined ? { attachProcessHandlers: options.attachProcessHandlers } : {}),
    theme: startupTheme,
    ...(options.themeDescriptors !== undefined ? { themeDescriptors: options.themeDescriptors } : {}),
    language: startupLanguage,
    ...(options.welcomeText !== undefined ? { welcomeText: options.welcomeText } : {}),
    ...(options.approvalStore !== undefined ? { approvalStore: options.approvalStore } : {}),
    ...(options.questionStore !== undefined ? { questionStore: options.questionStore } : {}),
    ...(options.pluginDialogStore !== undefined ? { pluginDialogStore: options.pluginDialogStore } : {}),
    ...(options.scenes !== undefined ? { scenes: options.scenes } : {}),
    ...(options.statusHost !== undefined ? { statusHost: options.statusHost } : {}),
    ...(options.shortcutHost !== undefined ? { shortcutHost: options.shortcutHost } : {}),
    ...(options.trajectory !== undefined ? { trajectory: options.trajectory } : {}),
    shellCapability: options.shellCapability ?? createNodeShellCapability(),
    clipboardCapability: options.clipboardCapability ?? createNodeClipboardCapability(),
    editorRunner: options.editorRunner ?? createNodeEditorRunner(),
    ...(options.restartRunner === null ? {} : { restartRunner: options.restartRunner ?? createNodeRestartRunner() }),
    ...(options.updateProfile !== undefined ? { updateProfile: options.updateProfile } : {}),
    ...(options.onUpdateRequest !== undefined ? { onUpdateRequest: options.onUpdateRequest } : {}),
    languageCapability: options.languageCapability ?? {
      supported: ['zh', 'en'],
      set: async (language: string) => isLang(language) ? (setLang(language), { status: 'changed' as const, language }) : { status: 'unsupported' as const },
    },
    preferencePersistence: options.preferencePersistence ?? {
      readTheme: () => readThemePref(),
      writeTheme: (name) => writeThemePref(name),
      readLanguage: () => readLangPref(),
      writeLanguage: (language) => isLang(language) && writeLangPref(language),
    },
    ...(options.actionTrace !== undefined ? { actionTrace: options.actionTrace } : {}),
    editorArgv: options.editorArgv ?? (() => resolveEditorCommand()),
    ...(options.confirmUpdate !== undefined ? { confirmUpdate: options.confirmUpdate } : {}),
    ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
  });
  return {
    start: () => coordinator.start(),
    stop: (reason = 'user-exit') => coordinator.stop(reason),
    awaitStop: () => coordinator.awaitStop(),
    adapter: coordinator.adapter,
    commands: coordinator.commands,
    coordinator,
  };
}
