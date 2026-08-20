/**
 * WP-05b dialogs controller: approval/question/plugin-dialog overlay
 * priority, input capture, cancel/timeout paths and live/replay equivalence.
 *
 * Coverage:
 *  - approval open → navigate → Enter/quick-key decide; fail-closed Esc/Ctrl+C;
 *  - cross-store priority (approval > plugin-dialog > question, ported from the
 *    legacy Chat.tsx chrome ternary) with preemption + re-open, and the focus
 *    fallback chain (dialog → next capturing overlay → editor);
 *  - question single/multi-select answers, batch advance, optionless custom
 *    text, Esc → ASK_CANCELLED; harness abort → ASK_ABORTED;
 *  - plugin select/confirm/input answers, paste flattening, keyed cancel and
 *    clock-driven timeout (settle → close → focus fallback);
 *  - captureInput normalization ({captureInput:true, nonCapturing:false}) and
 *    schema rejection of contradictory combinations;
 *  - the overlay AppEvent sequence (source 'overlay', revision monotonic);
 *  - live/replay canonical equivalence over a mixed dialog scenario;
 *  - dispose semantics (unsubscribed + inert);
 *  - the minimal overlay components render payload-only, within width.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serializeCanonicalUiState } from '../../src/tui-v2/model/canonical-state.js';
import { validateAppEvent, type AppEvent } from '../../src/tui-v2/model/events.js';
import {
  parseDialogOverlayPayload,
  type ApprovalDialogPayload,
  type DialogOverlayPayload,
  type PluginDialogPayload,
  type QuestionDialogPayload,
} from '../../src/tui-v2/model/overlay-payloads.js';
import { createReducer } from '../../src/tui-v2/model/reducer.js';
import { validateOverlayState, type OverlayState } from '../../src/tui-v2/model/schema.js';
import { normalizeOverlayOptions } from '../../src/tui-v2/renderer/component.js';
import { measureLineWidth } from '../../src/tui-v2/renderer/lines.js';
import { createApprovalDialog } from '../../src/tui-v2/components/overlays/approval-dialog.js';
import { createPluginDialog } from '../../src/tui-v2/components/overlays/plugin-dialog.js';
import { createQuestionDialog } from '../../src/tui-v2/components/overlays/question-dialog.js';
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js';
import {
  createDialogsController,
  type ApprovalStoreLike,
  type DialogsController,
} from '../../src/tui-v2/controllers/dialogs.js';
import { replayTrace } from '../../src/tui-v2/controllers/replay.js';
import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js';
import type { TerminalInputEvent } from '../../src/tui-v2/terminal/input.js';
import {
  createControllerRig,
  ManualClock,
  addUserRows,
  type ControllerRig,
} from './helpers/controller-rig.js';
import {
  createFakeApprovalStore,
  createFakePluginDialogStore,
  createFakeQuestionStore,
  type FakeApprovalStore,
  type FakePluginDialogStore,
  type FakeQuestionStore,
} from './helpers/fake-dialog-stores.js';

const THEME = DEFAULT_COMPONENT_THEME;
const PROFILE = unknownConservativeDefaults();

// ---------------------------------------------------------------------------
// rig + event helpers
// ---------------------------------------------------------------------------

interface DialogsRig {
  readonly rig: ControllerRig;
  readonly controller: DialogsController;
  readonly approvals: FakeApprovalStore;
  readonly questions: FakeQuestionStore;
  readonly dialogs: FakePluginDialogStore;
}

function dialogsRig(onQuestionSummary?: (title: string, lines: readonly string[]) => void): DialogsRig {
  const rig = createControllerRig({ height: 8 });
  const approvals = createFakeApprovalStore();
  const questions = createFakeQuestionStore();
  const dialogs = createFakePluginDialogStore(rig.clock);
  const controller = createDialogsController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
    getState: rig.state,
    approvals,
    questions,
    dialogs,
    ...(onQuestionSummary !== undefined ? { onQuestionSummary } : {}),
  });
  controller.start();
  return { rig, controller, approvals, questions, dialogs };
}

function keyEvent(key: string): TerminalInputEvent {
  return { kind: 'key', sequence: 0, generation: 0, payload: { key, raw: '', text: null, eventType: 'press' } };
}

function charEvent(ch: string): TerminalInputEvent {
  return { kind: 'key', sequence: 0, generation: 0, payload: { key: null, raw: ch, text: ch, eventType: 'press' } };
}

function pasteEvent(text: string): TerminalInputEvent {
  return { kind: 'paste', sequence: 0, generation: 0, payload: { text } };
}

/** The focused overlayId, or null when the editor holds focus. */
function focusedOverlay(rig: ControllerRig): string | null {
  const focus = rig.state().focus;
  return focus.target === 'overlay' ? focus.overlayId : null;
}

