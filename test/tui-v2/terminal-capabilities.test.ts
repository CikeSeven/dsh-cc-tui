import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalCapabilitySnapshot,
  capabilitySupport,
  createCapabilityRegistry,
  detectTerminalCapabilities,
  hashCapabilitySnapshot,
} from '../../src/tui-v2/terminal/capabilities.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js'

const response = (kind: 'kitty-keyboard' | 'focus', generation = 2, tokenId = 'q1') => ({
  tokenId,
  generation,
  kind,
  value: kind === 'kitty-keyboard' ? { flags: 1 } : { mode: 1, enabled: true, recognized: true },
  receivedAt: 10,
})

test('terminal capabilities: profile and allowlisted host hints normalize to immutable snapshot', () => {
  const snapshot = detectTerminalCapabilities({
    profile: getProfile('kitty-sync'),
    generation: 2,
    stdinIsTTY: true,
    environment: {
      TERM: 'xterm-kitty',
      TERM_PROGRAM: 'kitty',
      SECRET_TOKEN: 'must-not-appear',
    },
    queries: [{ token: { tokenId: 'q1', generation: 2, kind: 'kitty-keyboard' }, status: 'response', response: response('kitty-keyboard') }],
  })

  assert.equal(snapshot.host, 'kitty')
  assert.equal(snapshot.generation, 2)
  assert.equal(capabilitySupport(snapshot, 'kittyKeyboard'), true)
  assert.equal(snapshot.queries.accepted.length, 1)
  assert.equal(snapshot.queries.accepted[0]?.tokenId, 'q1')
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.capabilities), true)
  const serialized = canonicalCapabilitySnapshot(snapshot)
  assert.equal(serialized.includes('must-not-appear'), false)
  assert.equal(serialized.includes('SECRET_TOKEN'), false)
  assert.match(hashCapabilitySnapshot(snapshot), /^[0-9a-f]{64}$/)
})

test('terminal capabilities: stale generation, token mismatch and timeout are dropped conservatively', () => {
  const snapshot = detectTerminalCapabilities({
    profile: getProfile('kitty-sync'),
    generation: 2,
    queries: [
      { token: { tokenId: 'q1', generation: 1, kind: 'kitty-keyboard' }, status: 'response', response: response('kitty-keyboard', 1) },
      { token: { tokenId: 'q2', generation: 2, kind: 'kitty-keyboard' }, status: 'response', response: response('kitty-keyboard', 2, 'other') },
      { token: { tokenId: 'q3', generation: 2, kind: 'focus' }, status: 'timeout' },
    ],
  })
  assert.equal(snapshot.queries.accepted.length, 0)
  assert.equal(snapshot.queries.dropped.length, 3)
  assert.deepEqual(snapshot.queries.dropped.map((item) => item.reason), [
    'query-generation-mismatch',
    'query-token-mismatch',
    'query-timeout',
  ])
  assert.equal(snapshot.capabilities.kittyKeyboard.support, 'no')
  assert.equal(snapshot.capabilities.focusReporting.support, 'no')
})

test('terminal capabilities: unknown/non-TTY profile never enables dangerous capability', () => {
  const snapshot = detectTerminalCapabilities({
    profile: unknownConservativeDefaults(),
    generation: 0,
    stdinIsTTY: false,
    policy: { osc52: 'no' },
  })
  assert.equal(snapshot.host, 'unknown')
  assert.equal(snapshot.capabilities.alternateScreen.support, 'unknown')
  assert.equal(snapshot.capabilities.rawInput.support, 'no')
  assert.equal(snapshot.capabilities.osc52.support, 'no')
  assert.equal(snapshot.mouse.enabled, 'unknown')
  assert.equal(snapshot.conservative, true)
  assert.deepEqual(snapshot.deferred, ['pty', 'real-host'])
})

test('terminal capabilities: host profile fixtures classify ssh/tmux/vscode and nested SSH+tmux safely', () => {
  assert.equal(detectTerminalCapabilities({ profile: getProfile('ssh'), generation: 0 }).host, 'ssh')
  assert.equal(detectTerminalCapabilities({ profile: getProfile('tmux'), generation: 0 }).host, 'tmux')
  assert.equal(detectTerminalCapabilities({ profile: getProfile('vscode-terminal'), generation: 0 }).host, 'vscode')
  const nested = detectTerminalCapabilities({
    profile: getProfile('tmux'),
    generation: 0,
    environment: { TMUX: '/tmp/tmux', SSH_CONNECTION: 'present-but-not-retained' },
  })
  assert.equal(nested.host, 'tmux')
  assert.equal(nested.capabilities.tmux.support, 'yes')
  assert.equal(nested.capabilities.ssh.support, 'yes')
  assert.equal(JSON.stringify(nested).includes('present-but-not-retained'), false)
})

test('terminal capabilities: malformed query shape is dropped and disables the negotiated feature', () => {
  const snapshot = detectTerminalCapabilities({
    profile: getProfile('kitty-sync'),
    generation: 0,
    queries: [{ token: { tokenId: 'q-bad', generation: 0, kind: 'kitty-keyboard' }, status: 'response', response: { tokenId: 'q-bad', generation: 0, kind: 'kitty-keyboard', value: { flags: 99 }, receivedAt: 0 } }],
  })
  assert.equal(snapshot.queries.accepted.length, 0)
  assert.equal(snapshot.queries.dropped[0]?.reason, 'query-error')
  assert.equal(snapshot.capabilities.kittyKeyboard.support, 'no')
})

test('terminal capabilities: query policy drops even otherwise valid responses', () => {
  const snapshot = detectTerminalCapabilities({
    profile: getProfile('kitty-sync'),
    generation: 0,
    policy: { allowQueries: false },
    queries: [{ token: { tokenId: 'q-policy', generation: 0, kind: 'kitty-keyboard' }, status: 'response', response: response('kitty-keyboard', 0, 'q-policy') }],
  })
  assert.equal(snapshot.queries.accepted.length, 0)
  assert.equal(snapshot.queries.dropped[0]?.reason, 'policy-denied')
  assert.equal(snapshot.capabilities.kittyKeyboard.support, 'yes')
})

test('terminal capabilities: policy cannot re-enable a profile-denied OSC52 capability', () => {
  const profile = { ...getProfile('unicode-ambiguous-narrow'), supportsOsc52: 'no' as const }
  const snapshot = detectTerminalCapabilities({ profile, generation: 0, policy: { osc52: 'yes' } })
  assert.equal(snapshot.capabilities.osc52.support, 'no')
  assert.equal(snapshot.capabilities.osc52.reason, 'profile-denied')
})

test('terminal capabilities: registry refresh is generation-transactional and immutable', () => {
  const registry = createCapabilityRegistry({ profile: getProfile('unicode-ambiguous-narrow'), generation: 0 })
  const old = registry.snapshot()
  const stale = registry.refresh({ profile: getProfile('kitty-sync'), generation: 0 })
  assert.equal(stale.status, 'stale')
  assert.equal(registry.snapshot(), old)

  const transaction = registry.transaction({ profile: getProfile('kitty-sync'), generation: 1 })
  transaction.abort()
  assert.equal(transaction.commit().status, 'stale')
  assert.equal(registry.snapshot(), old)

  const committed = registry.refresh({ profile: getProfile('kitty-sync'), generation: 1 })
  assert.equal(committed.status, 'committed')
  assert.equal(registry.snapshot().profileId, 'kitty-sync')
})
