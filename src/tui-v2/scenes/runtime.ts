/**
 * Plugin UI runtime (WP-08a, plan §7.4): SceneV2 registration, capability
 * contexts, the coordinator-bound scene session (open/close/input/error
 * boundary) and plugin row renderers.
 *
 * This module is Cordis-free by construction. The dsh-adapter facade
 * (`src/dsh-adapter/scenes.ts`) resolves the caller's activation, verified
 * identity and effect ledger, then delegates to this runtime; the v2
 * coordinator attaches via `attach(hooks)` and drives render/input. A scene
 * never sees legacy component runtime, the Channel, the Cordis context, the TerminalWriter or
 * stdout — its only host handle is the minted `SceneCapabilityContext`
 * (§7.4 capability rules).
 *
 * Error boundary (§7.4, verbatim semantics): exceptions from the scene
 * factory, `render`, `handleInput`, `dispatch` and `onClose` become an
 * `app/error` event carrying the plugin/scene identity
 * (`{ pluginId, instanceId, sceneId, phase }`), the scene's capability is
 * revoked (further dispatch/close calls are inert; re-opening requires a
 * fresh registration), and the takeover lease is restored so the previous
 * layer comes back. Nothing ever propagates into the coordinator.
 *
 * Close/teardown run at most once per open instance; repeated `close()`
 * calls return the same completed promise (§7.4).
 *
 * Dependency rule (§4.3): model/renderer/terminal contracts only; no
 * dsh-adapter, no Cordis, no stdout.
 */
import type { AppEvent } from '../model/events.js'
import {
  isSerializableValue,
  type EventMeta,
  type SceneViewModel,
  type SerializableValue,
} from '../model/schema.js'
import type { Component } from '../renderer/component.js'
import type { ScreenTakeover, TakeoverLease, TakeoverToken } from '../terminal/lifecycle.js'
import type { TerminalInputEvent } from '../terminal/query.js'
import { createSceneComponentAdapter, type SceneAdapterErrorPhase, type SceneComponentAdapterInstance } from './adapter.js'
import {
  SCENE_API_VERSION,
  SUPPORTED_SCENE_API_VERSIONS,
  type PluginRowView,
  type SceneCapabilityContext,
  type SceneCommand,
  type SceneComponentAdapter,
  type SceneDescriptorV2,
  type SceneRegistration,
  type SceneRegistrationHandle,
  type SceneV2,
  type ToolRowView,
  type TuiSceneRuntimeV2Contract,
} from './contract.js'

// ---------------------------------------------------------------------------
// public host-facing types
// ---------------------------------------------------------------------------

/** Identity the facade resolved for the registering activation. */
export interface SceneRuntimeIdentity {
  /** Verified plugin id; absent identities register as 'undeclared' (C-060). */
  readonly pluginId?: string
}

/** Coordinator-side hooks handed over at `attach` time. */
export interface SceneHostHooks {
  readonly dispatch: (event: AppEvent) => void
  /** EventMeta factory bound to the 'plugin' source. */
  readonly nextMeta: (sourceSeq: string) => EventMeta
  readonly takeover: ScreenTakeover
  readonly requestRender: () => void
  readonly onDiagnostic?: (code: string, message: string, details?: Record<string, unknown>) => void
}

/**
 * v2 row renderer (§7.4): input is a serialized `ToolRowView` /
 * `PluginRowView`; output is a `Component` or a mutable `string[]`.
 * `undefined` falls back to the host's default row rendering.
 */
export type PluginRowRenderer = (view: ToolRowView | PluginRowView) => Component | readonly string[] | undefined

/** Throw points reported through `app/error` (§7.4). */
export type SceneErrorPhase = 'factory' | SceneAdapterErrorPhase | 'dispatch' | 'close'

/** Stable `app/error` code for every scene boundary failure. */
export const PLUGIN_SCENE_ERROR_CODE = 'PLUGIN_SCENE_ERROR'

export interface PluginUIRuntimeDiagnostics {
  readonly attached: boolean
  readonly registeredScenes: number
  readonly registeredRowRenderers: number
  readonly activeSceneId: string | null
  readonly openCount: number
  readonly errors: number
}

