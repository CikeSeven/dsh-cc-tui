/** Deterministic Kitty protocol identities shared by the writer and test oracles. */
import { createHash } from 'node:crypto'

const MAX_KITTY_ID = 0x7ffffffe

function numericKittyId(value: string): number {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Kitty identity source must be a non-empty string')
  }
  const digest = createHash('sha256').update(value, 'utf8').digest()
  return (digest.readUInt32BE(0) % MAX_KITTY_ID) + 1
}

/** Numeric payload id used by Kitty upload/delete commands. */
export function kittyImageId(storeKey: string): number {
  return numericKittyId(storeKey)
}

/** Numeric placement id used to recover a logical placement from wire bytes. */
export function kittyPlacementId(imageId: string): number {
  return numericKittyId(`placement:${imageId}`)
}

/** Canonical identity observable from Kitty's `p=` placement parameter. */
export function canonicalImageId(protocol: 'kitty' | 'iterm2', imageId: string): string {
  if (protocol !== 'kitty') return imageId
  return /^kitty-(?:p|i)[1-9]\d*$/.test(imageId) ? imageId : `kitty-p${kittyPlacementId(imageId)}`
}
