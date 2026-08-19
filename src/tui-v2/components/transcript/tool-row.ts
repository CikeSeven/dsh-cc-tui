/**
 * tui-v2 tool row component (WP-04b).
 *
 * Visual form mirrors the legacy `AssistantToolUseMessage.tsx` in skeleton
 * scope: a status-glyph + summary header (`● Bash(ls -la)`-shaped plain
 * summary from the projection's text block), running/result/error glyph
 * states (● running/accent, ● result/success, ✗ error), a dim duration
 * suffix, and the body hung under the ` ⎿ ` gutter with a 3-line cap
 * (`… +N lines`). Structured presentation views (diff/search/terminal
 * cards) are WP-08; here result/error payloads degrade to their text
 * content through the same sanitize+pipeline path as everything else.
 */
import type { Component } from '../../renderer/component.js'
import { lineStyle, type LineStyle } from '../../renderer/lines.js'
import type { SerializableValue, ToolLifecycleSnapshot } from '../../model/schema.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import { hangingTextLines, singleLine, type HangingLayoutOptions } from './block-lines.js'
import type { TranscriptRowView } from './row-view.js'

/** Body line budget, mirroring the legacy collapsed card (renderTruncatedContent). */
const TOOL_BODY_MAX_LINES = 3

const GLYPH: Record<ToolLifecycleSnapshot['phase'], string> = {
  running: '●',
  result: '●',
  error: '✗',
}

/** `12 ms` / `1.2 s` / `2 m 5 s` (reduced form of cc/format.ts formatDuration). */
export function formatToolDuration(durationMs: number): string {
  const ms = Math.max(0, Math.floor(durationMs))
  if (ms < 1000) return `${ms} ms`
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes} m` : `${minutes} m ${seconds} s`
}

/** Pull printable text lines out of a presentation/result payload, best effort. */
function payloadLines(value: SerializableValue | undefined): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return value.split('\n')
  if (Array.isArray(value)) {
    return value.flatMap((item) => payloadLines(item))
  }
  if (typeof value === 'object') {
    const record = value as { readonly [key: string]: SerializableValue }
    if (typeof record.output === 'string') return record.output.split('\n')
    if (Array.isArray(record.content)) {
      const text = record.content
        .map((block) =>
          typeof block === 'object' && block !== null && !Array.isArray(block)
            ? String((block as { text?: unknown }).text ?? '')
            : '',
        )
        .join('')
        .trimEnd()
      return text === '' ? [] : text.split('\n')
    }
    if (typeof record.title === 'string') return [record.title]
  }
  return []
}

export function createToolRow(view: TranscriptRowView, profile: TerminalProfile): Component {
  let cache: { width: number; lines: string[] } | null = null
  const tool = view.tool
  const phase: ToolLifecycleSnapshot['phase'] = tool?.phase ?? 'result'
  const glyphStyle: LineStyle =
    phase === 'error'
      ? view.theme.roles.error
      : phase === 'running'
        ? view.theme.roles.accent
        : view.theme.roles.success

  const headerLayout: HangingLayoutOptions = {
    prefix: `${GLYPH[phase]} `,
    indent: '  ',
    prefixStyle: glyphStyle,
    textStyle: view.theme.roles.text,
    profile,
  }
  const bodyLayout: HangingLayoutOptions = {
    prefix: ' ⎿ ',
    indent: '   ',
    prefixStyle: view.theme.roles.subtle,
    textStyle: view.theme.roles.subtle,
    profile,
  }

  return {
    render(width: number): string[] {
      if (width <= 0) return []
      if (cache !== null && cache.width === width) return cache.lines
      const lines: string[] = []

      // Header: first text block is the projection's plain summary line.
      const summary = view.blocks.find((block) => block.type === 'text')
      const headerText = summary !== undefined && summary.type === 'text' ? summary.text : '(tool)'
      const duration = tool?.durationMs !== undefined ? ` (${formatToolDuration(tool.durationMs)})` : ''
      lines.push(...hangingTextLines(headerText + duration, headerLayout, width))

      // Body: result/error payloads, guttered and capped.
      let body: { text: string; style: LineStyle }[] = []
      if (phase === 'error' && tool?.error !== undefined) {
        body = [{ text: tool.error.message, style: view.theme.roles.error }]
      } else if (phase === 'result') {
        body = payloadLines(tool?.resultView).map((text) => ({ text, style: view.theme.roles.subtle }))
      } else if (phase === 'running') {
        body = []
      }
      if (body.length > TOOL_BODY_MAX_LINES) {
        const hidden = body.length - TOOL_BODY_MAX_LINES
        body = [...body.slice(0, TOOL_BODY_MAX_LINES), { text: `… +${hidden} lines`, style: lineStyle({ dim: true }) }]
      }
      for (const line of body) {
        lines.push(...hangingTextLines(line.text, { ...bodyLayout, textStyle: line.style }, width))
      }
      if (lines.length === 0) lines.push(singleLine('(tool)', view.theme.roles.subtle, profile, width))
      cache = { width, lines }
      return lines
    },
    invalidate() {
      cache = null
    },
  }
}