/** Parsed payload of the topmost overlay on the stack. */
function topPayload(rig: ControllerRig): DialogOverlayPayload {
  const stack = rig.state().overlays.stack;
  const overlay = stack[stack.length - 1];
  assert.ok(overlay !== undefined, 'an overlay is on the stack');
  const payload = parseDialogOverlayPayload(overlay.payload);
  assert.ok(payload !== null, 'payload parses as a dialog payload');
  return payload;
}

/** Overlay events among the applied stream, in applied order. */
function overlayEvents(rig: ControllerRig): AppEvent[] {
  return rig.applied.filter((event) => event.type === 'overlay/open' || event.type === 'overlay/close');
}

function replayEquivalence(rig: ControllerRig): void {
  const replayed = replayTrace(rig.applied, createReducer({ clock: new ManualClock() }), rig.initialState);
  assert.equal(
    serializeCanonicalUiState(replayed),
    serializeCanonicalUiState(rig.state()),
    'live/replay canonical state must be byte-identical',
  );
}

// ---------------------------------------------------------------------------
// approval
// ---------------------------------------------------------------------------

test('controller dialogs: approval open, navigate, Enter decide; close falls back to editor', async () => {
  const { rig, controller, approvals } = dialogsRig();
  const outcome = approvals.park({ toolName: 'Bash', command: 'ls -la', reason: 'needs shell' });

  // Opened synchronously on park (store emit → sync → overlay/open).
  assert.equal(focusedOverlay(rig), 'dialog/approval/1');
  assert.equal(controller.activeOverlayId(), 'dialog/approval/1');
  const opened = topPayload(rig);
  assert.equal(opened.kind, 'approval');
  if (opened.kind === 'approval') {
    assert.equal(opened.toolName, 'Bash');
    assert.equal(opened.command, 'ls -la');
    assert.equal(opened.selection.focusIndex, 0);
  }
  const overlay = rig.state().overlays.stack[0];
  assert.ok(overlay !== undefined);
  assert.equal(overlay.captureInput, true);
  assert.equal(overlay.nonCapturing, false);
  assert.equal(overlay.revision, 1);

  // Navigation republishes with a bumped revision and updated selection.
  controller.handleInput(keyEvent('down'));
  const moved = topPayload(rig);
  assert.equal(moved.selection.focusIndex, 1);
  assert.equal(rig.state().overlays.stack[0]?.revision, 2);

  // Enter decides the focused outcome (No) → store settles → close → editor.
  controller.handleInput(keyEvent('enter'));
  assert.equal(await outcome, 'rejected');
  assert.equal(rig.state().overlays.stack.length, 0);
  assert.deepEqual(rig.state().focus, { target: 'editor', overlayId: null });

  // The AppEvent sequence: open, revision-bumped open, close — all 'overlay'.
  const events = overlayEvents(rig);
  assert.deepEqual(
    events.map((event) => event.type),
    ['overlay/open', 'overlay/open', 'overlay/close'],
  );
  for (const event of events) assert.equal(event.source, 'overlay');
  assert.deepEqual(controller.diagnostics(), {
    opened: 1,
    closed: 1,
    preempted: 0,
    revisionBumps: 1,
    decisions: 1,
    cancels: 0,
    staleInput: 0,
    ignoredInput: 0,
  });
  replayEquivalence(rig);
});

test('controller dialogs: approval quick keys 1/2 and fail-closed Esc/Ctrl+C', async () => {
  const { rig, controller, approvals } = dialogsRig();

  const first = approvals.park({ toolName: 'Bash' });
  controller.handleInput(charEvent('1'));
  assert.equal(await first, 'allowed-once');
  assert.equal(rig.state().overlays.stack.length, 0);

  const second = approvals.park({ toolName: 'Write' });
  assert.equal(focusedOverlay(rig), 'dialog/approval/2');
  controller.handleInput(charEvent('2'));
  assert.equal(await second, 'rejected');

  // Esc rejects (fail closed), Ctrl+C rejects; both close the overlay.
  const third = approvals.park({ toolName: 'Bash' });
  controller.handleInput(keyEvent('escape'));
  assert.equal(await third, 'rejected');
  assert.equal(rig.state().overlays.stack.length, 0);
  const fourth = approvals.park({ toolName: 'Bash' });
  controller.handleInput(keyEvent('ctrl+c'));
  assert.equal(await fourth, 'rejected');
  assert.deepEqual(rig.state().focus, { target: 'editor', overlayId: null });
  assert.equal(controller.diagnostics().cancels, 2);
  replayEquivalence(rig);
});

// ---------------------------------------------------------------------------
// priority / preemption
// ---------------------------------------------------------------------------

