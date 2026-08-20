/** WP-08e2 adapter/image seam: metadata only, bytes never cross the UI boundary. */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  projectStagedImageMetadata,
  type StagedImageInput,
} from '../../src/dsh-adapter/channel.js'
import { createControllerRig } from './helpers/controller-rig.js'

test('staged image metadata is hash-only and serializable', () => {
  const input: StagedImageInput = { data: new TextEncoder().encode('secret image bytes'), mediaType: 'image/png', name: 'x.png' }
  const attachment = { attachmentId: 'sha256:attachment', mediaType: 'image/png' as const, bytes: input.data.byteLength, width: 4, height: 3, name: 'x.png' }
  const metadata = projectStagedImageMetadata('[Image #1]', input, attachment)
  assert.deepEqual(metadata, {
    token: '[Image #1]',
    payloadHash: createHash('sha256').update(input.data).digest('hex'),
    mediaType: 'image/png',
    bytes: input.data.byteLength,
    width: 4,
    height: 3,
    name: 'x.png',
  })
  const serialized = JSON.stringify(metadata)
  assert.ok(!serialized.includes('secret image bytes'))
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'data'), false)
})

test('staged image controller command returns stored hash metadata without AppEvent bytes', async () => {
  const rig = createControllerRig({
    storeStagedImage: async (_input, metadata) => ({
      status: 'stored', token: metadata.token, metadata,
      storeKey: `image:kitty:${metadata.payloadHash}`, protocol: 'kitty',
    }),
  })
  const input: StagedImageInput = {
    data: new TextEncoder().encode('process-local payload'), mediaType: 'image/png', name: 'clip.png',
  }
  const before = rig.applied.length
  const result = await rig.adapter.commands.stageImage(input)
  assert.equal(result.status, 'stored')
  assert.equal(rig.applied.length, before, 'staging emits no AppEvent')
  assert.ok(JSON.stringify(result).includes(createHash('sha256').update(input.data).digest('hex')))
  assert.ok(!JSON.stringify(result).includes('process-local payload'))
  assert.match(rig.channel.notifyLog.at(-1)?.text ?? '', /Image staged as \[Image #1\]/)
})

test('staged image command unsupported path returns placeholder and warning', async () => {
  const rig = createControllerRig()
  const result = await rig.adapter.commands.stageImage({
    data: new Uint8Array([1, 2, 3]), mediaType: 'image/png',
  })
  assert.equal(result.status, 'fallback')
  if (result.status !== 'fallback') return
  assert.equal(result.reason, 'unsupported-profile')
  assert.match(result.placeholder, /^\[Image unavailable:/)
  assert.equal(rig.channel.notifyLog.at(-1)?.color, 'warning')
})
