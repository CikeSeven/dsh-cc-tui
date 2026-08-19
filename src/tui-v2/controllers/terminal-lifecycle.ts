/**
 * Terminal-lifecycle controller (WP-04).
 *
 * Translates terminal-side happenings into model events and coordinator
 * callbacks:
 *
 *   input resize event   → viewport/resize journal + scheduler resize
 *                          transaction (the scheduler re-reads state after
 *                          the reducer applied the event)
 *   SIGCONT (onResume)   → terminal/resumed journal + full-redraw flag
 *   onRequestStop        → coordinator requestStop(reason)
 *   onProcessError       → app/error journal + requestStop('error')
 *
 * The controller never touches the terminal itself; takeover/cleanup stay in
 * the terminal lifecycle module (§6.6), and this layer holds no UI truth
 * beyond event translation.
 */

import type { AppEvent } from '../model/events.js';
import type { EventMeta, SerializableError } from '../model/schema.js';
import type { LifecycleStopReason } from '../terminal/lifecycle.js';

export interface TerminalLifecycleCallbacks {
  /** Open a scheduler resize transaction (coordinator wiring). */
  readonly beginResizeTransaction: () => void;
  /** Mark that the next committed frame must be a full redraw. */
  readonly markFullRedraw: () => void;
  /** Ask the coordinator to stop (signal/stdin-close/error paths). */
  readonly requestStop: (reason: LifecycleStopReason) => void;
}

export interface TerminalLifecycleControllerOptions {
  /** Outgoing event journal (coordinator dispatch pipeline). */
  readonly dispatch: (event: AppEvent) => void;
  /** Allocate the journal event envelope; controller sourceSeqs are `terminal-N`. */
  readonly nextMeta: (sourceSeq: string) => EventMeta;
  readonly callbacks: TerminalLifecycleCallbacks;
}

export interface TerminalLifecycleControllerDiagnostics {
  readonly resizes: number;
  readonly resumes: number;
  readonly stopRequests: number;
  readonly processErrors: number;
}

export interface TerminalLifecycleController {
  /** Input-source resize event (SIGWINCH or stdout 'resize'). */
  readonly handleResize: (columns: number, rows: number) => void;
  /** SIGCONT revival: journal + force the next frame to repaint fully. */
  readonly handleResume: () => void;
  /** Lifecycle-initiated stop request (signals, stdin close/error). */
  readonly handleStopRequest: (reason: LifecycleStopReason) => void;
  /** uncaughtException / unhandledRejection funnel. */
  readonly handleProcessError: (error: unknown, origin: 'uncaughtException' | 'unhandledRejection') => void;
  readonly diagnostics: () => TerminalLifecycleControllerDiagnostics;
}

function toSerializableError(error: unknown, origin: string): SerializableError {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    code: `process/${origin}`,
    message: err.message,
    recoverable: false,
  };
}

export function createTerminalLifecycleController(
  options: TerminalLifecycleControllerOptions,
): TerminalLifecycleController {
  let journalSeq = 0;
  const counts = { resizes: 0, resumes: 0, stopRequests: 0, processErrors: 0 };

  const journal = (body: Pick<AppEvent, 'type'> & Record<string, unknown>): void => {
    journalSeq += 1;
    options.dispatch({ ...options.nextMeta(`terminal-${journalSeq}`), ...body } as AppEvent);
  };

  return {
    handleResize: (columns, rows) => {
      counts.resizes += 1;
      journal({ type: 'viewport/resize', width: columns, height: rows });
      // The reducer applied the resize synchronously inside dispatch; the
      // scheduler transaction coalesces the follow-up render (§11.2).
      options.callbacks.beginResizeTransaction();
    },
    handleResume: () => {
      counts.resumes += 1;
      journal({ type: 'terminal/resumed' });
      options.callbacks.markFullRedraw();
    },
    handleStopRequest: (reason) => {
      counts.stopRequests += 1;
      options.callbacks.requestStop(reason);
    },
    handleProcessError: (error, origin) => {
      counts.processErrors += 1;
      journal({ type: 'app/error', error: toSerializableError(error, origin) });
      options.callbacks.requestStop('error');
    },
    diagnostics: () => ({ ...counts }),
  };
}