test('controller dialogs: priority approval > plugin-dialog > question; preempt and re-open', async () => {
  const { rig, controller, approvals, questions, dialogs } = dialogsRig();

  // Question first: it owns the overlay while nothing outranks it.
  const questionPromise = questions.ask({
    questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'a' }, { label: 'b' }] }],
  });
  assert.equal(focusedOverlay(rig), 'dialog/question/1-0');

  // A plugin dialog outranks the question: preempt (close question, open
  // plugin). The question ask stays parked in its store.
  const selectPromise = dialogs.ask({
    kind: 'select',
    title: 'Choose',
    options: [
      { id: 'opt-1', label: 'One' },
      { id: 'opt-2', label: 'Two' },
    ],
  });
  assert.equal(focusedOverlay(rig), 'dialog/plugin-dialog/dlg-1');
  assert.deepEqual(
    overlayEvents(rig).map((event) => event.type),
    ['overlay/open', 'overlay/close', 'overlay/open'],
  );

  // An approval outranks both: preempt again.
  const approvalPromise = approvals.park({ toolName: 'Bash' });
  assert.equal(focusedOverlay(rig), 'dialog/approval/1');
  assert.equal(rig.state().overlays.stack.length, 1, 'at most one managed dialog on the stack');

  // Settle the approval → the plugin dialog is re-opened (fresh interaction).
  controller.handleInput(charEvent('1'));
  assert.equal(await approvalPromise, 'allowed-once');
  assert.equal(focusedOverlay(rig), 'dialog/plugin-dialog/dlg-1');

  // Settle the plugin dialog → the question is re-opened.
  controller.handleInput(keyEvent('down'));
  controller.handleInput(keyEvent('enter'));
  assert.equal(await selectPromise, 'opt-2');
  assert.equal(focusedOverlay(rig), 'dialog/question/1-0');

  // Answer the question → stack empty, focus back with the editor.
  controller.handleInput(keyEvent('enter'));
  const answered = await questionPromise;
  assert.deepEqual(answered.answers, [{ id: 'q1', selected: ['a'] }]);
  assert.equal(rig.state().overlays.stack.length, 0);
  assert.deepEqual(rig.state().focus, { target: 'editor', overlayId: null });

  const diagnostics = controller.diagnostics();
  assert.equal(diagnostics.opened, 5); // question, plugin, approval, plugin, question
  assert.equal(diagnostics.closed, 5);
  assert.equal(diagnostics.preempted, 2); // plugin over question, approval over plugin
  replayEquivalence(rig);
});

// ---------------------------------------------------------------------------
// question
// ---------------------------------------------------------------------------

test('controller dialogs: question batch advance and multi-select toggle', async () => {
  const { rig, controller, questions } = dialogsRig();
  const promise = questions.ask({
    questions: [
      { id: 'q1', question: 'Single', options: [{ label: 'a' }, { label: 'b' }] },
      { id: 'q2', question: 'Multi', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] },
    ],
  });

  // q1: single-select, down + Enter answers the focused label.
  assert.equal(focusedOverlay(rig), 'dialog/question/1-0');
  controller.handleInput(keyEvent('down'));
  controller.handleInput(keyEvent('enter'));

  // q2 opens under a new key (batchId-index), progress carried in the payload.
  assert.equal(focusedOverlay(rig), 'dialog/question/1-1');
  const q2 = topPayload(rig);
  assert.equal(q2.kind, 'question');
  if (q2.kind === 'question') {
    assert.equal(q2.position, 2);
    assert.equal(q2.total, 2);
    assert.equal(q2.answered, 1);
    assert.equal(q2.multiSelect, true);
  }

  // Space toggles the focused row; Enter with nothing checked is a no-op.
  controller.handleInput(keyEvent('enter'));
  assert.equal(focusedOverlay(rig), 'dialog/question/1-1', 'empty multi-select submit ignored');
  controller.handleInput(charEvent(' '));
  controller.handleInput(keyEvent('down'));
  controller.handleInput(charEvent(' '));
  const checkedPayload = topPayload(rig);
  assert.deepEqual(checkedPayload.selection.checked, [0, 1]);
  controller.handleInput(keyEvent('enter'));

  const answered = await promise;
  assert.deepEqual(answered.answers, [
    { id: 'q1', selected: ['b'] },
    { id: 'q2', selected: ['x', 'y'] },
  ]);
  assert.equal(rig.state().overlays.stack.length, 0);
  assert.deepEqual(rig.state().focus, { target: 'editor', overlayId: null });
  replayEquivalence(rig);
});

test('controller dialogs: optionless question custom text; Esc rejects ASK_CANCELLED', async () => {
  const { rig, controller, questions } = dialogsRig();

  const promise = questions.ask({ questions: [{ id: 'free', question: 'Say something' }] });
  const payload = topPayload(rig);
  assert.equal(payload.kind, 'question');
  if (payload.kind === 'question') assert.equal(payload.options.length, 0);

  controller.handleInput(charEvent('h'));
  controller.handleInput(charEvent('i'));
  controller.handleInput(keyEvent('backspace'));
  controller.handleInput(charEvent('i'));
  assert.equal(topPayload(rig).selection.text, 'hi');
  controller.handleInput(keyEvent('enter'));
  const answered = await promise;
  assert.deepEqual(answered.answers, [{ id: 'free', selected: [], custom: 'hi' }]);
  assert.deepEqual(rig.state().focus, { target: 'editor', overlayId: null });

  // Esc on a fresh ask: user cancel propagates the ASK_CANCELLED code.
  const cancelled = questions.ask({ questions: [{ id: 'x', question: 'again?' }] });
  const assertion = assert.rejects(cancelled, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ASK_CANCELLED');
    return true;
  });
  controller.handleInput(keyEvent('escape'));
  await assertion;
  assert.equal(rig.state().overlays.stack.length, 0);
  assert.equal(controller.diagnostics().cancels, 1);
  replayEquivalence(rig);
});

