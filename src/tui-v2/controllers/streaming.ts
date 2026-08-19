/**
 * Streaming ingress controller (WP-04).
 *
 * Sits between the session-events adapter and the model reducer:
 *
 *   adapter.dispatch → StreamingController.ingest → dispatch (reducer)
 *
 * Responsibilities:
 *
 *  1. Coalesce `stream/chunk` bursts into a single chunk per row per
 *     16–33ms window (§11.2): the first chunk of a burst carries the merged
 *     text of all later chunks in the same window, keeping causal order and
 *     preserving the already-validated original event inside the carrier.
 *  2. Drop-and-count cancelled streams: `cancelStream(rowId)` marks a row;
 *     subsequent chunks for it are discarded (counted, not dispatched) until
 *     the row settles (`stream/settled`, `row-complete`, `row-upsert`), which
 *     releases the mark after flushing any buffered text for that row.
 *     Re-marking an already-marked row is a no-op (not double-counted). A
 *     `session/rows-reset` clears every mark (counted): reset rows are a new
 *     epoch, so stale marks would leak. The pending BUFFER is deliberately
 *     not cleared — buffered chunks belong to the pre-reset epoch and the
 *     flush-then-reset order below keeps them causal.
 *  3. Own the outgoing event sequence: because cancelled chunks create gaps
 *     in the upstream sequence, every event leaving this controller is
 *     re-stamped with a contiguous controller-owned `seq` (the reducer
 *     rejects gaps/duplicates for the active adapter instance).
 *  4. Be event-agnostic otherwise: non-chunk events flush the window first
 *     (preserving per-row chunk order relative to barriers) and pass through
 *     immediately — validation, freezing, revision bookkeeping and reset
 *     handling all stay in the model layer (§4.6: controllers hold no UI
 *     truth).
 *
 * The controller never throws for content reasons; unexpected upstream
 * problems are diagnostics, model-layer invariants stay the reducer's job.
 */

import type { AppEvent } from '../model/events.js';
import type { Clock } from '../model/schema.js';

/** The chunk variant of AppEvent (the only event this controller buffers). */
type StreamChunkEvent = Extract<AppEvent, { type: 'stream/chunk' }>;

export interface StreamingControllerOptions {
  readonly clock: Clock;
  /**
   * Merge window in milliseconds. Clamped into the §11.2 mandated 16–33ms
   * band. Default 16.
   */
  readonly windowMs?: number;
  /**
   * Maximum merged text size (characters) before a window is flushed early.
   * Bounds per-window memory under hostile chunk floods. Default 256KiB.
   */
  readonly maxMergedTextLength?: number;
  /** Downstream sink (coordinator's dispatch pipeline). */
  readonly dispatch: (event: AppEvent) => void;
  readonly onDiagnostic?: (code: string, data?: Record<string, unknown>) => void;
}

export interface StreamingController {
  /** Adapter-facing entry point. Never throws. */
  readonly ingest: (event: AppEvent) => void;
  /** Mark a stream as cancelled; later chunks for the row are dropped. */
  readonly cancelStream: (rowId: string) => void;
  /** Flush any open window and disarm its timer. */
  readonly flush: () => void;
  /** Flush and disarm; after stop() ingest() drops events (counted). */
  readonly stop: () => void;
  readonly diagnostics: () => StreamingControllerDiagnostics;
}

export interface StreamingControllerDiagnostics {
  readonly ingested: number;
  readonly emitted: number;
  readonly mergedChunks: number;
  readonly droppedChunks: number;
  readonly droppedAfterStop: number;
  readonly windowsFlushed: number;
  readonly cancelledStreams: number;
  /** Cancellation marks cleared by a rows-reset (new epoch). */
  readonly cancelMarksReset: number;
}

const MIN_WINDOW_MS = 16;
const MAX_WINDOW_MS = 33;
const DEFAULT_MAX_MERGED = 256 * 1024;

