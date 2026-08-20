/**
 * tui-v2 WP-08a scene × coordinator integration: a SceneV2 registered on the
 * plugin UI runtime takes over the whole viewport through the coordinator's
 * scene frame path, owns the keyboard while `focus.target === 'scene'`, and
 * the previous layer comes back on close — on both backend profiles.
 *
 * Chain under test:
 *
 *   createPluginUIRuntime → coordinator attach → ScreenTakeover lease →
 *   scene/open reducer event → renderOnce scene branch → buildFrame →
 *   backend → TerminalWriter → VirtualTerminal
 *
 * and the input path (stdin → InputSource → focus 'scene' → scene.handleInput)
 * plus the error boundary landing in the model as app/error.
 *
 * Top-level names carry "scene"/"plugin" for pattern selection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { createTuiV2Coordinator } from '../../src/tui-v2/app/coordinator.js';
import type { Clock } from '../../src/tui-v2/model/schema.js';
import {
  createPluginUIRuntime,
  PLUGIN_SCENE_ERROR_CODE,
  type PluginUIRuntime,
} from '../../src/tui-v2/scenes/runtime.js';
import type { SceneCapabilityContext, SceneDescriptorV2 } from '../../src/tui-v2/scenes/contract.js';
import { unknownConservativeDefaults, type TerminalProfile } from '../../src/tui-v2/terminal/profile.js';
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js';
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js';
import { createFakeChannel } from './helpers/fake-channel.js';

class FakeStdin extends PassThrough {
  readonly isTTY = true;
  override setRawMode(_raw: boolean): void {}
}

class VtStream extends Writable {
  constructor(private readonly vt: VirtualTerminal) {
    super();
  }
  override _write(chunk: unknown, _enc: string, cb: (error?: Error | null) => void): void {
    this.vt.write(String(chunk));
    cb();
  }
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

async function waitForReal(condition: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitForReal deadline exceeded');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function screenText(vt: VirtualTerminal): string {
  const snapshot = vt.snapshot();
  const lines: string[] = [];
  for (let y = 0; y < snapshot.height; y++) {
    lines.push(
      snapshot.cells
        .slice(y * snapshot.width, (y + 1) * snapshot.width)
        .map((cell) => cell.grapheme)
        .join(''),
    );
  }
  return lines.join('\n');
}

interface Rig {
  stdin: FakeStdin;
  vt: VirtualTerminal;
  coordinator: ReturnType<typeof createTuiV2Coordinator>;
  scenes: PluginUIRuntime;
  diagnostics: string[];
}

function buildRig(profileId: 'kitty-sync' | 'unknown-conservative'): Rig {
  const base = profileId === 'kitty-sync' ? getProfile('kitty-sync') : unknownConservativeDefaults();
  const profile: TerminalProfile = { ...base, columns: 100, rows: 30 };
  const stdin = new FakeStdin();
  const stdout = { columns: 100, rows: 30, isTTY: true };
  const vt = new VirtualTerminal(profile);
  const stream = new VtStream(vt);
  const scenes = createPluginUIRuntime();
  const diagnostics: string[] = [];
  const coordinator = createTuiV2Coordinator({
    channel: createFakeChannel(),
    stdin,
    stdout,
    stream,
    profile,
    clock: realClock,
    welcomeText: 'scene-rig-welcome',
    attachProcessHandlers: false,
    onDiagnostic: (d) => diagnostics.push(d.code),
    scenes,
  });
  return { stdin, vt, coordinator, scenes, diagnostics };
}

interface DemoScene {
  context: SceneCapabilityContext | null;
  input: string[];
  renderCount: number;
  throwOnRender: boolean;
}

function demoScene(id: string, demo: DemoScene): SceneDescriptorV2 {
  return {
    apiVersion: '2',
    id,
    requiredGrants: [],
    commands: [
      {
        commandId: 'bump',
        schemaVersion: 1,
        validate(payload) {
          if (payload === null || typeof payload !== 'object') throw new TypeError('bump payload must be an object');
        },
      },
    ],
    create(context) {
      demo.context = context;
      return {
        apiVersion: '2',
        sceneId: id,
        focused: false,
        render(view) {
          demo.renderCount += 1;
          if (demo.throwOnRender) throw new Error('scene render exploded');
          const marker = typeof view.data === 'object' && view.data !== null && 'marker' in view.data ? String(view.data.marker) : 'none';
          return [`PLUGIN-SCENE ${id}`, `marker: ${marker}`];
        },
        handleInput(event) {
          demo.input.push(typeof event === 'string' ? event : event.kind);
        },
        invalidate() {},
      };
    },
  };
}

for (const profileId of ['kitty-sync', 'unknown-conservative'] as const) {
  test(`plugin scene (${profileId}): open takes the viewport, owns input, close restores the conversation`, async () => {
    const rig = buildRig(profileId);
    await rig.coordinator.start();
    await waitForReal(() => screenText(rig.vt).includes('scene-rig-welcome'));

    const demo: DemoScene = { context: null, input: [], renderCount: 0, throwOnRender: false };
    const handle = rig.scenes.register(demoScene('demo', demo), { pluginId: 'plugin-demo' });
    assert.equal(handle.result.status, 'accepted');

    assert.equal(rig.scenes.open('demo'), true);
    await rig.scenes.whenIdle();
    await waitForReal(() => screenText(rig.vt).includes('PLUGIN-SCENE demo'));
    assert.equal(rig.coordinator.state.focus.target, 'scene');
    assert.equal(rig.coordinator.state.scene?.view.sceneId, 'demo');

    // The scene owns the keyboard while focused (plain keys included).
    rig.stdin.write('x');
    await waitForReal(() => demo.input.length > 0);

    // A validated typed command becomes the next view; the frame follows.
    demo.context!.dispatch({ type: 'dispatch', commandId: 'bump', payload: { marker: 'updated-by-command' } });
    await waitForReal(() => screenText(rig.vt).includes('marker: updated-by-command'));
    assert.equal(rig.coordinator.state.scene?.view.revision, 1);

    // Close through the capability: the conversation layer comes back.
    await demo.context!.close();
    await rig.scenes.whenIdle();
    await waitForReal(() => screenText(rig.vt).includes('scene-rig-welcome') && !screenText(rig.vt).includes('PLUGIN-SCENE'));
    assert.equal(rig.coordinator.state.scene, null);
    assert.notEqual(rig.coordinator.state.focus.target, 'scene');

    await rig.coordinator.stop('user-exit');
    await rig.coordinator.awaitStop();
    assert.equal(rig.coordinator.phase, 'stopped');
  });
}

test('plugin scene error boundary (kitty-sync): a render throw lands as app/error and restores the layer', async () => {
  const rig = buildRig('kitty-sync');
  await rig.coordinator.start();
  await waitForReal(() => screenText(rig.vt).includes('scene-rig-welcome'));

  const demo: DemoScene = { context: null, input: [], renderCount: 0, throwOnRender: false };
  rig.scenes.register(demoScene('fragile', demo), { pluginId: 'plugin-demo' });
  assert.equal(rig.scenes.open('fragile'), true);
  await rig.scenes.whenIdle();
  await waitForReal(() => screenText(rig.vt).includes('PLUGIN-SCENE fragile'));

  // The next frame's render throws: the boundary revokes the capability,
  // dispatches app/error and restores the previous layer.
  demo.throwOnRender = true;
  demo.context!.dispatch({ type: 'dispatch', commandId: 'bump', payload: { marker: 'trigger' } });
  await rig.scenes.whenIdle();
  await waitForReal(() => rig.coordinator.state.diagnostics.lastError?.code === PLUGIN_SCENE_ERROR_CODE);
  await waitForReal(() => screenText(rig.vt).includes('scene-rig-welcome') && !screenText(rig.vt).includes('PLUGIN-SCENE'));
  assert.equal(rig.coordinator.state.scene, null);
  assert.equal(rig.scenes.isRevoked('fragile'), true);
  assert.equal(rig.scenes.open('fragile'), false, 'a revoked scene cannot re-open without re-registration');

  await rig.coordinator.stop('user-exit');
  await rig.coordinator.awaitStop();
  assert.equal(rig.coordinator.phase, 'stopped');
});

test('plugin scene teardown (kitty-sync): coordinator stop detaches an open scene exactly once', async () => {
  const rig = buildRig('kitty-sync');
  await rig.coordinator.start();
  await waitForReal(() => screenText(rig.vt).includes('scene-rig-welcome'));

  const demo: DemoScene = { context: null, input: [], renderCount: 0, throwOnRender: false };
  let closeCount = 0;
  const descriptor = demoScene('stopping', demo);
  const originalCreate = descriptor.create;
  rig.scenes.register({
    ...descriptor,
    create(context) {
      const scene = originalCreate(context);
      return { ...scene, onClose: () => { closeCount += 1; } };
    },
  });
  assert.equal(rig.scenes.open('stopping'), true);
  await rig.scenes.whenIdle();
  await waitForReal(() => screenText(rig.vt).includes('PLUGIN-SCENE stopping'));

  await rig.coordinator.stop('user-exit');
  await rig.coordinator.awaitStop();
  assert.equal(rig.coordinator.phase, 'stopped');
  assert.equal(closeCount, 1, 'teardown ran onClose exactly once');
  assert.equal(rig.scenes.attached, false);
  assert.equal(rig.scenes.activeView(), null);
});
