import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Clock } from '../../src/tui-v2/model/schema.js'
import { createKittyKeyboardNegotiator } from '../../src/tui-v2/terminal/kitty-keyboard.js'

class ManualClock implements Clock {
  private time = 0
  private next = 0
  private timers: Array<{ id: number; at: number; callback: () => void }> = []
  now(): number { return this.time }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.next
    this.timers.push({ id, at: this.time + delayMs, callback })
    return id
  }
  clearTimeout(handle: unknown): void { this.timers = this.timers.filter((timer) => timer.id !== handle) }
  advance(ms: number): void {
    const target = this.time + ms
    for (;;) {
      const timer = this.timers.filter((candidate) => candidate.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (timer === undefined) break
      this.timers = this.timers.filter((candidate) => candidate.id !== timer.id)
      this.time = timer.at
      timer.callback()
    }
    this.time = target
  }
}

const tick = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)) }

test('kitty keyboard: query/enable/active then idempotent cleanup', async () => {
  const clock = new ManualClock()
  let generation = 4
  const writes: string[] = []
  let inputActive = false
  const negotiator = createKittyKeyboardNegotiator({
    clock,
    generation: () => generation,
    writer: {
      query: async () => ({ tokenId: 'q1', generation: 4, kind: 'kitty-keyboard', value: { flags: 0 }, receivedAt: 0 }),
      writeControl: async (operation) => {
        writes.push(operation.kind === 'sequence' ? String(operation.sequence) : operation.kind)
        return { status: 'written' as const, bytes: 4 }
      },
    },
    setInputActive: (active) => { inputActive = active },
  })
  const active = await negotiator.negotiate()
  assert.equal(active.state, 'active')
  assert.equal(inputActive, true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0], '\x1b[>1u')

  const disabled = await negotiator.cleanup()
  assert.equal(disabled.state, 'disabled')
  assert.equal(inputActive, false)
  assert.equal(writes[1], '\x1b[<99u')
  assert.equal(await negotiator.cleanup().then((snapshot) => snapshot.state), 'disabled')
  assert.equal(writes.length, 2)
})

test('kitty keyboard: timeout falls back and does not block later cleanup', async () => {
  const clock = new ManualClock()
  const writes: string[] = []
  const negotiator = createKittyKeyboardNegotiator({
    clock,
    generation: () => 0,
    writer: {
      query: () => new Promise(() => {}),
      writeControl: async (operation) => {
        writes.push(operation.kind)
        return { status: 'written' as const }
      },
    },
  })
  const pending = negotiator.negotiate()
  await tick()
  clock.advance(300)
  const snapshot = await pending
  assert.equal(snapshot.state, 'fallback')
  assert.equal(snapshot.reason, 'query-timeout')
  assert.deepEqual(writes, [])
  assert.equal((await negotiator.cleanup()).state, 'fallback')
})

test('kitty keyboard: synchronous query failure is folded into fallback', async () => {
  const negotiator = createKittyKeyboardNegotiator({
    clock: new ManualClock(),
    generation: () => 0,
    writer: {
      query: () => { throw new Error('query unavailable') },
      writeControl: async () => ({ status: 'written' as const }),
    },
  })
  const snapshot = await negotiator.negotiate()
  assert.equal(snapshot.state, 'fallback')
  assert.equal(snapshot.reason, 'query-error')
})

test('kitty keyboard: malformed report falls back without enabling', async () => {
  const clock = new ManualClock()
  let enabled = false
  const negotiator = createKittyKeyboardNegotiator({
    clock,
    generation: () => 0,
    writer: {
      query: async () => ({ tokenId: 'bad', generation: 0, kind: 'kitty-keyboard', value: { flags: 99 }, receivedAt: 0 }),
      writeControl: async () => { enabled = true; return { status: 'written' as const } },
    },
  })
  const snapshot = await negotiator.negotiate()
  assert.equal(snapshot.state, 'fallback')
  assert.equal(snapshot.reason, 'late-response')
  assert.equal(enabled, false)
})

test('kitty keyboard: generation change drops late query before enable', async () => {
  const clock = new ManualClock()
  let generation = 1
  let resolveQuery!: (value: any) => void
  const writes: string[] = []
  const negotiator = createKittyKeyboardNegotiator({
    clock,
    generation: () => generation,
    writer: {
      query: () => new Promise((resolve) => { resolveQuery = resolve }),
      writeControl: async () => { writes.push('enable'); return { status: 'written' as const } },
    },
  })
  const pending = negotiator.negotiate(1)
  await tick()
  generation = 2
  resolveQuery({ tokenId: 'late', generation: 1, kind: 'kitty-keyboard', value: { flags: 1 }, receivedAt: 0 })
  const snapshot = await pending
  assert.equal(snapshot.state, 'fallback')
  assert.equal(snapshot.reason, 'generation-mismatch')
  assert.deepEqual(writes, [])
})
