/**
 * In-memory controller rig for WP-05 controller tests.
 *
 * Wires the real pipeline minus the terminal/renderer:
 *
 *   FakeChannel → ChannelUiAdapter → StreamingController → applyEvent
 *     (validate → deepFreeze → reduce → pendingReset? recoverSnapshotGap)
 *
 * and records every APPLIED event (post-streaming, re-sequenced) so tests can
 * feed them to replayTrace for live/replay canonical equivalence.
 */
import type { AppEvent } from '../../../src/tui-v2/model/events.js';
import { validateAppEvent } from '../../../src/tui-v2/model/events.js';
import { createReducer, type Reducer } from '../../../src/tui-v2/model/reducer.js';
import { deepFreeze, type Clock, type EventMeta } from '../../../src/tui-v2/model/schema.js';
import { initialUiState, type UiState } from '../../../src/tui-v2/model/state.js';
import {
  createChannelUiAdapter,
  createEventMetaFactory,
  type ChannelUiAdapter,
  type DockStoreView,
  type EventMetaFactory,
  type StagedImageCommandResult,
} from '../../../src/tui-v2/controllers/session-events.js';
import {
  createStreamingController,
  type StreamingController,
} from '../../../src/tui-v2/controllers/streaming.js';
import type { StagedImageInput, StagedImageMetadata } from '../../../src/dsh-adapter/channel.js';
import { createFakeChannel, type FakeChannel } from './fake-channel.js';

export class ManualClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers: Array<{ id: number; at: number; cb: () => void }> = [];
  now(): number {
    return this.t;
  }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, delayMs), cb: callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.t = due.at;
      due.cb();
    }
    this.t = target;
  }
}

export interface ControllerRig {
  readonly channel: FakeChannel;
  readonly clock: ManualClock;
  readonly meta: EventMetaFactory;
  readonly reducer: Reducer;
  readonly adapter: ChannelUiAdapter;
  readonly streaming: StreamingController;
  readonly initialState: UiState;
  /** Every event that passed the reducer boundary, in applied order. */
  readonly applied: AppEvent[];
  readonly diagnostics: { code: string; message: string }[];
  state(): UiState;
  dock(): DockStoreView | null;
  /** Flush the streaming merge window (ManualClock alternative). */
  flushStream(): void;
  /** Journal a viewport resize the way the lifecycle controller does. */
  resize(width: number, height: number): void;
}

export function createControllerRig(options: {
  channel?: FakeChannel;
  width?: number;
  height?: number;
  welcomeText?: string;
  storeStagedImage?: (input: StagedImageInput, metadata: StagedImageMetadata) => Promise<StagedImageCommandResult>;
} = {}): ControllerRig {
  const channel = options.channel ?? createFakeChannel();
  const clock = new ManualClock();
  const reducer = createReducer({ clock });
  const width = options.width ?? 40;
  const height = options.height ?? 5;
  const initialState = initialUiState({
    width,
    height,
    profileId: 'test-profile',
    theme: 'default',
    language: 'en',
  });

  let state = initialState;
  const applied: AppEvent[] = [];
  const diagnostics: { code: string; message: string }[] = [];
  let dockView: DockStoreView | null = null;

  const meta = createEventMetaFactory({
    adapterInstanceId: 'rig-adapter',
    durableSessionId: 'rig-session',
    uiSessionGeneration: 'rig-gen',
    clock,
  });

  const applyEvent = (event: AppEvent): void => {
    const validated = validateAppEvent(event);
    state = reducer.reduce(state, deepFreeze(validated) as AppEvent);
    applied.push(validated);
    if (state.session.pendingReset !== null && validated.type !== 'session/rows-reset') {
      adapter.recoverSnapshotGap();
    }
  };

  const streaming = createStreamingController({
    clock,
    dispatch: applyEvent,
    onDiagnostic: (code) => diagnostics.push({ code: `stream/${code}`, message: code }),
  });

  const adapter = createChannelUiAdapter({
    channel,
    meta,
    dispatch: (event) => streaming.ingest(event),
    ...(options.welcomeText !== undefined ? { welcomeText: options.welcomeText } : {}),
    ...(options.storeStagedImage !== undefined ? { storeStagedImage: options.storeStagedImage } : {}),
    onDockChange: (dock) => {
      dockView = dock;
    },
    onDiagnostic: (d) => diagnostics.push({ code: `adapter/${d.code}`, message: d.message }),
  });
  adapter.start();

  let resizeSeq = 0;
  return {
    channel,
    clock,
    meta,
    reducer,
    adapter,
    streaming,
    initialState,
    applied,
    diagnostics,
    state: () => state,
    dock: () => dockView,
    flushStream: () => streaming.flush(),
    resize(width2, height2) {
      resizeSeq += 1;
      const event: AppEvent = {
        ...meta.next('terminal', `rig-resize-${resizeSeq}`),
        type: 'viewport/resize',
        width: width2,
        height: height2,
      };
      streaming.ingest(event);
    },
  };
}

/** Convenience: append `count` user rows through the channel. */
export function addUserRows(rig: ControllerRig, count: number, prefix = 'row'): void {
  for (let i = 0; i < count; i++) rig.channel.addUserRow(`${prefix}-${i + 1}`);
}

/** Meta builder for direct reducer injections (gap/duplicate scenarios). */
export function rigMeta(rig: ControllerRig, seq: number, at: number): EventMeta {
  return {
    schemaVersion: 1,
    adapterInstanceId: 'rig-adapter',
    durableSessionId: 'rig-session',
    uiSessionGeneration: 'rig-gen',
    resetEpoch: 0,
    sessionEpoch: 'rig-gen:0',
    source: 'session',
    sourceSeq: `inject-${seq}`,
    seq,
    at,
  };
}
