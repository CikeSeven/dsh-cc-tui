import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createNotificationDock } from '../../src/tui-v2/components/chrome/notification-dock.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js'

const profile = unknownConservativeDefaults()

test('external action component contract: width zero/one/two/narrow and untrusted text', () => {
  const component = createNotificationDock([
    {
      notificationId: 'n1',
      text: '\x1b[31m危险\x1b[0m 你好 👩‍💻',
      severity: 'warning',
      sticky: false,
      createdAt: 0,
      expiresAt: 10,
      dedupeKey: null,
      count: 2,
    },
  ], { profile, theme: DEFAULT_COMPONENT_THEME })
  for (const width of [0, 1, 2, 3, 8, 20, 80]) {
    const lines = component.render(width)
    if (width <= 0) assert.deepEqual(lines, [])
    else assert.ok(lines.every((line) => !line.includes('\x1b[31m')))
  }
})
