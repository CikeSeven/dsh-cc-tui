/**
 * Fake Channel for the WP-04 walking-skeleton tests, the WP-05 controller
 * tests and the verify script.
 *
 * Implements the `CoordinatorChannel` surface the coordinator reads (mutable
 * rows with in-place growth, exactly like the real channel: `row.text +=
 * chunk`, `streaming` flips, tool status transitions) plus scripted helpers.
 * No agent, no session log — `submit` echoes a user row and starts an
 * assistant stream that tests drive manually.
 *
 * WP-05 additions:
 *  - a real `pending` queue (steer while working enqueues placement 'steer';
 *    interruptAndDeliver drains it) and a notifications list (`notify`),
 *  - a folded-history pool (`foldedPool`) restored by `loadOlder` as a
 *    PREPEND of `restored: true` rows,
 *  - scriptable async session ops: newSession/resumeTo/rewindTo/promptRewind
 *    all await a microtask first so the adapter's async withReset path is
 *    genuinely exercised; results/rows are scriptable,
 *  - scriptable command surfaces: commandList/runExternalCommand, workspace,
 *    model/preset/effort and settings capability seams.
 */
import type {
  Channel,
  ChatRow,
  EffortOption,
  NotificationItem,
  PendingMessage,
  PresetOption,
  ResumeResult,
  TokenUsage,
} from '../../src/dsh-adapter/channel.js';
import type { TuiRewindMode } from '../../src/dsh-adapter/extension-events.js';
import type { PreviewEntry, SessionSummary } from '../../src/dsh-adapter/sessions/index.js';
import type {
  TuiWorkspaceCommand,
  TuiWorkspaceCommandResult,
  TuiWorkspaceTarget,
} from '../../src/dsh-adapter/workspaces.js';
import type { LocalCommand } from '../../src/commands.js';
import type { CoordinatorChannel } from '../../src/tui-v2/app/coordinator.js';

export interface FakeChannel extends CoordinatorChannel {
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
  /** Settle a tool row with an error (in-place mutation). */
  failTool(row: ChatRow, errorText: string): void;
  /** Flip the working flag without touching rows. */
  setWorking(value: boolean): void;
  /** Submitted/steered texts, in order. */
  readonly submitted: readonly string[];
  readonly cancelCount: number;
  readonly interruptCount: number;
  /** Texts delivered through interruptAndDeliver. */
  readonly interruptedTexts: readonly string[];
  /** notify() calls, in order. */
  readonly notifyLog: readonly { text: string; color?: 'error' | 'warning' | 'success' }[];
  /** pushLocal() calls, in order. */
  readonly localReports: readonly { title: string; lines: readonly string[] }[];
  /** Folded older history (oldest first); loadOlder prepends from the END. */
  foldedPool: ChatRow[];
  /** Max rows restored per loadOlder call (default: all of foldedPool). */
  loadOlderBatch: number;
  /** Scripting hooks. */
  onSubmit: (() => void) | null;
  newSessionResult: boolean;
  resumeResult: ResumeResult;
  /** Rows installed by resumeTo (default: keep current rows). */
  resumeRows: ChatRow[] | null;
  promptRewindResult: { modes: readonly TuiRewindMode[] } | 'cancel' | null;
  sessionSummaries: SessionSummary[];
  sessionPreviews: Map<string, readonly PreviewEntry[]>;
  workspaceTargets: TuiWorkspaceTarget[];
  modelOptions: Array<{ provider: string; id: string; name: string; description?: string; inputModalities?: readonly ('text' | 'image')[] }>;
  presetOptions: PresetOption[];
  effortOptions: EffortOption[];
  defaultEffort: string | undefined;
  modelSwitches: Array<[string, string]>;
  presetSwitches: string[];
  effortSwitches: string[];
  commandList: LocalCommand[];
  runExternalCommand: (name: string, rawInput: string) => Promise<string | undefined>;
  workspaceCommands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[];
  runWorkspaceCommand(name: string, input: string, signal?: AbortSignal): Promise<TuiWorkspaceCommandResult | undefined>;
  switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean>;
}

