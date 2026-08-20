/** WP-08d2 pure settings/model/preset/effort overlay contracts. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderDialogOverlayLines } from '../../src/tui-v2/components/overlays/render-dialog.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import {
  parseSettingsRoutingOverlayPayload,
  type EffortDialogPayload,
  type RoutingPickerPayload,
  type SettingsDialogPayload,
} from '../../src/tui-v2/model/settings-routing-overlay-payloads.js'
import { measureLineWidth } from '../../src/tui-v2/renderer/lines.js'
import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js'

const profile = unknownConservativeDefaults()
const theme = DEFAULT_COMPONENT_THEME
const hostile = '控制👩‍💻e\u0301\x1b]52;c;ZXZpbA==\x07\x1b]8;;https://evil.invalid\x07link\x1b]8;;\x07\x1b[31m red\nnext'

function settingsPayload(pane: 'sections' | 'fields' = 'sections'): SettingsDialogPayload {
  return {
    kind: 'settings-dialog',
    key: 'settings-contract',
    title: `Settings ${hostile}`,
    phase: 'ready',
    pane,
    mode: 'edit',
    sections: [
      {
        id: 'section:demo', ns: 'demo', title: `SECTION_SENTINEL ${hostile}`, source: 'section',
        available: true, applies: 'restart', dirty: true, invalid: true, saving: false,
        failed: false, conflicted: true, fieldsCount: 2,
      },
      {
        id: 'namespace:raw', ns: 'raw', title: 'Raw', source: 'namespace', available: true,
        applies: 'live', dirty: false, invalid: false, saving: false, failed: false,
        conflicted: false, fieldsCount: 0, preview: hostile,
      },
    ],
    sectionWindowStart: 0,
    sectionWindowEnd: 2,
    selectedSectionId: 'section:demo',
    fields: [
      {
        id: 'name', label: `FIELD_SENTINEL ${hostile}`, hint: hostile, kind: 'text', text: `值😀 ${hostile}`,
        staged: true, overridden: true, invalid: false, secret: false,
      },
      {
        id: 'token', label: 'Secret token', kind: 'text', text: '••••', staged: true,
        overridden: false, invalid: false, secret: true, configured: true,
      },
    ],
    fieldWindowStart: 0,
    fieldWindowEnd: 2,
    selectedFieldId: 'name',
    editing: { fieldId: 'name', text: `编辑😀${hostile}`, cursor: 3 },
    notice: { text: hostile, tone: 'warning' },
    error: hostile,
    hint: hostile,
  }
}

function routingPayload(route: 'model' | 'preset'): RoutingPickerPayload {
  return {
    kind: 'routing-picker-dialog',
    key: `${route}-contract`,
    title: `${route} ${hostile}`,
    route,
    phase: 'pending',
    list: {
      query: '控😀', cursor: 2, activeIndex: 0, windowStart: 0, windowEnd: 2,
      items: [
        {
          id: `${route}:0`, label: `ROUTE_SENTINEL ${hostile}`, description: hostile,
          ...(route === 'model' ? { provider: hostile } : {}),
          metadata: [{ label: 'input', value: `text/image ${hostile}` }],
          ...(route === 'preset' ? { badges: ['default', 'minimal'] } : {}),
          current: true,
        },
        {
          id: `${route}:1`, label: 'Unavailable', disabled: true, disabledReason: hostile,
          badges: ['unavailable'],
        },
      ],
      sourceCount: 2,
      emptyMessage: hostile,
      noResultsMessage: hostile,
    },
    pendingId: `${route}:0`,
    notice: { text: hostile, tone: 'info' },
    error: hostile,
    hint: hostile,
  }
}

function effortPayload(): EffortDialogPayload {
  return {
    kind: 'effort-dialog', key: 'effort-contract', title: `Effort ${hostile}`, phase: 'pending',
    options: [
      { id: 'effort:0', name: `Off ${hostile}`, current: true },
      { id: 'effort:1', name: `High😀${hostile}`, description: hostile, default: true },
      { id: 'effort:2', name: `Max ${hostile}`, disabled: true },
    ],
    activeIndex: 1,
    currentId: 'off',
    defaultId: 'high',
    pendingId: 'effort:1',
    notice: { text: hostile, tone: 'success' },
    error: hostile,
    hint: hostile,
  }
}

for (const width of [0, 1, 2, 8, 30, 80, 99, 100, 140]) {
  test(`settings/routing components are cell-safe at width ${width}`, () => {
    for (const payload of [settingsPayload(), routingPayload('model'), routingPayload('preset'), effortPayload()]) {
      const lines = renderDialogOverlayLines(payload, width, { profile, theme })
      if (width === 0) {
        assert.deepEqual(lines, [])
        continue
      }
      assert.ok(lines.length > 0, `${payload.kind} renders`)
      for (const line of lines) {
        assert.ok(measureLineWidth(line, profile) <= width, `${payload.kind} exceeds ${width}: ${JSON.stringify(line)}`)
        assert.ok(!line.includes('\x1b]'), 'OSC is stripped')
        assert.ok(!line.includes('https://evil.invalid'), 'OSC URI is not replayed as text')
        assert.ok(!line.includes('ZXZpbA=='), 'OSC52 payload is not replayed')
      }
    }
  })
}

test('settings dialog switches at exactly 100 cells and narrow pane is explicit', () => {
  const sectionPane = settingsPayload('sections')
  const narrow = renderDialogOverlayLines(sectionPane, 99, { profile, theme }).join('\n')
  assert.match(narrow, /SECTION_SENTINEL/)
  assert.ok(!narrow.includes('FIELD_SENTINEL'), 'narrow section pane does not pretend to be split')

  const fieldPane = settingsPayload('fields')
  const narrowField = renderDialogOverlayLines(fieldPane, 99, { profile, theme }).join('\n')
  assert.match(narrowField, /FIELD_SENTINEL/)
  assert.ok(!narrowField.includes('SECTION_SENTINEL'))

  const split = renderDialogOverlayLines(sectionPane, 100, { profile, theme }).join('\n')
  assert.match(split, /SECTION_SENTINEL/)
  assert.match(split, /FIELD_SENTINEL/)
})

test('settings/routing strict parser rejects malformed cursors, windows and foreign callbacks', () => {
  const settings = settingsPayload()
  const routing = routingPayload('model')
  const effort = effortPayload()
  assert.equal(parseSettingsRoutingOverlayPayload(settings)?.kind, 'settings-dialog')
  assert.equal(parseSettingsRoutingOverlayPayload(routing)?.kind, 'routing-picker-dialog')
  assert.equal(parseSettingsRoutingOverlayPayload(effort)?.kind, 'effort-dialog')

  assert.equal(parseSettingsRoutingOverlayPayload({
    ...settings,
    editing: { ...settings.editing, cursor: 99 },
  }), null)
  assert.equal(parseSettingsRoutingOverlayPayload({
    ...routing,
    list: { ...routing.list, windowEnd: 99 },
  }), null)
  assert.equal(parseSettingsRoutingOverlayPayload({ ...effort, activeIndex: 99 }), null)
  assert.equal(parseSettingsRoutingOverlayPayload({ ...settings, callback: () => {} }), null)
  assert.deepEqual(renderDialogOverlayLines({ kind: 'settings-dialog' }, 80, { profile, theme }), [])
})
