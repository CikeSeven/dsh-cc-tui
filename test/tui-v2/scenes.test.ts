/**
 * tui-v2 WP-08a plugin scene runtime tests (plan §7.4):
 *
 *  - registration matrix (apiVersion gate / grants / duplicates / shape
 *    violations) with the verbatim SceneRegistration result contract;
 *  - capability-context minting (leak-free: no writer/stdout/channel keys,
 *    opaque takeover token) and the typed-command dispatch gate;
 *  - the five error-boundary throw points (factory/render/handleInput/
 *    dispatch/onClose) → app/error PLUGIN_SCENE_ERROR → revoke → restore;
 *  - close/teardown once-only semantics (same completed promise);
 *  - the minimal ScreenTakeover (single lease, token identity, idempotent
 *    restore) and the SceneComponentAdapter bridge;
 *  - the `./tui-v2` package export surface (anchors present, React scene
 *    exports gone).
 *
 * Top-level names carry "scene"/"plugin"/"takeover" for pattern selection.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AppEvent } from '../../src/tui-v2/model/events.js'
import type { EventMeta, SceneViewModel, SerializableValue } from '../../src/tui-v2/model/schema.js'
import type { TerminalModeSnapshot } from '../../src/tui-v2/renderer/frame.js'
import { createSceneComponentAdapter } from '../../src/tui-v2/scenes/adapter.js'
import {
  SCENE_API_VERSION,
  SUPPORTED_SCENE_API_VERSIONS,
  type SceneCapabilityContext,
  type SceneDescriptorV2,
  type SceneV2,
} from '../../src/tui-v2/scenes/contract.js'
import {
  createPluginUIRuntime,
  invokeRowRenderer,
  PLUGIN_SCENE_ERROR_CODE,
  type PluginUIRuntime,
  type PluginUIRuntimeOptions,
  type SceneHostHooks,
} from '../../src/tui-v2/scenes/runtime.js'
import { createScreenTakeover, isMintedTakeoverToken } from '../../src/tui-v2/terminal/takeover.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Harness {
  runtime: PluginUIRuntime
  events: AppEvent[]
  renderRequests: number
  diagnostics: string[]
  restores: string[]
  takeover: ReturnType<typeof createScreenTakeover>
  lifecycle: { generation(): number; setGeneration(next: number): void }
}

function createHarness(options?: PluginUIRuntimeOptions, attach = true): Harness {
  const events: AppEvent[] = []
  const diagnostics: string[] = []
  const restores: string[] = []
  let renderRequests = 0
  let seq = 0
  let generation = 0
  const modeSnapshot = { alternateScreen: true } as unknown as TerminalModeSnapshot
  const lifecycle = {
    generation: () => generation,
    setGeneration: (next: number) => {
      generation = next
    },
    currentModeSnapshot: () => modeSnapshot,
  }
  const writer = {
    quiesce: async () => ({ generation, committedPatchSeq: 0 }),
    resume: () => {},
  }
  const takeover = createScreenTakeover({
    lifecycle,
    writer,
    onRestore: (_lease, reason) => restores.push(reason),
  })
  const runtime = createPluginUIRuntime(options)
  const hooks: SceneHostHooks = {
    dispatch: (event) => events.push(event),
    nextMeta: (sourceSeq): EventMeta => ({
      schemaVersion: 1,
      adapterInstanceId: 'scene-test',
      durableSessionId: 'scene-test',
      uiSessionGeneration: 'gen-1',
      resetEpoch: 0,
      sessionEpoch: 'gen-1:0',
      source: 'plugin',
      sourceSeq,
      seq: ++seq,
      at: 0,
    }),
    takeover,
    requestRender: () => {
      renderRequests += 1
    },
    onDiagnostic: (code) => diagnostics.push(code),
  }
  if (attach) runtime.attach(hooks)
  return {
    runtime,
    events,
    get renderRequests() {
      return renderRequests
    },
    diagnostics,
    restores,
    takeover,
    lifecycle,
  }
}

interface SceneSpies {
  createdWith: SceneCapabilityContext[]
  renderViews: SceneViewModel[]
  input: unknown[]
  closed: Array<'user' | 'teardown' | 'error'>
  invalidated: number
  throws?: { factory?: unknown; render?: unknown; handleInput?: unknown; onClose?: unknown }
}

function sceneDescriptor(id: string, spies: SceneSpies, commands: SceneDescriptorV2['commands'] = []): SceneDescriptorV2 {
  return {
    apiVersion: '2',
    id,
    requiredGrants: [],
    commands,
    create(context) {
      if (spies.throws?.factory !== undefined) throw spies.throws.factory
      spies.createdWith.push(context)
      const scene: SceneV2 = {
        apiVersion: '2',
        sceneId: id,
        focused: false,
        render(view) {
          if (spies.throws?.render !== undefined) throw spies.throws.render
          spies.renderViews.push(view)
          return [`scene ${id} rev ${view.revision}`]
        },
        handleInput(event) {
          if (spies.throws?.handleInput !== undefined) throw spies.throws.handleInput
          spies.input.push(event)
        },
        invalidate() {
          spies.invalidated += 1
        },
        onClose(reason) {
          if (spies.throws?.onClose !== undefined) throw spies.throws.onClose
          spies.closed.push(reason)
        },
      }
      return scene
    },
  }
}

const refreshCommand: SceneDescriptorV2['commands'][number] = {
  commandId: 'refresh',
  schemaVersion: 1,
  validate(payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('refresh payload must be an object')
    }
  },
}

function errors(h: Harness): Array<Extract<AppEvent, { type: 'app/error' }>> {
  return h.events.filter((event) => event.type === 'app/error')
}

async function openAndIdle(h: Harness, id: string): Promise<boolean> {
  const accepted = h.runtime.open(id)
  await h.runtime.whenIdle()
  return accepted
}

// ---------------------------------------------------------------------------
// registration matrix
// ---------------------------------------------------------------------------

test('scene registration matrix: apiVersion gate, grants, duplicates, shape violations', async () => {
  const h = createHarness()
  const spies: SceneSpies = { createdWith: [], renderViews: [], input: [], closed: [], invalidated: 0 }

  const accepted = h.runtime.register(sceneDescriptor('demo', spies), { pluginId: 'plugin-a' })
  assert.equal(accepted.result.status, 'accepted')
  if (accepted.result.status === 'accepted') {
    assert.equal(accepted.result.apiVersion, '2')
    assert.equal(accepted.result.descriptorId, 'demo')
  }

  // Legacy React descriptor (no apiVersion, a component field): structured
  // rejection, not a throw — this is where every old registration lands.
  const legacy = h.runtime.register({ id: 'legacy', component: () => null } as never)
  assert.equal(legacy.result.status, 'rejected')
  if (legacy.result.status === 'rejected') {
    assert.equal(legacy.result.code, 'unsupported-scene-api')
    assert.deepEqual(legacy.result.supported, SUPPORTED_SCENE_API_VERSIONS)
  }
  // Rejected handles dispose inertly.
  legacy.dispose()

  for (const apiVersion of ['1', '3', 2, undefined] as const) {
    const rejected = h.runtime.register({ ...sceneDescriptor('skew', spies), apiVersion } as never)
    assert.equal(rejected.result.status, 'rejected')
    if (rejected.result.status === 'rejected') assert.equal(rejected.result.code, 'unsupported-scene-api')
  }

  // Duplicate ids reject case-insensitively.
  const duplicate = h.runtime.register(sceneDescriptor('DEMO', spies))
  assert.equal(duplicate.result.status, 'rejected')
  if (duplicate.result.status === 'rejected') assert.equal(duplicate.result.code, 'duplicate-scene')

  // Shape violations are programmer errors: TypeError (validateAppEvent rule).
  const base = sceneDescriptor('shape', spies) as unknown as Record<string, unknown>
  assert.throws(() => h.runtime.register({ ...base, id: 'not a scene id' } as never), TypeError)
  assert.throws(() => h.runtime.register({ ...base, requiredGrants: 'x' } as never), TypeError)
  assert.throws(() => h.runtime.register({ ...base, commands: 'x' } as never), TypeError)
  assert.throws(
    () => h.runtime.register({ ...base, commands: [refreshCommand, refreshCommand] } as never),
    /duplicate scene command id/,
  )
  assert.throws(
    () => h.runtime.register({ ...base, commands: [{ ...refreshCommand, schemaVersion: -1 }] } as never),
    TypeError,
  )
  assert.throws(
    () => h.runtime.register({ ...base, commands: [{ ...refreshCommand, validate: 1 }] } as never),
    TypeError,
  )
  assert.throws(() => h.runtime.register({ ...base, create: undefined } as never), TypeError)

  // Grant gate: absent gate / deny / throw all fail closed with missing-grant.
  const needingGrant: SceneDescriptorV2 = { ...sceneDescriptor('gated', spies), requiredGrants: ['storage.local.read'] }
  const noGate = createHarness()
  const rejectedNoGate = noGate.runtime.register(needingGrant)
  assert.equal(rejectedNoGate.result.status, 'rejected')
  if (rejectedNoGate.result.status === 'rejected') assert.equal(rejectedNoGate.result.code, 'missing-grant')
  const denying = createHarness({ hasGrant: () => false })
  assert.equal(denying.runtime.register(needingGrant).result.status, 'rejected')
  const throwing = createHarness({
    hasGrant: () => {
      throw new Error('grant store exploded')
    },
  })
  assert.equal(throwing.runtime.register(needingGrant).result.status, 'rejected')
  const granting = createHarness({ hasGrant: () => true })
  assert.equal(granting.runtime.register(needingGrant).result.status, 'accepted')

  await h.runtime.detach()
})

// ---------------------------------------------------------------------------
// capability context + dispatch gate
// ---------------------------------------------------------------------------

test('scene open mints a leak-free capability context and drives the model', async () => {
  const h = createHarness()
  const spies: SceneSpies = { createdWith: [], renderViews: [], input: [], closed: [], invalidated: 0 }
  h.runtime.register(sceneDescriptor('demo', spies, [refreshCommand]), { pluginId: 'plugin-a' })

  assert.equal(h.runtime.open('missing'), false)
  assert.ok(h.diagnostics.includes('scene/unknown'))

  assert.equal(await openAndIdle(h, 'DEMO'), true, 'open normalizes ids')
  assert.equal(spies.createdWith.length, 1)
  const context = spies.createdWith[0]!
  assert.deepEqual(
    Object.keys(context).sort(),
    ['close', 'dispatch', 'instanceId', 'pluginId', 'sceneId', 'takeover'],
    'capability context exposes exactly the §7.4 surface',
  )
  assert.equal(context.pluginId, 'plugin-a')
  assert.equal(context.sceneId, 'demo')
  assert.match(context.instanceId, /^scene-ins-/)
  assert.ok(isMintedTakeoverToken(context.takeover), 'takeover token is host-minted')
  assert.equal(typeof (context.takeover as { restore?: unknown }).restore, 'undefined', 'token carries no restore')

  const opened = h.events.filter((event) => event.type === 'scene/open')
  assert.equal(opened.length, 1)
  assert.deepEqual(opened[0], { ...opened[0]!, type: 'scene/open', scene: { sceneId: 'demo', revision: 0, data: {} } })
  assert.ok(h.renderRequests > 0)

  // A validated typed command makes its payload the next view (revision+1).
  context.dispatch({ type: 'dispatch', commandId: 'refresh', payload: { at: 1 } })
  assert.equal(h.runtime.activeView()?.revision, 1)
  assert.deepEqual(h.runtime.activeView()?.data, { at: 1 })
  assert.equal(h.events.filter((event) => event.type === 'scene/open').length, 2)

  // Focus command → scene/focus; close command → the close path.
  context.dispatch({ type: 'focus', target: 'scene' })
  assert.ok(h.events.some((event) => event.type === 'scene/focus' && event.target === 'scene'))
  context.dispatch({ type: 'close', reason: 'user' })
  await h.runtime.whenIdle()
  assert.deepEqual(spies.closed, ['user'])
  assert.ok(h.events.some((event) => event.type === 'scene/close' && event.reason === 'user'))
  assert.equal(h.runtime.activeView(), null)
  assert.ok(h.restores.includes('completed'), 'user close restores the takeover as completed')

  await h.runtime.detach()
})

test('scene dispatch gate rejects undeclared/invalid/throwing commands through the boundary', async () => {
  const h = createHarness()
  const spies: SceneSpies = { createdWith: [], renderViews: [], input: [], closed: [], invalidated: 0 }
  const firstHandle = h.runtime.register(sceneDescriptor('demo', spies, [refreshCommand]), { pluginId: 'plugin-a' })
  await openAndIdle(h, 'demo')
  const context = spies.createdWith[0]!

  // Undeclared commandId → app/error + revoke + restore; nothing propagates.
  context.dispatch({ type: 'dispatch', commandId: 'nope', payload: {} })
  await h.runtime.whenIdle()
  let sceneErrors = errors(h)
  assert.equal(sceneErrors.length, 1)
  assert.equal(sceneErrors[0]!.error.code, PLUGIN_SCENE_ERROR_CODE)
  assert.deepEqual(sceneErrors[0]!.error.details, {
    pluginId: 'plugin-a',
    instanceId: context.instanceId,
    sceneId: 'demo',
    phase: 'dispatch',
  })
  assert.equal(h.runtime.isRevoked('demo'), true)
  assert.equal(h.runtime.activeView(), null)
  assert.deepEqual(spies.closed, ['error'])

  // A revoked capability is inert; re-opening requires a fresh registration.
  context.dispatch({ type: 'dispatch', commandId: 'refresh', payload: { at: 2 } })
  assert.equal(errors(h).length, 1, 'revoked dispatch stays inert')
  assert.equal(h.runtime.open('demo'), false)
  assert.ok(h.diagnostics.includes('scene/revoked'))

  // The revoked record still holds the id: re-registration is a duplicate
  // until the old handle is disposed (revoke → dispose → register is the
  // §7.4 recovery sequence).
  const stillDuplicate = h.runtime.register(sceneDescriptor('demo', spies, [refreshCommand]), { pluginId: 'plugin-a' })
  assert.equal(stillDuplicate.result.status, 'rejected')
  if (stillDuplicate.result.status === 'rejected') assert.equal(stillDuplicate.result.code, 'duplicate-scene')
  firstHandle.dispose()
  h.runtime.register(sceneDescriptor('demo', spies, [refreshCommand]), { pluginId: 'plugin-a' })
  assert.equal(await openAndIdle(h, 'demo'), true)
  const context2 = spies.createdWith[1]!

  // Non-serializable payload → boundary.
  context2.dispatch({ type: 'dispatch', commandId: 'refresh', payload: (() => {}) as unknown as SerializableValue })
  await h.runtime.whenIdle()
  sceneErrors = errors(h)
  assert.equal(sceneErrors.length, 2)
  assert.equal(sceneErrors[1]!.error.code, PLUGIN_SCENE_ERROR_CODE)

  await h.runtime.detach()
})

// ---------------------------------------------------------------------------
// error boundary: the five throw points
// ---------------------------------------------------------------------------

test('scene error boundary covers factory/render/handleInput/onClose throw points', async () => {
  // factory
  {
    const h = createHarness()
    const spies: SceneSpies = {
      createdWith: [], renderViews: [], input: [], closed: [], invalidated: 0,
      throws: { factory: new Error('factory boom') },
    }
    h.runtime.register(sceneDescriptor('bad-factory', spies))
    assert.equal(await openAndIdle(h, 'bad-factory'), true, 'open is sync-accepted even when the factory fails')
    const sceneErrors = errors(h)
    assert.equal(sceneErrors.length, 1)
    assert.equal(sceneErrors[0]!.error.code, PLUGIN_SCENE_ERROR_CODE)
    assert.deepEqual(sceneErrors[0]!.error.details, {
      pluginId: 'undeclared',
      instanceId: sceneErrors[0]!.error.details !== undefined
        ? (sceneErrors[0]!.error.details as { instanceId: string }).instanceId
        : '',
      sceneId: 'bad-factory',
      phase: 'factory',
    })
    assert.match(sceneErrors[0]!.error.message, /factory boom/)
    assert.equal(h.runtime.isRevoked('bad-factory'), true)
    assert.equal(h.runtime.activeView(), null)
    assert.equal(h.takeover.current(), null, 'failed mount restores the lease')
    await h.runtime.detach()
  }

  // render
  {
    const h = createHarness()
    const spies: SceneSpies = {
      createdWith: [], renderViews: [], input: [], closed: [], invalidated: 0,
      throws: { render: new Error('render boom') },
    }
    h.runtime.register(sceneDescriptor('bad-render', spies))
    await openAndIdle(h, 'bad-render')
    const adapter = h.runtime.activeAdapter()
    assert.ok(adapter !== null)
    assert.deepEqual(adapter.render(80), [], 'an errored render yields zero lines, never a throw')
    await h.runtime.whenIdle()
    const sceneErrors = errors(h)
    assert.equal(sceneErrors.length, 1)
    assert.equal(sceneErrors[0]!.error.code, PLUGIN_SCENE_ERROR_CODE)
    assert.equal((sceneErrors[0]!.error.details as { phase?: unknown }).phase, 'render')
    assert.equal(h.runtime.activeView(), null)
    await h.runtime.detach()
  }

  // handleInput
  {
    const h = createHarness()
    const spies: SceneSpies = {
      createdWith: [], renderViews: [], input: [], closed: [], invalidated: 0,
      throws: { handleInput: new Error('input boom') },
    }
    h.runtime.register(sceneDescriptor('bad-input', spies))
    await openAndIdle(h, 'bad-input')
    h.runtime.handleInput('x')
    await h.runtime.whenIdle()
    const sceneErrors = errors(h)
    assert.equal(sceneErrors.length, 1)
    assert.equal((sceneErrors[0]!.error.details as { phase?: unknown }).phase, 'handleInput')
    assert.equal(h.runtime.activeView(), null)
    await h.runtime.detach()
  }

  // onClose: the close still completes; the error is reported.
  {
    const h = createHarness()
    const spies: SceneSpies = {
      createdWith: [], renderViews: [], input: [], closed: [], invalidated: 0,
      throws: { onClose: new Error('close boom') },
    }
    h.runtime.register(sceneDescriptor('bad-close', spies))
    await openAndIdle(h, 'bad-close')
    await h.runtime.close()
    await h.runtime.whenIdle()
    const sceneErrors = errors(h)
    assert.equal(sceneErrors.length, 1)
    assert.equal((sceneErrors[0]!.error.details as { phase?: unknown }).phase, 'close')
    assert.equal(h.runtime.activeView(), null)
    assert.equal(h.runtime.isRevoked('bad-close'), true)
    assert.ok(h.restores.includes('completed'))
    await h.runtime.detach()
  }
})

test('scene close is once-only: repeated close returns the same completed promise', async () => {
  const h = createHarness()
  const spies: SceneSpies = { createdWith: [], renderViews: [], input: [], closed: [], invalidated: 0 }
  h.runtime.register(sceneDescriptor('demo', spies))
  await openAndIdle(h, 'demo')
  const context = spies.createdWith[0]!

  const first = context.close()
  const second = context.close()
  assert.equal(first, second, 'concurrent closes share one promise')
  await first
  const third = context.close()
  assert.equal(third, first, 'post-close calls return the same completed result')
  await h.runtime.whenIdle()
  assert.deepEqual(spies.closed, ['user'], 'onClose ran exactly once')

  // close() with no active scene resolves without events.
  const before = h.events.length
  await h.runtime.close()
  assert.equal(h.events.length, before)

  // Detach tears an open scene down exactly once.
  assert.equal(await openAndIdle(h, 'demo'), true)
  await h.runtime.detach()
  assert.deepEqual(spies.closed, ['user', 'teardown'])
})

// ---------------------------------------------------------------------------
// adapter bridge
// ---------------------------------------------------------------------------

test('scene component adapter: pass-through, validation, focus and cursor delegation', () => {
  const errors: Array<{ phase: string; error: unknown }> = []
  let view: SceneViewModel = { sceneId: 'demo', revision: 0, data: {} }
  const scene: SceneV2 = {
    apiVersion: '2',
    sceneId: 'demo',
    focused: false,
    cursor: { x: 2, y: 3, visible: true },
    render: (v, width) => [`w=${width} rev=${v.revision}`, 'tail'],
    invalidate: () => {},
  }
  const context = {
    pluginId: 'p', instanceId: 'i', sceneId: 'demo',
    takeover: {} as SceneCapabilityContext['takeover'],
    dispatch: () => {},
    close: async () => {},
  }
  let invalidated = 0
  const adapter = createSceneComponentAdapter({
    scene,
    context,
    getView: () => view,
    onError: (phase, error) => errors.push({ phase, error }),
    onInvalidated: () => {
      invalidated += 1
    },
  })
  assert.equal(adapter.scene, scene)
  assert.deepEqual(adapter.render(80), ['w=80 rev=0', 'tail'])
  assert.deepEqual(adapter.render(0), [], 'invalid width yields no lines')
  assert.equal(errors.length, 0)
  view = { sceneId: 'demo', revision: 1, data: {} }
  assert.deepEqual(adapter.render(40), ['w=40 rev=1', 'tail'], 'the host-owned view swap is visible')
  adapter.focused = true
  assert.equal(adapter.focused, true)
  assert.deepEqual(adapter.cursor, { x: 2, y: 3, visible: true }, 'cursor delegates to the scene')
  adapter.handleInput('key')
  adapter.invalidate()
  assert.equal(invalidated, 1)

  const malformed: SceneV2 = { ...scene, render: () => ['ok', 42] as unknown as string[] }
  const bad = createSceneComponentAdapter({
    scene: malformed,
    context,
    getView: () => view,
    onError: (phase, error) => errors.push({ phase, error }),
  })
  assert.deepEqual(bad.render(80), [])
  assert.equal(errors.length, 1)
  assert.equal(errors[0]!.phase, 'render')
  assert.ok(errors[0]!.error instanceof TypeError)
})

// ---------------------------------------------------------------------------
// takeover
// ---------------------------------------------------------------------------

test('screen takeover: single lease, token identity, idempotent restore', async () => {
  const restored: Array<string> = []
  let generation = 0
  const takeover = createScreenTakeover({
    lifecycle: {
      generation: () => generation,
      setGeneration: (next) => {
        generation = next
      },
      currentModeSnapshot: () => ({}) as TerminalModeSnapshot,
    },
    writer: { quiesce: async () => ({ generation, committedPatchSeq: 7 }), resume: () => {} },
    onRestore: (lease, reason) => restored.push(`${lease.token.id}:${reason}`),
  })

  const lease = await takeover.request('scene', 'scene:demo')
  assert.ok(isMintedTakeoverToken(lease.token))
  assert.equal(takeover.current()?.token, lease.token)

  // A second request while held is rejected; the holder keeps the screen.
  await assert.rejects(() => takeover.request('external-editor', 'editor'), /busy/)
  assert.equal(takeover.current()?.token, lease.token)

  // A foreign token can never release somebody else's lease.
  const foreign = { id: 'forged', ownerKind: 'scene', generation: 0 } as unknown as typeof lease.token
  assert.equal(isMintedTakeoverToken(foreign), false)
  await assert.rejects(() => takeover.restore(foreign), /rejected/)
  assert.equal(takeover.current()?.token, lease.token)

  // Restore is idempotent: same promise, one generation bump, one host hook.
  const first = takeover.restore(lease.token, { reason: 'completed' })
  const second = takeover.restore(lease.token, { reason: 'completed' })
  assert.equal(first, second)
  await first
  assert.equal(generation, 1)
  assert.deepEqual(restored, [`${lease.token.id}:completed`])
  assert.equal(takeover.current(), null)
  const third = takeover.restore(lease.token)
  assert.equal(third, first, 'a later restore of the same token replays the completed result')
  await third
  assert.equal(generation, 1)

  // The gate reopens after a restore.
  const next = await takeover.request('scene', 'scene:next')
  assert.equal(takeover.current()?.token, next.token)
  await takeover.restore(next.token, { reason: 'teardown' })
  assert.deepEqual(restored, [`${lease.token.id}:completed`, `${next.token.id}:teardown`])
})

// ---------------------------------------------------------------------------
// row renderers
// ---------------------------------------------------------------------------

test('plugin row renderer: registration, duplicate refusal, safe invocation', () => {
  const h = createHarness()
  const renderer = (view: { rowId: string }) => [`row ${view.rowId}`]
  const dispose = h.runtime.registerRowRenderer(renderer, { pluginId: 'plugin-a' })
  assert.equal(h.runtime.rowRendererFor('plugin-a'), renderer)
  const duplicate = h.runtime.registerRowRenderer(() => undefined, { pluginId: 'plugin-a' })
  duplicate()
  assert.equal(h.runtime.rowRendererFor('plugin-a'), renderer, 'duplicate dispose is inert')
  assert.ok(h.diagnostics.includes('row-renderer/duplicate'))

  assert.deepEqual(invokeRowRenderer(h.runtime, 'plugin-a', { rowId: 'r1', revision: 0, pluginId: 'plugin-a', data: {} }), ['row r1'])
  assert.equal(invokeRowRenderer(h.runtime, 'nobody', { rowId: 'r1', revision: 0, pluginId: 'nobody', data: {} }), undefined)
  const boom = () => {
    throw new Error('renderer boom')
  }
  h.runtime.registerRowRenderer(boom, { pluginId: 'plugin-b' })
  let reported: unknown
  assert.equal(
    invokeRowRenderer(h.runtime, 'plugin-b', { rowId: 'r2', revision: 0, pluginId: 'plugin-b', data: {} }, (error) => {
      reported = error
    }),
    undefined,
  )
  assert.ok(reported instanceof Error)

  dispose()
  assert.equal(h.runtime.rowRendererFor('plugin-a'), undefined)
  dispose()
})

// ---------------------------------------------------------------------------
// package export surface
// ---------------------------------------------------------------------------

test('tui-v2 package export: anchors present, legacy React scene exports removed', async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>
  }
  assert.ok('./tui-v2' in manifest.exports, 'the versioned ./tui-v2 export exists')
  assert.ok(!('./scenes' in manifest.exports), './scenes is gone')
  assert.ok(!('./jsx-runtime' in manifest.exports), './jsx-runtime is gone')

  const entry = await import('../../src/tui-v2/index.js')
  assert.equal(entry.SCENE_API_VERSION, SCENE_API_VERSION)
  assert.deepEqual([...entry.SUPPORTED_SCENE_API_VERSIONS], ['2'])
  // The capability export is contract + anchors only: no runtime, no vendor,
  // no adapter internals.
  assert.deepEqual(Object.keys(entry).sort(), ['SCENE_API_VERSION', 'SUPPORTED_SCENE_API_VERSIONS'])
})
