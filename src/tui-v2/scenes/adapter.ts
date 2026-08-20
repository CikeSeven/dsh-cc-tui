/**
 * `SceneComponentAdapter` (WP-08a, plan §7.4): the single bridge between a
 * `SceneV2` and the v2 `Component` contract.
 *
 *  - `render(width)` invokes `scene.render(view, width, context)` and hands
 *    the returned MUTABLE `string[]` to the v2 pipeline — this adapter is the
 *    ONLY consumer; external read-only consumers must copy the array and a
 *    `readonly string[]` facade never reaches the renderer (§7.4).
 *  - Every plugin throw (`render`/`handleInput`/`invalidate`) is forwarded
 *    to the runtime's error boundary via `onError`; the adapter itself never
 *    lets an exception escape into the renderer (an errored render yields
 *    zero lines — the boundary teardown restores the previous layer on the
 *    next frame).
 *  - `focused` is driven by the host (the coordinator sets it from
 *    `state.focus`); `cursor` delegates to the scene's `Focusable.cursor`.
 *
 * Dependency rule (§4.3): import type from model/renderer contracts only.
 */
import type { SceneViewModel } from '../model/schema.js'
import type { Focusable } from '../renderer/component.js'
import type { TerminalInputEvent } from '../terminal/query.js'
import type { SceneCapabilityContext, SceneComponentAdapter, SceneV2 } from './contract.js'

/** Throw points the adapter reports to the runtime error boundary (§7.4). */
export type SceneAdapterErrorPhase = 'render' | 'handleInput'

/**
 * The concrete adapter: the verbatim `SceneComponentAdapter` contract plus
 * the `Focusable` surface the coordinator drives per frame (`focused` from
 * `state.focus`; `cursor` delegated to the scene).
 */
export type SceneComponentAdapterInstance = SceneComponentAdapter & Focusable

export interface SceneComponentAdapterDeps {
  readonly scene: SceneV2
  readonly context: SceneCapabilityContext
  /** The host-owned immutable view model (replaced on every typed dispatch). */
  readonly getView: () => SceneViewModel
  readonly onError: (phase: SceneAdapterErrorPhase, error: unknown) => void
  /** Post-`invalidate()` host hook (schedules the next frame). */
  readonly onInvalidated?: () => void
}

export function createSceneComponentAdapter(deps: SceneComponentAdapterDeps): SceneComponentAdapterInstance {
  const { scene, context } = deps
  return {
    scene,
    focused: false,
    get cursor() {
      return scene.cursor
    },
    render(width: number): string[] {
      if (!Number.isInteger(width) || width <= 0) return []
      try {
        const lines = scene.render(deps.getView(), width, context)
        if (!Array.isArray(lines)) {
          throw new TypeError(`SceneV2.render must return string[] (got ${typeof lines})`)
        }
        for (const line of lines) {
          if (typeof line !== 'string') {
            throw new TypeError('SceneV2.render lines must all be strings')
          }
        }
        return lines
      } catch (error) {
        deps.onError('render', error)
        return []
      }
    },
    invalidate(): void {
      try {
        scene.invalidate()
      } catch (error) {
        deps.onError('render', error)
        return
      }
      deps.onInvalidated?.()
    },
    handleInput(data: string | TerminalInputEvent): void {
      if (scene.handleInput === undefined) return
      try {
        scene.handleInput(data)
      } catch (error) {
        deps.onError('handleInput', error)
      }
    },
  }
}
