/**
 * Cordis facade over the tui-v2 plugin UI runtime (WP-08a, plan §7.4).
 *
 * BREAKING (v2 scene API): the React scene contract (`TuiSceneProps` /
 * `TuiSceneDescriptor` with a `component`, the `./scenes` and `./jsx-runtime`
 * package exports, the channel/Chat React render path) is removed. Scenes are
 * now `SceneDescriptorV2` registrations handled by the Cordis-free runtime in
 * `src/tui-v2/scenes/runtime.js`; this module only resolves the caller's
 * activation, verified Component identity, grant gate and effect ledger, then
 * delegates. Old React descriptors fail the `apiVersion` gate and come back
 * as a structured `{ status: 'rejected', code: 'unsupported-scene-api' }`.
 *
 * Grant gate (§7.4 注册时 grant 校验): every `requiredGrants` entry is a
 * permission name evaluated against the live GrantStore with the canonical
 * enforceable scope for that permission kind — storage permissions bind to
 * the plugin's own component id, intercept permissions to their event point,
 * `messages.observe.read` to the `session:*` wildcard. Permissions without a
 * derivable scope (e.g. `commands.invoke`, whose scope is a concrete command
 * id a scene descriptor cannot name) can never satisfy the gate and reject
 * the registration with `missing-grant` — fail closed, never guessed.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SceneDescriptorV2, SceneRegistrationHandle } from '../tui-v2/scenes/contract.js'
import {
  createPluginUIRuntime,
  type PluginRowRenderer,
  type PluginUIRuntime,
} from '../tui-v2/scenes/runtime.js'
import {
  INTERCEPT_EVENT_SCOPE_BY_PERMISSION,
  STORAGE_PERMISSIONS,
} from '../plugin-spec/permission-scope.js'
import { activationFiber, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import { componentIdentityOf } from './component-identity.js'
import type { TuiPluginHost } from './plugin-host.js'

export type {
  PluginRowView,
  SceneCapabilityContext,
  SceneCommand,
  SceneCommandDescriptor,
  SceneComponentAdapter,
  SceneDescriptorV2,
  SceneRegistration,
  SceneRegistrationHandle,
  SceneV2,
  ToolRowView,
} from '../tui-v2/scenes/contract.js'
export type { PluginRowRenderer } from '../tui-v2/scenes/runtime.js'

/** Plugin-facing view of the currently open scene (legacy `active` parity:
 *  the descriptor object is gone, the id/plugin identity remains). */
export interface TuiActiveScene {
  readonly id: string
  readonly pluginId: string
}

/** Host-only scene controls; omitted from the plugin export surface. */
export interface TuiSceneHost {
  /** The Cordis-free runtime, for the v2 coordinator's `attach(hooks)`. */
  readonly runtime: PluginUIRuntime
  readonly active: TuiActiveScene | undefined
  open(id: string): boolean
  close(): void
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiScenes: TuiSceneRuntime
  }
}

/**
 * `ctx.tuiScenes` — SceneV2 registration + row renderers (plan §7.4).
 *
 * A plugin registers a scene once (`ctx.tuiScenes.register(descriptor)`,
 * keep the handle's `dispose`) and opens it from anywhere host-side —
 * typically its own dsh-commands handler: `ctx.tuiScenes.open('my-scene')`
 * plus a silent `success` result, so the conversation stays untouched while
 * the scene takes the whole terminal the way the trajectory scene does.
 * Command execution remains owned by dsh-commands; the scene's own typed
 * commands flow through its capability context (`SceneCommand`).
 */
