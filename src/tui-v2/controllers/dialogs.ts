/**
 * Dialogs controller (WP-05b; plan §7.3 "approval/question/plugin dialog
 * 优先级 → dialogs.ts + overlay stack", WP-05 "为 approval、question、
 * plugin dialog 建立 overlay focus/capture 优先级").
 *
 * Subscribes the three business dialog stores — ApprovalStore (tool
 * permission), QuestionStore (ask_user_question), TuiDialogStore (managed
 * plugin dialogs) — and projects their snapshots into normalized
 * `OverlayState`s on the model overlay stack. The controller never touches
 * `UiState` directly: every model change is an AppEvent (`overlay/open`,
 * revision-bumped `overlay/open` for interaction-state changes,
 * `overlay/close`) through the coordinator/rig dispatch pipeline, so live and
 * replay runs converge byte-identically (§5.2).
 *
 * Focus/capture priority (decision recorded in plan §15.1):
 *
 *  - Cross-type order is ported verbatim from the legacy Chat.tsx chrome
 *    ternary (approval panel > managed plugin dialog > questionnaire >
 *    prompt): approval=300, plugin-dialog=200, question=100.
 *  - The controller arbitrates BETWEEN stores: at most one dialog overlay is
 *    on the stack at a time — the highest-priority pending snapshot. A
 *    lower-priority snapshot arriving while a higher-priority dialog is open
 *    stays pending in its store and is only opened once the higher one
 *    settles; a higher-priority snapshot arriving mid-dialog PREEMPTS (the
 *    current overlay is closed — the underlying ask stays parked in its
 *    store — and the winner is opened). When the preempting dialog settles,
 *    the next pending snapshot is opened. This reproduces the legacy panel
 *    swap exactly (the store queue, not the overlay stack, is the truth).
 *  - Preemption re-opens reset the interaction state (focus/checked/text),
 *    matching the legacy panel remount (`key={snapshot.key}`).
 *  - Focus fallback (close → next capturing overlay on the stack → editor) is
 *    the reducer's `applyOverlayClose` semantics; with at most one managed
 *    dialog on the stack it resolves to the editor unless a foreign overlay
 *    (WP-06+) sits above. Within one store the queue is FIFO and key-stable,
 *    so the "latest capturing dialog on top" tie-break never fires between
 *    managed dialogs.
 *
 * Input semantics (keys reach this controller only while
 * `focus.target === 'overlay'` and the focused overlay is the active dialog;
 * the coordinator routes them, the editor never sees them — legacy: "prompt
 * input is inert while a modal dialog owns the keyboard"):
 *
 *  - approval: ↑/↓ (or ←/→) move the Yes/No focus, `1`/`2` quick-decide,
 *    Enter decides the focused outcome, Esc/Ctrl+C reject (fail closed).
 *  - question: ↑/↓ move over the options, Enter answers with the focused
 *    label (multi-select: Space toggles, Enter answers the checked labels),
 *    optionless questions accept a single-line draft (printable chars append,
 *    Backspace deletes, Enter answers `{ selected: [], custom: text }`),
 *    Esc/Ctrl+C cancelCurrent() — the asker sees ASK_CANCELLED.
 *  - plugin select: ↑/↓ + Enter settle the option id; confirm: arrows + Enter
 *    settle the boolean; input: printable/Backspace edit the draft (seeded
 *    from `initial`), Enter settles the text. Esc/Ctrl+C cancel(key) → the
 *    plugin promise resolves with the cancelled value.
 *
 * Cancel/timeout/abort paths all converge on the same close route: the store
 * settles (user cancel, caller AbortSignal, TuiDialogStore's own timeout
 * timer), its snapshot goes null, the emitted notification re-enters
 * `syncFromStores`, which dispatches `overlay/close`; focus fallback is the
 * reducer's. The controller owns NO timers (the store owns dialog timeouts),
 * so `dispose()` is exactly "unsubscribe + go inert": it is called by the
 * coordinator at stop, where the whole UiState is torn down anyway, so it
 * deliberately does not dispatch a final close.
 *
 * Dependency rule (§4.3): model + terminal input types + dsh-adapter types
 * only; no stdout, no ANSI, no component internals.
 */

