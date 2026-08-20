/** WP-08e2 pure image placement/fallback component contracts. */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createImageComponent,
  planImageOperations,
  resolveImagePlacement,
  type ImageViewMetadata,
} from '../../src/tui-v2/renderer/image-placement.js'
import { buildFrame } from '../../src/tui-v2/renderer/frame-builder.js'
import { measureLineWidth } from '../../src/tui-v2/renderer/lines.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import type { TerminalModeSnapshot } from '../../src/tui-v2/renderer/frame.js'

const HASH = '1'.repeat(64)
const metadata: ImageViewMetadata = {
  imageId: 'image-1',
  payloadHash: HASH,
  storeKey: `image:kitty:${HASH}`,
  x: 2,
  y: 1,
  width: 8,
  height: 4,
  label: 'preview 你好😀\x1b]52;c;evil\x07',
}

function profile(protocol: 'kitty' | 'iterm2' | null | 'unknown'): TerminalProfile {
  return {
    ...getProfile('kitty-sync'),
    id: `image-${String(protocol)}`,
    family: protocol === 'iterm2' ? 'iterm2' : protocol === 'kitty' ? 'kitty' : 'unknown',
    imageProtocol: protocol,
    columns: 20,
    rows: 8,
  }
}

function modes(height: number): TerminalModeSnapshot {
  return {
    alternateScreen: false, rawInput: false, mouse: 'off', bracketedPaste: false,
    syncOutput: false, autowrap: true, wrapPending: false,
    scrollRegion: { top: 0, bottom: height - 1 }, cursorStyle: 'block', cursorVisible: false,
    kittyKeyboard: false, modifyOtherKeys: false, focusReporting: false,
    windowsDec9001: false, osc133: false, title: null, progress: { state: 'none' },
  }
}

test('image placement chooses confirmed Kitty and clips safely to the viewport', () => {
  const result = resolveImagePlacement(metadata, profile('kitty'), { width: 7, height: 3 }, {
    storeKey: metadata.storeKey,
    payloadHash: HASH,
    protocol: 'kitty',
    bytes: 12,
  })
  assert.equal(result.status, 'supported')
  if (result.status !== 'supported') return
  assert.deepEqual(result.placement, {
    imageId: 'image-1', protocol: 'kitty', x: 2, y: 1, width: 5, height: 2,
    payloadHash: HASH, storeKey: metadata.storeKey,
  })
})

test('image placement supports confirmed iTerm2 but rejects profile/request mismatch', () => {
  const iterm = { ...metadata, requestedProtocol: 'iterm2' as const, storeKey: `image:iterm2:${HASH}` }
  assert.equal(resolveImagePlacement(iterm, profile('iterm2'), { width: 20, height: 8 }).status, 'supported')
  const mismatch = resolveImagePlacement({ ...metadata, requestedProtocol: 'kitty' }, profile('iterm2'), { width: 20, height: 8 })
  assert.equal(mismatch.status, 'fallback')
  if (mismatch.status === 'fallback') assert.equal(mismatch.diagnostic.reason, 'protocol-mismatch')
})

test('image placement treats null/unknown/sixel/outside as explicit unsupported-image fallback', () => {
  for (const [candidate, expected] of [
    [resolveImagePlacement(metadata, profile(null), { width: 20, height: 8 }), 'unsupported-profile'],
    [resolveImagePlacement(metadata, profile('unknown'), { width: 20, height: 8 }), 'unsupported-profile'],
    [resolveImagePlacement({ ...metadata, requestedProtocol: 'sixel' }, profile('kitty'), { width: 20, height: 8 }), 'sixel-unsupported'],
    [resolveImagePlacement({ ...metadata, x: 99 }, profile('kitty'), { width: 20, height: 8 }), 'outside-viewport'],
  ] as const) {
    assert.equal(candidate.status, 'fallback')
    if (candidate.status === 'fallback') {
      assert.equal(candidate.diagnostic.code, 'unsupported-image')
      assert.equal(candidate.diagnostic.reason, expected)
      assert.ok(!candidate.placeholder.includes('\x1b]52'), 'hostile controls are stripped')
    }
  }
})

test('image component obeys width 0/1/2 and invalidation contract on fallback', () => {
  const component = createImageComponent(metadata, profile(null))
  for (const width of [0, 1, 2, 10]) {
    const lines = component.render(width)
    assert.equal(lines.length, 1)
    assert.ok(measureLineWidth(lines[0] ?? '', profile(null)) <= width)
  }
  const cached = component.render(10)
  assert.equal(component.render(10), cached)
  component.invalidate()
  assert.notEqual(component.render(10), cached)
})

test('image operation planner orders delete/upload/place and inline emits no image ops', () => {
  const kitty = profile('kitty')
  const previous = buildFrame({
    frameId: 'old', stateRevision: 1, width: 20, height: 8, lines: [], profile: kitty,
    modes: modes(8), generation: 1,
    images: [{ ...metadata, protocol: 'kitty' }],
  })
  const nextImage = { ...metadata, imageId: 'image-2', x: 3, protocol: 'kitty' as const }
  const next = buildFrame({
    frameId: 'new', stateRevision: 2, width: 20, height: 8, lines: [], profile: kitty,
    modes: modes(8), generation: 1, images: [nextImage],
  })
  assert.deepEqual(planImageOperations(previous, next, { profile: kitty }).map((op) => op.kind), [
    'image-delete', 'image-upload', 'image-place',
  ])
  const diagnostics: string[] = []
  assert.deepEqual(
    planImageOperations(previous, next, {
      profile: kitty,
      inline: true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    }),
    [],
  )
  assert.deepEqual(diagnostics, ['unsupported-image'])
})

test('image operation planner re-places every Kitty placement sharing a changed payload key', () => {
  const kitty = profile('kitty')
  const oldA = { ...metadata, imageId: 'image-a', protocol: 'kitty' as const }
  const oldB = { ...metadata, imageId: 'image-b', x: 12, protocol: 'kitty' as const }
  const previous = buildFrame({
    frameId: 'shared-old', stateRevision: 1, width: 20, height: 8, lines: [], profile: kitty,
    modes: modes(8), generation: 1, images: [oldA, oldB],
  })
  const next = buildFrame({
    frameId: 'shared-next', stateRevision: 2, width: 20, height: 8, lines: [], profile: kitty,
    modes: modes(8), generation: 1, images: [{ ...oldA, x: 4 }, oldB],
  })
  const operations = planImageOperations(previous, next, { profile: kitty })
  assert.deepEqual(operations.map((operation) => operation.kind), [
    'image-delete', 'image-upload', 'image-place', 'image-place',
  ])
  assert.deepEqual(
    operations.filter((operation) => operation.kind === 'image-place').map((operation) => operation.placement.imageId),
    ['image-a', 'image-b'],
  )
})

test('iTerm2 operation planner positions cursor before upload and keeps hash-only operations', () => {
  const iterm = profile('iterm2')
  const placement = {
    ...metadata,
    requestedProtocol: 'iterm2' as const,
    protocol: 'iterm2' as const,
    storeKey: `image:iterm2:${HASH}`,
  }
  const frame = buildFrame({
    frameId: 'iterm', stateRevision: 1, width: 20, height: 8, lines: [], profile: iterm,
    modes: modes(8), generation: 1, images: [placement],
  })
  const operations = planImageOperations(null, frame, { profile: iterm })
  assert.deepEqual(operations.map((op) => op.kind), ['cursor', 'image-upload', 'image-place'])
  assert.ok(!JSON.stringify(operations).includes('raw-image-bytes'))
  assert.ok(JSON.stringify(operations).includes(HASH))
})