export interface PluginUIRuntime extends TuiSceneRuntimeV2Contract {
  /** Register a v2 row renderer for one plugin id (one per plugin). */
  registerRowRenderer(renderer: PluginRowRenderer, identity?: SceneRuntimeIdentity): () => void
  rowRendererFor(pluginId: string): PluginRowRenderer | undefined
  /** Coordinator binding; attaching twice without detach is a host bug. */
  attach(hooks: SceneHostHooks): void
  detach(): Promise<void>
  readonly attached: boolean
  /** Host-side open (the facade adds caller/owner checks). Sync accept; the
   *  mount (takeover lease + factory) completes on `whenIdle()`. */
  open(sceneId: string): boolean
  /** Close the active scene, if any. */
  close(reason?: 'user' | 'teardown'): Promise<void>
  activeView(): SceneViewModel | null
  activeAdapter(): SceneComponentAdapterInstance | null
  /** Route focused input to the active scene (error-boundary wrapped). */
  handleInput(event: string | TerminalInputEvent): void
  /** Settles when the pending mount and the active close have completed. */
  whenIdle(): Promise<void>
  /** Open/close/error transition feed. */
  subscribe(listener: () => void): () => void
  /** True while the registration's capability is revoked (error boundary). */
  isRevoked(sceneId: string): boolean
  /** Registration record lookup for the facade's owner scoping. */
  registrationOf(sceneId: string): { readonly pluginId: string; readonly instanceId: string } | undefined
  diagnostics(): PluginUIRuntimeDiagnostics
}

