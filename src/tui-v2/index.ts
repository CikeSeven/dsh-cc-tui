/**
 * `@deepseek-harness-tui/dsh-tui/tui-v2` — the versioned plugin capability
 * export of the v2 renderer (WP-08a, plan §7.4).
 *
 * This subpath is the ONLY public v2 surface. It deliberately exposes just
 * the versioned contracts: the `Component` contract, the immutable
 * `SceneViewModel`, the serialized row views (`ToolRowView`/`PluginRowView`),
 * `SceneDescriptorV2` and the typed scene commands. Vendor internals, Frame
 * buffers, the TerminalWriter and the ANSI builders are NOT exported and
 * never will be — plugins cannot reach the terminal through this package.
 *
 * Semver/grant/identity/error-boundary/lifecycle semantics are pinned by the
 * package-level smoke (scripts/verify-package.mjs) and the WP-08a test
 * fixtures (test/tui-v2/scenes*.test.ts).
 */

export type { Component, Focusable } from './renderer/component.js'
export type { SceneViewModel, SerializableValue } from './model/schema.js'

export {
  SCENE_API_VERSION,
  SUPPORTED_SCENE_API_VERSIONS,
} from './scenes/contract.js'
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
  TuiSceneRuntimeV2Contract,
} from './scenes/contract.js'

/** Row renderer signature (serialized row view in, Component/string[] out). */
export type { PluginRowRenderer } from './scenes/runtime.js'

/** WP-08f stable host capability contracts; Node bindings stay private. */
export type {
  ClipboardCapability,
  ClipboardReadValue,
  ClipboardWriteResult,
  EditorRequest,
  EditorResult,
  EditorRunner,
  ExternalActionKind,
  ExternalActionPhase,
  ExternalActionSummary,
  ExternalActionTraceSink,
  LanguageCapability,
  PreferencePersistence,
  RestartRequest,
  RestartResult,
  RestartRunner,
  ShellCapability,
  ShellOutputSink,
  ShellRequest,
  ShellResult,
} from './capabilities/external-actions.js'
export type { NotificationController, NotificationInput, NotificationView } from './controllers/notifications.js'
