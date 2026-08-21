/**
 * tui-v2 bootstrap (WP-04): the single public entry point for the v2
 * walking skeleton. Production wiring (which binary path calls this, and the
 * removal of the v1 JSX bootstrap) is WP-09 — this module only assembles the
 * coordinator from real process streams.
 *
 * Defaults: the real wall clock, `process.stdin`/`process.stdout`, and the
 * `unknown-conservative` terminal profile (capability probing is a later
 * work package; §5.4 treats 'unknown' as off, so the default mode is the
 * inline degradation path unless the caller supplies a probed profile).
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
import { unknownConservativeDefaults, type TerminalProfile } from '../terminal/profile.js';
import {
  createTuiV2Coordinator,
  type CoordinatorChannel,
  type CoordinatorDiagnostic,
  type TuiV2Coordinator,
} from './coordinator.js';

export interface TuiV2AppOptions {
  readonly channel: CoordinatorChannel;
  readonly stdin?: InputStdin;
  readonly stdout?: NodeJS.WriteStream;
  /** Present for interface completeness; the skeleton does not write it. */
  readonly stderr?: NodeJS.WriteStream;
  readonly profile?: TerminalProfile;
  readonly clock?: Clock;
  readonly mode?: TerminalMode;
  readonly theme?: string;
  readonly language?: string;
  readonly welcomeText?: string;
  readonly trajectory?: boolean;
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

export interface TuiV2App {
  start(): Promise<void>;
  stop(): Promise<void>;
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
  const profile: TerminalProfile = {
    ...(options.profile ?? unknownConservativeDefaults()),
    columns: stdout.columns ?? options.profile?.columns ?? 80,
    rows: stdout.rows ?? options.profile?.rows ?? 24,
  };
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
    clock: options.clock ?? realClock,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    theme: startupTheme,
    language: startupLanguage,
    ...(options.welcomeText !== undefined ? { welcomeText: options.welcomeText } : {}),
    ...(options.trajectory !== undefined ? { trajectory: options.trajectory } : {}),
    shellCapability: options.shellCapability ?? createNodeShellCapability(),
    clipboardCapability: options.clipboardCapability ?? createNodeClipboardCapability(),
    editorRunner: options.editorRunner ?? createNodeEditorRunner(),
    restartRunner: options.restartRunner ?? createNodeRestartRunner(),
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
    stop: () => coordinator.stop('user-exit'),
    awaitStop: () => coordinator.awaitStop(),
    adapter: coordinator.adapter,
    commands: coordinator.commands,
    coordinator,
  };
}
