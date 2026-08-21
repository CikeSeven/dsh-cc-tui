/** Pure v2 notification dock component (WP-08f).
 *
 * It only renders the immutable notification view supplied by the controller;
 * timers, dismissal and host effects live in controllers/notifications.ts.
 */
import type { Component } from '../../renderer/component.js'
import {
  cellsToString,
  lineToCells,
  sanitizeText,
  truncateCells,
  type LineStyle,
} from '../../renderer/lines.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'
import type { NotificationView, NotificationSeverity } from '../../controllers/notifications.js'

export interface NotificationDockOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
  readonly prefix?: string
}

function styleFor(theme: ComponentTheme, severity: NotificationSeverity): LineStyle {
  switch (severity) {
    case 'error': return theme.roles.error
    case 'warning': return theme.roles.warning
    case 'success': return theme.roles.success
    default: return theme.roles.subtle
  }
}

export function createNotificationDock(
  notifications: readonly NotificationView[],
  options: NotificationDockOptions,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return []
      const prefix = options.prefix ?? '! '
      return notifications.map((notification) => {
        const suffix = notification.count > 1 ? ` ×${notification.count}` : ''
        const text = `${prefix}${notification.text}${suffix}`
        const cells = lineToCells(sanitizeText(text), options.profile).map((cell) => ({
          ...cell,
          style: styleFor(options.theme, notification.severity),
        }))
        return cellsToString(truncateCells(cells, width))
      })
    },
    invalidate() {},
  }
}
