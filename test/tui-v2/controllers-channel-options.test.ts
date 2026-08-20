/** WP-08d2 model/preset/effort controller capability and lifecycle tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { EffortOption, PresetOption } from '../../src/dsh-adapter/channel.js'
import type { LlmModelInfo } from '../../src/dsh-adapter/types.js'
import {
  createChannelOptionsController,
  type ChannelOptionsCapability,
} from '../../src/tui-v2/controllers/channel-options.js'
import {
  parseSettingsRoutingOverlayPayload,
  type EffortDialogPayload,
  type RoutingPickerPayload,
} from '../../src/tui-v2/model/settings-routing-overlay-payloads.js'
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

function routingPayload(rig: ReturnType<typeof createControllerRig>): RoutingPickerPayload {
  const overlay = rig.state().overlays.stack.at(-1)
  assert.ok(overlay !== undefined)
  const parsed = parseSettingsRoutingOverlayPayload(overlay.payload)
  assert.ok(parsed?.kind === 'routing-picker-dialog')
  return parsed
}

function effortPayload(rig: ReturnType<typeof createControllerRig>): EffortDialogPayload {
  const overlay = rig.state().overlays.stack.at(-1)
  assert.ok(overlay !== undefined)
  const parsed = parseSettingsRoutingOverlayPayload(overlay.payload)
  assert.ok(parsed?.kind === 'effort-dialog')
  return parsed
}

interface CapabilityFixture {
  capability: ChannelOptionsCapability
  models: LlmModelInfo[]
  presets: PresetOption[]
  efforts: EffortOption[]
  modelCalls: Array<[string, string]>
  presetCalls: string[]
  effortCalls: string[]
  tools: string[]
  setWorking(value: boolean): void
  setCurrentModel(provider: string, model: string): void
  current(): { provider: string; model: string; preset?: string; effort?: string }
  emit(): void
}

function capabilityFixture(overrides: Partial<{
  switchModel: (provider: string, model: string) => Promise<boolean>
  switchPreset: (id: string) => Promise<boolean>
  setEffort: (id: string) => Promise<boolean>
  listModels: () => Promise<readonly LlmModelInfo[]>
}> = {}): CapabilityFixture {
  const models: LlmModelInfo[] = [
    { provider: 'provider-a', id: 'alpha', name: 'Alpha', description: 'Current text model', inputModalities: ['text'] },
    { provider: 'provider-b', id: 'vision/pro', name: 'Vision Pro 你好😀', description: 'Image input', inputModalities: ['text', 'image'] },
  ]
  const presets: PresetOption[] = [
    { id: 'standard', name: 'Standard', description: 'Full tool set', isDefault: true },
    { id: 'minimal', name: 'Minimal', description: 'Two tools', isDefault: false },
    { id: 'broken', name: 'Broken', broken: 'manifest missing', isDefault: false },
  ]
  const efforts: EffortOption[] = [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High', description: 'Balanced reasoning' },
    { id: 'max', name: 'Max' },
  ]
  let provider = 'provider-a'
  let model = 'alpha'
  let preset: string | undefined = 'standard'
  let effort: string | undefined = 'high'
  let working = false
  const listeners = new Set<() => void>()
  const modelCalls: Array<[string, string]> = []
  const presetCalls: string[] = []
  const effortCalls: string[] = []
  const tools = ['bash', 'edit', 'ask_user_question']
  const emit = () => { for (const listener of [...listeners]) listener() }

  const capability: ChannelOptionsCapability = {
    listModels: overrides.listModels ?? (async () => models),
    async switchModel(nextProvider, nextModel) {
      modelCalls.push([nextProvider, nextModel])
      if (overrides.switchModel !== undefined) return overrides.switchModel(nextProvider, nextModel)
      provider = nextProvider
      model = nextModel
      emit()
      return true
    },
    async listPresets() { return presets },
    async switchPreset(id) {
      presetCalls.push(id)
      if (overrides.switchPreset !== undefined) return overrides.switchPreset(id)
      if (presets.find((entry) => entry.id === id)?.broken !== undefined) return false
      preset = id
      tools.splice(0, tools.length, ...(id === 'minimal' ? ['bash', 'str_replace_editor'] : ['bash', 'edit', 'ask_user_question']))
      emit()
      return true
    },
    async listEfforts() { return { efforts, defaultEffort: 'high' } },
    async setEffort(id) {
      effortCalls.push(id)
      if (overrides.setEffort !== undefined) return overrides.setEffort(id)
      if (!efforts.some((entry) => entry.id === id)) return false
      effort = id
      emit()
      return true
    },
    currentModel: () => ({ provider, model }),
    currentPreset: () => preset,
    currentEffort: () => effort,
    working: () => working,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    capability,
    models,
    presets,
    efforts,
    modelCalls,
    presetCalls,
    effortCalls,
    tools,
    setWorking(value) { working = value; emit() },
    setCurrentModel(nextProvider, nextModel) { provider = nextProvider; model = nextModel; emit() },
    current: () => ({ provider, model, ...(preset === undefined ? {} : { preset }), ...(effort === undefined ? {} : { effort }) }),
    emit,
  }
}

function controllerFor(rig: ReturnType<typeof createControllerRig>, capability: ChannelOptionsCapability) {
  return createChannelOptionsController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
    getState: rig.state,
    capability,
    isBusinessDialogActive: () => false,
  })
}

test('controller channel options: model filter/current/no-op and exact atomic route switch', async () => {
  const rig = createControllerRig({ width: 100, height: 30 })
  let resolveSwitch!: (ok: boolean) => void
  const gated = new Promise<boolean>((resolve) => { resolveSwitch = resolve })
  const fixture = capabilityFixture({
    switchModel: async (provider, model) => {
      const ok = await gated
      if (ok) fixture.setCurrentModel(provider, model)
      return ok
    },
  })
  const controller = controllerFor(rig, fixture.capability)

  assert.equal(controller.openModel(), true)
  assert.equal(routingPayload(rig).phase, 'loading')
  await flush()
  let view = routingPayload(rig)
  assert.equal(view.phase, 'ready')
  assert.equal(view.list.items[0]?.current, true)
  assert.deepEqual(view.list.items[1]?.metadata?.map((entry) => entry.value), ['vision/pro', 'text', 'image'])

  controller.handleInput(key('enter'))
  assert.equal(fixture.modelCalls.length, 0, 'selecting the current route is a no-op')
  assert.match(routingPayload(rig).notice?.text ?? '', /already current/)

  controller.handleInput(paste('vision'))
  view = routingPayload(rig)
  assert.equal(view.list.items.length, 1)
  assert.match(view.list.items[0]?.label ?? '', /Vision Pro/)
  controller.handleInput(key('enter'))
  assert.equal(routingPayload(rig).phase, 'pending')
  assert.deepEqual(fixture.modelCalls, [['provider-b', 'vision/pro']], 'raw provider/model pair reaches one atomic API call')
  resolveSwitch(true)
  await flush()
  assert.equal(controller.activeOverlayId(), null)
  assert.deepEqual(fixture.current(), { provider: 'provider-b', model: 'vision/pro', preset: 'standard', effort: 'high' })
})

test('controller channel options: working model is disabled and late list result is fenced', async () => {
  const rig = createControllerRig({ width: 80, height: 25 })
  let resolveList!: (models: readonly LlmModelInfo[]) => void
  const delayed = new Promise<readonly LlmModelInfo[]>((resolve) => { resolveList = resolve })
  const lateFixture = capabilityFixture({ listModels: async () => delayed })
  const late = controllerFor(rig, lateFixture.capability)
  late.openModel()
  late.close()
  const afterClose = rig.applied.length
  resolveList(lateFixture.models)
  await flush()
  assert.equal(rig.applied.length, afterClose)
  assert.ok(late.diagnostics().lateResults >= 1)

  const fixture = capabilityFixture()
  fixture.setWorking(true)
  const controller = controllerFor(rig, fixture.capability)
  controller.openModel()
  await flush()
  controller.handleInput(key('down'))
  assert.equal(routingPayload(rig).list.items[1]?.disabled, true)
  controller.handleInput(key('enter'))
  assert.match(routingPayload(rig).error ?? '', /running/)
  assert.deepEqual(fixture.modelCalls, [])
})

test('controller channel options: preset metadata, broken handling, and existing capability refreshes tools', async () => {
  const rig = createControllerRig({ width: 90, height: 30 })
  const fixture = capabilityFixture()
  const controller = controllerFor(rig, fixture.capability)
  controller.openPreset()
  await flush()
  let view = routingPayload(rig)
  assert.deepEqual(view.list.items.map((item) => item.badges), [['default'], ['minimal'], ['unavailable']])
  assert.equal(view.list.items[0]?.current, true)

  controller.handleInput(key('down'))
  controller.handleInput(key('enter'))
  await flush()
  assert.deepEqual(fixture.presetCalls, ['minimal'])
  assert.deepEqual(fixture.tools, ['bash', 'str_replace_editor'], 'tool state is refreshed by the injected domain capability')
  assert.equal(controller.activeOverlayId(), null)

  controller.openPreset('broken')
  await flush()
  view = routingPayload(rig)
  assert.equal(view.list.items[0]?.disabled, true)
  controller.handleInput(key('enter'))
  assert.match(routingPayload(rig).error ?? '', /manifest missing/)
  assert.deepEqual(fixture.presetCalls, ['minimal'])
})

test('controller channel options: effort arrows/tab/backtab/numbers live-apply actual value and pending/error', async () => {
  const rig = createControllerRig({ width: 50, height: 20 })
  const fixture = capabilityFixture()
  const controller = controllerFor(rig, fixture.capability)
  controller.openEffort()
  await flush()
  let view = effortPayload(rig)
  assert.equal(view.currentId, 'high')
  assert.equal(view.activeIndex, 1)

  controller.handleInput(key('right'))
  await flush()
  view = effortPayload(rig)
  assert.deepEqual(fixture.effortCalls, ['max'])
  assert.equal(view.currentId, 'max')
  assert.equal(view.options[2]?.current, true)

  controller.handleInput(key('shift+tab'))
  await flush()
  assert.deepEqual(fixture.effortCalls, ['max', 'high'])
  assert.equal(effortPayload(rig).currentId, 'high')

  controller.handleInput(key('1', '1'))
  await flush()
  assert.deepEqual(fixture.effortCalls, ['max', 'high', 'off'])
  assert.equal(effortPayload(rig).currentId, 'off')
  assert.equal(fixture.current().effort, 'off')

  controller.handleInput(key('tab'))
  await flush()
  assert.equal(effortPayload(rig).currentId, 'high')
  controller.handleInput(key('enter'))
  assert.equal(controller.activeOverlayId(), null)

  const failedFixture = capabilityFixture({ setEffort: async () => false })
  const failed = controllerFor(rig, failedFixture.capability)
  failed.openEffort()
  await flush()
  failed.handleInput(key('right'))
  await flush()
  assert.match(effortPayload(rig).error ?? '', /not accepted/)
  assert.equal(effortPayload(rig).currentId, 'high', 'UI reports the capability actual value after failure')
  failed.dispose()
})
