/**
 * Plugin row components (WP-08a, plan §7.4): adapt a registered
 * `PluginRowRenderer` (serialized `ToolRowView`/`PluginRowView` in, v2
 * `Component` or mutable `string[]` out) into the transcript row pipeline.
 *
 * Isolation rules (§7.4 "插件异常转换为 app/error 或受控 notice，不得破坏主
 * frame"): a throwing renderer — or one returning a malformed component —
 * degrades THAT row to the host fallback rendering; the frame pipeline never
 * sees the exception. Renderer output is render-path only (never persisted),
 * so styled `string[]` lines enter the trusted cell pipeline like any other
 * component output.
 *
 * Dependency rule (§4.3): model/renderer/terminal contracts + the scene
 * runtime; no dsh-adapter, no Cordis.
 */
import type { UiRowSnapshot } from '../model/schema.js'
import { fallbackRowComponent } from '../renderer/base-renderer.js'
import type { Component } from '../renderer/component.js'
import type { TerminalProfile } from '../terminal/profile.js'
import type { PluginRowView, ToolRowView } from './contract.js'
import { invokeRowRenderer, type PluginUIRuntime } from './runtime.js'

/** Build the serialized row view for a plugin-sourced transcript row. Rows
 *  carrying a tool lifecycle map to `ToolRowView`; the rest to
 *  `PluginRowView` (§7.4). */
export function pluginRowViewOf(row: UiRowSnapshot): ToolRowView | PluginRowView {
  const tool = row.tool
  if (tool !== undefined) {
    return {
      rowId: row.rowId,
      revision: row.revision,
      phase: tool.phase,
      call: tool.callView ?? {},
      ...(tool.resultView !== undefined ? { result: tool.resultView } : {}),
      ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
    }
  }
  return {
    rowId: row.rowId,
    revision: row.revision,
    pluginId: row.sourceId,
    data: row.blocks.length === 1 ? (row.blocks[0] as PluginRowView['data']) : [...row.blocks],
  }
}

/**
 * Row component factory for `source: 'plugin'` rows. `row.sourceId` is the
 * plugin identity (the ChannelUiAdapter's source-prefix convention); without
 * a registered renderer the row keeps the host fallback.
 */
export function createPluginRowComponent(
  row: UiRowSnapshot,
  profile: TerminalProfile,
  runtime: PluginUIRuntime,
  onError?: (error: unknown) => void,
): Component {
  const fallback = () => fallbackRowComponent(row, profile)
  if (row.source !== 'plugin') return fallback()
  const view = pluginRowViewOf(row)
  return {
    render(width: number): string[] {
      const output = invokeRowRenderer(runtime, row.sourceId, view, onError)
      if (output === undefined) return fallback().render(width)
      if (Array.isArray(output)) {
        return output.every((line) => typeof line === 'string') ? [...output] : fallback().render(width)
      }
      const component = output as Component
      if (component !== null && typeof component === 'object' && typeof component.render === 'function') {
        try {
          const lines = component.render(width)
          return Array.isArray(lines) && lines.every((line) => typeof line === 'string')
            ? lines
            : fallback().render(width)
        } catch (error) {
          try {
            onError?.(error)
          } catch {
            /* diagnostics never break rendering */
          }
          return fallback().render(width)
        }
      }
      return fallback().render(width)
    },
    invalidate() {
      // Row renderers are pure view→lines; no host-side cache to flush.
    },
  }
}