// ---------------------------------------------------------------------------
// plugin dialogs
// ---------------------------------------------------------------------------

test('controller dialogs: plugin select/confirm/input answers and keyed cancel', async () => {
  const { rig, controller, dialogs } = dialogsRig();

  // select: down + Enter settles the option id.
  const select = dialogs.ask({
    kind: 'select',
    title: 'Pick',
    options: [
      { id: 'opt-1', label: 'One' },
      { id: 'opt-2', label: 'Two', description: 'second' },
    ],
  });
  assert.equal(focusedOverlay(rig), 'dialog/plugin-dialog/dlg-1');
  controller.handleInput(keyEvent('down'));
  controller.handleInput(keyEvent('enter'));
  assert.equal(await select, 'opt-2');

  // confirm: Enter on the default focus = confirm label (true); ← + Enter = cancel label (false).
  const confirmYes = dialogs.ask({ kind: 'confirm', title: 'Sure?', confirmLabel: 'Yes', cancelLabel: 'No' });
  controller.handleInput(keyEvent('enter'));
  assert.equal(await confirmYes, true);
  const confirmNo = dialogs.ask({ kind: 'confirm', title: 'Sure?', confirmLabel: '', cancelLabel: '' });
  controller.handleInput(keyEvent('left'));
  controller.handleInput(keyEvent('enter'));
  assert.equal(await confirmNo, false);

  // input: draft seeded from initial, Backspace + printable edits, Enter settles.
  const input = dialogs.ask({ kind: 'input', title: 'Name', initial: 'seed', placeholder: 'type here' });
  const inputPayload = topPayload(rig);
  assert.equal(inputPayload.kind, 'plugin-dialog');
  if (inputPayload.kind === 'plugin-dialog') assert.equal(inputPayload.selection.text, 'seed');
  controller.handleInput(keyEvent('backspace'));
  controller.handleInput(keyEvent('backspace'));
  controller.handleInput(charEvent('d'));
  controller.handleInput(keyEvent('enter'));
  assert.equal(await input, 'sed');

  // input: a bracketed paste flattens newlines; Esc cancels (undefined).
  const pasted = dialogs.ask({ kind: 'input', title: 'Paste', initial: '' });
  controller.handleInput(pasteEvent('a\nb'));
  assert.equal(topPayload(rig).selection.text, 'a b');
  controller.handleInput(keyEvent('escape'));
  assert.equal(await pasted, undefined);
  assert.equal(rig.state().overlays.stack.length, 0);
  assert.deepEqual(rig.state().focus, { target: 'editor', overlayId: null });
  replayEquivalence(rig);
});

test('controller dialogs: plugin dialog timeout settles, closes and falls back to editor', async () => {
  const { rig, controller, dialogs } = dialogsRig();
  const promise = dialogs.ask(
    { kind: 'select', title: 'Timed', options: [{ id: 'a', label: 'A' }] },
    1000,
  );
  assert.equal(focusedOverlay(rig), 'dialog/plugin-dialog/dlg-1');

  rig.clock.advance(999);
  assert.equal(focusedOverlay(rig), 'dialog/plugin-dialog/dlg-1', 'not yet timed out');
  rig.clock.advance(2);
  assert.equal(await promise, undefined, 'timeout resolves the cancelled value');
  assert.equal(rig.state().overlays.stack.length, 0, 'timeout path closes the overlay');
  assert.deepEqual(rig.state().focus, { target: 'editor', overlayId: null });
  assert.deepEqual(controller.diagnostics(), {
    opened: 1,
    closed: 1,
    preempted: 0,
    revisionBumps: 0,
    decisions: 0,
    cancels: 0,
    staleInput: 0,
    ignoredInput: 0,
  });
  replayEquivalence(rig);
});

test('controller dialogs: harness abort closes approval and question overlays', async () => {
  const { rig, controller, approvals, questions } = dialogsRig();

  const approval = approvals.park({ toolName: 'Bash' });
  assert.equal(focusedOverlay(rig), 'dialog/approval/1');
  approvals.abortActive();
  assert.equal(await approval, 'cancelled');
  assert.equal(rig.state().overlays.stack.length, 0);

  const question = questions.ask({ questions: [{ id: 'q', question: 'abort me' }] });
  const assertion = assert.rejects(question, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ASK_ABORTED');
    return true;
  });
  assert.equal(focusedOverlay(rig), 'dialog/question/1-0');
  questions.abortActive();
  await assertion;
  assert.equal(rig.state().overlays.stack.length, 0);
  assert.deepEqual(rig.state().focus, { target: 'editor', overlayId: null });
  assert.equal(controller.diagnostics().decisions, 0, 'aborts are not user decisions');
  replayEquivalence(rig);
});

