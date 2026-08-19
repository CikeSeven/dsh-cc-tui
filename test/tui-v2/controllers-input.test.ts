/**
 * WP-05 input controller deepening + prompt-editor extensions.
 *
 * Coverage: the Ctrl+C three-state contract (working-interrupt / clear-draft /
 * arm+exit, repro-ctrlc transcription), Escape-while-working interrupt
 * (pending delivery vs plain cancel), paste atomicity (pasted newlines never
 * submit), the UTF-16 cursor offset on a real PromptEditor (emoji = 2 code
 * units), the history mirror, and the vendored-editor history navigation
 * (3×Up/3×Down restores the in-progress draft — verify-prompt-history-draft).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AppEvent } from '../../src/tui-v2/model/events.js';
import type { EventMeta } from '../../src/tui-v2/model/schema.js';
import type { InputCommand } from '../../src/tui-v2/model/schema.js';
import {
  createInputController,
  type InputController,
  type InputEditorBinding,
} from '../../src/tui-v2/controllers/input.js';
import { createPromptEditor, type PromptEditor } from '../../src/tui-v2/components/editor/prompt-editor.js';
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js';
import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js';
import type { TerminalInputEvent } from '../../src/tui-v2/terminal/input.js';
import { ManualClock } from './helpers/controller-rig.js';

function keyEvent(key: string | null, raw: string): TerminalInputEvent {
  return { kind: 'key', sequence: 0, generation: 0, payload: { key, raw, text: null, eventType: 'press' } };
}

function pasteEvent(text: string): TerminalInputEvent {
  return { kind: 'paste', sequence: 0, generation: 0, payload: { text } };
}

function testMeta(seq: number): EventMeta {
  return {
    schemaVersion: 1,
    adapterInstanceId: 'input-test',
    durableSessionId: 'input-session',
    uiSessionGeneration: 'gen-1',
    resetEpoch: 0,
    sessionEpoch: 'gen-1:0',
    source: 'input',
    sourceSeq: `input-${seq}`,
    seq,
    at: 0,
  };
}

interface InputRig {
  controller: InputController;
  journaled: InputCommand[];
  submitted: string[];
  cancels: number;
  interrupts: number;
  exitRequests: number;
  exitArms: number;
  interruptHooks: number;
  pastes: string[];
  editorText: { text: string };
  setWorking(value: boolean): void;
  clock: ManualClock;
}

function inputRig(options: { working?: boolean; withPaste?: boolean } = {}): InputRig {
  const clock = new ManualClock();
  const journaled: InputCommand[] = [];
  const submitted: string[] = [];
  const pastes: string[] = [];
  const editorText = { text: '' };
  let working = options.working === true;
  let seq = 0;
  const rig: InputRig = {
    journaled,
    submitted,
    pastes,
    editorText,
    cancels: 0,
    interrupts: 0,
    exitRequests: 0,
    exitArms: 0,
    interruptHooks: 0,
    clock,
    setWorking(value) {
      working = value;
    },
    controller: undefined as unknown as InputController,
  };
  const editor: InputEditorBinding = {
    handleRawInput: (raw) => {
      editorText.text += raw;
    },
    getText: () => editorText.text,
    clearText: () => {
      editorText.text = '';
    },
    ...(options.withPaste === false
      ? {}
      : {
          insertPaste: (text: string) => {
            pastes.push(text);
            editorText.text += text;
          },
        }),
  };
  rig.controller = createInputController({
    clock,
    dispatch: (event: AppEvent) => {
      if (event.type === 'input/command') journaled.push(event.command);
    },
    nextMeta: () => {
      seq += 1;
      return testMeta(seq);
    },
    editor,
    commands: {
      submit: (text) => submitted.push(text),
      cancel: () => {
        rig.cancels += 1;
      },
      interrupt: () => {
        rig.interrupts += 1;
      },
    },
    isWorking: () => working,
    onExitRequest: () => {
      rig.exitRequests += 1;
    },
    onInterrupt: () => {
      rig.interruptHooks += 1;
    },
    onExitArm: () => {
      rig.exitArms += 1;
    },
  });
  return rig;
}

// ---------------------------------------------------------------------------
// Ctrl+C three-state contract (repro-ctrlc transcription)
// ---------------------------------------------------------------------------

test('controller input: Ctrl+C while working interrupts (journal + cancel + hook)', () => {
  const rig = inputRig({ working: true });
  rig.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  assert.equal(rig.cancels, 1);
  assert.equal(rig.interruptHooks, 1, 'coordinator streaming-cancel hook fired');
  assert.deepEqual(rig.journaled, [{ type: 'app', command: 'interrupt' }]);
  assert.equal(rig.exitRequests, 0, 'never exits while working');
});

test('controller input: Ctrl+C clears a non-empty draft (no arm, no exit)', () => {
  const rig = inputRig();
  rig.editorText.text = 'draft';
  rig.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  assert.equal(rig.editorText.text, '', 'draft cleared');
  assert.deepEqual(rig.journaled, [{ type: 'editor', command: 'cancel' }]);
  assert.equal(rig.exitArms, 0, 'clearing a draft does not arm the exit');
  assert.equal(rig.exitRequests, 0);
});

test('controller input: Ctrl+C on empty draft arms, second press exits (repro-ctrlc)', () => {
  const rig = inputRig();
  rig.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  assert.equal(rig.exitArms, 1, 'arm hook fired (coordinator notifies)');
  assert.equal(rig.exitRequests, 0);

  // Within the arming window: exit.
  rig.clock.advance(500);
  rig.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  assert.equal(rig.exitRequests, 1);
  assert.deepEqual(rig.journaled.at(-1), { type: 'app', command: 'exit' });
});

test('controller input: arming expires after ctrlCArmMs; typing disarms', () => {
  const rig = inputRig();
  rig.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  rig.clock.advance(3000); // beyond the 2000ms window
  rig.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  assert.equal(rig.exitRequests, 0, 'expired arm does not exit');
  assert.equal(rig.exitArms, 2, 're-armed instead');

  rig.controller.handleEvent(keyEvent('a', 'a')); // typing disarms
  rig.controller.handleEvent(keyEvent('ctrl+c', '\x03'));
  assert.equal(rig.exitRequests, 0, 'disarmed by the intervening key');
});

// ---------------------------------------------------------------------------
// Escape while working
// ---------------------------------------------------------------------------

test('controller input: Escape while working interrupts (interrupt ?? cancel)', () => {
  const rig = inputRig({ working: true });
  rig.controller.handleEvent(keyEvent('escape', '\x1b'));
  assert.equal(rig.interrupts, 1, 'rich interrupt preferred (pending delivery)');
  assert.equal(rig.cancels, 0);
  assert.equal(rig.interruptHooks, 1);
  assert.deepEqual(rig.journaled, [{ type: 'app', command: 'interrupt' }]);
});

test('controller input: Escape while idle reaches the editor untouched', () => {
  const rig = inputRig();
  rig.controller.handleEvent(keyEvent('escape', '\x1b'));
  assert.equal(rig.interrupts, 0);
  assert.equal(rig.cancels, 0);
  assert.equal(rig.editorText.text, '\x1b', 'raw input forwarded to the editor');
});

// ---------------------------------------------------------------------------
// paste
// ---------------------------------------------------------------------------

test('controller input: paste is atomic and never submits (multi-line safe)', () => {
  const rig = inputRig();
  rig.controller.handleEvent(pasteEvent('line1\nline2\nline3'));
  assert.deepEqual(rig.pastes, ['line1\nline2\nline3'], 'insertPaste used');
  assert.equal(rig.submitted.length, 0, 'pasted newlines never trigger submit');
  assert.equal(rig.editorText.text, 'line1\nline2\nline3');
});

test('controller input: paste falls back to raw input without insertPaste', () => {
  const rig = inputRig({ withPaste: false });
  rig.controller.handleEvent(pasteEvent('pasted'));
  assert.equal(rig.editorText.text, 'pasted');
  assert.equal(rig.submitted.length, 0);
});

// ---------------------------------------------------------------------------
// editor commands + history mirror
// ---------------------------------------------------------------------------

test('controller input: submit journals, forwards, and mirrors history (dedup/cap)', () => {
  const rig = inputRig();
  const submit = (text: string): void =>
    rig.controller.handleEditorCommand({ type: 'editor', command: 'submit', text });
  submit('first');
  submit('second');
  submit('second'); // consecutive duplicate: no new history entry
  submit('   '); // blank: never forwarded, never journaled into history
  assert.deepEqual(rig.submitted, ['first', 'second', 'second']);
  assert.deepEqual([...rig.controller.history()], ['second', 'first'], 'newest first, deduped');
  assert.deepEqual(rig.journaled.length, 4, 'every editor command journaled');
});

// ---------------------------------------------------------------------------
// real PromptEditor: cursor offsets + history navigation
// ---------------------------------------------------------------------------

function realEditor(commands: InputCommand[] = []): PromptEditor {
  const editor = createPromptEditor({
    profile: unknownConservativeDefaults(),
    theme: DEFAULT_COMPONENT_THEME,
    terminalRows: 40,
    onCommand: (command) => commands.push(command),
  });
  editor.focused = true;
  return editor;
}

test('controller input: PromptEditor exposes a true UTF-16 cursor offset', () => {
  const editor = realEditor();
  editor.handleInput('abc');
  assert.equal(editor.getText(), 'abc');
  assert.equal(editor.getCursorUtf16Offset(), 3, 'cursor at the tail');

  editor.handleInput('\x1b[D'); // left
  assert.equal(editor.getCursorUtf16Offset(), 2);

  // Emoji is 2 UTF-16 code units: offsets count code units, not graphemes.
  editor.setDraft('a😀b');
  assert.equal(editor.getCursorUtf16Offset(), 4, 'a(1) + 😀(2) + b(1)');
  editor.handleInput('\x1b[D'); // left over 'b'
  assert.equal(editor.getCursorUtf16Offset(), 3);
  editor.handleInput('\x1b[D'); // left over the emoji (2 code units)
  assert.equal(editor.getCursorUtf16Offset(), 1);
});

test('controller input: PromptEditor insertText is atomic (paste path)', () => {
  const commands: InputCommand[] = [];
  const editor = realEditor(commands);
  editor.insertText('one\ntwo');
  assert.equal(editor.getText(), 'one\ntwo');
  assert.ok(
    !commands.some((command) => command.command === 'submit'),
    'insertion never triggers submit',
  );
});

test('controller input: history navigation restores the in-progress draft (3xUp/3xDown)', () => {
  const editor = realEditor();
  editor.addToHistory('one');
  editor.addToHistory('two');
  editor.addToHistory('three');

  // Type a draft, then walk the history up and back down to the draft.
  // Vendored rule: Up with the cursor mid-line first moves to the line start;
  // the NEXT Up enters history browsing.
  editor.setDraft('draft');
  editor.handleInput('\x1b[A'); // Up -> cursor to line start (still 'draft')
  assert.equal(editor.getText(), 'draft');
  editor.handleInput('\x1b[A'); // Up -> 'three'
  assert.equal(editor.getText(), 'three');
  editor.handleInput('\x1b[A'); // Up -> 'two'
  assert.equal(editor.getText(), 'two');
  editor.handleInput('\x1b[A'); // Up -> 'one'
  assert.equal(editor.getText(), 'one');
  editor.handleInput('\x1b[B'); // Down -> 'two'
  editor.handleInput('\x1b[B'); // Down -> 'three'
  assert.equal(editor.getText(), 'three');
  editor.handleInput('\x1b[B'); // Down past newest -> draft restored
  assert.equal(editor.getText(), 'draft', 'the in-progress draft survives history browsing');
});

test('controller input: history dedups consecutive entries and caps at 100', () => {
  const editor = realEditor();
  editor.addToHistory('one');
  editor.addToHistory('two');
  editor.addToHistory('two'); // consecutive duplicate: collapsed
  // Empty draft with the cursor at col 0: Up enters history directly.
  editor.handleInput('\x1b[A'); // Up -> newest: 'two'
  assert.equal(editor.getText(), 'two');
  editor.handleInput('\x1b[A'); // Up -> 'one'
  assert.equal(editor.getText(), 'one');
  editor.handleInput('\x1b[A'); // Up at the oldest: stays
  assert.equal(editor.getText(), 'one');
});

test('controller input: setDraft replaces text and lands the cursor at the end', () => {
  const editor = realEditor();
  editor.setDraft('rewound text');
  assert.equal(editor.getText(), 'rewound text');
  assert.equal(editor.getCursorUtf16Offset(), 'rewound text'.length);
  editor.setDraft('rewound text');
  assert.equal(editor.getText(), 'rewound text', 'idempotent on identical text');
});
