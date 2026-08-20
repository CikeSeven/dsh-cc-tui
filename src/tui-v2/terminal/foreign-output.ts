/**
 * tui-v2 foreign output guard (WP-07, plan §WP-07 third-party 输出重锚).
 *
 * Inline mode shares the main screen with everything else in the process
 * (and with libraries writing to stdout/stderr directly). The terminal
 * writer owns the ONLY sanctioned byte lane, so any write to the underlying
 * stream that did not pass through it is foreign: those bytes can move the
 * cursor, scroll the screen and corrupt the frame = screen invariant.
 *
 * The guard monkey-patches the underlying stream's `write` (restored on
 * `detach`) and hands the writer a proxy (`writerStream`) whose `write`
 * marks the synchronous call as ours. Foreign writes are counted and
 * reported through `onForeign(bytes)` — the callback must only schedule a
 * re-anchor render (set the damage full-redraw reason and request a render);
 * it must never write bytes itself (single-writer rule, §5.6).
 *
 * Attached only when the backend declares `supportsInlineLiveRegion`;
 * fullscreen owns the alternate screen and needs no guard.
 */
import type { Writable } from 'node:stream';

export interface ForeignOutputGuard {
  /** The stream the TerminalWriter must wrap: writes through it are ours. */
  readonly writerStream: Writable;
  /** Count of foreign writes observed while attached. */
  readonly foreignWrites: number;
  attach(): void;
  detach(): void;
}

type WriteMethod = Writable['write'];

export function createForeignOutputGuard(
  stream: Writable,
  onForeign: (bytes: number) => void,
): ForeignOutputGuard {
  let attached = false;
  let inWriter = false;
  let foreignWrites = 0;
  const hadOwnWrite = Object.prototype.hasOwnProperty.call(stream, 'write');
  const originalWrite: WriteMethod = stream.write;

  const patchedWrite = function (this: Writable, chunk: unknown, ...rest: unknown[]): boolean {
    if (!inWriter) {
      foreignWrites += 1;
      const bytes =
        typeof chunk === 'string'
          ? Buffer.byteLength(chunk)
          : chunk instanceof Uint8Array
            ? chunk.byteLength
            : 0;
      try {
        onForeign(bytes);
      } catch {
        /* diagnostics never break the pipeline */
      }
    }
    return Reflect.apply(originalWrite, this, [chunk, ...rest]) as boolean;
  };

  // The writer's view of the stream: `write` is intercepted to mark the
  // synchronous call as ours; every other property/method is forwarded with
  // the real stream as receiver (stream internals must never see the proxy).
  const writerStream = new Proxy(stream, {
    get(target, prop) {
      if (prop === 'write') {
        return (chunk: unknown, ...rest: unknown[]): boolean => {
          inWriter = true;
          try {
            return Reflect.apply(target.write, target, [chunk, ...rest]) as boolean;
          } finally {
            inWriter = false;
          }
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return {
    writerStream,
    get foreignWrites() {
      return foreignWrites;
    },
    attach() {
      if (attached) return;
      stream.write = patchedWrite as WriteMethod;
      attached = true;
    },
    detach() {
      if (!attached) return;
      attached = false;
      // Never clobber a re-patch someone else installed after our attach.
      if ((stream as { write?: unknown }).write !== patchedWrite) return;
      if (hadOwnWrite) {
        stream.write = originalWrite;
      } else {
        // Restore prototype inheritance exactly as found.
        delete (stream as { write?: WriteMethod }).write;
      }
    },
  };
}
