/** WP-08d1 workspace target/provider controller: fallback, flow and cancellation. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type {
  TuiWorkspaceChoice,
  TuiWorkspaceCommandResult,
  TuiWorkspaceTarget,
} from '../../src/dsh-adapter/workspaces.js'
import {
  createWorkspaceFlowController,
  type WorkspaceHostCapability,
} from '../../src/tui-v2/controllers/workspace-flow.js'
import { parseCatalogOverlayPayload, type WorkspaceDialogPayload } from '../../src/tui-v2/model/catalog-overlay-payloads.js'
import type { TerminalInputEvent } from '../../src/tui-v2/terminal/input.js'
import { createControllerRig } from './helpers/controller-rig.js'

function target(id: string, overrides: Partial<TuiWorkspaceTarget> = {}): TuiWorkspaceTarget {
  return {
    uri: `file:///repo/${id}`,
    cwd: `/repo/${id}`,
    label: id,
    description: `/repo/${id}`,
    kind: 'local',
    badge: 'LOCAL',
    ...overrides,
  }
}

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

function payload(rig: ReturnType<typeof createControllerRig>): WorkspaceDialogPayload {
  const overlay = rig.state().overlays.stack.at(-1)
  assert.ok(overlay !== undefined)
  const parsed = parseCatalogOverlayPayload(overlay.payload)
  assert.ok(parsed?.kind === 'workspace-dialog')
  return parsed
}

function fallback(current = '/repo/current'): WorkspaceHostCapability {
  return {
    async list() { return [target('current', { cwd: current, uri: `file://${current}`, label: 'current' })] },
    async resolve(reference) {
      return reference.startsWith('provider:') ? undefined : target('resolved', { cwd: reference, description: reference })
    },
    commands: () => [],
    async runCommand() { return undefined },
  }
}

function controllerFor(
  rig: ReturnType<typeof createControllerRig>,
  options: {
    host?: WorkspaceHostCapability
    local?: WorkspaceHostCapability
    current?: string
    switchTarget?: (workspace: TuiWorkspaceTarget) => Promise<boolean>
    rename?: (title: string) => Promise<boolean>
    notices?: string[]
  },
) {
  const notices = options.notices ?? []
  return createWorkspaceFlowController({
    dispatch: (event) => rig.streaming.ingest(event),
    nextMeta: (sourceSeq) => rig.meta.next('overlay', sourceSeq),
    getState: rig.state,
    ...(options.host !== undefined ? { host: options.host } : {}),
    fallback: options.local ?? fallback(options.current),
    actions: {
      currentCwd: () => options.current ?? '/repo/current',
      switchTarget: options.switchTarget ?? (async () => true),
      renameCurrent: options.rename ?? (async () => true),
    },
    isBusinessDialogActive: () => false,
    notify: (text) => { notices.push(text) },
  })
}

test('controller workspace: local/provider targets filter, window, open and switch', async () => {
  const rig = createControllerRig({ height: 25 })
  const targets = [
    target('current', { cwd: '/repo/current' }),
    ...Array.from({ length: 12 }, (_, index) => target(`local-${index}`)),
    target('remote-你好😀', {
      uri: 'ssh://host/repo',
      cwd: 'ssh://host/repo',
      kind: 'provider',
      badge: 'SSH',
      description: 'Remote provider workspace 你好😀',
    }),
  ]
  const host: WorkspaceHostCapability = {
    async list(_cwd, signal) { signal?.throwIfAborted(); return targets },
    async resolve(reference, _cwd, signal) {
      signal?.throwIfAborted()
      return targets.find((item) => item.uri === reference || item.cwd === reference)
    },
    commands: () => [],
    async runCommand() { return undefined },
  }
  const switched: string[] = []
  const controller = controllerFor(rig, {
    host,
    switchTarget: async (workspace) => { switched.push(workspace.uri); return true },
  })

  assert.equal(controller.handleCommand(''), true)
  assert.equal(payload(rig).phase, 'loading')
  await flush()
  let view = payload(rig)
  assert.equal(view.phase, 'ready')
  assert.ok(view.items.length <= 8)
  assert.ok(view.items.some((item) => item.current === true))
  assert.equal(view.hasMoreBelow, true)

  controller.handleInput(key('r', 'remote'))
  view = payload(rig)
  assert.equal(view.filteredCount, 1)
  assert.equal(view.items[0]?.badge, 'SSH')
  assert.match(view.items[0]?.description ?? '', /你好😀/)
  controller.handleInput(key('enter'))
  await flush()
  assert.deepEqual(switched, ['ssh://host/repo'])
  assert.equal(controller.activeOverlayId(), null)

  assert.equal(controller.handleCommand('open ssh://host/repo'), true)
  await flush()
  await flush()
  assert.deepEqual(switched, ['ssh://host/repo', 'ssh://host/repo'])
})

test('controller workspace: provider choices, input creation, recursive result and pending cancel', async () => {
  const rig = createControllerRig({ height: 25 })
  const created = target('created')
  const submitted: string[] = []
  let pendingSignal: AbortSignal | undefined
  let releasePending!: (result: TuiWorkspaceCommandResult) => void
  const pending = new Promise<TuiWorkspaceCommandResult>((resolve) => { releasePending = resolve })
  const inputChoice: TuiWorkspaceChoice = {
    id: 'create',
    label: 'Create workspace',
    description: 'Provider-owned creation',
    choose: () => ({ kind: 'choices', title: 'Nested', choices: [{ id: 'later', label: 'Later', choose: () => pending }] }),
    input: {
      placeholder: 'workspace name',
      submit(value, signal) {
        submitted.push(value)
        signal?.throwIfAborted()
        return { kind: 'target', target: created }
      },
    },
  }
  const host: WorkspaceHostCapability = {
    async list() { return [] },
    async resolve() { return undefined },
    commands: () => [{ name: 'review', aliases: ['rv'], description: 'Review provider workspaces' }],
    async runCommand(_name, input, _cwd, signal) {
      if (input === 'pending') {
        pendingSignal = signal
        return pending
      }
      return { kind: 'choices', title: 'Provider choices', choices: [inputChoice] }
    },
  }
  const switched: string[] = []
  const controller = controllerFor(rig, {
    host,
    switchTarget: async (workspace) => { switched.push(workspace.uri); return true },
  })

  assert.equal(controller.handleCommand('rv create'), true)
  await flush()
  let view = payload(rig)
  assert.equal(view.view, 'choices')
  assert.equal(view.items[0]?.hasInput, true)
  controller.handleInput(key('tab'))
  assert.ok(payload(rig).input !== undefined)
  controller.handleInput(paste('新 workspace\n😀'))
  controller.handleInput(key('enter'))
  await flush()
  await flush()
  assert.deepEqual(submitted, ['新 workspace 😀'])
  assert.deepEqual(switched, [created.uri])
  assert.equal(controller.activeOverlayId(), null)

  controller.handleCommand('review pending')
  await flush()
  view = payload(rig)
  assert.equal(view.phase, 'pending')
  controller.handleInput(key('escape'))
  assert.equal(pendingSignal?.aborted, true)
  releasePending({ kind: 'target', target: created })
  await flush()
  assert.deepEqual(switched, [created.uri], 'aborted provider completion is inert')
  assert.ok(controller.diagnostics().cancels >= 1)
})

test('controller workspace: missing host uses local fallback; failures and dispose are bounded', async () => {
  const rig = createControllerRig({ height: 20 })
  const notices: string[] = []
  const controller = controllerFor(rig, { notices })
  controller.handleCommand('')
  await flush()
  let view = payload(rig)
  assert.equal(view.degraded, true)
  assert.match(view.notice?.text ?? '', /local-only fallback/)
  assert.equal(view.items[0]?.kind, 'target')
  controller.close()

  controller.handleCommand('provider missing')
  assert.ok(notices.some((text) => /Unknown workspace command/.test(text)))

  let resolveLate!: (value: readonly TuiWorkspaceTarget[]) => void
  const late = new Promise<readonly TuiWorkspaceTarget[]>((resolve) => { resolveLate = resolve })
  const failingHost: WorkspaceHostCapability = {
    list: () => late,
    async resolve() { throw new Error('resolve exploded') },
    commands: () => [],
    async runCommand() { return undefined },
  }
  const lateController = controllerFor(rig, { host: failingHost })
  lateController.handleCommand('')
  lateController.dispose()
  const afterDispose = rig.applied.length
  resolveLate([target('late')])
  await flush()
  assert.equal(rig.applied.length, afterDispose)
  assert.ok(lateController.diagnostics().lateResults >= 1)
  assert.equal(lateController.handleCommand(''), false)

  const errorController = controllerFor(rig, { host: failingHost })
  errorController.handleCommand('open missing')
  await flush()
  view = payload(rig)
  assert.equal(view.phase, 'error')
  assert.match(view.error ?? '', /resolve exploded/)
})