import { canonicalJson } from '../model/canonical-json.js';
import type { AppEvent } from '../model/events.js';
import type {
  DialogOptionView,
  DialogOverlayPayload,
  DialogSelectionView,
} from '../model/overlay-payloads.js';
import type { EventMeta, OverlayState } from '../model/schema.js';
import type { UiState } from '../model/state.js';
import type { KeyPayload, PastePayload, TerminalInputEvent } from '../terminal/input.js';
import type { ApprovalSnapshot } from '../../dsh-adapter/approvals.js';
import type { QuestionSelection, QuestionSnapshot } from '../../dsh-adapter/questions.js';
import type { TuiDialogAnswer, TuiDialogSnapshot } from '../../dsh-adapter/dialogs.js';

// ---------------------------------------------------------------------------
// Narrow store surfaces (structural; the real dsh-adapter stores satisfy them)
// ---------------------------------------------------------------------------

export interface ApprovalStoreLike {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ApprovalSnapshot | null;
  readonly decide: (outcome: 'allowed-once' | 'rejected') => void;
}

export interface QuestionStoreLike {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => QuestionSnapshot | null;
  readonly answerCurrent: (selection: QuestionSelection) => void;
  /** User-initiated cancel (Esc/Ctrl+C) — rejects with ASK_CANCELLED. */
  readonly cancelCurrent: () => void;
}

export interface PluginDialogStoreLike {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => TuiDialogSnapshot | null;
  /** Keyed settle: a mismatched key is a stale callback and ignored. */
  readonly decide: (key: string, value: TuiDialogAnswer) => void;
  readonly cancel: (key: string) => void;
}

export type DialogKind = 'approval' | 'question' | 'plugin-dialog';

/**
 * Cross-type focus priority, ported from the legacy Chat.tsx render ternary
 * (approval panel > managed plugin dialog > questionnaire). Higher wins.
 */
export const DIALOG_PRIORITY: Readonly<Record<DialogKind, number>> = Object.freeze({
  approval: 300,
  'plugin-dialog': 200,
  question: 100,
});

export interface DialogsControllerOptions {
  /** Outgoing event journal (coordinator dispatch pipeline). */
  readonly dispatch: (event: AppEvent) => void;
  /** Allocate the journal event envelope; controller sourceSeqs are `dialog-N`. */
  readonly nextMeta: (sourceSeq: string) => EventMeta;
  /** Current model state (focus check for input routing). */
  readonly getState: () => UiState;
  readonly approvals?: ApprovalStoreLike;
  readonly questions?: QuestionStoreLike;
  readonly dialogs?: PluginDialogStoreLike;
  readonly onDiagnostic?: (code: string, message: string) => void;
}

export interface DialogsControllerDiagnostics {
  readonly opened: number;
  readonly closed: number;
  /** Closes caused by a higher-priority dialog taking over (not a settle). */
  readonly preempted: number;
  /** Revision-bumped overlay/opens (interaction-state changes). */
  readonly revisionBumps: number;
  /** Settles through a store decide/answer (all kinds). */
  readonly decisions: number;
  /** User cancels (Esc/Ctrl+C; approval rejects count as cancels). */
  readonly cancels: number;
  /** Keys received while the focused overlay is NOT the active dialog. */
  readonly staleInput: number;
  /** Non-key/paste or release events (counted, not acted on). */
  readonly ignoredInput: number;
}

