/**
 * tui-v2 plugin scene + row contracts (WP-08a, plan §7.4).
 *
 * The type definitions in this module are verbatim from the development
 * plan — they are the FINAL plugin-facing surface. The old legacy component runtime scene
 * descriptor (`TuiSceneProps`/`TuiSceneDescriptor`, `./scenes` export) and
 * the `./jsx-runtime` export are deleted in the same breaking release; no
 * legacy adapter is provided. Old descriptors are rejected at registration
 * with a structured `unsupported-scene-api` result.
 *
 * Boundary rules (plan §7.4):
 *
 *  - A scene never receives legacy component runtime, the Channel, the Cordis context, the
 *    TerminalWriter or stdout — its only host handle is the capability
 *    context minted at registration/open.
 *  - `SceneV2.render()` returns a MUTABLE `string[]`; the single
 *    `SceneComponentAdapter` bridge feeds it into the v2 pipeline
 *    (`Component.render(width): string[]`). External read-only consumers
 *    must copy the array; a `readonly string[]` facade never reaches the
 *    renderer.
 *  - `takeover` is an opaque host-issued lease token: the scene cannot
 *    construct one and cannot restore the screen by itself.
 *
 * Dependency rule (§4.3): `import type` from model/renderer/terminal
 * contracts only; no runtime imports, no dsh-adapter, no legacy component runtime.
 */
import type { SceneViewModel, SerializableValue } from '../model/schema.js'
import type { Component, Focusable } from '../renderer/component.js'
import type { TakeoverToken } from '../terminal/lifecycle.js'
import type { TerminalInputEvent } from '../terminal/query.js'

// ---------------------------------------------------------------------------
// Verbatim plan §7.4 contract
// ---------------------------------------------------------------------------

export type SceneCommand =
  | { type: 'dispatch'; commandId: string; payload: SerializableValue }
  | { type: 'focus'; target: 'scene' | 'overlay' }
  | { type: 'close'; reason: 'user' | 'error' }

export interface SceneCapabilityContext {
  readonly pluginId: string
  readonly instanceId: string
  readonly sceneId: string
  readonly takeover: TakeoverToken
  dispatch(command: SceneCommand): void
  close(reason?: 'user' | 'error'): Promise<void>
}

export interface SceneV2 extends Focusable {
  readonly apiVersion: '2'
  readonly sceneId: string
  render(view: SceneViewModel, width: number, context: SceneCapabilityContext): string[]
  handleInput?(event: string | TerminalInputEvent): void
  invalidate(): void
  onClose?(reason: 'user' | 'teardown' | 'error'): void | Promise<void>
}

export interface SceneComponentAdapter extends Component {
  readonly scene: SceneV2
}

export interface SceneDescriptorV2 {
  apiVersion: '2'
  id: string
  title?: string
  requiredGrants: readonly string[]
  commands: readonly SceneCommandDescriptor[]
  create(context: SceneCapabilityContext): SceneV2
}

export interface SceneCommandDescriptor {
  commandId: string
  schemaVersion: number
  validate(payload: SerializableValue): void
}

export type SceneRegistration =
  | { status: 'accepted'; apiVersion: '2'; descriptorId: string }
  | { status: 'rejected'; code: 'unsupported-scene-api' | 'missing-grant' | 'duplicate-scene'; supported: readonly ['2'] }

export interface SceneRegistrationHandle {
  readonly result: SceneRegistration
  dispose(): void
}

export interface TuiSceneRuntimeV2Contract {
  /** Final API; the old legacy component runtime descriptor/register overload is removed in this breaking release. */
  register(descriptor: SceneDescriptorV2, identity?: unknown): SceneRegistrationHandle
}

export interface ToolRowView {
  rowId: string
  revision: number
  phase: 'running' | 'result' | 'error'
  call: SerializableValue
  result?: SerializableValue
  durationMs?: number
}

export interface PluginRowView {
  rowId: string
  revision: number
  pluginId: string
  data: SerializableValue
}

// ---------------------------------------------------------------------------
// Runtime anchors (the only runtime values of the `./tui-v2` package export)
// ---------------------------------------------------------------------------

/** The single supported scene API version; the registration gate rejects all others. */
export const SCENE_API_VERSION = '2' as const

/** The `supported` list carried by every rejected registration. */
export const SUPPORTED_SCENE_API_VERSIONS: readonly ['2'] = ['2']
