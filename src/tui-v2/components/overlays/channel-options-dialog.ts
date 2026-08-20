/** Pure line components for model, preset and effort overlays (WP-08d2). */
import type { Component } from '../../renderer/component.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type {
  EffortDialogPayload,
  RoutingPickerPayload,
  RoutingOptionView,
} from '../../model/settings-routing-overlay-payloads.js'
import type { ComponentTheme } from '../theme.js'
import { renderHighlightedLine, renderInputLine, renderLine, renderSegments, renderWrapped } from './overlay-text.js'

export interface ChannelOptionsRenderOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

function noticeLine(text: string, tone: 'info' | 'success' | 'warning' | 'error', width: number, options: ChannelOptionsRenderOptions): string {
  const style = tone === 'error'
    ? options.theme.roles.error
    : tone === 'warning'
      ? options.theme.roles.warning
      : tone === 'success'
        ? options.theme.roles.success
        : options.theme.roles.subtle
  return renderLine(text, width, options.profile, style)
}

function routingItemLine(
  item: RoutingOptionView,
  query: string,
  focused: boolean,
  pendingId: string | undefined,
  width: number,
  options: ChannelOptionsRenderOptions,
): string[] {
  const { profile, theme } = options
  const disabled = item.disabled === true
  const pending = pendingId === item.id
  const marker = pending ? '⋯ ' : focused ? '❯ ' : '  '
  const style = disabled ? theme.roles.subtle : focused ? theme.roles.accent : theme.roles.text
  const badges = [
    item.current ? 'current' : '',
    ...(item.badges ?? []),
    pending ? 'pending' : '',
    disabled ? 'unavailable' : '',
  ].filter(Boolean)
  const title = badges.length === 0 ? item.label : `${item.label} [${badges.join(' · ')}]`
  const lines = [renderHighlightedLine(marker, title, query, width, profile, {
    base: disabled ? theme.roles.subtle : style,
    match: theme.roles.warning,
  })]
  if (item.description !== undefined && item.description !== '') {
    lines.push(renderHighlightedLine('    ', item.description, query, width, profile, {
      base: theme.roles.subtle,
      match: theme.roles.warning,
    }))
  }
  if (item.provider !== undefined && item.provider !== '') {
    // provider is already part of model labels, but remains explicit in the
    // metadata line for narrow truncation and hostile-name safety.
    lines.push(renderLine(`    provider: ${item.provider}`, width, profile, theme.roles.subtle))
  }
  if (item.metadata !== undefined) {
    for (const metadata of item.metadata.slice(0, 4)) {
      lines.push(renderLine(`    ${metadata.label}: ${metadata.value}`, width, profile, theme.roles.subtle))
    }
  }
  if (item.disabledReason !== undefined && item.disabledReason !== '') {
    lines.push(...renderWrapped(`    ${item.disabledReason}`, Math.max(1, width), profile, theme.roles.warning, 2))
  }
  return lines
}

export function createRoutingPickerDialog(
  view: RoutingPickerPayload,
  options: ChannelOptionsRenderOptions,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const { profile, theme } = options
      const lines: string[] = [renderLine(view.title, width, profile, theme.roles.toolName)]
      lines.push(renderInputLine(
        'Filter: ',
        view.list.query,
        view.list.cursor,
        width,
        profile,
        { text: theme.roles.text, caret: { ...theme.roles.accent, inverse: true }, placeholder: theme.roles.subtle },
        'type to filter',
      ))
      if (view.phase === 'loading') lines.push(renderLine('Loading options…', width, profile, theme.roles.subtle))
      else if (view.list.sourceCount === 0) lines.push(renderLine(view.list.emptyMessage, width, profile, theme.roles.subtle))
      else if (view.list.items.length === 0) lines.push(renderLine(view.list.noResultsMessage, width, profile, theme.roles.subtle))
      else {
        if (view.list.windowStart > 0) lines.push(renderLine('↑ more options', width, profile, theme.roles.subtle))
        for (let index = view.list.windowStart; index < view.list.windowEnd; index += 1) {
          const item = view.list.items[index]
          if (item === undefined) continue
          lines.push(...routingItemLine(
            item,
            view.list.query,
            index === view.list.activeIndex,
            view.pendingId,
            width,
            options,
          ))
        }
        if (view.list.windowEnd < view.list.items.length) lines.push(renderLine('↓ more options', width, profile, theme.roles.subtle))
      }
      if (view.notice !== undefined) lines.push(noticeLine(view.notice.text, view.notice.tone, width, options))
      if (view.error !== undefined) lines.push(renderLine(view.error, width, profile, theme.roles.error))
      lines.push(renderLine(view.hint, width, profile, theme.roles.subtle))
      return lines
    },
    invalidate() {},
  }
}

function effortLine(
  view: EffortDialogPayload,
  width: number,
  options: ChannelOptionsRenderOptions,
): string {
  const { profile, theme } = options
  const segments = view.options.flatMap((effort, index) => {
    const selected = index === view.activeIndex
    const current = effort.current === true
    const pending = view.pendingId === effort.id
    const label = `${pending ? '…' : ''}${effort.name}${current ? '✓' : ''}`
    return [
      ...(index === 0 ? [] : [{ text: ' ── ', style: theme.roles.subtle }]),
      { text: label, style: selected ? { ...theme.roles.accent, inverse: true, bold: true } : current ? theme.roles.success : theme.roles.text },
    ]
  })
  return renderSegments(segments, width, profile)
}

export function createEffortDialog(
  view: EffortDialogPayload,
  options: ChannelOptionsRenderOptions,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const { profile, theme } = options
      const lines: string[] = [renderLine(view.title, width, profile, theme.roles.toolName)]
      if (view.phase === 'loading') lines.push(renderLine('Loading effort levels…', width, profile, theme.roles.subtle))
      else if (view.options.length === 0) lines.push(renderLine('The active model does not expose effort levels.', width, profile, theme.roles.warning))
      else {
        lines.push(effortLine(view, width, options))
        const focused = view.options[view.activeIndex]
        if (focused?.description !== undefined) lines.push(renderLine(focused.description, width, profile, theme.roles.subtle))
        if (view.currentId !== undefined) lines.push(renderLine(`Actual: ${view.currentId}`, width, profile, theme.roles.success))
        if (view.defaultId !== undefined) lines.push(renderLine(`Default: ${view.defaultId}`, width, profile, theme.roles.subtle))
      }
      if (view.notice !== undefined) lines.push(noticeLine(view.notice.text, view.notice.tone, width, options))
      if (view.error !== undefined) lines.push(renderLine(view.error, width, profile, theme.roles.error))
      lines.push(renderLine(view.hint, width, profile, theme.roles.subtle))
      return lines
    },
    invalidate() {},
  }
}
