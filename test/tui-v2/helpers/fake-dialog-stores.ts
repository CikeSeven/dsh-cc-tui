/**
 * Fake dialog stores for the WP-05b dialogs-controller tests and the verify
 * script's `--check controllers` scenario.
 *
 * They mirror the real stores' observable semantics — FIFO queue, one active
 * snapshot at a time, keyed decide/cancel, synchronous emit — minus cordis and
 * real timers (plugin-dialog timeouts run on the injected Clock, so tests and
 * verify stay deterministic on the rig's ManualClock):
 *
 *  - FakeApprovalStore  ~ src/dsh-adapter/approvals.ts ApprovalStore
 *    (park/decide; abortActive() simulates the asker's AbortSignal → 'cancelled')
 *  - FakeQuestionStore  ~ src/dsh-adapter/questions.ts QuestionStore
 *    (ask/answerCurrent/cancelCurrent; cancel rejects with code ASK_CANCELLED,
 *    abortActive() rejects with ASK_ABORTED, matching UserQuestionError codes)
 *  - FakePluginDialogStore ~ src/dsh-adapter/dialogs.ts TuiDialogStore
 *    (ask/decide/cancel; timeoutMs settles undefined on the injected clock)
 */
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions';
import type { ApprovalSnapshot } from '../../../src/dsh-adapter/approvals.js';
import type { QuestionSelection, QuestionSnapshot } from '../../../src/dsh-adapter/questions.js';
import type { TuiDialogAnswer, TuiDialogSnapshot } from '../../../src/dsh-adapter/dialogs.js';
import type { Clock } from '../../../src/tui-v2/model/schema.js';
import type {
  ApprovalStoreLike,
  PluginDialogStoreLike,
  QuestionStoreLike,
} from '../../../src/tui-v2/controllers/dialogs.js';

/** Distributive Omit (same trick as dsh-adapter/dialogs.ts): keep the union. */
type WithoutKey<T> = T extends unknown ? Omit<T, 'key'> : never;

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

export type FakeApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled';

export interface FakeApprovalStore extends ApprovalStoreLike {
  /** Park an ask; resolves on decide('allowed-once'|'rejected') or abort. */
  readonly park: (input: { toolName: string; reason?: string; command?: string }) => Promise<FakeApprovalOutcome>;
  /** Simulate the asker's AbortSignal: the active ask settles 'cancelled'. */
  readonly abortActive: () => void;
  /** Live subscription count (dispose assertions). */
  readonly listenerCount: number;
}