export interface DialogsController {
  /** Subscribe the stores and open whatever is already pending. Idempotent. */
  readonly start: () => void;
  /**
   * Route a terminal input event to the active dialog. Acts only while the
   * model focus is THIS controller's active overlay; anything else is counted
   * (staleInput) so a foreign overlay's keys never leak into a dialog.
   */
  readonly handleInput: (event: TerminalInputEvent) => void;
  /** overlayId of the currently managed dialog overlay (null when none). */
  readonly activeOverlayId: () => string | null;
  readonly diagnostics: () => DialogsControllerDiagnostics;
  /**
   * Unsubscribe every store and go inert (no further events, no input).
   * Called by the coordinator at stop; the model state is torn down with the
   * coordinator, so no closing event is dispatched here.
   */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// implementation
// ---------------------------------------------------------------------------

interface InteractionState {
  focusIndex: number;
  readonly checked: Set<number>;
  text: string;
}

interface ActiveDialog {
  readonly overlayId: string;
  readonly kind: DialogKind;
  /** Store key the overlay was opened for (stale-snapshot guard). */
  readonly key: string;
  readonly interaction: InteractionState;
  /** canonicalJson of the last published payload (drift detection). */
  publishedJson: string;
}

export function createDialogsController(options: DialogsControllerOptions): DialogsController {
  let started = false;
  let disposed = false;
  let active: ActiveDialog | null = null;
  let journalSeq = 0;
  /** Monotonic per-overlayId revisions (survive close/re-open). */
  const revisions = new Map<string, number>();
  const unsubscribes: (() => void)[] = [];
  const counts = {
    opened: 0,
    closed: 0,
    preempted: 0,
    revisionBumps: 0,
    decisions: 0,
    cancels: 0,
    staleInput: 0,
    ignoredInput: 0,
  };

  const diagnostic = (code: string, message: string): void => {
    try {
      options.onDiagnostic?.(code, message);
    } catch {
      /* diagnostics never break the pipeline */
    }
  };

  const overlayIdFor = (kind: DialogKind, key: string): string => `dialog/${kind}/${key}`;

  /** Highest-priority pending snapshot across the three stores (null = idle). */
  const currentWinner = (): { kind: DialogKind; key: string; priority: number } | null => {
    const approval = options.approvals?.getSnapshot() ?? null;
    const plugin = options.dialogs?.getSnapshot() ?? null;
    const question = options.questions?.getSnapshot() ?? null;
    let winner: { kind: DialogKind; key: string; priority: number } | null = null;
    const consider = (kind: DialogKind, key: string): void => {
      const priority = DIALOG_PRIORITY[kind];
      if (winner === null || priority > winner.priority) winner = { kind, key, priority };
    };
    if (question !== null) consider('question', question.key);
    if (plugin !== null) consider('plugin-dialog', plugin.key);
    if (approval !== null) consider('approval', approval.key);
    return winner;
  };

  /** Snapshot of the given kind, null when absent or key-mismatched (stale). */
  const snapshotFor = (
    kind: DialogKind,
    key: string,
  ): ApprovalSnapshot | QuestionSnapshot | TuiDialogSnapshot | null => {
    const snapshot =
      kind === 'approval'
        ? (options.approvals?.getSnapshot() ?? null)
        : kind === 'question'
          ? (options.questions?.getSnapshot() ?? null)
          : (options.dialogs?.getSnapshot() ?? null);
    if (snapshot === null || snapshot.key !== key) return null;
    return snapshot;
  };

  const selectionView = (interaction: InteractionState): DialogSelectionView => ({
    focusIndex: interaction.focusIndex,
    checked: [...interaction.checked].sort((a, b) => a - b),
    text: interaction.text,
  });

  /**
   * Build the payload for the active dialog from its CURRENT store snapshot.
   * The question item is projected field-by-field (never embedded raw) so the
   * payload is guaranteed plain-serializable. Returns null when the snapshot
   * vanished mid-sync (defensive; the follow-up emit re-syncs).
   */
  const buildPayload = (dialog: ActiveDialog): DialogOverlayPayload | null => {
    const snapshot = snapshotFor(dialog.kind, dialog.key);
    if (snapshot === null) return null;
    const selection = selectionView(dialog.interaction);
    switch (dialog.kind) {
      case 'approval': {
        const approval = snapshot as ApprovalSnapshot;
        return {
          kind: 'approval',
          key: dialog.key,
          toolName: approval.toolName,
          ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
          ...(approval.command !== undefined ? { command: approval.command } : {}),
          selection,
        };
      }
      case 'question': {
        const question = snapshot as QuestionSnapshot;
        const item = question.question;
        const options_: DialogOptionView[] = (item.options ?? []).map((option) => ({
          // The answer protocol echoes option LABELS; the label is the id.
          id: option.label,
          label: option.label,
          ...(option.description !== undefined ? { description: option.description } : {}),
        }));
        return {
          kind: 'question',
          key: dialog.key,
          questionId: item.id,
          question: item.question,
          ...(item.header !== undefined ? { header: item.header } : {}),
          ...(item.detail !== undefined ? { detail: item.detail } : {}),
          options: options_,
          multiSelect: item.multiSelect === true,
          position: question.position,
          total: question.total,
          answered: question.answered,
          selection,
        };
      }
      case 'plugin-dialog': {
        const plugin = snapshot as TuiDialogSnapshot;
        const base = {
          kind: 'plugin-dialog' as const,
          dialogKind: plugin.kind,
          key: dialog.key,
          title: plugin.title,
          selection,
        };
        switch (plugin.kind) {
          case 'select':
            return {
              ...base,
              options: plugin.options.map((option) => ({
                id: option.id,
                label: option.label,
                ...(option.description !== undefined ? { description: option.description } : {}),
              })),
              initial: '',
            };
          case 'confirm':
            return {
              ...base,
              ...(plugin.message !== undefined ? { message: plugin.message } : {}),
              confirmLabel: plugin.confirmLabel,
              cancelLabel: plugin.cancelLabel,
              initial: '',
            };
          case 'input':
            return {
              ...base,
              ...(plugin.placeholder !== undefined ? { placeholder: plugin.placeholder } : {}),
              initial: plugin.initial,
            };
        }
        return null;
      }
    }
  };

  /** Dispatch an overlay/open for the active dialog (fresh or revision bump). */
  const publishOpen = (): void => {
    const dialog = active;
    if (dialog === null) return;
    const payload = buildPayload(dialog);
    if (payload === null) {
      diagnostic('dialog/stale-snapshot', `${dialog.overlayId}: snapshot gone before open`);
      return;
    }
    const revision = (revisions.get(dialog.overlayId) ?? 0) + 1;
    revisions.set(dialog.overlayId, revision);
    dialog.publishedJson = canonicalJson(payload);
    journalSeq += 1;
    // Dialogs are input-capturing by definition; the normalization rule
    // (captureInput === !nonCapturing, §5.1) is pinned explicitly. Geometry is
    // minimal: bottom-center full width, like the legacy bottom-chrome slot;
    // the compositor (WP-06) owns final placement.
    const overlay: OverlayState = {
      overlayId: dialog.overlayId,
      revision,
      anchor: 'bottom-center',
      width: '100%',
      visible: true,
      captureInput: true,
      nonCapturing: false,
      payload,
    };
    options.dispatch({ ...options.nextMeta(`dialog-${journalSeq}`), type: 'overlay/open', overlay });
  };

  /** Dispatch an overlay/close for the active dialog and clear it. */
  const closeActive = (preempted: boolean): void => {
    const dialog = active;
    if (dialog === null) return;
    active = null;
    counts.closed += 1;
    if (preempted) counts.preempted += 1;
    journalSeq += 1;
    options.dispatch({
      ...options.nextMeta(`dialog-${journalSeq}`),
      type: 'overlay/close',
      overlayId: dialog.overlayId,
    });
  };

  /** Fresh interaction state for a newly opened dialog. */
  const freshInteraction = (kind: DialogKind, key: string): InteractionState => {
    const interaction: InteractionState = { focusIndex: 0, checked: new Set<number>(), text: '' };
    if (kind === 'plugin-dialog') {
      const snapshot = snapshotFor(kind, key);
      if (snapshot !== null && (snapshot as TuiDialogSnapshot).kind === 'input') {
        // The input draft is seeded from the request's `initial` text.
        interaction.text = (snapshot as Extract<TuiDialogSnapshot, { kind: 'input' }>).initial;
      }
    }
    return interaction;
  };

  /**
   * Reconcile the overlay stack with the store snapshots. Idempotent; runs on
   * start and on every store notification (which include the settle echoes of
   * the controller's own decide/answer/cancel calls).
   */
  const syncFromStores = (): void => {
    if (!started || disposed) return;
    const winner = currentWinner();
    if (winner === null) {
      closeActive(false);
      return;
    }
    const overlayId = overlayIdFor(winner.kind, winner.key);
    if (active !== null && active.overlayId !== overlayId) {
      // Two distinct reasons the winner differs from the active overlay:
      //  - the active dialog SETTLED (snapshot gone / store advanced to the
      //    next key) and a lower-priority pending dialog takes over — a plain
      //    close; or
      //  - the active dialog is STILL PENDING but a higher-priority dialog
      //    arrived — a genuine preemption (counted; the underlying ask stays
      //    parked in its store and is re-opened when the winner settles).
      closeActive(snapshotFor(active.kind, active.key) !== null);
    }
    if (active === null) {
      active = {
        overlayId,
        kind: winner.kind,
        key: winner.key,
        interaction: freshInteraction(winner.kind, winner.key),
        publishedJson: '',
      };
      counts.opened += 1;
      publishOpen();
      return;
    }
    // Same overlay still active: publish a revision bump when the snapshot
    // content drifted (stores are key-stable, so this is defensive).
    const dialog = active;
    const payload = buildPayload(dialog);
    if (payload !== null && canonicalJson(payload) !== dialog.publishedJson) {
      counts.revisionBumps += 1;
      publishOpen();
    }
  };

  // ---------------------------------------------------------- input handling

  /** Publish an interaction-state change as a revision-bumped overlay/open. */
  const publishInteraction = (): void => {
    counts.revisionBumps += 1;
    publishOpen();
  };

  /**
   * Settle/cancel routes. Every one ends in a store call whose emit re-enters
   * syncFromStores synchronously (closing the overlay), so callers must not
   * touch `active` after invoking these.
   */
  const decideApproval = (outcome: 'allowed-once' | 'rejected'): void => {
    counts.decisions += 1;
    options.approvals?.decide(outcome);
  };
  const answerQuestion = (selection: QuestionSelection): void => {
    counts.decisions += 1;
    options.questions?.answerCurrent(selection);
  };
  const decidePlugin = (key: string, value: TuiDialogAnswer): void => {
    counts.decisions += 1;
    options.dialogs?.decide(key, value);
  };
  const cancelActive = (dialog: ActiveDialog): void => {
    counts.cancels += 1;
    if (dialog.kind === 'approval') {
      // Fail closed (legacy ApprovalPanel: Esc/Ctrl+C reject).
      options.approvals?.decide('rejected');
    } else if (dialog.kind === 'question') {
      // User-initiated cancel — the asker learns ASK_CANCELLED.
      options.questions?.cancelCurrent();
    } else {
      options.dialogs?.cancel(dialog.key);
    }
  };

  const moveFocus = (dialog: ActiveDialog, delta: number, rowCount: number): void => {
    if (rowCount <= 0) return;
    dialog.interaction.focusIndex = (dialog.interaction.focusIndex + delta + rowCount) % rowCount;
    publishInteraction();
  };

  /** Append printable text to the single-line draft (code-point safe). */
  const appendText = (dialog: ActiveDialog, text: string): void => {
    if (text === '') return;
    dialog.interaction.text += text;
    publishInteraction();
  };

  const backspaceText = (dialog: ActiveDialog): void => {
    const points = [...dialog.interaction.text];
    if (points.length === 0) return;
    points.pop();
    dialog.interaction.text = points.join('');
    publishInteraction();
  };

  const handleApprovalKey = (dialog: ActiveDialog, payload: KeyPayload): void => {
    if (payload.key === 'up' || payload.key === 'down' || payload.key === 'left' || payload.key === 'right') {
      moveFocus(dialog, 1, 2);
      return;
    }
    // Legacy ApprovalPanel quick keys: '1' = Yes, '2' = No.
    if (payload.text === '1') {
      decideApproval('allowed-once');
      return;
    }
    if (payload.text === '2') {
      decideApproval('rejected');
      return;
    }
    if (payload.key === 'enter') {
      decideApproval(dialog.interaction.focusIndex === 0 ? 'allowed-once' : 'rejected');
      return;
    }
    counts.ignoredInput += 1;
  };

  const questionOptions = (dialog: ActiveDialog): readonly DialogOptionView[] => {
    const payload = buildPayload(dialog);
    return payload !== null && payload.kind === 'question' ? payload.options : [];
  };

  const handleQuestionKey = (dialog: ActiveDialog, payload: KeyPayload): void => {
    const options_ = questionOptions(dialog);
    if (options_.length > 0) {
      if (payload.key === 'up') {
        moveFocus(dialog, -1, options_.length);
        return;
      }
      if (payload.key === 'down') {
        moveFocus(dialog, 1, options_.length);
        return;
      }
      const snapshot = snapshotFor('question', dialog.key);
      const multiSelect =
        snapshot !== null && (snapshot as QuestionSnapshot).question.multiSelect === true;
      if (multiSelect && (payload.text === ' ' || payload.key === 'space')) {
        const focus = dialog.interaction.focusIndex;
        if (dialog.interaction.checked.has(focus)) dialog.interaction.checked.delete(focus);
        else dialog.interaction.checked.add(focus);
        publishInteraction();
        return;
      }
      if (payload.key === 'enter') {
        if (multiSelect) {
          // Legacy shows an inline error for an empty multi-select submit; the
          // minimal panel ignores it instead (full UX is WP-08).
          if (dialog.interaction.checked.size === 0) {
            counts.ignoredInput += 1;
            return;
          }
          const selected = [...dialog.interaction.checked]
            .sort((a, b) => a - b)
            .map((index) => options_[index]?.label)
            .filter((label): label is string => typeof label === 'string');
          answerQuestion({ selected });
          return;
        }
        const label = options_[dialog.interaction.focusIndex]?.label;
        if (label === undefined) {
          counts.ignoredInput += 1;
          return;
        }
        answerQuestion({ selected: [label] });
        return;
      }
      counts.ignoredInput += 1;
      return;
    }
    // Optionless question: a single-line draft answered as `custom` text.
    if (payload.key === 'enter') {
      const text = dialog.interaction.text;
      if (text === '') {
        counts.ignoredInput += 1;
        return;
      }
      answerQuestion({ selected: [], custom: text });
      return;
    }
    if (payload.key === 'backspace') {
      backspaceText(dialog);
      return;
    }
    // Printable text (space included) appends to the draft; named keys that
    // are neither navigation nor editing are ignored.
    if (payload.text !== null) {
      appendText(dialog, payload.text);
      return;
    }
    counts.ignoredInput += 1;
  };

  const handlePluginKey = (dialog: ActiveDialog, payload: KeyPayload): void => {
    const snapshot = snapshotFor('plugin-dialog', dialog.key) as TuiDialogSnapshot | null;
    if (snapshot === null) {
      counts.staleInput += 1;
      return;
    }
    switch (snapshot.kind) {
      case 'select': {
        if (payload.key === 'up') {
          moveFocus(dialog, -1, snapshot.options.length);
          return;
        }
        if (payload.key === 'down') {
          moveFocus(dialog, 1, snapshot.options.length);
          return;
        }
        if (payload.key === 'enter') {
          const option = snapshot.options[dialog.interaction.focusIndex];
          if (option === undefined) {
            counts.ignoredInput += 1;
            return;
          }
          decidePlugin(dialog.key, option.id);
          return;
        }
        counts.ignoredInput += 1;
        return;
      }
      case 'confirm': {
        if (payload.key === 'up' || payload.key === 'down' || payload.key === 'left' || payload.key === 'right') {
          moveFocus(dialog, 1, 2);
          return;
        }
        if (payload.key === 'enter') {
          decidePlugin(dialog.key, dialog.interaction.focusIndex === 0);
          return;
        }
        counts.ignoredInput += 1;
        return;
      }
      case 'input': {
        if (payload.key === 'enter') {
          decidePlugin(dialog.key, dialog.interaction.text);
          return;
        }
        if (payload.key === 'backspace') {
          backspaceText(dialog);
          return;
        }
        if (payload.text !== null) {
          appendText(dialog, payload.text);
          return;
        }
        counts.ignoredInput += 1;
        return;
      }
    }
  };

  const handleKey = (dialog: ActiveDialog, payload: KeyPayload): void => {
    if (payload.key === 'escape' || payload.key === 'ctrl+c') {
      cancelActive(dialog);
      return;
    }
    if (dialog.kind === 'approval') {
      handleApprovalKey(dialog, payload);
      return;
    }
    if (dialog.kind === 'question') {
      handleQuestionKey(dialog, payload);
      return;
    }
    handlePluginKey(dialog, payload);
  };

  /** Bracketed paste lands in single-line drafts only, newlines flattened. */
  const handlePaste = (dialog: ActiveDialog, text: string): void => {
    const textBearing =
      dialog.kind === 'question'
        ? questionOptions(dialog).length === 0
        : dialog.kind === 'plugin-dialog' &&
          (snapshotFor('plugin-dialog', dialog.key) as TuiDialogSnapshot | null)?.kind === 'input';
    if (textBearing !== true) {
      counts.ignoredInput += 1;
      return;
    }
    appendText(dialog, text.replace(/[\r\n]+/g, ' '));
  };

  const handleInput = (event: TerminalInputEvent): void => {
    if (!started || disposed) return;
    const dialog = active;
    if (dialog === null) {
      counts.ignoredInput += 1;
      return;
    }
    const focus = options.getState().focus;
    if (focus.target !== 'overlay' || focus.overlayId !== dialog.overlayId) {
      counts.staleInput += 1;
      return;
    }
    if (event.kind === 'key') {
      const payload = event.payload as KeyPayload;
      if (payload.eventType === 'release') {
        counts.ignoredInput += 1;
        return;
      }
      handleKey(dialog, payload);
      return;
    }
    if (event.kind === 'paste') {
      handlePaste(dialog, (event.payload as PastePayload).text);
      return;
    }
    counts.ignoredInput += 1;
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      for (const store of [options.approvals, options.questions, options.dialogs]) {
        if (store !== undefined) unsubscribes.push(store.subscribe(syncFromStores));
      }
      // Open whatever was already pending before the UI subscribed (legacy
      // panels render from the current snapshot on mount).
      syncFromStores();
    },
    handleInput,
    activeOverlayId: () => active?.overlayId ?? null,
    diagnostics: () => ({ ...counts }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    },
  };
}