export function createStreamingController(options: StreamingControllerOptions): StreamingController {
  const windowMs = Math.max(MIN_WINDOW_MS, Math.min(MAX_WINDOW_MS, options.windowMs ?? MIN_WINDOW_MS));
  const maxMerged = Math.max(1, options.maxMergedTextLength ?? DEFAULT_MAX_MERGED);

  /** Buffered chunks keyed by rowId; flush order follows first arrival. */
  const pending = new Map<string, { carrier: StreamChunkEvent; text: string }>();
  const cancelled = new Set<string>();
  let timer: ReturnType<Clock['setTimeout']> | null = null;
  let outSeq = 0;
  let stopped = false;
  let ingested = 0;
  let emitted = 0;
  let mergedChunks = 0;
  let droppedChunks = 0;
  let droppedAfterStop = 0;
  let windowsFlushed = 0;
  let cancelledStreams = 0;
  let cancelMarksReset = 0;

  const diagnostic = (code: string, data?: Record<string, unknown>): void => {
    try {
      options.onDiagnostic?.(code, data);
    } catch {
      /* diagnostics must never break ingestion */
    }
  };

  const emit = (event: AppEvent): void => {
    outSeq += 1;
    emitted += 1;
    // Re-stamp with the controller-owned contiguous sequence; the upstream
    // seq is preserved as causalSeq (EventMeta supports it) for forensics.
    const restamped: AppEvent = { ...event, seq: outSeq, causalSeq: event.causalSeq ?? event.seq };
    options.dispatch(restamped);
  };

  const disarm = (): void => {
    if (timer !== null) {
      options.clock.clearTimeout(timer);
      timer = null;
    }
  };

  const flush = (): void => {
    disarm();
    if (pending.size === 0) return;
    windowsFlushed += 1;
    const drained = [...pending.values()];
    pending.clear();
    for (const { carrier, text } of drained) {
      if (text === carrier.text) {
        emit(carrier);
      } else {
        emit({ ...carrier, text });
      }
    }
  };

  /** Release a cancelled row: buffered text (if any) is emitted before the barrier. */
  const releaseRow = (rowId: string): void => {
    if (!cancelled.delete(rowId)) return;
    const entry = pending.get(rowId);
    if (!entry) return;
    pending.delete(rowId);
    windowsFlushed += 1;
    emit(entry.text === entry.carrier.text ? entry.carrier : { ...entry.carrier, text: entry.text });
    if (pending.size === 0) disarm();
  };

  const ingest = (event: AppEvent): void => {
    ingested += 1;
    if (stopped) {
      droppedAfterStop += 1;
      return;
    }
    if (event.type === 'stream/chunk') {
      if (cancelled.has(event.rowId)) {
        droppedChunks += 1;
        return;
      }
      const existing = pending.get(event.rowId);
      if (existing) {
        existing.text += event.text;
        mergedChunks += 1;
        if (existing.text.length >= maxMerged) {
          pending.delete(event.rowId);
          emit({ ...existing.carrier, text: existing.text });
          if (pending.size === 0) disarm();
          diagnostic('stream/window-overflow-flush', { rowId: event.rowId });
        }
        return;
      }
      pending.set(event.rowId, { carrier: event, text: event.text });
      if (timer === null) {
        timer = options.clock.setTimeout(flush, windowMs);
      }
      return;
    }
    // Stream lifecycle barriers release a cancellation mark after the row's
    // buffered chunks so per-row order stays causal.
    if (event.type === 'session/rows-reset') {
      // New epoch: every outstanding cancellation mark is stale (its rowId is
      // about to be re-issued). Clear marks, keep the pending buffer — the
      // flush below emits pre-reset chunks ahead of the reset, preserving
      // causality.
      cancelMarksReset += cancelled.size;
      cancelled.clear();
    } else if (event.type === 'stream/settled' || event.type === 'session/row-complete') {
      releaseRow(event.rowId);
    } else if (event.type === 'session/row-upsert') {
      releaseRow(event.row.rowId);
    }
    flush();
    emit(event);
  };

  return {
    ingest,
    cancelStream: (rowId) => {
      if (cancelled.has(rowId)) return;
      cancelled.add(rowId);
      cancelledStreams += 1;
    },
    flush,
    stop: () => {
      if (stopped) return;
      stopped = true;
      flush();
    },
    diagnostics: () => ({
      ingested,
      emitted,
      mergedChunks,
      droppedChunks,
      droppedAfterStop,
      windowsFlushed,
      cancelledStreams,
      cancelMarksReset,
    }),
  };
}