// ---------------------------------------------------------------------------
// focus interop with foreign overlays
// ---------------------------------------------------------------------------

test('controller dialogs: a foreign overlay above steals focus; its close falls back to the dialog', async () => {
  const { rig, controller, questions } = dialogsRig();
  const promise = questions.ask({
    questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'a' }, { label: 'b' }] }],
  });
  const questionOverlayId = focusedOverlay(rig);
  assert.equal(questionOverlayId, 'dialog/question/1-0');

  // A foreign capturing overlay (WP-06+ producer) lands on top and takes focus.
  const foreign: OverlayState = {
    overlayId: 'foreign/picker',
    revision: 1,
    anchor: 'center',
    visible: true,
    captureInput: true,
    nonCapturing: false,
    payload: { note: 'not a dialog' },
  };
  rig.streaming.ingest({ ...rig.meta.next('overlay', 'foreign-open-1'), type: 'overlay/open', overlay: foreign });
  assert.equal(focusedOverlay(rig), 'foreign/picker');

  // Keys routed to the dialogs controller while a foreign overlay holds focus
  // are stale: counted, no state change, no store call.
  controller.handleInput(keyEvent('down'));
  assert.equal(controller.diagnostics().staleInput, 1);
  const questionOverlay = rig.state().overlays.stack.find((o) => o.overlayId === 'dialog/question/1-0');
  assert.ok(questionOverlay !== undefined, 'the dialog overlay is still on the stack');
  const questionPayload = parseDialogOverlayPayload(questionOverlay.payload);
  assert.ok(questionPayload !== null);
  assert.equal(questionPayload.selection.focusIndex, 0);

  // Closing the foreign overlay falls back to the next capturing overlay:
  // the still-open dialog. Esc then cancels the question normally.
  rig.streaming.ingest({ ...rig.meta.next('overlay', 'foreign-close-1'), type: 'overlay/close', overlayId: 'foreign/picker' });
  assert.equal(focusedOverlay(rig), questionOverlayId);
  const assertion = assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ASK_CANCELLED');
    return true;
  });
  controller.handleInput(keyEvent('escape'));
  await assertion;
  assert.deepEqual(rig.state().focus, { target: 'editor', overlayId: null });
  replayEquivalence(rig);
});

// ---------------------------------------------------------------------------
// schema normalization + event hygiene
// ---------------------------------------------------------------------------

test('controller dialogs: captureInput normalization and contradictory-combo rejection', () => {
  const { rig, approvals } = dialogsRig();
  void approvals.park({ toolName: 'Bash' }).then(() => {});

  // Every controller-published dialog overlay is explicitly capturing.
  for (const event of overlayEvents(rig)) {
    if (event.type !== 'overlay/open') continue;
    assert.equal(event.overlay.captureInput, true);
    assert.equal(event.overlay.nonCapturing, false);
    // Ingress validation already ran; re-assert at the boundary contract.
    validateOverlayState(event.overlay);
  }

  // §5.1 normalization: captureInput === !nonCapturing is derived, and
  // contradictory combinations are rejected at schema validation.
  const base = {
    overlayId: 'x',
    revision: 0,
    anchor: 'center' as const,
    visible: true,
    payload: {},
  };
  assert.throws(
    () => validateOverlayState({ ...base, captureInput: true, nonCapturing: true }),
    /negation/,
  );
  assert.throws(
    () => validateOverlayState({ ...base, captureInput: false, nonCapturing: false }),
    /negation/,
  );
  const normalized = normalizeOverlayOptions({
    overlayId: 'x',
    revision: 1,
    payload: {},
    options: { nonCapturing: true },
    termWidth: 80,
    termHeight: 24,
  });
  assert.equal(normalized.captureInput, false);
  assert.equal(normalized.nonCapturing, true);
  const capturing = normalizeOverlayOptions({
    overlayId: 'x',
    revision: 1,
    payload: {},
    options: {},
    termWidth: 80,
    termHeight: 24,
  });
  assert.equal(capturing.captureInput, true);
  assert.equal(capturing.nonCapturing, false);
});