export function createFakeApprovalStore(): FakeApprovalStore {
  interface Pending {
    readonly key: string;
    readonly snapshot: Omit<ApprovalSnapshot, 'key'>;
    readonly resolve: (outcome: FakeApprovalOutcome) => void;
  }
  const queue: Pending[] = [];
  let active: Pending | null = null;
  const listeners = new Set<() => void>();
  let seq = 0;

  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const advance = (): void => {
    if (active === null && queue.length > 0) active = queue.shift() ?? null;
    emit();
  };
  const settleActive = (outcome: FakeApprovalOutcome): void => {
    const pending = active;
    if (pending === null) return;
    active = null;
    pending.resolve(outcome);
    advance();
  };

  return {
    park(input) {
      return new Promise<FakeApprovalOutcome>((resolve) => {
        queue.push({ key: String(++seq), snapshot: input, resolve });
        advance();
      });
    },
    decide: (outcome) => settleActive(outcome),
    abortActive: () => settleActive('cancelled'),
    getSnapshot: () => (active === null ? null : { key: active.key, ...active.snapshot }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

// ---------------------------------------------------------------------------
// questions
// ---------------------------------------------------------------------------

export interface FakeQuestionStore extends QuestionStoreLike {
  /** Park a batch; resolves with the answers, rejects on cancel/abort. */
  readonly ask: (request: { questions: readonly AskUserQuestionItem[] }) => Promise<AskUserQuestionAnswer>;
  /** Simulate the harness abort signal: rejects the active ask ASK_ABORTED. */
  readonly abortActive: () => void;
  readonly listenerCount: number;
}

export function createFakeQuestionStore(): FakeQuestionStore {
  interface Pending {
    readonly request: { questions: readonly AskUserQuestionItem[] };
    readonly batchId: number;
    index: number;
    readonly answers: AskUserQuestionAnswerItem[];
    readonly resolve: (answer: AskUserQuestionAnswer) => void;
    readonly reject: (error: unknown) => void;
  }
  const queue: Pending[] = [];
  let active: Pending | null = null;
  const listeners = new Set<() => void>();
  let batchSeq = 0;

  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const advance = (): void => {
    if (active === null && queue.length > 0) active = queue.shift() ?? null;
    emit();
  };
  const failActive = (error: unknown): void => {
    const pending = active;
    if (pending === null) return;
    active = null;
    pending.reject(error);
    advance();
  };

  return {
    ask(request) {
      return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
        queue.push({ request, batchId: ++batchSeq, index: 0, answers: [], resolve, reject });
        advance();
      });
    },
    answerCurrent(selection) {
      const pending = active;
      const question = pending?.request.questions[pending.index];
      if (pending === undefined || pending === null || question === undefined) return;
      pending.answers.push({
        id: question.id,
        selected: [...selection.selected],
        ...(selection.custom !== undefined && selection.custom !== '' ? { custom: selection.custom } : {}),
      });
      pending.index += 1;
      if (pending.index >= pending.request.questions.length) {
        active = null;
        pending.resolve({ answers: [...pending.answers] });
        advance();
        return;
      }
      emit();
    },
    // User-initiated cancel (Esc/Ctrl+C) — the asker learns ASK_CANCELLED.
    cancelCurrent: () => failActive(codedError('the user cancelled ask_user_question', 'ASK_CANCELLED')),
    abortActive: () =>
      failActive(codedError('ask_user_question was interrupted before the user answered', 'ASK_ABORTED')),
    getSnapshot: () => {
      if (active === null) return null;
      const question = active.request.questions[active.index];
      if (question === undefined) return null;
      return {
        key: `${active.batchId}-${active.index}`,
        question,
        position: active.index + 1,
        total: active.request.questions.length,
        answered: active.answers.length,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

// ---------------------------------------------------------------------------
// managed plugin dialogs
// ---------------------------------------------------------------------------

export interface FakePluginDialogStore extends PluginDialogStoreLike {
  /**
   * Park a dialog; resolves with the answer (select id / confirm boolean /
   * input text), undefined on cancel/timeout. `timeoutMs` runs on the
   * injected Clock (the rig's ManualClock — deterministic).
   */
  readonly ask: (snapshot: WithoutKey<TuiDialogSnapshot>, timeoutMs?: number) => Promise<TuiDialogAnswer>;
  readonly listenerCount: number;
}

export function createFakePluginDialogStore(clock: Clock): FakePluginDialogStore {
  interface Pending {
    readonly key: string;
    readonly snapshot: TuiDialogSnapshot;
    readonly resolve: (value: TuiDialogAnswer) => void;
    timer: unknown;
  }
  const queue: Pending[] = [];
  let active: Pending | null = null;
  const listeners = new Set<() => void>();
  let seq = 0;

  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const advance = (): void => {
    if (active === null && queue.length > 0) active = queue.shift() ?? null;
    emit();
  };
  const settle = (pending: Pending, value: TuiDialogAnswer): void => {
    if (pending.timer !== null) {
      clock.clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (active === pending) active = null;
    const index = queue.indexOf(pending);
    if (index >= 0) queue.splice(index, 1);
    pending.resolve(value);
    advance();
  };

  return {
    ask(snapshot, timeoutMs) {
      return new Promise<TuiDialogAnswer>((resolve) => {
        const key = `dlg-${++seq}`;
        const pending: Pending = {
          key,
          snapshot: { ...snapshot, key } as TuiDialogSnapshot,
          resolve,
          timer: null,
        };
        if (timeoutMs !== undefined && timeoutMs > 0) {
          pending.timer = clock.setTimeout(() => settle(pending, undefined), timeoutMs);
        }
        queue.push(pending);
        advance();
      });
    },
    decide(key, value) {
      if (active === null || active.key !== key) return;
      settle(active, value);
    },
    cancel(key) {
      if (active === null || active.key !== key) return;
      settle(active, undefined);
    },
    getSnapshot: () => active?.snapshot ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}
