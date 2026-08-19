/**
 * Fake Channel for the WP-04 walking-skeleton tests and the verify script.
 *
 * Implements the `ChannelUiChannel` subset the adapter reads (mutable rows
 * with in-place growth, exactly like the real channel: `row.text += chunk`,
 * `streaming` flips, tool status transitions) plus scripted helpers. No
 * agent, no session log — `submit` echoes a user row and starts an assistant
 * stream that tests drive manually.
 */
import type {
  Channel,
  ChatRow,
  NotificationItem,
  PendingMessage,
  ResumeResult,
  TokenUsage,
} from '../../src/dsh-adapter/channel.js';
import type { ChannelUiChannel } from '../../src/tui-v2/controllers/session-events.js';

export interface FakeChannel extends ChannelUiChannel {
  /** Wake subscribers (channel.subscribe contract: version bump + listener). */
  bump(): void;
  /** Append a user row; returns it. */
  addUserRow(text: string): ChatRow;
  /** Append a streaming assistant row (streaming: true). */
  startAssistant(text?: string): ChatRow;
  /** In-place append to the current streaming assistant row. */
  appendAssistant(chunk: string): void;
  /** Settle the current streaming assistant row (streaming: false). */
  settleAssistant(): void;
  /** Append a tool row in `running` state. */
  addToolRow(name: string, argsText?: string): ChatRow;
  /** Settle a tool row with ok/result text (in-place mutation). */
  settleTool(row: ChatRow, resultText: string): void;
  /** Submitted texts, in order. */
  readonly submitted: readonly string[];
  readonly cancelCount: number;
  /** Scripting hook: runs inside submit() after the user row lands. */
  onSubmit: (() => void) | null;
}

export function createFakeChannel(): FakeChannel {
  let version = 0;
  let rows: ChatRow[] = [];
  let nextRowId = 1;
  let nextSeq = 1;
  let working = false;
  const listeners = new Set<() => void>();
  const submitted: string[] = [];
  let cancelCount = 0;

  const bump = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };

  const pushRow = (partial: Omit<ChatRow, 'id'>): ChatRow => {
    const row: ChatRow = { id: nextRowId++, ...partial };
    rows = [...rows, row];
    bump();
    return row;
  };

  const channel: FakeChannel = {
    get version() {
      return version;
    },
    get rows() {
      return rows;
    },
    get status(): Channel['status'] {
      return working ? ('working' as Channel['status']) : ('idle' as Channel['status']);
    },
    get working() {
      return working;
    },
    get model() {
      return 'fake-model';
    },
    get tokens(): TokenUsage {
      return { input: 0, output: 0 };
    },
    get cwd() {
      return '/fake/cwd';
    },
    get gitBranch() {
      return 'main';
    },
    get notifications(): readonly NotificationItem[] {
      return [];
    },
    get pending(): readonly PendingMessage[] {
      return [];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit(text) {
      submitted.push(text);
      pushRow({ kind: 'user', text, seq: nextSeq++ });
      working = true;
      channel.onSubmit?.();
      bump();
    },
    steer(text) {
      submitted.push(text);
    },
    cancel() {
      cancelCount += 1;
      working = false;
      const streaming = rows.find((row) => row.streaming === true);
      if (streaming !== undefined) streaming.streaming = false;
      bump();
    },
    clear() {
      rows = [];
      bump();
    },
    loadOlder() {
      return 0;
    },
    async newSession() {
      rows = [];
      bump();
      return true;
    },
    async resumeTo(): Promise<ResumeResult> {
      rows = [];
      bump();
      return { ok: true };
    },
    async rewindTo(row: ChatRow) {
      const at = rows.indexOf(row);
      if (at >= 0) rows = rows.slice(0, at + 1);
      bump();
      return null;
    },

    bump,
    addUserRow: (text) => pushRow({ kind: 'user', text, seq: nextSeq++ }),
    startAssistant: (text = '') => {
      working = true;
      return pushRow({ kind: 'assistant', text, streaming: true, seq: nextSeq++ });
    },
    appendAssistant(chunk) {
      const row = rows.find((candidate) => candidate.kind === 'assistant' && candidate.streaming === true);
      if (row === undefined) throw new Error('fake-channel: no streaming assistant row');
      row.text += chunk; // in-place growth, like the real channel
      bump();
    },
    settleAssistant() {
      const row = rows.find((candidate) => candidate.kind === 'assistant' && candidate.streaming === true);
      if (row === undefined) throw new Error('fake-channel: no streaming assistant row');
      row.streaming = false;
      working = false;
      bump();
    },
    addToolRow: (name, argsText = '{}') =>
      pushRow({
        kind: 'tool',
        text: '',
        seq: nextSeq++,
        tool: { callId: `call-${nextRowId}`, name, argsText, status: 'running', startedAt: 0 },
      }),
    settleTool(row, resultText) {
      if (row.tool === undefined) throw new Error('fake-channel: not a tool row');
      row.tool.status = 'ok';
      row.tool.resultText = resultText;
      row.tool.durationMs = 1;
      bump();
    },
    get submitted() {
      return submitted;
    },
    get cancelCount() {
      return cancelCount;
    },
    onSubmit: null,
  };

  return channel;
}