test('controller dialogs: overlay events re-validate after JSONL round-trip', () => {
  const { rig, controller, approvals } = dialogsRig();
  const promise = approvals.park({ toolName: 'Bash', command: 'ls' });
  controller.handleInput(keyEvent('down'));
  controller.handleInput(keyEvent('enter'));
  return promise.then(() => {
    // Every dialog event survives the trace round-trip (JSONL fixture shape).
    for (const event of overlayEvents(rig)) {
      const reparsed = validateAppEvent(JSON.parse(JSON.stringify(event)));
      assert.deepEqual(reparsed, event);
    }
    // Revisions are monotonic per overlayId across the whole stream.
    const revisions = new Map<string, number>();
    for (const event of overlayEvents(rig)) {
      if (event.type !== 'overlay/open') continue;
      const previous = revisions.get(event.overlay.overlayId) ?? 0;
      assert.ok(event.overlay.revision > previous, 'revision strictly increases');
      revisions.set(event.overlay.overlayId, event.overlay.revision);
    }
  });
});

// ---------------------------------------------------------------------------
// live/replay equivalence over a mixed scenario
// ---------------------------------------------------------------------------

test('controller dialogs: mixed live scenario replays byte-identical', async () => {
  const { rig, controller, approvals, questions, dialogs } = dialogsRig();
  addUserRows(rig, 2);

  // Approval: navigate + decide.
  const approval = approvals.park({ toolName: 'Bash', command: 'rm -rf /tmp/x' });
  controller.handleInput(keyEvent('down'));
  controller.handleInput(keyEvent('up'));
  controller.handleInput(charEvent('1'));
  assert.equal(await approval, 'allowed-once');

  // Plugin dialog decided, then one that times out.
  const select = dialogs.ask({ kind: 'select', title: 'T', options: [{ id: 'o', label: 'O' }] });
  controller.handleInput(keyEvent('enter'));
  assert.equal(await select, 'o');
  const timed = dialogs.ask({ kind: 'confirm', title: 'T2', confirmLabel: '', cancelLabel: '' }, 500);
  rig.clock.advance(500);
  assert.equal(await timed, undefined);

  // Question answered, then one cancelled.
  const answered = questions.ask({
    questions: [{ id: 'q1', question: 'Q', options: [{ label: 'a' }, { label: 'b' }] }],
  });
  controller.handleInput(keyEvent('down'));
  controller.handleInput(keyEvent('enter'));
  await answered;
  const cancelled = questions.ask({ questions: [{ id: 'q2', question: 'Q2' }] });
  const rejection = assert.rejects(cancelled, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ASK_CANCELLED');
    return true;
  });
  controller.handleInput(keyEvent('ctrl+c'));
  await rejection;

  assert.equal(rig.state().overlays.stack.length, 0);
  replayEquivalence(rig);
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

test('controller dialogs: dispose unsubscribes every store and goes inert', async () => {
  const { rig, controller, approvals, questions, dialogs } = dialogsRig();
  const before = rig.applied.length;
  controller.dispose();
  assert.equal(approvals.listenerCount, 0);
  assert.equal(questions.listenerCount, 0);
  assert.equal(dialogs.listenerCount, 0);

  // Store activity after dispose produces no events and no overlay.
  const parked = approvals.park({ toolName: 'Bash' });
  assert.equal(rig.applied.length, before, 'no overlay events after dispose');
  assert.equal(rig.state().overlays.stack.length, 0);
  controller.handleInput(keyEvent('escape'));
  assert.equal(controller.diagnostics().cancels, 0, 'input is inert after dispose');
  approvals.decide('allowed-once');
  assert.equal(await parked, 'allowed-once');

  // start() after dispose stays inert; dispose() is idempotent.
  controller.start();
  controller.dispose();
  assert.equal(rig.applied.length, before);
});

// ---------------------------------------------------------------------------
// minimal overlay components (payload-only rendering, width-bounded)
// ---------------------------------------------------------------------------

function assertWithinWidth(lines: string[], width: number): void {
  for (const line of lines) {
    assert.ok(measureLineWidth(line, PROFILE) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
  }
}

test('controller dialogs: approval component renders the published payload', () => {
  const { rig, approvals } = dialogsRig();
  void approvals.park({ toolName: 'Bash', command: 'ls -la', reason: 'needs shell access' }).then(() => {});
  const overlay = rig.state().overlays.stack[0];
  assert.ok(overlay !== undefined);
  const payload = parseDialogOverlayPayload(overlay.payload);
  assert.ok(payload !== null && payload.kind === 'approval');
  // Round-trip: the parsed payload is structurally identical to the published one.
  assert.deepEqual(payload, overlay.payload);

  const component = createApprovalDialog(payload as ApprovalDialogPayload, { profile: PROFILE, theme: THEME });
  const lines = component.render(40);
  assertWithinWidth(lines, 40);
  const plain = lines.join('\n');
  assert.match(plain, /Approval required: Bash/);
  assert.match(plain, /ls -la/);
  assert.match(plain, /❯ 1\. Proceed once/);
  assert.match(plain, /2\. Reject/);
  assert.equal(component.render(0).length, 0, 'zero width renders nothing');
});

test('controller dialogs: question component renders options, checks and the draft', () => {
  const question: QuestionDialogPayload = {
    kind: 'question',
    key: '1-0',
    questionId: 'q1',
    question: 'Which colors?',
    header: 'setup',
    options: [
      { id: 'red', label: 'red' },
      { id: 'blue', label: 'blue', description: 'the sky' },
    ],
    multiSelect: true,
    position: 1,
    total: 2,
    answered: 0,
    selection: { focusIndex: 1, checked: [0], text: '' },
  };
  const component = createQuestionDialog(question, { profile: PROFILE, theme: THEME });
  const lines = component.render(30);
  assertWithinWidth(lines, 30);
  const plain = lines.join('\n');
  assert.match(plain, /setup · Which colors\? \[1\/2\]/);
  assert.match(plain, /◉ red/);
  assert.match(plain, /❯ ○ blue/);
  assert.match(plain, /the sky/);
  assert.match(plain, /Space toggle/);

  const freeText: QuestionDialogPayload = {
    ...question,
    options: [],
    multiSelect: false,
    selection: { focusIndex: 0, checked: [], text: 'typed' },
  };
  const draftLines = createQuestionDialog(freeText, { profile: PROFILE, theme: THEME }).render(30);
  assertWithinWidth(draftLines, 30);
  assert.match(draftLines.join('\n'), /typed/);
});

test('controller dialogs: plugin dialog component renders select/confirm/input', () => {
  const select: PluginDialogPayload = {
    kind: 'plugin-dialog',
    dialogKind: 'select',
    key: 'dlg-1',
    title: 'Pick one',
    options: [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta', description: 'second option' },
    ],
    initial: '',
    selection: { focusIndex: 1, checked: [], text: '' },
  };
  const selectLines = createPluginDialog(select, { profile: PROFILE, theme: THEME }).render(30);
  assertWithinWidth(selectLines, 30);
  assert.match(selectLines.join('\n'), /Pick one/);
  assert.match(selectLines.join('\n'), /❯ Beta/);
  assert.match(selectLines.join('\n'), /second option/);

  const confirm: PluginDialogPayload = {
    kind: 'plugin-dialog',
    dialogKind: 'confirm',
    key: 'dlg-2',
    title: 'Proceed?',
    message: 'this cannot be undone',
    confirmLabel: '',
    cancelLabel: 'Stop',
    initial: '',
    selection: { focusIndex: 0, checked: [], text: '' },
  };
  const confirmLines = createPluginDialog(confirm, { profile: PROFILE, theme: THEME }).render(30);
  assertWithinWidth(confirmLines, 30);
  assert.match(confirmLines.join('\n'), /this cannot be undone/);
  assert.match(confirmLines.join('\n'), /❯ 1\. Yes/); // '' confirm label falls back
  assert.match(confirmLines.join('\n'), / Stop/);

  const input: PluginDialogPayload = {
    kind: 'plugin-dialog',
    dialogKind: 'input',
    key: 'dlg-3',
    title: 'Name',
    placeholder: 'your name',
    initial: '',
    selection: { focusIndex: 0, checked: [], text: '' },
  };
  const emptyLines = createPluginDialog(input, { profile: PROFILE, theme: THEME }).render(30);
  assertWithinWidth(emptyLines, 30);
  assert.match(emptyLines.join('\n'), /your name/);
  const filled = createPluginDialog(
    { ...input, selection: { focusIndex: 0, checked: [], text: 'ada' } },
    { profile: PROFILE, theme: THEME },
  ).render(30);
  assert.match(filled.join('\n'), /❯ ada/);
});

// ---------------------------------------------------------------------------
// WP-08c complete interaction semantics
// ---------------------------------------------------------------------------

test('controller dialogs: custom answer supports attachment and code-point cursor editing', async () => {
  const { rig, controller, questions } = dialogsRig();
  const answer = questions.ask({
    questions: [{ id: 'custom', question: 'Choose or explain', options: [{ label: 'a' }, { label: 'b' }] }],
  });
  controller.handleInput(charEvent('h'));
  controller.handleInput(charEvent('😀'));
  controller.handleInput(keyEvent('tab'));
  controller.handleInput(keyEvent('left'));
  controller.handleInput(charEvent('X'));
  const edited = topPayload(rig);
  assert.equal(edited.selection.text, 'hX😀');
  assert.equal(edited.selection.cursor, 2);
  assert.equal(edited.selection.attachedOptionId, 'a');
  // Enter on the trailing input row carries the option that was focused when
  // typing began and preserves the emoji as one cursor step.
  controller.handleInput(keyEvent('enter'));
  assert.deepEqual((await answer).answers, [
    { id: 'custom', selected: ['a'], custom: 'hX😀' },
  ]);
});

test('controller dialogs: plan review forbids approve-with-feedback and maps feedback to decline', async () => {
  const { rig, controller, questions } = dialogsRig();
  const answer = questions.ask({
    questions: [{
      id: 'plan',
      question: 'Approve?',
      detail: '# Plan\n\nDo work',
      options: [{ label: 'approve' }, { label: 'revise' }],
      intent: { kind: 'plan-review', approve: 'approve' },
    }],
  });
  for (const ch of 'fix') controller.handleInput(charEvent(ch));
  controller.handleInput(keyEvent('up'));
  controller.handleInput(keyEvent('up'));
  controller.handleInput(keyEvent('enter'));
  const blocked = topPayload(rig);
  assert.equal(blocked.kind, 'question');
  assert.match(blocked.selection.error ?? '', /Clear feedback/);
  controller.handleInput(keyEvent('backspace'));
  controller.handleInput(keyEvent('backspace'));
  controller.handleInput(keyEvent('backspace'));
  controller.handleInput(keyEvent('enter'));
  assert.deepEqual((await answer).answers, [{ id: 'plan', selected: ['approve'] }]);
});

test('controller dialogs: plugin select filters source options and skips disabled rows', async () => {
  const { rig, controller, dialogs } = dialogsRig();
  const answer = dialogs.ask({
    kind: 'select',
    title: 'Filtered',
    options: [
      { id: 'alpha', label: 'Alpha', disabled: true, disabledReason: 'busy' },
      { id: 'beta', label: 'Beta' },
      { id: 'gamma', label: 'Gamma' },
    ],
  });
  let payload = topPayload(rig);
  assert.equal(payload.kind, 'plugin-dialog');
  if (payload.kind === 'plugin-dialog') {
    assert.equal(payload.totalOptions, 3);
    assert.equal(payload.selection.focusIndex, 1, 'first enabled source row is focused');
  }
  controller.handleInput(charEvent('z'));
  controller.handleInput(keyEvent('enter'));
  payload = topPayload(rig);
  assert.match(payload.selection.error ?? '', /No options match/);
  controller.handleInput(keyEvent('backspace'));
  controller.handleInput(charEvent('b'));
  payload = topPayload(rig);
  if (payload.kind === 'plugin-dialog') {
    assert.deepEqual(payload.options?.map((option) => option.id), ['beta']);
    assert.equal(payload.totalOptions, 3);
  }
  controller.handleInput(keyEvent('enter'));
  assert.equal(await answer, 'beta');
});

test('controller dialogs: option windows budget rendered description rows', async () => {
  const { rig, controller, dialogs } = dialogsRig();
  const answer = dialogs.ask({
    kind: 'select',
    title: 'Tall options',
    options: Array.from({ length: 5 }, (_, index) => ({
      id: `option-${index}`,
      label: `Option ${index}`,
      description: `Description ${index}`,
    })),
  });
  const payload = topPayload(rig);
  assert.equal(payload.kind, 'plugin-dialog');
  if (payload.kind === 'plugin-dialog') {
    assert.equal(payload.selection.windowStart, 0);
    assert.equal(payload.selection.windowEnd, 4, 'four two-row options fit the eight-row budget');
  }
  controller.handleInput(keyEvent('escape'));
  assert.equal(await answer, undefined);
});

test('controller dialogs: completed question summaries are drained to the coordinator callback', async () => {
  const summaries: Array<{ title: string; lines: readonly string[] }> = [];
  const { rig, controller, questions } = dialogsRig((title, lines) => summaries.push({ title, lines }));
  const answer = questions.ask({
    questions: [
      { id: 'one', question: 'First?', options: [{ label: 'yes' }] },
      { id: 'two', question: 'Second?', options: [{ label: 'done' }] },
    ],
  });
  controller.handleInput(keyEvent('enter'));
  const second = topPayload(rig);
  assert.equal(second.kind, 'question');
  if (second.kind === 'question') assert.match(second.answeredSummary?.[0] ?? '', /First\?/);
  controller.handleInput(keyEvent('enter'));
  await answer;
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.lines.length, 2);
});

test('controller dialogs: approval content paging is journaled and store failure disables proceed', async () => {
  const rig = createControllerRig({ height: 8 });
  const base = createFakeApprovalStore();
  const approvals: ApprovalStoreLike = {
    subscribe: (listener) => base.subscribe(listener),
    getSnapshot: () => base.getSnapshot(),
    decide: (outcome) => {
      if (outcome === 'allowed-once') throw new Error('offline');
      base.decide(outcome);
    },
  };
  const controller = createDialogsController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
    getState: rig.state,
    approvals,
  });
  controller.start();
  const answer = base.park({ toolName: 'Bash', command: 'one\ntwo\nthree\nfour\nfive\nsix\nseven' });
  controller.handleInput(keyEvent('pageDown'));
  assert.equal(topPayload(rig).selection.contentOffset, 6);
  controller.handleInput(charEvent('1'));
  const failed = topPayload(rig);
  assert.equal(failed.kind, 'approval');
  if (failed.kind === 'approval') assert.equal(failed.status, 'error');
  assert.match(failed.selection.error ?? '', /disabled/);
  controller.handleInput(charEvent('2'));
  assert.equal(await answer, 'rejected');
  assert.equal(rig.state().overlays.stack.length, 0);
  replayEquivalence(rig);
});
