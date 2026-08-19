/**
 * tui-v2 component contract (WP-04b, plan §5.1).
 *
 * Type definitions are verbatim from the development plan. This module also
 * hosts `normalizeOverlayOptions`, the single bridge from the process-local
 * `OverlayOptions` contract (which may carry a `visible` callback) into the
 * serializable `OverlayState` the model publishes — functions must never
 * enter event/trace payloads (§5.1), so the callback is evaluated here and
 * only the resulting boolean crosses the boundary.
 *
 * Dependency rule (§4.3): `import type` from model and terminal only.
 */
import type { OverlayAnchor, OverlayState, SerializableValue } from '../model/schema.js'
import { validateOverlayState } from '../model/schema.js'
import type { TerminalInputEvent } from '../terminal/query.js'

export interface Component {
  /** 根据当前 viewport 宽度生成带 ANSI 样式的逻辑行。 */
  render(width: number): string[]
  /** 主题、宽度、数据或终端 profile 改变时丢弃局部缓存。 */
  invalidate(): void
  /** 获得焦点时处理原始输入；未实现表示不可交互。 */
  handleInput?(data: string | TerminalInputEvent): void
  /** 是否需要 Kitty key-release 事件。 */
  wantsKeyRelease?: boolean
}

export interface Focusable {
  focused: boolean
  /** focused component emits a zero-width cursor marker or an explicit cursor position */
  cursor?: { x: number; y: number; visible: boolean }
}

export interface OverlayOptions {
  anchor?: OverlayAnchor
  minWidth?: number | `${number}%`
  width?: number | `${number}%`
  maxHeight?: number | `${number}%`
  row?: number | `${number}%`
  col?: number | `${number}%`
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number }
  offsetX?: number
  offsetY?: number
  visible?: boolean | ((termWidth: number, termHeight: number) => boolean)
  nonCapturing?: boolean
}

export interface Overlay extends Component {
  readonly options: OverlayOptions
  onClose?(reason: 'user' | 'teardown' | 'error'): void | Promise<void>
}

// ---------------------------------------------------------------------------
// OverlayOptions -> OverlayState normalization (§5.1)
// ---------------------------------------------------------------------------

export interface NormalizeOverlayOptionsInput {
  readonly overlayId: string
  readonly revision: number
  readonly payload: SerializableValue
  readonly options: OverlayOptions
  readonly termWidth: number
  readonly termHeight: number
}

/**
 * Evaluate the process-local `visible` callback (default: visible), resolve
 * the `captureInput === !nonCapturing` rule and schema-validate the result.
 * Contradictory `captureInput`/`nonCapturing` combinations are rejected by
 * `validateOverlayState` — the renderer never guesses (§5.1).
 *
 * `margin` is forwarded structurally; numeric forms and partial-side objects
 * are both legal in `OverlayState`.
 */
export function normalizeOverlayOptions(input: NormalizeOverlayOptionsInput): OverlayState {
  const { options } = input
  const visible =
    typeof options.visible === 'function'
      ? options.visible(input.termWidth, input.termHeight)
      : options.visible ?? true
  const nonCapturing = options.nonCapturing ?? false
  const state: OverlayState = {
    overlayId: input.overlayId,
    revision: input.revision,
    anchor: options.anchor ?? 'center',
    ...(options.minWidth !== undefined ? { minWidth: options.minWidth } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.maxHeight !== undefined ? { maxHeight: options.maxHeight } : {}),
    ...(options.row !== undefined ? { row: options.row } : {}),
    ...(options.col !== undefined ? { col: options.col } : {}),
    ...(options.margin !== undefined ? { margin: options.margin } : {}),
    ...(options.offsetX !== undefined ? { offsetX: options.offsetX } : {}),
    ...(options.offsetY !== undefined ? { offsetY: options.offsetY } : {}),
    visible,
    captureInput: !nonCapturing,
    nonCapturing,
    payload: input.payload,
  }
  // Throws TypeError on any rule violation (§5.2); callers let it propagate.
  return validateOverlayState(state)
}