export class TuiSceneRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiScenes')
    compositionRoot(ctx)
    const runtime = this
    const pluginRuntime = createPluginUIRuntime({
      hasGrant(pluginId, grant) {
        if (pluginId === 'undeclared') return false
        const store = ctx.get('tuiPluginHost')?.grants
        if (store === undefined) return false
        const scope = sceneGrantScope(grant, pluginId)
        if (scope === undefined) return false
        try {
          return store.allows({ componentId: pluginId }, grant, scope)
        } catch {
          return false // a throwing grant store fails closed
        }
      },
    })
    const state: SceneState = {
      runtime: pluginRuntime,
      owners: new Map(),
      listeners: new Set(),
      lastActive: undefined,
      host: undefined,
      logger: ctx.logger,
    }
    state.host = Object.freeze({
      runtime: pluginRuntime,
      get active() {
        return activeSceneOf(sceneStateFor(runtime))
      },
      open(id: string) {
        return sceneStateFor(runtime).runtime.open(id)
      },
      close() {
        void sceneStateFor(runtime).runtime.close()
      },
      subscribe(listener: () => void) {
        return sceneStateFor(runtime).runtime.subscribe(listener)
      },
    })
    // Re-dispatch the runtime's transition feed to owner-scoped listeners
    // (legacy subscribe parity: a plugin only hears about its own scenes).
    pluginRuntime.subscribe(() => pumpScenes(sceneStateFor(runtime)))
    sceneStates.set(this, state)
  }

  /**
   * Register a SceneV2 descriptor (plan §7.4). Returns the registration
   * handle — check `handle.result.status`: `accepted` carries the negotiated
   * apiVersion, `rejected` carries a structured code
   * (`unsupported-scene-api` for legacy React descriptors, `missing-grant`,
   * `duplicate-scene`) and an inert dispose. Shape violations (bad id,
   * malformed commands) are programmer errors and throw TypeError. Caller
   * identity and activation rules are unchanged from the legacy seam. The
   * optional trailing `identity` (the plugin's own ctx) only feeds the
   * effect ledger's pluginId — omitting it records `undeclared` (C-060).
   */
  register(descriptor: SceneDescriptorV2, identity?: Context): SceneRegistrationHandle {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.register', this)
    const activationOwner = activationFiber(caller)
    if (activationOwner === undefined) throw new Error('dsh-tui: tuiScenes.register requires a live activation')
    const callerIdentity = componentIdentityOf(caller)
    const suppliedIdentity = identity === undefined ? callerIdentity : componentIdentityOf(identity)
    if (identity !== undefined && callerIdentity !== undefined && suppliedIdentity !== callerIdentity) {
      throw new Error('dsh-tui: tuiScenes.register identity belongs to another activation')
    }
    const state = sceneStateFor(this)
    const handle = state.runtime.register(descriptor, {
      ...(suppliedIdentity === undefined ? {} : { pluginId: suppliedIdentity.componentId }),
    })
    if (handle.result.status === 'rejected') {
      caller.get('tuiEffectLedger')?.record(
        {
          operation: 'create',
          // The descriptor may be a legacy React one (no usable id); keep the
          // ledger row stable rather than echoing arbitrary input.
          resource: { kind: 'scene', id: ledgerSceneId(descriptor) },
          result: 'failed',
          errorCode: SCENE_REJECTION_ERROR_CODES[handle.result.code],
        },
        identity,
      )
      return handle
    }
    const sceneId = handle.result.descriptorId
    state.owners.set(sceneId, activationOwner)
    caller.get('tuiEffectLedger')?.record(
      { operation: 'create', resource: { kind: 'scene', id: sceneId }, result: 'applied' },
      identity,
    )
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      if (state.owners.get(sceneId) === activationOwner) state.owners.delete(sceneId)
      handle.dispose()
      caller.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'scene', id: sceneId }, result: 'applied' },
        identity,
      )
    }
    bindCallerEffect(caller, dispose)
    return Object.freeze({ result: handle.result, dispose })
  }

  /**
   * Register a v2 row renderer for the caller's plugin id (one per plugin;
   * §7.4 ToolRowView/PluginRowView in, Component or mutable string[] out).
   * Refusals follow the tuiRenderers convention: warn, inert dispose.
   */
  registerRowRenderer(renderer: PluginRowRenderer, identity?: Context): () => void {
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiScenes.registerRowRenderer', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiScenes.registerRowRenderer requires a live non-root plugin activation')
      return () => {}
    }
    const callerIdentity = componentIdentityOf(caller)
    const suppliedIdentity = identity === undefined ? callerIdentity : componentIdentityOf(identity)
    if (identity !== undefined && callerIdentity !== undefined && suppliedIdentity !== callerIdentity) {
      this.ctx.logger.warn('dsh-tui: tuiScenes.registerRowRenderer identity belongs to another activation')
      return () => {}
    }
    const state = sceneStateFor(this)
    const pluginId = suppliedIdentity?.componentId ?? 'undeclared'
    const dispose = state.runtime.registerRowRenderer(renderer, { pluginId })
    if (state.runtime.rowRendererFor(pluginId) !== renderer) {
      // Duplicate or invalid registration: the runtime returned an inert
      // dispose; mirror the refusal in the ledger and the log.
      this.ctx.logger.warn(`dsh-tui: tuiScenes.registerRowRenderer rejected a renderer for "${pluginId}"`)
      caller.get('tuiEffectLedger')?.record(
        {
          operation: 'create',
          resource: { kind: 'row-renderer', id: pluginId },
          result: 'failed',
          errorCode: 'DUPLICATE_CONTRIBUTION_ID',
        },
        identity,
      )
      return dispose
    }
    caller.get('tuiEffectLedger')?.record(
      { operation: 'create', resource: { kind: 'row-renderer', id: pluginId }, result: 'applied' },
      identity,
    )
    const tracked = () => {
      dispose()
      caller.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'row-renderer', id: pluginId }, result: 'applied' },
        identity,
      )
    }
    bindCallerEffect(caller, tracked)
    return tracked
  }

  /**
   * Swap the conversation for the named scene. Returns false (and warns)
   * when no plugin registered that id or the scene belongs to another
   * activation — a mistyped id must fail visibly in the log, not silently
   * do nothing in the UI.
   */
  open(id: string): boolean {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.open', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return false
    const state = sceneStateFor(this)
    const sceneId = String(id ?? '').trim().toLowerCase()
    const registration = state.runtime.registrationOf(sceneId)
    if (registration === undefined) {
      caller.logger.warn(`dsh-tui: no TUI scene registered as "${sceneId}"`)
      return false
    }
    if (state.owners.get(sceneId) !== owner) {
      caller.logger.warn(`dsh-tui: scene "${sceneId}" belongs to another activation`)
      return false
    }
    return state.runtime.open(sceneId)
  }

  close(): void {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.close', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return
    const state = sceneStateFor(this)
    const activeId = state.runtime.activeView()?.sceneId
    if (activeId === undefined) return
    if (state.owners.get(activeId) !== owner) {
      caller.logger.warn(`dsh-tui: scene "${activeId}" belongs to another activation`)
      return
    }
    void state.runtime.close()
  }

  /** The caller's own open scene, if any (legacy owner-scoped `active`). */
  get active(): TuiActiveScene | undefined {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.active', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return undefined
    const state = sceneStateFor(this)
    const current = activeSceneOf(state)
    return current !== undefined && state.owners.get(current.id) === owner ? current : undefined
  }

  /** UI-side change feed, owner-scoped: fired when a transition opens or
   *  closes a scene owned by the caller's activation. */
  subscribe(listener: () => void): () => void {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.subscribe', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return () => {}
    const state = sceneStateFor(this)
    const entry = { owner, listener }
    state.listeners.add(entry)
    const dispose = () => {
      state.listeners.delete(entry)
    }
    bindCallerEffect(caller, dispose)
    return dispose
  }
}

