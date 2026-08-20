/**
 * WP-05 commands controller (slash routing skeleton).
 *
 * v1 Chat.tsx parity under test: working-steer (with the /btw exception),
 * /new, /clear, /resume (overlay + direct id), /workspace (usage / provider
 * subcommands / choices degradation / target switch), external commands
 * (registry truth), skill + unknown-slash fallthrough to the model, and
 * superseded async ops.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCommandsController, type CommandsController } from '../../src/tui-v2/controllers/commands.js';
import { createReplayController } from '../../src/tui-v2/controllers/replay.js';
import { serializeCanonicalUiState } from '../../src/tui-v2/model/canonical-state.js';
import { createReducer } from '../../src/tui-v2/model/reducer.js';
import { replayTrace } from '../../src/tui-v2/controllers/replay.js';
import type { LocalCommand } from '../../src/commands.js';
import type {
  TuiWorkspaceCommandResult,
  TuiWorkspaceTarget,
} from '../../src/dsh-adapter/workspaces.js';
import { createControllerRig, addUserRows, ManualClock, type ControllerRig } from './helpers/controller-rig.js';

interface OverlayHarness {
  resumeSelect: ((id: string) => void) | null;
  helpQueries: string[];
  historyQueries: string[];
  searchQueries: string[];
}

interface CommandsRig {
  commands: CommandsController;
  rig: ControllerRig;
  overlays: OverlayHarness;
  resumed: string[];
}

function commandsFor(rig: ControllerRig): CommandsRig {
  const replay = createReplayController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('input', sourceSeq),
    commands: rig.adapter.commands,
    chatRowForRowId: (rowId) => rig.adapter.chatRowForRowId(rowId),
    promptRewind: (row) => rig.channel.promptRewind(row),
    getState: rig.state,
    setEditorDraft: () => {},
    notify: (text, options) => rig.channel.notify(text, options),
    requestStop: () => {},
  });
  const overlays: OverlayHarness = {
    resumeSelect: null,
    helpQueries: [],
    historyQueries: [],
    searchQueries: [],
  };
  const resumed: string[] = [];
  const commands = createCommandsController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('input', sourceSeq),
    channel: rig.channel,
    replay: {
      newSession: replay.newSession,
      clear: replay.clear,
      resume: (id) => {
        resumed.push(id);
        return replay.resume(id);
      },
    },
    overlays: {
      openResumePicker: (onSelect) => {
        overlays.resumeSelect = onSelect;
        return true;
      },
      openHelp: (query) => {
        overlays.helpQueries.push(query);
        return true;
      },
      openHistorySearch: (query) => {
        overlays.historyQueries.push(query);
        return true;
      },
      openTranscriptSearch: (query) => {
        overlays.searchQueries.push(query);
        return true;
      },
    },
    submitToModel: (text) => rig.adapter.commands.submit(text),
    steerToModel: (text) => rig.adapter.commands.steer(text),
    notify: (text, options) => rig.channel.notify(text, options),
  });
  return { commands, rig, overlays, resumed };
}

function replayEquivalence(rig: ControllerRig): void {
  const replayed = replayTrace(rig.applied, createReducer({ clock: new ManualClock() }), rig.initialState);
  assert.equal(serializeCanonicalUiState(replayed), serializeCanonicalUiState(rig.state()));
}

test('controller commands: empty / plain text / unknown slash fall through to the model', () => {
  const { commands, rig } = commandsFor(createControllerRig({ height: 5 }));

  assert.equal(commands.handleSubmittedText('   '), 'empty');
  assert.equal(rig.channel.submitted.length, 0);

  assert.equal(commands.handleSubmittedText('hello model'), 'submitted');
  assert.deepEqual(rig.channel.submitted, ['hello model']);

  // Unknown slash: the whole line goes to the model (v1).
  rig.channel.setWorking(false);
  assert.equal(commands.handleSubmittedText('/xyzzy frobnicate'), 'submitted');
  assert.equal(rig.channel.submitted[1], '/xyzzy frobnicate');
  assert.equal(commands.diagnostics().unknownCommands, 1);
});

test('controller commands: working routes to steer; /btw still dispatches', async () => {
  const { commands, rig } = commandsFor(createControllerRig({ height: 5 }));
  const externalCalls: string[] = [];
  rig.channel.commandList = [
    { name: 'btw', description: 'side question', external: true } as LocalCommand,
  ];
  rig.channel.runExternalCommand = async (name, rawInput) => {
    externalCalls.push(`${name}:${rawInput}`);
    return '';
  };

  rig.channel.setWorking(true);
  assert.equal(commands.handleSubmittedText('hold on'), 'steered');
  assert.equal(rig.channel.pending.length, 1, 'steered text queued as pending');
  assert.equal(rig.channel.pending[0]?.text, 'hold on');

  assert.equal(commands.handleSubmittedText('/btw what is up'), 'command');
  await Promise.resolve();
  assert.deepEqual(externalCalls, ['btw:what is up']);
  replayEquivalence(rig);
});

test('controller commands: /new and /clear reset through the replay controller', async () => {
  const { commands, rig } = commandsFor(createControllerRig({ height: 5 }));
  addUserRows(rig, 3);

  assert.equal(commands.handleSubmittedText('/clear'), 'command');
  assert.equal(rig.state().session.rowOrder.length, 0);

  addUserRows(rig, 2);
  assert.equal(commands.handleSubmittedText('/new'), 'command');
  await Promise.resolve(); // async withReset settles on a microtask
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rig.state().session.rowOrder.length, 0, 'newSession reset landed');
  replayEquivalence(rig);
});

test('controller commands: /resume uses the generic picker callback boundary', async () => {
  const { commands, rig, overlays, resumed } = commandsFor(createControllerRig({ height: 5 }));

  assert.equal(commands.handleSubmittedText('/resume'), 'command');
  assert.equal(typeof overlays.resumeSelect, 'function');
  assert.equal(rig.state().overlays.stack.length, 0, 'commands never invent a session-browser payload');
  overlays.resumeSelect?.('picked-session');
  assert.deepEqual(resumed, ['picked-session']);

  assert.equal(commands.handleSubmittedText('/resume abc123'), 'command');
  assert.deepEqual(resumed, ['picked-session', 'abc123']);
  await new Promise((resolve) => setImmediate(resolve));
  replayEquivalence(rig);
});

test('controller commands: /help, /history and /search use utility actions with initial queries', () => {
  const { commands, overlays } = commandsFor(createControllerRig({ height: 5 }));
  assert.equal(commands.handleSubmittedText('/help keys'), 'command');
  assert.equal(commands.handleSubmittedText('/history deploy'), 'command');
  assert.equal(commands.handleSubmittedText('/search error'), 'command');
  assert.deepEqual(overlays.helpQueries, ['keys']);
  assert.deepEqual(overlays.historyQueries, ['deploy']);
  assert.deepEqual(overlays.searchQueries, ['error']);
  assert.equal(commands.diagnostics().overlaysOpened, 3);
});

test('controller commands: /workspace usage, provider subcommands, choices and target', async () => {
  const { commands, rig } = commandsFor(createControllerRig({ height: 5 }));
  const switched: TuiWorkspaceTarget[] = [];
  const target: TuiWorkspaceTarget = { kind: 'path', path: '/tmp/ws', title: 'ws' } as TuiWorkspaceTarget;
  const choicesResult: TuiWorkspaceCommandResult = {
    kind: 'choices',
    title: 'pick one',
    choices: [
      { id: 'a', label: 'Choice A' },
      { id: 'b', label: 'Choice B' },
    ],
  };
  rig.channel.workspaceCommands = () => [
    { name: 'review', aliases: ['rv'], description: 'Review workspaces' },
  ];
  rig.channel.runWorkspaceCommand = async (name, input) => {
    if (input === 'pick') return choicesResult;
    if (input === 'go') return { kind: 'target', target };
    return undefined;
  };
  rig.channel.switchWorkspace = async (t) => {
    switched.push(t);
    return true;
  };

  // No subcommand: usage pushed as local rows.
  assert.equal(commands.handleSubmittedText('/workspace'), 'command');
  assert.equal(rig.channel.localReports.length, 1);
  assert.match(rig.channel.localReports[0]?.lines[0] ?? '', /Usage: \/workspace/);
  assert.ok(rig.state().session.rowOrder.length >= 2, 'usage rows landed in the transcript');

  // Alias match + choices degrade to a local list (WP-08 owns the picker).
  assert.equal(commands.handleSubmittedText('/workspace rv pick'), 'command');
  await new Promise((resolve) => setImmediate(resolve));
  const degraded = rig.channel.localReports.find((report) => report.title === 'pick one');
  assert.deepEqual(degraded?.lines, ['Choice A', 'Choice B']);

  // Target result switches the workspace.
  assert.equal(commands.handleSubmittedText('/workspace review go'), 'command');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(switched.length, 1);

  // Unknown subcommand notifies without touching providers.
  assert.equal(commands.handleSubmittedText('/workspace nope'), 'command');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(rig.channel.notifyLog.some((entry) => /Unknown workspace command: nope/.test(entry.text)));
  replayEquivalence(rig);
});

test('controller commands: external command registry truth (undefined/empty/text)', async () => {
  const { commands, rig } = commandsFor(createControllerRig({ height: 5 }));
  const results: Record<string, string | undefined> = {
    deploy: 'deployed ok',
    silent: '',
  };
  rig.channel.commandList = [
    { name: 'deploy', description: '', external: true },
    { name: 'silent', description: '', external: true },
    { name: 'missing', description: '', external: true },
  ] as LocalCommand[];
  rig.channel.runExternalCommand = async (name) => results[name];

  assert.equal(commands.handleSubmittedText('/deploy now'), 'command');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(rig.channel.notifyLog.some((entry) => entry.text === 'deployed ok'));

  assert.equal(commands.handleSubmittedText('/silent'), 'command');
  const notifyCount = rig.channel.notifyLog.length;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rig.channel.notifyLog.length, notifyCount, "'' result stays silent");

  assert.equal(commands.handleSubmittedText('/missing'), 'command');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(rig.channel.notifyLog.some((entry) => /Command not found: \/missing/.test(entry.text)));
  replayEquivalence(rig);
});

test('controller commands: skill entries are completion-only (fall through to the model)', () => {
  const { commands, rig } = commandsFor(createControllerRig({ height: 5 }));
  rig.channel.commandList = [{ name: 'review', description: '', skill: true } as LocalCommand];

  assert.equal(commands.handleSubmittedText('/review src/foo.ts'), 'submitted');
  assert.equal(rig.channel.submitted[0], '/review src/foo.ts');
});

test('controller commands: unsupported built-in locals never leak to the model', () => {
  const { commands, rig } = commandsFor(createControllerRig({ height: 5 }));
  rig.channel.commandList = [{ name: 'status', description: 'Show status' } as LocalCommand];

  assert.equal(commands.handleSubmittedText('/status'), 'command');
  assert.equal(rig.channel.submitted.length, 0);
  assert.ok(rig.channel.notifyLog.some((entry) => /Unsupported command/.test(entry.text)));
});

test('controller commands: a newer submission supersedes a stale async command', async () => {
  const { commands, rig } = commandsFor(createControllerRig({ height: 5 }));
  rig.channel.commandList = [{ name: 'deploy', description: '', external: true } as LocalCommand];
  let releaseFirst!: (value: string | undefined) => void;
  const gated = new Promise<string | undefined>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  rig.channel.runExternalCommand = async () => {
    calls += 1;
    return calls === 1 ? gated : 'second done';
  };

  commands.handleSubmittedText('/deploy one');
  commands.handleSubmittedText('/deploy two');
  releaseFirst('first done');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    rig.channel.notifyLog.some((entry) => entry.text === 'second done'),
    'the fresh command surfaced',
  );
  assert.ok(
    !rig.channel.notifyLog.some((entry) => entry.text === 'first done'),
    'the superseded command was dropped',
  );
  assert.equal(commands.diagnostics().superseded, 1);
});