export function createFakeChannel(): FakeChannel {
  let version = 0;
  let rows: ChatRow[] = [];
  let nextRowId = 1;
  let nextSeq = 1;
  let working = false;
  let nextNotificationId = 1;
  let nextPendingId = 1;
  let notifications: NotificationItem[] = [];
  let pending: PendingMessage[] = [];
  let currentProvider = 'fake-provider';
  let currentModel = 'fake-model';
  let currentPreset: string | undefined = 'standard';
  let currentEffort: string | undefined = 'high';
  const listeners = new Set<() => void>();
  const settingsSectionListeners = new Set<() => void>();
  const submitted: string[] = [];
  let cancelCount = 0;
  let interruptCount = 0;
  const interruptedTexts: string[] = [];
  const notifyLog: { text: string; color?: 'error' | 'warning' | 'success' }[] = [];
  const localReports: { title: string; lines: readonly string[] }[] = [];

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
    get provider() {
      return currentProvider;
    },
    get model() {
      return currentModel;
    },
    get reasoningEffort() {
      return currentEffort;
    },
    get agentPreset() {
      return currentPreset;
    },
    get tokens(): TokenUsage {
      return { input: 0, output: 0 };
    },
    get cwd() {
      return '/fake/cwd';
    },
    get agentId() {
      return 'fake-current-session';
    },
    get gitBranch() {
      return 'main';
    },
    get notifications(): readonly NotificationItem[] {
      return notifications;
    },
    get pending(): readonly PendingMessage[] {
      return pending;
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
      // The real channel queues messages submitted mid-turn.
      if (working) {
        pending = [...pending, { id: `p${nextPendingId++}`, text, placement: 'steer' }];
        bump();
      }
    },
    cancel() {
      cancelCount += 1;
      working = false;
      const streaming = rows.find((row) => row.streaming === true);
      if (streaming !== undefined) streaming.streaming = false;
      bump();
    },
    interruptAndDeliver(texts) {
      interruptCount += 1;
      interruptedTexts.push(...texts);
      const delivered = new Set(texts);
      const claimed = pending.filter((message) => delivered.has(message.text)).length;
      pending = [];
      working = false;
      const streaming = rows.find((row) => row.streaming === true);
      if (streaming !== undefined) streaming.streaming = false;
      bump();
      return claimed;
    },
    clear() {
      rows = [];
      bump();
    },
    loadOlder() {
      if (channel.foldedPool.length === 0) return 0;
      const count = Math.min(channel.loadOlderBatch, channel.foldedPool.length);
      const restoredRows = channel.foldedPool.splice(channel.foldedPool.length - count, count);
      // loadOlder lands as a PREPEND (structural break → adapter snapshot-gap
      // reset); restored rows carry the marker like the real channel's.
      rows = [...restoredRows.map((row) => ({ ...row, restored: true })), ...rows];
      bump();
      return count;
    },
    // Async session ops await a microtask first so the adapter's async
    // withReset path (suspend-until-settle) is genuinely exercised.
    async newSession() {
      await Promise.resolve();
      if (!channel.newSessionResult) return false;
      rows = [];
      pending = [];
      bump();
      return true;
    },
    async resumeTo(): Promise<ResumeResult> {
      await Promise.resolve();
      if (!channel.resumeResult.ok) return channel.resumeResult;
      if (channel.resumeRows !== null) {
        rows = channel.resumeRows;
      }
      pending = [];
      bump();
      return channel.resumeResult;
    },
    async rewindTo(row: ChatRow, _mode?: string | null) {
      await Promise.resolve();
      const at = rows.indexOf(row);
      if (at < 0) return null;
      // Rewind THROUGH the message: it leaves the transcript and its text
      // goes back to the editor draft.
      rows = rows.slice(0, at);
      bump();
      return String(row.text ?? '');
    },
    async promptRewind(_row: ChatRow) {
      await Promise.resolve();
      return channel.promptRewindResult;
    },
    notify(text, options = {}) {
      const item: NotificationItem = {
        id: nextNotificationId++,
        text,
        ...(options.color !== undefined ? { color: options.color } : {}),
        timeoutMs: options.timeoutMs ?? 4000,
      };
      notifications = [...notifications, item];
      notifyLog.push({ text, ...(options.color !== undefined ? { color: options.color } : {}) });
      bump();
      return () => {
        notifications = notifications.filter((candidate) => candidate.id !== item.id);
        bump();
      };
    },
    pushLocal(title, lines) {
      localReports.push({ title, lines });
      pushRow({ kind: 'local', text: title });
      for (const line of lines) {
        pushRow({ kind: 'local-output', text: line });
      }
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
    failTool(row, errorText) {
      if (row.tool === undefined) throw new Error('fake-channel: not a tool row');
      row.tool.status = 'error';
      row.tool.errorText = errorText;
      bump();
    },
    setWorking(value) {
      working = value;
      bump();
    },
    get submitted() {
      return submitted;
    },
    get cancelCount() {
      return cancelCount;
    },
    get interruptCount() {
      return interruptCount;
    },
    get interruptedTexts() {
      return interruptedTexts;
    },
    get notifyLog() {
      return notifyLog;
    },
    get localReports() {
      return localReports;
    },
    foldedPool: [],
    loadOlderBatch: Number.POSITIVE_INFINITY,
    onSubmit: null,
    newSessionResult: true,
    resumeResult: { ok: true },
    resumeRows: null,
    promptRewindResult: null,
    sessionSummaries: [],
    sessionPreviews: new Map(),
    workspaceTargets: [],
    modelOptions: [
      { provider: 'fake-provider', id: 'fake-model', name: 'Fake Model', inputModalities: ['text'] },
      { provider: 'fake-provider', id: 'fake-model-pro', name: 'Fake Model Pro', description: 'Larger fake model', inputModalities: ['text', 'image'] },
    ],
    presetOptions: [
      { id: 'standard', name: 'Standard', isDefault: true },
      { id: 'minimal', name: 'Minimal', description: 'Minimal tool set', isDefault: false },
    ],
    effortOptions: [
      { id: 'off', name: 'Off' },
      { id: 'high', name: 'High' },
      { id: 'max', name: 'Max' },
    ],
    defaultEffort: 'high',
    modelSwitches: [],
    presetSwitches: [],
    effortSwitches: [],
    commandList: [],
    async runExternalCommand() {
      return undefined;
    },
    async listSessions(signal) {
      signal?.throwIfAborted();
      return channel.sessionSummaries.map((summary) => ({ ...summary }));
    },
    async previewSession(sessionId, signal) {
      signal?.throwIfAborted();
      return [...(channel.sessionPreviews.get(sessionId) ?? [])];
    },
    async deleteSession(sessionId) {
      const before = channel.sessionSummaries.length;
      channel.sessionSummaries = channel.sessionSummaries.filter((summary) => summary.id !== sessionId);
      return channel.sessionSummaries.length !== before;
    },
    async renameSessionTo(sessionId, title) {
      const index = channel.sessionSummaries.findIndex((summary) => summary.id === sessionId);
      const summary = channel.sessionSummaries[index];
      if (summary === undefined) return false;
      channel.sessionSummaries[index] = { ...summary, title: { text: title, source: 'renamed' } };
      return true;
    },
    async listWorkspaces(signal) {
      signal?.throwIfAborted();
      return [...channel.workspaceTargets];
    },
    async resolveWorkspace(reference, signal) {
      signal?.throwIfAborted();
      return channel.workspaceTargets.find((target) => target.uri === reference || target.cwd === reference);
    },
    async renameWorkspace() {
      return true;
    },
    workspaceCommands() {
      return [];
    },
    async runWorkspaceCommand() {
      return undefined;
    },
    async switchWorkspace() {
      return true;
    },
    async listModels() {
      return channel.modelOptions.map((model) => ({ ...model }));
    },
    async switchModel(provider, model) {
      channel.modelSwitches.push([provider, model]);
      currentProvider = provider;
      currentModel = model;
      bump();
      return true;
    },
    async listPresets() {
      return channel.presetOptions.map((preset) => ({ ...preset }));
    },
    async switchPreset(id) {
      channel.presetSwitches.push(id);
      const preset = channel.presetOptions.find((candidate) => candidate.id === id);
      if (preset === undefined || preset.broken !== undefined) return false;
      currentPreset = id;
      bump();
      return true;
    },
    async listEfforts() {
      return { efforts: channel.effortOptions.map((effort) => ({ ...effort })), defaultEffort: channel.defaultEffort };
    },
    async setEffort(id) {
      channel.effortSwitches.push(id);
      if (!channel.effortOptions.some((effort) => effort.id === id)) return false;
      currentEffort = id;
      bump();
      return true;
    },
    settingsHost() {
      return undefined;
    },
    settingsSections() {
      return [];
    },
    subscribeSettingsSections(listener) {
      settingsSectionListeners.add(listener);
      return () => settingsSectionListeners.delete(listener);
    },
  };

  return channel;
}