export interface PluginUIRuntimeOptions {
  /**
   * Grant gate (§7.4 注册时 grant 校验): must answer whether `pluginId`
   * currently holds `grant` (the facade decides the evaluation scope).
   * Absent or denying for any required grant rejects the registration with
   * `missing-grant` (fail closed).
   */
  readonly hasGrant?: (pluginId: string, grant: string) => boolean
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface SceneRecord {
  readonly sceneId: string
  readonly descriptor: SceneDescriptorV2
  readonly pluginId: string
  readonly instanceId: string
  revoked: boolean
  disposed: boolean
  /** The completed promise every later `close()` returns (§7.4 once-only). */
  lastClosePromise: Promise<void> | null
}

interface ActiveScene {
  readonly record: SceneRecord
  readonly context: SceneCapabilityContext
  readonly scene: SceneV2
  readonly lease: TakeoverLease
  view: SceneViewModel
  closed: boolean
  closePromise: Promise<void> | null
  adapter: SceneComponentAdapterInstance | null
}

const SCENE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u
let instanceCounter = 0

function rejected(code: 'unsupported-scene-api' | 'missing-grant' | 'duplicate-scene'): SceneRegistrationHandle {
  const result: SceneRegistration = Object.freeze({ status: 'rejected', code, supported: SUPPORTED_SCENE_API_VERSIONS })
  return Object.freeze({ result, dispose: () => {} })
}

function accepted(descriptorId: string): SceneRegistration {
  return Object.freeze({ status: 'accepted', apiVersion: SCENE_API_VERSION, descriptorId })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPluginUIRuntime(options: PluginUIRuntimeOptions = {}): PluginUIRuntime {
  const records = new Map<string, SceneRecord>()
  const rowRenderers = new Map<string, PluginRowRenderer>()
  const listeners = new Set<() => void>()
  let hooks: SceneHostHooks | null = null
  let active: ActiveScene | null = null
  let pendingMount: { readonly token: object; readonly record: SceneRecord; readonly promise: Promise<boolean> } | null = null
  /** In-flight close of the most recent active scene (closeActive clears
   *  `active` synchronously, so whenIdle must track the close separately). */
  let closing: Promise<void> | null = null
  let eventCounter = 0
  let openCount = 0
  let errors = 0

  const diagnostic = (code: string, message: string, details?: Record<string, unknown>): void => {
    try {
      hooks?.onDiagnostic?.(code, message, details)
    } catch {
      /* diagnostics never break the runtime */
    }
  }

  const sceneSourceSeq = (sceneId: string): string => `scene:${sceneId}:${++eventCounter}`

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        diagnostic('scene/listener-error', errorMessage(error))
      }
    }
  }

  // --------------------------------------------------------- registration

  const normalizeDescriptor = (descriptor: SceneDescriptorV2): SceneDescriptorV2 => {
    if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      throw new TypeError('dsh-tui: SceneDescriptorV2 must be an object')
    }
    const raw = descriptor as unknown as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
    if (!SCENE_ID_PATTERN.test(id)) throw new TypeError(`dsh-tui: invalid SceneV2 id: ${String(raw.id)}`)
    if (raw.title !== undefined && typeof raw.title !== 'string') {
      throw new TypeError('dsh-tui: SceneDescriptorV2.title must be a string')
    }
    if (!Array.isArray(raw.requiredGrants) || raw.requiredGrants.some((g) => typeof g !== 'string')) {
      throw new TypeError('dsh-tui: SceneDescriptorV2.requiredGrants must be an array of strings')
    }
    if (!Array.isArray(raw.commands)) {
      throw new TypeError('dsh-tui: SceneDescriptorV2.commands must be an array')
    }
    const seenCommands = new Set<string>()
    for (const command of raw.commands as unknown[]) {
      if (command === null || typeof command !== 'object' || Array.isArray(command)) {
        throw new TypeError('dsh-tui: SceneCommandDescriptor must be an object')
      }
      const c = command as Record<string, unknown>
      if (typeof c.commandId !== 'string' || c.commandId === '') {
        throw new TypeError('dsh-tui: SceneCommandDescriptor.commandId must be a non-empty string')
      }
      if (seenCommands.has(c.commandId)) {
        throw new TypeError(`dsh-tui: duplicate scene command id: ${c.commandId}`)
      }
      seenCommands.add(c.commandId)
      if (!Number.isInteger(c.schemaVersion) || (c.schemaVersion as number) < 0) {
        throw new TypeError('dsh-tui: SceneCommandDescriptor.schemaVersion must be a non-negative integer')
      }
      if (typeof c.validate !== 'function') {
        throw new TypeError('dsh-tui: SceneCommandDescriptor.validate must be a function')
      }
    }
    if (typeof raw.create !== 'function') {
      throw new TypeError('dsh-tui: SceneDescriptorV2.create must be a function')
    }
    return Object.freeze({
      apiVersion: SCENE_API_VERSION,
      id,
      ...(raw.title !== undefined ? { title: raw.title as string } : {}),
      requiredGrants: Object.freeze([...(raw.requiredGrants as string[])]),
      commands: Object.freeze([...(raw.commands as SceneDescriptorV2['commands'])]),
      create: raw.create as SceneDescriptorV2['create'],
    })
  }

  const register = (descriptor: SceneDescriptorV2, identity?: unknown): SceneRegistrationHandle => {
    // apiVersion gate first (§7.4): old legacy component runtime descriptors (a `component`
    // field, no apiVersion) land here, as does any future version skew.
    const apiVersion = (descriptor as { apiVersion?: unknown } | null | undefined)?.apiVersion
    if (apiVersion !== SCENE_API_VERSION) {
      return rejected('unsupported-scene-api')
    }
    // Shape invariants are programmer errors: TypeError, same convention as
    // validateAppEvent. Structured rejection covers runtime dispositions only.
    const normalized = normalizeDescriptor(descriptor)
    if (records.has(normalized.id)) {
      return rejected('duplicate-scene')
    }
    const pluginId =
      identity !== null && typeof identity === 'object' && typeof (identity as SceneRuntimeIdentity).pluginId === 'string'
        ? ((identity as SceneRuntimeIdentity).pluginId as string)
        : 'undeclared'
    let grantsOk = true
    for (const grant of normalized.requiredGrants) {
      let allowed = false
      try {
        allowed = options.hasGrant?.(pluginId, grant) === true
      } catch {
        allowed = false // a throwing grant store fails closed
      }
      if (!allowed) {
        grantsOk = false
        break
      }
    }
    if (!grantsOk) return rejected('missing-grant')
    const record: SceneRecord = {
      sceneId: normalized.id,
      descriptor: normalized,
      pluginId,
      instanceId: `scene-ins-${++instanceCounter}`,
      revoked: false,
      disposed: false,
      lastClosePromise: null,
    }
    records.set(record.sceneId, record)
    return Object.freeze({
      result: accepted(normalized.id),
      dispose: () => {
        if (record.disposed) return
        record.disposed = true
        record.revoked = true
        if (records.get(record.sceneId) === record) records.delete(record.sceneId)
        // Disposing the open scene's registration must not strand the user
        // on a dead screen (legacy parity): close it as a teardown.
        if (active?.record === record && !active.closed) void closeActive('teardown')
        notify()
      },
    })
  }

  // ------------------------------------------------------------- session

  const dispatchSceneError = (record: SceneRecord, phase: SceneErrorPhase, error: unknown): void => {
    errors += 1
    const h = hooks
    if (h === null) return
    h.dispatch({
      ...h.nextMeta(sceneSourceSeq(record.sceneId)),
      type: 'app/error',
      error: {
        code: PLUGIN_SCENE_ERROR_CODE,
        message: errorMessage(error),
        recoverable: true,
        details: {
          pluginId: record.pluginId,
          instanceId: record.instanceId,
          sceneId: record.sceneId,
          phase,
        },
      },
    })
  }

  const safeRestore = async (lease: TakeoverLease, reason: 'completed' | 'cancelled' | 'error' | 'teardown'): Promise<void> => {
    try {
      await hooks?.takeover.restore(lease.token, { reason })
    } catch (error) {
      // Restore must never propagate into the coordinator (§7.4).
      diagnostic('scene/restore-error', errorMessage(error), { sceneId: lease.token.id })
    }
  }

  /**
   * Close the active scene: model event → onClose (boundary-wrapped) →
   * takeover restore → re-render. Runs at most once per instance; repeated
   * calls return the same promise (§7.4).
   */
  const closeActive = (reason: 'user' | 'teardown' | 'error'): Promise<void> => {
    const instance = active
    if (instance === null) return Promise.resolve()
    if (instance.closePromise !== null) return instance.closePromise
    const record = instance.record
    instance.closed = true
    active = null
    // The promise is stored on BOTH the instance and the record up front:
    // repeated close() calls during or after the close return this same
    // result (§7.4 once-only semantics).
    const promise = (async () => {
      const h = hooks
      if (h !== null) {
        h.dispatch({
          ...h.nextMeta(sceneSourceSeq(record.sceneId)),
          type: 'scene/close',
          sceneId: record.sceneId,
          reason,
        })
      }
      // onClose is itself a boundary throw point (§7.4): report, keep closing.
      try {
        await instance.scene.onClose?.(reason)
      } catch (error) {
        record.revoked = true
        dispatchSceneError(record, 'close', error)
      }
      await safeRestore(instance.lease, reason === 'user' ? 'completed' : reason)
      hooks?.requestRender()
      notify()
    })()
    instance.closePromise = promise
    record.lastClosePromise = promise
    closing = promise
    void promise.finally(() => {
      if (closing === promise) closing = null
    })
    return promise
  }

  const boundaryError = (instance: ActiveScene, phase: SceneErrorPhase, error: unknown): void => {
    // §7.4 ordering: app/error with identity → revoke the capability →
    // ScreenTakeover.restore() brings the previous layer back (inside close).
    instance.record.revoked = true
    dispatchSceneError(instance.record, phase, error)
    void closeActive('error')
  }

  const mintContext = (record: SceneRecord, token: TakeoverToken): SceneCapabilityContext => {
    const context: SceneCapabilityContext = {
      pluginId: record.pluginId,
      instanceId: record.instanceId,
      sceneId: record.sceneId,
      takeover: token,
      dispatch(command: SceneCommand): void {
        dispatchSceneCommand(record, command)
      },
      close(reason: 'user' | 'error' = 'user'): Promise<void> {
        const instance = active
        if (instance === null || instance.record !== record) {
          // Already closed: the same completed result, forever (§7.4).
          return record.lastClosePromise ?? Promise.resolve()
        }
        return closeActive(reason)
      },
    }
    return Object.freeze(context)
  }

  const dispatchSceneCommand = (record: SceneRecord, command: SceneCommand): void => {
    const instance = active
    // Capability revoked / scene not active: dispatch is inert (§7.4).
    if (instance === null || instance.record !== record || instance.closed || record.revoked) return
    const h = hooks
    if (h === null) return
    const fail = (error: unknown): void => boundaryError(instance, 'dispatch', error)
    if (command === null || typeof command !== 'object' || Array.isArray(command)) {
      fail(new TypeError('SceneCommand must be an object'))
      return
    }
    switch ((command as { type?: unknown }).type) {
      case 'dispatch': {
        const { commandId, payload } = command as { commandId?: unknown; payload?: unknown }
        const declared = record.descriptor.commands.find((c) => c.commandId === commandId)
        if (declared === undefined) {
          fail(new Error(`dsh-tui: scene "${record.sceneId}" dispatched undeclared command "${String(commandId)}"`))
          return
        }
        if (!isSerializableValue(payload)) {
          fail(new TypeError(`dsh-tui: scene command "${declared.commandId}" payload is not a SerializableValue`))
          return
        }
        try {
          declared.validate(payload as SerializableValue)
        } catch (error) {
          fail(error)
          return
        }
        // The validated payload becomes the next immutable view (§7.4: the
        // host owns SceneViewModel; typed commands are the only mutation).
        instance.view = { sceneId: record.sceneId, revision: instance.view.revision + 1, data: payload as SerializableValue }
        h.dispatch({ ...h.nextMeta(sceneSourceSeq(record.sceneId)), type: 'scene/open', scene: instance.view })
        h.requestRender()
        return
      }
      case 'focus': {
        const target = (command as { target?: unknown }).target
        if (target !== 'scene' && target !== 'overlay') {
          fail(new TypeError(`dsh-tui: scene focus target must be scene|overlay (got ${String(target)})`))
          return
        }
        h.dispatch({ ...h.nextMeta(sceneSourceSeq(record.sceneId)), type: 'scene/focus', sceneId: record.sceneId, target })
        h.requestRender()
        return
      }
      case 'close': {
        const reason = (command as { reason?: unknown }).reason
        if (reason !== 'user' && reason !== 'error') {
          fail(new TypeError('dsh-tui: scene close reason must be user|error'))
          return
        }
        void contextClose(record, reason)
        return
      }
      default:
        fail(new TypeError(`dsh-tui: unknown scene command type ${String((command as { type?: unknown }).type)}`))
    }
  }

  const contextClose = (record: SceneRecord, reason: 'user' | 'error'): Promise<void> => {
    const instance = active
    if (instance === null || instance.record !== record) {
      return record.lastClosePromise ?? Promise.resolve()
    }
    return closeActive(reason)
  }

  const assertSceneShape = (scene: SceneV2, record: SceneRecord): void => {
    if (scene === null || typeof scene !== 'object') throw new TypeError('SceneV2 factory must return an object')
    if ((scene as SceneV2).apiVersion !== SCENE_API_VERSION) {
      throw new TypeError(`dsh-tui: SceneV2.apiVersion must be '${SCENE_API_VERSION}'`)
    }
    if ((scene as SceneV2).sceneId !== record.sceneId) {
      throw new TypeError(`dsh-tui: SceneV2.sceneId "${String((scene as SceneV2).sceneId)}" does not match descriptor "${record.sceneId}"`)
    }
    if (typeof (scene as SceneV2).render !== 'function') throw new TypeError('dsh-tui: SceneV2.render must be a function')
    if (typeof (scene as SceneV2).invalidate !== 'function') throw new TypeError('dsh-tui: SceneV2.invalidate must be a function')
  }

  const mount = async (record: SceneRecord, token: object): Promise<boolean> => {
    try {
      if (active !== null) {
        await closeActive('user')
        // Superseded while closing the previous scene. The pendingMount check
        // only runs after a real await: open() assigns pendingMount
        // synchronously right after invoking mount(), so the token always
        // resolves once a yield has happened.
        if (pendingMount?.token !== token) return false
      }
      const h = hooks
      if (h === null) return false
      let lease: TakeoverLease
      try {
        lease = await h.takeover.request('scene', `scene:${record.sceneId}`)
      } catch (error) {
        diagnostic('scene/takeover-rejected', errorMessage(error), { sceneId: record.sceneId })
        return false
      }
      if (pendingMount?.token !== token || hooks !== h) {
        // Superseded or detached while the lease was being issued.
        await safeRestore(lease, 'cancelled')
        return false
      }
      const context = mintContext(record, lease.token)
      let scene: SceneV2
      try {
        scene = record.descriptor.create(context)
        assertSceneShape(scene, record)
      } catch (error) {
        // Factory throw point (§7.4): app/error → revoke → restore.
        record.revoked = true
        dispatchSceneError(record, 'factory', error)
        await safeRestore(lease, 'error')
        notify()
        return false
      }
      const instance: ActiveScene = {
        record,
        context,
        scene,
        lease,
        view: { sceneId: record.sceneId, revision: 0, data: {} },
        closed: false,
        closePromise: null,
        adapter: null,
      }
      instance.adapter = createSceneComponentAdapter({
        scene,
        context,
        getView: () => instance.view,
        onError: (phase, error) => boundaryError(instance, phase, error),
        onInvalidated: () => hooks?.requestRender(),
      })
      active = instance
      openCount += 1
      h.dispatch({ ...h.nextMeta(sceneSourceSeq(record.sceneId)), type: 'scene/open', scene: instance.view })
      h.requestRender()
      notify()
      return true
    } catch (error) {
      // The error boundary must never let an exception reach the coordinator.
      diagnostic('scene/mount-error', errorMessage(error), { sceneId: record.sceneId })
      return false
    }
  }

  // ------------------------------------------------------------- facade

  const runtime: PluginUIRuntime = {
    register,

    registerRowRenderer(renderer: PluginRowRenderer, identity?: SceneRuntimeIdentity): () => void {
      if (typeof renderer !== 'function') {
        diagnostic('row-renderer/invalid', 'plugin row renderer must be a function')
        return () => {}
      }
      const pluginId = typeof identity?.pluginId === 'string' ? identity.pluginId : 'undeclared'
      if (rowRenderers.has(pluginId)) {
        diagnostic('row-renderer/duplicate', `a row renderer is already registered for "${pluginId}"`)
        return () => {}
      }
      rowRenderers.set(pluginId, renderer)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        if (rowRenderers.get(pluginId) === renderer) rowRenderers.delete(pluginId)
      }
    },

    rowRendererFor: (pluginId: string) => rowRenderers.get(pluginId),

    attach(nextHooks: SceneHostHooks): void {
      if (hooks !== null) throw new Error('dsh-tui: scene runtime is already attached to a coordinator')
      hooks = nextHooks
    },

    async detach(): Promise<void> {
      if (pendingMount !== null) pendingMount = null // in-flight mount cancels itself (hooks mismatch)
      try {
        if (active !== null) await closeActive('teardown')
      } finally {
        hooks = null
      }
    },

    get attached() {
      return hooks !== null
    },

    open(sceneId: string): boolean {
      const id = sceneId.trim().toLowerCase()
      const record = records.get(id)
      if (record === undefined) {
        diagnostic('scene/unknown', `no SceneV2 registered as "${id}"`)
        return false
      }
      if (record.revoked) {
        diagnostic('scene/revoked', `scene "${id}" capability was revoked; re-register to reopen`, { sceneId: id })
        return false
      }
      if (hooks === null) {
        diagnostic('scene/not-attached', 'scene runtime is not attached to a coordinator')
        return false
      }
      if ((active !== null && active.record === record && !active.closed) || pendingMount?.record === record) {
        return true
      }
      const token = {}
      const promise = mount(record, token)
      pendingMount = { token, record, promise }
      void promise.finally(() => {
        if (pendingMount?.token === token) pendingMount = null
      })
      return true
    },

    close: (reason: 'user' | 'teardown' = 'user') => closeActive(reason),

    activeView: () => (active === null ? null : active.view),

    activeAdapter: () => (active === null ? null : active.adapter),

    handleInput(event: string | TerminalInputEvent): void {
      const instance = active
      if (instance === null || instance.closed || instance.scene.handleInput === undefined) return
      try {
        instance.scene.handleInput(event)
      } catch (error) {
        boundaryError(instance, 'handleInput', error)
      }
    },

    async whenIdle(): Promise<void> {
      for (;;) {
        // closePromise is null (not undefined) on a live instance — `!= null`
        // excludes both, otherwise an active scene would spin this loop.
        const pending = [pendingMount?.promise, active?.closePromise, closing].filter((p) => p != null)
        if (pending.length === 0) return
        await Promise.allSettled(pending)
      }
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    isRevoked: (sceneId: string) => records.get(sceneId.trim().toLowerCase())?.revoked ?? false,

    registrationOf(sceneId: string) {
      const record = records.get(sceneId.trim().toLowerCase())
      return record === undefined
        ? undefined
        : { pluginId: record.pluginId, instanceId: record.instanceId }
    },

    diagnostics: () => ({
      attached: hooks !== null,
      registeredScenes: records.size,
      registeredRowRenderers: rowRenderers.size,
      activeSceneId: active?.record.sceneId ?? null,
      openCount,
      errors,
    }),
  }
  return runtime
}

/** Safe invocation of a plugin row renderer (§7.4: 插件异常不得破坏主 frame).
 *  Returns the renderer output, or undefined on absence/throw. */
export function invokeRowRenderer(
  runtime: PluginUIRuntime,
  pluginId: string,
  view: ToolRowView | PluginRowView,
  onError?: (error: unknown) => void,
): Component | readonly string[] | undefined {
  const renderer = runtime.rowRendererFor(pluginId)
  if (renderer === undefined) return undefined
  try {
    return renderer(view)
  } catch (error) {
    try {
      onError?.(error)
    } catch {
      /* diagnostics never break rendering */
    }
    return undefined
  }
}
