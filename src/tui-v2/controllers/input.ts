/**
 * Input controller (WP-04).
 *
 * Routes decoded `TerminalInputEvent`s to the prompt editor, the session
 * command surface, and the app-exit path. Owns the WP-04 Ctrl+C contract:
 *
 *   assistant working      → commands.cancel() + journal `app interrupt`
 *   editor text non-empty  → clear editor + journal `editor cancel`
 *   armed (within window)  → journal `app exit` + onExitRequest()
 *   otherwise              → arm for ctrlCArmMs
 *
 * The editor itself stays the single owner of editor text: this controller
 * journals every editor command as an `input/command` event (the reducer
 * journals it; model editor state is a WP-05 seam) and forwards submit to
 * the channel commands. It holds no UI truth beyond the Ctrl+C arming
 * timestamp.
 */

import type { AppEvent } from '../model/events.js';
import type { Clock, EventMeta, InputCommand } from '../model/schema.js';
import type { KeyPayload, PastePayload, TerminalInputEvent } from '../terminal/input.js';

/** Minimal editor surface the controller needs (implemented by coordinator's editor binding). */
export interface InputEditorBinding {
  /** Feed a raw terminal sequence (key or paste payload) to the editor. */
  readonly handleRawInput: (raw: string) => void;
  readonly getText: () => string;
  /** Clear editor text (Ctrl+C on non-empty draft). */
  readonly clearText: () => void;
}

/** Minimal session command surface (subset of ChannelCommands). */
export interface InputCommandSink {
  readonly submit: (text: string) => void;
  readonly cancel: () => void;
}

export interface InputControllerOptions {
  readonly clock: Clock;
  /** Outgoing event journal (coordinator dispatch pipeline). */
  readonly dispatch: (event: AppEvent) => void;
  /**
   * Allocate the journal event envelope (full EventMeta: schemaVersion,
   * adapter/session ids, epochs, source, seq, at). The controller journals
   * with caller-provided sourceSeqs (`input-N`).
   */
  readonly nextMeta: (sourceSeq: string) => EventMeta;
  readonly editor: InputEditorBinding;
  readonly commands: InputCommandSink;
  /** True while the assistant is working (Ctrl+C cancels the run). */
  readonly isWorking: () => boolean;
  /** Called after the exit journal event when the armed second Ctrl+C lands. */
  readonly onExitRequest: () => void;
  /** Arming window for the double-Ctrl+C exit. Default 2000ms. */
  readonly ctrlCArmMs?: number;
}

export interface InputControllerDiagnostics {
  readonly keyEvents: number;
  readonly pasteEvents: number;
  readonly ignoredEvents: number;
  readonly ctrlCancellations: number;
  readonly ctrlCClears: number;
  readonly ctrlCArms: number;
  readonly exitRequests: number;
  readonly submittedCommands: number;
}

export interface InputController {
  /** Entry point for terminal input events. Never throws. */
  readonly handleEvent: (event: TerminalInputEvent) => void;
  /** Entry point for editor commands emitted by the prompt editor component. */
  readonly handleEditorCommand: (command: InputCommand) => void;
  readonly diagnostics: () => InputControllerDiagnostics;
}

const DEFAULT_CTRL_C_ARM_MS = 2000;

export function createInputController(options: InputControllerOptions): InputController {
  const armMs = options.ctrlCArmMs ?? DEFAULT_CTRL_C_ARM_MS;
  let armedAt: number | null = null;
  let journalSeq = 0;
  const counts = {
    keyEvents: 0,
    pasteEvents: 0,
    ignoredEvents: 0,
    ctrlCancellations: 0,
    ctrlCClears: 0,
    ctrlCArms: 0,
    exitRequests: 0,
    submittedCommands: 0,
  };

  const journal = (command: InputCommand): void => {
    journalSeq += 1;
    options.dispatch({
      ...options.nextMeta(`input-${journalSeq}`),
      type: 'input/command',
      command,
    });
  };

  const disarm = (): void => {
    armedAt = null;
  };

  const handleCtrlC = (): void => {
    if (options.isWorking()) {
      counts.ctrlCancellations += 1;
      disarm();
      journal({ type: 'app', command: 'interrupt' });
      options.commands.cancel();
      return;
    }
    if (options.editor.getText().length > 0) {
      counts.ctrlCClears += 1;
      disarm();
      options.editor.clearText();
      journal({ type: 'editor', command: 'cancel' });
      return;
    }
    const now = options.clock.now();
    if (armedAt !== null && now - armedAt <= armMs) {
      counts.exitRequests += 1;
      disarm();
      journal({ type: 'app', command: 'exit' });
      options.onExitRequest();
      return;
    }
    counts.ctrlCArms += 1;
    armedAt = now;
  };

  const handleEvent = (event: TerminalInputEvent): void => {
    if (event.kind === 'key') {
      counts.keyEvents += 1;
      const payload = event.payload as KeyPayload;
      if (payload.key === 'ctrl+c') {
        handleCtrlC();
        return;
      }
      disarm();
      options.editor.handleRawInput(payload.raw);
      return;
    }
    if (event.kind === 'paste') {
      counts.pasteEvents += 1;
      disarm();
      options.editor.handleRawInput((event.payload as PastePayload).text);
      return;
    }
    // resize/mouse/focus/signal/query-response are routed elsewhere (or are
    // not WP-04 surface); count them so dropped input is observable.
    counts.ignoredEvents += 1;
  };

  const handleEditorCommand = (command: InputCommand): void => {
    journal(command);
    if (command.type === 'editor' && command.command === 'submit') {
      const text = (command.text ?? '').trim();
      if (text.length > 0) {
        counts.submittedCommands += 1;
        options.commands.submit(command.text ?? '');
      }
    }
  };

  return {
    handleEvent,
    handleEditorCommand,
    diagnostics: () => ({ ...counts }),
  };
}
