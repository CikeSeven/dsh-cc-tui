/** WP-08d1 session catalog controller: bounded views, actions and cancellation. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { PreviewEntry, SessionSummary } from '../../src/dsh-adapter/sessions/index.js'
import { createSessionCatalogController, type SessionCatalogCapability } from '../../src/tui-v2/controllers/session-catalog.js'
import { parseCatalogOverlayPayload, type SessionBrowserPayload } from '../../src/tui-v2/model/catalog-overlay-payloads.js'
import type { OverlayState } from '../../src/tui-v2/model/schema.js'
import type { TerminalInputEvent } from '../../src/tui-v2/terminal/input.js'
import { createControllerRig } from './helpers/controller-rig.js'

function summary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    id: overrides.id,
    kind: { kind: 'root' },
    title: { text: overrides.id, source: 'auto' },
    cwd: '/repo',
    createdAt: 1_000,
    updatedAt: 2_000,
    bytes: 2_048,
    hasPrompt: true,
    agentPreset: 'standard',
    model: 'deepseek-v4',
    label: undefined,
    branch: 'main',
    childCount: 0,
    ...overrides,
  }
}

function key(key: string, text: string | null = null): TerminalInputEvent {
  return { kind: 'key', sequence: 0, generation: 0, payload: { key, raw: '', text, eventType: 'press' } }
}

function paste(text: string): TerminalInputEvent {
  return { kind: 'paste', sequence: 0, generation: 0, payload: { text } }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

function payload(rig: ReturnType<typeof createControllerRig>): SessionBrowserPayload {
  const overlay = rig.state().overlays.stack.at(-1)
  assert.ok(overlay !== undefined)
  const parsed = parseCatalogOverlayPayload(overlay.payload)
  assert.ok(parsed?.kind === 'session-browser-dialog')
  return parsed
}

function controllerFor(
  rig: ReturnType<typeof createControllerRig>,
  options: {
    catalog: SessionCatalogCapability
    resume?: (id: string) => Promise<{ ok: true } | { ok: false; reason: 'working' | 'unavailable' | 'cancelled' } | { ok: false; reason: 'failed'; error: string }>
    business?: () => boolean
  },
) {
  return createSessionCatalogController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
    getState: rig.state,
    catalog: options.catalog,
    replay: { resume: options.resume ?? (async () => ({ ok: true })) },
    context: () => ({ cwd: '/repo', branch: 'main', currentSessionId: 'current' }),
    sameProject: (left, right) => left === right,
    now: () => 10_000,
    isBusinessDialogActive: options.business ?? (() => false),
  })
}

test('controller session catalog: loading projects/kinds/filter/window/current and bounded preview', async () => {
  const rig = createControllerRig({ height: 30 })
  let resolveList!: (value: readonly SessionSummary[]) => void
  const list = new Promise<readonly SessionSummary[]>((resolve) => { resolveList = resolve })
  const previews = new Map<string, readonly PreviewEntry[]>()
  const catalog: SessionCatalogCapability = {
    list: () => list,
    async preview(id) { return previews.get(id) ?? [] },
    async delete() { return true },
    async rename() { return true },
  }
  const controller = controllerFor(rig, { catalog })

  assert.equal(controller.open(), true)
  assert.equal(payload(rig).phase, 'loading')
  const sessions: SessionSummary[] = [
    summary({ id: 'current', title: { text: 'Live conversation', source: 'renamed' }, updatedAt: 99_000 }),
    summary({ id: 'parent', title: { text: 'Parent 你好', source: 'prompt' }, updatedAt: 80_000, childCount: 1 }),
    summary({
      id: 'run',
      title: { text: 'Delegated run', source: 'prompt' },
      label: 'Audit 😀',
      kind: { kind: 'subagent', parent: 'parent', depth: 1 },
      updatedAt: 79_000,
    }),
    summary({ id: 'fork', title: { text: 'Fork title', source: 'auto' }, kind: { kind: 'fork', parent: 'gone' }, updatedAt: 78_000 }),
    summary({ id: 'empty', hasPrompt: false, updatedAt: 77_000 }),
    ...Array.from({ length: 20 }, (_, index) => summary({
      id: `session-${index}`,
      title: { text: index === 12 ? 'Needle session' : `Session ${index}`, source: index % 2 === 0 ? 'auto' : 'fallback' },
      cwd: '/repo',
      updatedAt: 70_000 - index,
    })),
  ]
  previews.set('parent', [
    { role: 'user', text: 'message 你好', at: 1 },
    { role: 'tool', text: 'bash · pnpm test 😀', at: 2 },
    { role: 'assistant', text: 'done', at: 3 },
  ])
  resolveList(sessions)
  await flush()

  let view = payload(rig)
  assert.equal(view.phase, 'ready')
  assert.equal(view.current.title, 'Live conversation')
  assert.equal(view.emptyCount, 1)
  assert.equal(view.hiddenSubagents, 1)
  assert.ok(view.rows.length <= 16, 'serialized catalog is windowed')
  assert.ok(view.rows.some((row) => row.kind === 'session' && row.sessionKind === 'fork'))
  assert.ok(view.rows.some((row) => row.kind === 'session' && row.cwd === '/repo'))
  assert.ok(!view.rows.some((row) => row.kind === 'session' && row.id === 'current'))

  controller.handleInput(key('tab'))
  await flush()
  view = payload(rig)
  assert.equal(view.preview.open, true)
  assert.equal(view.preview.phase, 'ready')
  assert.deepEqual(view.preview.entries.map((entry) => entry.role), ['user', 'tool', 'assistant'])

  controller.handleInput(key('ctrl+s'))
  await flush()
  view = payload(rig)
  assert.equal(view.filter.showSubagents, true)
  assert.equal(view.hiddenSubagents, 0)
  assert.ok(view.rows.some((row) => row.kind === 'session' && row.sessionKind === 'subagent'))

  controller.handleInput(key('n', 'Needle'))
  await flush()
  view = payload(rig)
  assert.equal(view.filter.query, 'Needle')
  assert.ok(view.rows.some((row) => row.kind === 'session' && row.title === 'Needle session'))
  assert.ok(view.rows.length <= 16)
  controller.handleInput(key('escape'))
  assert.equal(payload(rig).filter.query, '', 'first Esc clears the live filter')
  controller.handleInput(key('escape'))
  assert.equal(controller.activeOverlayId(), null)
})

test('controller session catalog: resume failure stays open; delete confirms; rename follows identity', async () => {
  const rig = createControllerRig({ height: 30 })
  let sessions = [
    summary({ id: 'alpha', title: { text: 'Alpha', source: 'auto' }, updatedAt: 30 }),
    summary({ id: 'beta', title: { text: 'Beta', source: 'auto' }, updatedAt: 20 }),
  ]
  const deleted: string[] = []
  const renamed: Array<[string, string]> = []
  let resumeResult: { ok: true } | { ok: false; reason: 'unavailable' } = { ok: false, reason: 'unavailable' }
  const catalog: SessionCatalogCapability = {
    async list() { return sessions },
    async preview() { return [] },
    async delete(id) {
      deleted.push(id)
      sessions = sessions.filter((item) => item.id !== id)
      return true
    },
    async rename(id, title) {
      renamed.push([id, title])
      sessions = sessions.map((item) => item.id === id
        ? { ...item, title: { text: title, source: 'renamed' as const }, updatedAt: 100 }
        : item)
      return true
    },
  }
  const controller = controllerFor(rig, { catalog, resume: async () => resumeResult })
  controller.open()
  await flush()
  assert.equal(payload(rig).selectedId, 'alpha')

  controller.handleInput(key('enter'))
  await flush()
  assert.match(payload(rig).error ?? '', /unavailable/)
  assert.equal(controller.activeOverlayId(), 'utility/session-browser')

  controller.handleInput(key('ctrl+d'))
  assert.equal(payload(rig).mode, 'confirm-delete')
  controller.handleInput(key('ctrl+enter'))
  assert.deepEqual(deleted, [], 'modified Enter cannot confirm deletion')
  controller.handleInput(key('enter'))
  await flush()
  assert.deepEqual(deleted, ['alpha'])
  assert.equal(payload(rig).selectedId, 'beta')

  controller.handleInput(key('ctrl+r'))
  assert.equal(payload(rig).mode, 'rename')
  controller.handleInput(paste(' renamed\n😀'))
  controller.handleInput(key('enter'))
  await flush()
  assert.deepEqual(renamed, [['beta', 'Beta renamed 😀']])
  assert.equal(payload(rig).selectedId, 'beta', 'MRU reorder cannot move focus to another identity')
  assert.equal(
    payload(rig).rows.find((row) => row.kind === 'session' && row.id === 'beta')?.title,
    'Beta renamed 😀',
  )

  resumeResult = { ok: true }
  controller.handleInput(key('enter'))
  await flush()
  assert.equal(controller.activeOverlayId(), null)
  assert.equal(rig.state().overlays.stack.length, 0)
})

test('controller session catalog: close/dispose and focus preemption reject late async results', async () => {
  const rig = createControllerRig({ height: 20 })
  let resolveList!: (value: readonly SessionSummary[]) => void
  const delayed = new Promise<readonly SessionSummary[]>((resolve) => { resolveList = resolve })
  const catalog: SessionCatalogCapability = {
    list: () => delayed,
    async preview() { return [] },
    async delete() { return true },
    async rename() { return true },
  }
  const controller = controllerFor(rig, { catalog })
  controller.open()
  controller.close()
  const eventsAfterClose = rig.applied.length
  resolveList([summary({ id: 'late' })])
  await flush()
  assert.equal(rig.applied.length, eventsAfterClose)
  assert.equal(rig.state().overlays.stack.length, 0)
  assert.ok(controller.diagnostics().lateResults >= 1)

  const immediate: SessionCatalogCapability = { ...catalog, async list() { return [summary({ id: 'one' })] } }
  const focused = controllerFor(rig, { catalog: immediate })
  focused.open()
  await flush()
  const business: OverlayState = {
    overlayId: 'dialog/question/preempt',
    revision: 1,
    anchor: 'center',
    visible: true,
    captureInput: true,
    nonCapturing: false,
    payload: { note: 'business' },
  }
  rig.streaming.ingest({ ...rig.meta.next('overlay', 'business-open'), type: 'overlay/open', overlay: business })
  focused.handleInput(key('down'))
  assert.equal(focused.diagnostics().staleInput, 1)
  rig.streaming.ingest({
    ...rig.meta.next('overlay', 'business-close'),
    type: 'overlay/close',
    overlayId: business.overlayId,
  })
  assert.equal(rig.state().focus.overlayId, 'utility/session-browser')
  focused.dispose()
  const afterDispose = rig.applied.length
  assert.equal(focused.open(), false)
  focused.handleInput(key('escape'))
  assert.equal(rig.applied.length, afterDispose)
})
