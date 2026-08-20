/** WP-08d2 settings controller: staged forms, conflict fencing and lifecycle. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { SettingsHost, SettingsNamespaceView, SettingsPathOp } from '../../src/dsh-adapter/settingsEditor.js'
import type { TuiSettingsSection } from '../../src/dsh-adapter/settings-sections.js'
import { createSettingsFlowController, type SettingsSectionsCapability } from '../../src/tui-v2/controllers/settings-flow.js'
import { parseSettingsRoutingOverlayPayload, type SettingsDialogPayload } from '../../src/tui-v2/model/settings-routing-overlay-payloads.js'
import type { TerminalInputEvent } from '../../src/tui-v2/terminal/input.js'
import { createControllerRig } from './helpers/controller-rig.js'

function key(keyName: string, text: string | null = null): TerminalInputEvent {
  return { kind: 'key', sequence: 0, generation: 0, payload: { key: keyName, raw: '', text, eventType: 'press' } }
}

function paste(text: string): TerminalInputEvent {
  return { kind: 'paste', sequence: 0, generation: 0, payload: { text } }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

function payload(rig: ReturnType<typeof createControllerRig>): SettingsDialogPayload {
  const overlay = rig.state().overlays.stack.at(-1)
  assert.ok(overlay !== undefined)
  const parsed = parseSettingsRoutingOverlayPayload(overlay.payload)
  assert.ok(parsed?.kind === 'settings-dialog')
  return parsed
}

const demoSection: TuiSettingsSection = {
  ns: 'demo',
  title: 'Demo 配置 😀',
  fields: [
    { path: ['enabled'], label: 'Enabled', kind: 'boolean' },
    { path: ['mode'], label: 'Mode', kind: 'select', options: [
      { value: 'fast', label: 'Fast' },
      { value: 'safe', label: 'Safe' },
    ] },
    { path: ['name'], label: 'Name', kind: 'text', hint: 'CJK/emoji accepted' },
    { path: ['limit'], label: 'Limit', kind: 'number' },
    { path: ['token'], label: 'Token', kind: 'text', secret: { ref: 'DEMO_TOKEN' } },
  ],
}

function hostFixture(options: { conflictOnce?: boolean; delayedWrite?: Promise<void> } = {}) {
  let view: SettingsNamespaceView = {
    ns: 'demo',
    revision: 1,
    applies: 'restart',
    value: { enabled: true, mode: 'fast', name: 'alpha', limit: 3 },
    user: { enabled: true },
  }
  const writes: Array<{ ns: string; ops: readonly SettingsPathOp[]; expected?: number }> = []
  let conflict = options.conflictOnce === true
  const host: SettingsHost = {
    listNamespaces: () => [view, {
      ns: 'raw-plugin',
      revision: 4,
      applies: 'live',
      value: { hostile: '\x1b]52;c;secret\x07 你好😀' },
      user: {},
    }],
    async write(ns, ops, expected) {
      writes.push({ ns, ops, ...(expected === undefined ? {} : { expected }) })
      if (conflict) {
        conflict = false
        view = { ...view, revision: 2 }
        const error = new Error('stale') as Error & { code: string }
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      await options.delayedWrite
      const value = { ...(view.value as Record<string, unknown>) }
      const user = { ...(view.user as Record<string, unknown>) }
      for (const op of ops) {
        const name = op.path[0] as string
        if (op.op === 'set') {
          value[name] = op.value
          user[name] = op.value
        } else {
          delete value[name]
          delete user[name]
        }
      }
      view = { ...view, revision: view.revision + 1, value, user }
    },
    async credentialConfigured() { return true },
    async writeCredential() {},
  }
  return { host, writes, view: () => view }
}

function sectionsFixture(initial: readonly TuiSettingsSection[] = [demoSection]): SettingsSectionsCapability & { emit(): void; set(next: readonly TuiSettingsSection[]): void } {
  let sections = [...initial]
  const listeners = new Set<() => void>()
  return {
    list: () => sections,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit() {
      sections = [...sections]
      for (const listener of [...listeners]) listener()
    },
    set(next) {
      sections = [...next]
      for (const listener of [...listeners]) listener()
    },
  }
}

function controllerFor(
  rig: ReturnType<typeof createControllerRig>,
  host: SettingsHost | undefined,
  sections: SettingsSectionsCapability,
) {
  return createSettingsFlowController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
    getState: rig.state,
    ...(host === undefined ? {} : { host }),
    sections,
    isBusinessDialogActive: () => false,
    language: 'en',
  })
}

test('controller settings: navigation and all field kinds stage, validate, conflict-save and reload', async () => {
  const rig = createControllerRig({ width: 120, height: 35 })
  const fixture = hostFixture({ conflictOnce: true })
  const sections = sectionsFixture()
  const controller = controllerFor(rig, fixture.host, sections)

  assert.equal(controller.open(), true)
  assert.equal(payload(rig).phase, 'loading')
  await flush()
  let view = payload(rig)
  assert.equal(view.phase, 'ready')
  assert.equal(view.sections.length, 2, 'plugin section plus read-only namespace')
  assert.equal(view.sections[0]?.applies, 'restart')
  assert.equal(view.fields.at(-1)?.configured, true, 'secret status is projected without its literal')

  controller.handleInput(key('enter')) // section -> fields
  assert.equal(payload(rig).pane, 'fields')
  controller.handleInput(key('enter')) // boolean toggle
  view = payload(rig)
  assert.equal(view.fields[0]?.text, 'false')
  assert.equal(view.sections[0]?.dirty, true)

  controller.handleInput(key('down'))
  controller.handleInput(key('enter')) // select cycle
  assert.equal(payload(rig).fields[1]?.text, 'safe')

  controller.handleInput(key('down'))
  controller.handleInput(key('enter')) // text edit
  assert.equal(payload(rig).mode, 'edit')
  controller.handleInput(key('end'))
  controller.handleInput(paste(' 你好😀\n\x1b]52;c;bad\x07'))
  controller.handleInput(key('enter'))
  assert.match(payload(rig).fields[2]?.text ?? '', /你好😀/)

  controller.handleInput(key('down'))
  controller.handleInput(key('enter')) // number edit, seeded "3"
  controller.handleInput(key('backspace'))
  controller.handleInput(key('x', 'oops'))
  controller.handleInput(key('enter'))
  assert.equal(payload(rig).fields[3]?.invalid, true)
  controller.handleInput(key('s', 's'))
  assert.match(payload(rig).error ?? '', /invalid/)
  assert.equal(fixture.writes.length, 0)

  controller.handleInput(key('enter'))
  for (let index = 0; index < 4; index += 1) controller.handleInput(key('backspace'))
  controller.handleInput(key('1', '10'))
  controller.handleInput(key('enter'))
  assert.equal(payload(rig).fields[3]?.invalid, false)
  controller.handleInput(key('s', 's'))
  await flush()
  await flush()

  view = payload(rig)
  assert.equal(view.phase, 'ready')
  assert.match(view.notice?.text ?? '', /Concurrent revision/)
  assert.deepEqual(fixture.writes.map((entry) => entry.expected), [1, 2], 'same ops retried against fresh revision')
  assert.equal((fixture.view().value as Record<string, unknown>).limit, 10)
  assert.equal((fixture.view().value as Record<string, unknown>).mode, 'safe')
  assert.equal(controller.diagnostics().conflicts, 1)
  assert.ok(!JSON.stringify(view).includes('DEMO_TOKEN'), 'credential ref/literal stays out of payload')
})

test('controller settings: dirty Esc confirms, reload confirms, focus preemption is stale', async () => {
  const rig = createControllerRig({ width: 80, height: 25 })
  const fixture = hostFixture()
  const controller = controllerFor(rig, fixture.host, sectionsFixture())
  controller.open()
  await flush()

  controller.handleInput(key('tab'))
  assert.equal(payload(rig).pane, 'fields', 'Tab enters the field pane')
  controller.handleInput(key('shift+tab'))
  assert.equal(payload(rig).pane, 'sections', 'Backtab returns to sections')
  controller.handleInput(key('enter'))
  controller.handleInput(key('enter')) // stage boolean
  controller.handleInput(key('escape')) // field pane -> section pane
  assert.equal(payload(rig).pane, 'sections')
  controller.handleInput(key('escape'))
  assert.equal(payload(rig).mode, 'confirm-close')
  controller.handleInput(key('escape'))
  assert.equal(payload(rig).mode, 'list')
  assert.equal(payload(rig).sections[0]?.dirty, true)

  controller.handleInput(key('r', 'r'))
  assert.equal(payload(rig).mode, 'confirm-reload')
  controller.handleInput(key('enter'))
  await flush()
  assert.equal(payload(rig).sections[0]?.dirty, false)

  controller.handleInput(key('enter')) // fields pane
  controller.handleInput(key('ctrl+d'))
  assert.equal(payload(rig).fields[0]?.text, '', 'field reset stages an unset')
  assert.equal(payload(rig).sections[0]?.dirty, true)
  assert.equal(controller.diagnostics().resets, 1)
  controller.handleInput(key('escape'))
  controller.handleInput(key('r', 'r'))
  controller.handleInput(key('enter'))
  await flush()

  const foreign = {
    ...rig.meta.next('overlay', 'foreign'),
    type: 'overlay/open' as const,
    overlay: {
      overlayId: 'dialog/question/preempt', revision: 1, anchor: 'center' as const,
      visible: true, captureInput: true, nonCapturing: false, payload: { note: 'business' },
    },
  }
  rig.streaming.ingest(foreign)
  controller.handleInput(key('down'))
  assert.equal(controller.diagnostics().staleInput, 1)
})

test('controller settings: plugin section projection updates clean forms and preserves bounded namespace fallback', async () => {
  const rig = createControllerRig({ width: 120, height: 30 })
  const fixture = hostFixture()
  const sections = sectionsFixture()
  const controller = controllerFor(rig, fixture.host, sections)
  controller.open()
  await flush()
  const added: TuiSettingsSection = {
    ns: 'added',
    title: 'Added section',
    fields: [{ path: ['enabled'], label: 'Enabled', kind: 'boolean' }],
  }
  sections.set([demoSection, added])
  await flush()
  assert.ok(payload(rig).sections.some((section) => section.ns === 'added'))
  sections.set([])
  await flush()
  assert.ok(payload(rig).sections.some((section) => section.source === 'namespace' && section.ns === 'raw-plugin'))
  controller.dispose()
})

test('controller settings: close/dispose fences a late save and section callback errors stay controlled', async () => {
  const rig = createControllerRig({ width: 100, height: 30 })
  let release!: () => void
  const delayed = new Promise<void>((resolve) => { release = resolve })
  const fixture = hostFixture({ delayedWrite: delayed })
  const controller = controllerFor(rig, fixture.host, sectionsFixture())
  controller.open()
  await flush()
  controller.handleInput(key('enter'))
  controller.handleInput(key('enter'))
  controller.handleInput(key('s', 's'))
  assert.equal(payload(rig).phase, 'pending')
  controller.close()
  const afterClose = rig.applied.length
  release()
  await flush()
  assert.equal(rig.applied.length, afterClose)
  assert.ok(controller.diagnostics().lateResults >= 1)

  controller.dispose()
  assert.equal(controller.open(), false)

  const broken = controllerFor(rig, fixture.host, {
    list() { throw new Error('plugin projection failed') },
    subscribe() { throw new Error('subscription failed') },
  })
  assert.equal(broken.open(), true)
  await flush()
  assert.equal(payload(rig).phase, 'error')
  assert.match(payload(rig).error ?? '', /plugin projection failed/)
  broken.dispose()
})