interface SceneState {
  readonly runtime: PluginUIRuntime
  /** sceneId → owning activation fiber (set at register, cleared at dispose). */
  readonly owners: Map<string, object>
  readonly listeners: Set<{ owner: object | undefined; listener: () => void }>
  lastActive: { readonly id: string; readonly owner: object | undefined } | undefined
  host: TuiSceneHost | undefined
  readonly logger: Context['logger']
}

const sceneStates = new WeakMap<TuiSceneRuntime, SceneState>()

const SCENE_REJECTION_ERROR_CODES = {
  'unsupported-scene-api': 'UNSUPPORTED_SCENE_API',
  'missing-grant': 'PERMISSION_NOT_GRANTED',
  'duplicate-scene': 'DUPLICATE_CONTRIBUTION_ID',
} as const

function sceneStateFor(runtime: TuiSceneRuntime): SceneState {
  const state = sceneStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiScenes host state is unavailable')
  return state
}

/**
 * Canonical enforceable scope for a scene grant (see the module header).
 * Returns undefined when the permission kind has no derivable scope — the
 * grant gate then fails closed.
 */
function sceneGrantScope(permission: string, componentId: string): string | undefined {
  if (STORAGE_PERMISSIONS.has(permission)) return componentId
  const eventScope = INTERCEPT_EVENT_SCOPE_BY_PERMISSION[permission]
  if (eventScope !== undefined) return eventScope
  if (permission === 'messages.observe.read') return 'session:*'
  return undefined
}

/** Stable ledger id even for legacy/garbage descriptors. */
function ledgerSceneId(descriptor: unknown): string {
  const id = (descriptor as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' && /^[a-z][a-z0-9_-]*$/u.test(id.trim().toLowerCase())
    ? id.trim().toLowerCase()
    : 'unregistered'
}

function activeSceneOf(state: SceneState): TuiActiveScene | undefined {
  const view = state.runtime.activeView()
  if (view === null) return undefined
  const registration = state.runtime.registrationOf(view.sceneId)
  if (registration === undefined) return undefined
  return Object.freeze({ id: view.sceneId, pluginId: registration.pluginId })
}

/** Owner-filtered fan-out of the runtime's transition feed (legacy parity:
 *  a listener scoped to activation A fires only when A's scene came or went). */
function pumpScenes(state: SceneState): void {
  const activeId = state.runtime.activeView()?.sceneId
  const currentOwner = activeId === undefined ? undefined : state.owners.get(activeId)
  const previousOwner = state.lastActive?.owner
  state.lastActive = activeId === undefined ? undefined : { id: activeId, owner: currentOwner }
  for (const entry of [...state.listeners]) {
    if (entry.owner !== undefined && entry.owner !== currentOwner && entry.owner !== previousOwner) continue
    try {
      entry.listener()
    } catch (error) {
      state.logger.warn('dsh-tui: tuiScenes subscriber threw: %o', error)
    }
  }
}

export function getHostSceneRuntime(runtime: TuiSceneRuntime | undefined): TuiSceneHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return sceneStateFor(runtime).host ?? undefined
  } catch {
    return undefined
  }
}

export default TuiSceneRuntime
