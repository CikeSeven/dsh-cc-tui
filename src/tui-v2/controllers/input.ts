/**
 * Input controller (WP-04, deepened WP-05).
 *
 * Routes decoded `TerminalInputEvent`s to the prompt editor, the session
 * command surface, and the app-exit path. Owns the Ctrl+C contract:
 *
 *   assistant working      → journal `app interrupt` + commands.cancel() +
 *                            onInterrupt() (coordinator hooks streaming cancel)
 *   editor text non-empty  → clear editor + journal `editor cancel`
 *   armed (within window)  → journal `app exit` + onExitRequest()
 *   otherwise              → arm for ctrlCArmMs + onExitArm() (coordinator
 *                            hooks the "press again to exit" notification)
 *
 * WP-05 additions:
 *   - Escape while working  → journal `app interrupt` + (commands.interrupt ??
 *                            commands.cancel)() + onInterrupt(). `interrupt`
 *                            is the richer channel op (interrupt-and-deliver
 *                            pending texts); cancel is the fallback.
 *   - Paste payloads go through `editor.insertPaste` when available: an
 *                            atomic insertion that never triggers submit
 *                            (pasted newlines stay text).
 *   - Submissions are mirrored into a bounded per-controller history
 *                            (newest-first, consecutive-deduped, cap 64) and
 *                            forwarded to the editor's own addToHistory when
 *                            present.
 *
 * WP-06b addition: Ctrl+L → journal `app redraw` + onRedrawRequest() — the
 * user-suspects-screen-damage full redraw (plan §6.4; the coordinator marks
 * the next frame fullRedraw with reason 'damage'). The key never reaches
 * the editor.
 *
 * The editor itself stays the single owner of editor text: this controller
 * journals every editor command as an `input/command` event and forwards
 * submit to the channel commands. It holds no UI truth beyond the Ctrl+C
 * arming timestamp and the history mirror.
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
  /**
   * Atomic paste insertion (never triggers submit, keeps pasted newlines as
   * text). When absent the controller falls back to handleRawInput.
   */
  readonly insertPaste?: (text: string) => void;
  /** UTF-16 offset of the cursor in getText() (coordinator mirror seam). */
  readonly getCursorOffset?: () => number;
  /** Push a submitted line into the editor's own history (dedup/cap inside). */
  readonly addToHistory?: (text: string) => void;
  /** Replace the editor draft (rewind refill). */
  readonly setDraft?: (text: string) => void;
}

/** Minimal session command surface (subset of ChannelCommands). */
export interface InputCommandSink {
  readonly submit: (text: string) => void;
  readonly cancel: () => void;
  /**
   * Working-state interrupt (WP-05): the channel's interrupt-and-deliver —
   * pending queued texts are delivered with the abort. Falls back to cancel.
   */
  readonly interrupt?: () => void;
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
  /**
   * Working-state interrupt hook (WP-05): fired for Ctrl+C AND Escape while
   * working; the coordinator hooks streaming.cancelStream(streamingRowId).
   */
  readonly onInterrupt?: () => void;
  /** Armed-Ctrl+C hook (WP-05): the coordinator surfaces the notify. */
  readonly onExitArm?: () => void;
  /**
   * Ctrl+L hook (WP-06b): the coordinator forces a full redraw
   * (fullRedrawReason 'damage'). The `app redraw` command is journaled first.
   */
  readonly onRedrawRequest?: () => void;
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
  readonly escapeInterrupts: number;
  readonly redrawRequests: number;
  readonly submittedCommands: number;
}

export interface InputController {
  /** Entry point for terminal input events. Never throws. */
  readonly handleEvent: (event: TerminalInputEvent) => void;
  /** Entry point for editor commands emitted by the prompt editor component. */
  readonly handleEditorCommand: (command: InputCommand) => void;
  /**
   * Submission history mirror (newest-first, consecutive-deduped, cap 64).
   * The editor's own history stays authoritative for Up/Down navigation;
   * this mirror exists for tests and future model journaling (WP-05b).
   */
  readonly history: () => readonly string[];
  readonly diagnostics: () => InputControllerDiagnostics;
}

const DEFAULT_CTRL_C_ARM_MS = 2000;
const HISTORY_CAP = 64;

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
    escapeInterrupts: 0,
    redrawRequests: 0,
    submittedCommands: 0,
  };
  /** Submission history mirror: newest first, consecutive duplicates merged. */
  const historyMirror: string[] = [];

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
      options.onInterrupt?.();
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
    options.onExitArm?.();
  };

  /** Escape while working: interrupt (delivering pending texts) or cancel. */
  const handleEscape = (): void => {
    if (!options.isWorking()) return;
    counts.escapeInterrupts += 1;
    disarm();
    journal({ type: 'app', command: 'interrupt' });
    const interrupt = options.commands.interrupt;
    if (interrupt !== undefined) {
      interrupt();
    } else {
      options.commands.cancel();
    }
    options.onInterrupt?.();
  };

  const handleEvent = (event: TerminalInputEvent): void => {
    if (event.kind === 'key') {
      counts.keyEvents += 1;
      const payload = event.payload as KeyPayload;
      if (payload.key === 'ctrl+c') {
        handleCtrlC();
        return;
      }
      if (payload.key === 'ctrl+l') {
        // WP-06b: user-forced full redraw (screen damage suspicion). The key
        // is consumed here — the editor never sees it.
        counts.redrawRequests += 1;
        disarm();
        journal({ type: 'app', command: 'redraw' });
        options.onRedrawRequest?.();
        return;
      }
      if (payload.key === 'escape' && options.isWorking()) {
        handleEscape();
        return;
      }
      disarm();
      options.editor.handleRawInput(payload.raw);
      return;
    }
    if (event.kind === 'paste') {
      counts.pasteEvents += 1;
      disarm();
      const text = (event.payload as PastePayload).text;
      // insertPaste is atomic and never triggers submit; handleRawInput would
      // replay a pasted '\r' as Enter.
      const insertPaste = options.editor.insertPaste;
      if (insertPaste !== undefined) {
        insertPaste(text);
      } else {
        options.editor.handleRawInput(text);
      }
      return;
    }
    // resize/mouse/focus/signal/query-response are routed elsewhere (or are
    // not WP-05 surface); count them so dropped input is observable.
    counts.ignoredEvents += 1;
  };

  const handleEditorCommand = (command: InputCommand): void => {
    journal(command);
    if (command.type === 'editor' && command.command === 'submit') {
      const text = (command.text ?? '').trim();
      if (text.length > 0) {
        counts.submittedCommands += 1;
        const raw = command.text ?? '';
        if (historyMirror[0] !== raw) {
          historyMirror.unshift(raw);
          if (historyMirror.length > HISTORY_CAP) historyMirror.length = HISTORY_CAP;
        }
        options.editor.addToHistory?.(raw);
        options.commands.submit(raw);
      }
    }
  };

  return {
    handleEvent,
    handleEditorCommand,
    history: () => [...historyMirror],
    diagnostics: () => ({ ...counts }),
  };
}
