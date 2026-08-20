/**
 * Pure image metadata placement and fallback component (WP-08e2).
 *
 * This module never reads image bytes and never owns a writer.  It consumes
 * serializable metadata plus a terminal profile, returns either a bounded
 * `FrameImagePlacement` or a sanitized placeholder/diagnostic, and is safe to
 * call from a renderer or test without a Channel/Cordis runtime.
 */
import type { Component } from './component.js'
import { DEFAULT_LINE_STYLE, lineToCells, cellsToString, sanitizeText, truncateCells } from './lines.js'
import type { Frame, FrameImagePlacement, ImageStore, PatchOperation } from './frame.js'
import { isImagePayloadHash, isImageStoreKey, type ImageStoreMetadata } from './image-store.js'
import type { TerminalProfile } from '../terminal/profile.js'

export type RequestedImageProtocol = 'auto' | 'kitty' | 'iterm2' | 'sixel'

export interface ImageViewMetadata {
  readonly imageId: string
  readonly payloadHash: string
  /** Ephemeral process-local key; never copied into canonical/trace output. */
  readonly storeKey: string
  readonly requestedProtocol?: RequestedImageProtocol
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly label?: string
}

export interface ImageViewport {
  readonly width: number
  readonly height: number
}

export type UnsupportedImageReason =
  | 'invalid-metadata'
  | 'unsupported-profile'
  | 'protocol-mismatch'
  | 'sixel-unsupported'
  | 'missing-store'
  | 'store-metadata-mismatch'
  | 'outside-viewport'
  | 'invalid-viewport'

export interface UnsupportedImageDiagnostic {
  readonly code: 'unsupported-image'
  readonly reason: UnsupportedImageReason
  readonly imageId?: string
  readonly payloadHash?: string
  readonly protocol?: string
}

export type ImagePlacementResult =
  | {
      readonly status: 'supported'
      readonly placement: FrameImagePlacement
      readonly diagnostic?: undefined
    }
  | {
      readonly status: 'fallback'
      readonly placeholder: string
      readonly diagnostic: UnsupportedImageDiagnostic
      readonly placement?: undefined
    }

export interface ImageComponent extends Component {
  resolve(viewport: ImageViewport, storeMetadata?: ImageStoreMetadata | null): ImagePlacementResult
}

function placeholder(metadata: Partial<ImageViewMetadata>, reason: UnsupportedImageReason, width: number): string {
  const label = typeof metadata.label === 'string' ? sanitizeText(metadata.label).slice(0, 80) : ''
  const hash = typeof metadata.payloadHash === 'string' && isImagePayloadHash(metadata.payloadHash)
    ? metadata.payloadHash.slice(0, 12)
    : 'invalid'
  const suffix = label === '' ? '' : ` ${label}`
  const text = `[Image unavailable: ${reason} ${hash}${suffix}]`
  if (width <= 0) return ''
  return cellsToString(truncateCells(lineToCells(text, FALLBACK_PROFILE), width))
}

// Placeholder text is ASCII, so its profile only matters for the shared cell
// pipeline.  The actual image resolver remains profile-driven.
const FALLBACK_PROFILE = {
  ambiguousWidth: 1,
  unicodeLevel: 2,
} as TerminalProfile

function fallback(
  metadata: Partial<ImageViewMetadata>,
  reason: UnsupportedImageReason,
  width: number,
  extra: Partial<UnsupportedImageDiagnostic> = {},
): ImagePlacementResult {
  const diagnostic: UnsupportedImageDiagnostic = {
    code: 'unsupported-image',
    reason,
    ...(typeof metadata.imageId === 'string' ? { imageId: metadata.imageId } : {}),
    ...(typeof metadata.payloadHash === 'string' ? { payloadHash: metadata.payloadHash } : {}),
    ...(extra.protocol !== undefined ? { protocol: extra.protocol } : {}),
  }
  return { status: 'fallback', placeholder: placeholder(metadata, reason, width), diagnostic }
}

function validInt(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min
}

/**
 * Resolve one metadata placement.  `storeMetadata` is optional for the pure
 * component seam; the writer performs the authoritative byte/hash check before
 * transmission.  When supplied, it must agree with the frame metadata.
 */
export function resolveImagePlacement(
  metadata: ImageViewMetadata,
  profile: TerminalProfile,
  viewport: ImageViewport,
  storeMetadata?: ImageStoreMetadata | null,
): ImagePlacementResult {
  const widthForPlaceholder = validInt(viewport.width) ? viewport.width : 0
  if (!validInt(viewport.width, 1) || !validInt(viewport.height, 1)) {
    return fallback(metadata, 'invalid-viewport', widthForPlaceholder)
  }
  if (
    typeof metadata.imageId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(metadata.imageId) ||
    !isImagePayloadHash(metadata.payloadHash) ||
    !isImageStoreKey(metadata.storeKey) ||
    !validInt(metadata.x) || !validInt(metadata.y) ||
    !validInt(metadata.width, 1) || !validInt(metadata.height, 1)
  ) {
    return fallback(metadata, 'invalid-metadata', viewport.width)
  }

  const requested = metadata.requestedProtocol ?? 'auto'
  if (requested === 'sixel') {
    return fallback(metadata, 'sixel-unsupported', viewport.width, { protocol: requested })
  }
  const profileProtocol = profile.imageProtocol
  if (profileProtocol !== 'kitty' && profileProtocol !== 'iterm2') {
    return fallback(metadata, 'unsupported-profile', viewport.width, { protocol: String(profileProtocol) })
  }
  if (requested !== 'auto' && requested !== profileProtocol) {
    return fallback(metadata, 'protocol-mismatch', viewport.width, { protocol: requested })
  }
  if (metadata.storeKey !== `image:${profileProtocol}:${metadata.payloadHash}`) {
    return fallback(metadata, 'store-metadata-mismatch', viewport.width, { protocol: profileProtocol })
  }
  if (storeMetadata !== undefined && storeMetadata !== null) {
    if (
      storeMetadata.storeKey !== metadata.storeKey ||
      storeMetadata.payloadHash !== metadata.payloadHash ||
      storeMetadata.protocol !== profileProtocol
    ) {
      return fallback(metadata, 'store-metadata-mismatch', viewport.width, { protocol: profileProtocol })
    }
  }

  if (metadata.x >= viewport.width || metadata.y >= viewport.height) {
    return fallback(metadata, 'outside-viewport', viewport.width, { protocol: profileProtocol })
  }
  const clippedWidth = Math.min(metadata.width, viewport.width - metadata.x)
  const clippedHeight = Math.min(metadata.height, viewport.height - metadata.y)
  if (clippedWidth < 1 || clippedHeight < 1) {
    return fallback(metadata, 'outside-viewport', viewport.width, { protocol: profileProtocol })
  }

  return {
    status: 'supported',
    placement: {
      imageId: metadata.imageId,
      protocol: profileProtocol,
      x: metadata.x,
      y: metadata.y,
      width: clippedWidth,
      height: clippedHeight,
      payloadHash: metadata.payloadHash,
      storeKey: metadata.storeKey,
    },
  }
}

/** Construct a pure component; supported images occupy no text cells. */
export function createImageComponent(
  metadata: ImageViewMetadata,
  profile: TerminalProfile,
  storeMetadata?: ImageStoreMetadata | null,
): ImageComponent {
  let lastWidth: number | null = null
  let lastHeight: number | null = null
  let lastResult: ImagePlacementResult | null = null
  let lastLines: string[] | null = null
  const resolve = (viewport: ImageViewport, currentStoreMetadata = storeMetadata): ImagePlacementResult => {
    if (
      lastResult !== null &&
      lastWidth === viewport.width &&
      lastHeight === viewport.height &&
      currentStoreMetadata === storeMetadata
    ) return lastResult
    const result = resolveImagePlacement(metadata, profile, viewport, currentStoreMetadata)
    lastWidth = viewport.width
    lastHeight = viewport.height
    lastResult = result
    lastLines = null
    return result
  }
  return {
    render(width: number): string[] {
      const result = resolve({ width, height: profile.rows }, storeMetadata)
      if (lastLines === null) lastLines = result.status === 'fallback' ? [result.placeholder] : []
      return lastLines
    },
    resolve,
    invalidate() {
      lastWidth = null
      lastHeight = null
      lastResult = null
      lastLines = null
    },
  }
}

/** Convert an image decision into a frame image list without leaking bytes. */
export function placementOrEmpty(result: ImagePlacementResult): readonly FrameImagePlacement[] {
  return result.status === 'supported' ? [result.placement] : []
}

/** A default style export keeps the component contract easy to test without a theme dependency. */
export const IMAGE_FALLBACK_STYLE = DEFAULT_LINE_STYLE

export interface ImageOperationPlanOptions {
  readonly profile: TerminalProfile
  readonly inline?: boolean
  readonly forceFull?: boolean
  /** Required by a backend before it can emit upload operations. */
  readonly store?: ImageStore
  readonly requireStore?: boolean
  readonly onDiagnostic?: (diagnostic: UnsupportedImageDiagnostic) => void
}

function placementMetadata(placement: FrameImagePlacement): ImageViewMetadata {
  return {
    imageId: placement.imageId,
    payloadHash: placement.payloadHash,
    storeKey: placement.storeKey,
    requestedProtocol: placement.protocol,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
  }
}

function sameImage(a: FrameImagePlacement, b: FrameImagePlacement): boolean {
  return (
    a.storeKey === b.storeKey &&
    a.payloadHash === b.payloadHash &&
    a.protocol === b.protocol &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  )
}

function resolveForPlan(
  image: FrameImagePlacement,
  next: Frame,
  options: ImageOperationPlanOptions,
): ImagePlacementResult {
  if (options.requireStore === true) {
    const store = options.store
    const metadata = store?.metadata?.(image.storeKey)
    if (store === undefined || metadata === null || metadata === undefined) {
      return fallback(placementMetadata(image), 'missing-store', next.width)
    }
    return resolveImagePlacement(placementMetadata(image), options.profile, next, metadata)
  }
  return resolveImagePlacement(placementMetadata(image), options.profile, next, null)
}

/**
 * Plan image lifecycle operations from frame metadata only.  It is pure: the
 * writer performs the authoritative store/hash validation when it encodes the
 * resulting operations.  The resources/cell operations remain owned by the
 * screen backend; callers append this list after their cell recipe.
 */
export function planImageOperations(
  previous: Frame | null,
  next: Frame,
  options: ImageOperationPlanOptions,
): PatchOperation[] {
  const previousImages = previous?.images ?? []
  const nextImages = next.images
  const operations: PatchOperation[] = []
  const previousById = new Map(previousImages.map((image) => [image.imageId, image]))

  if (options.inline) {
    for (const image of nextImages) {
      const result = resolveForPlan(image, next, options)
      if (result.status === 'fallback') options.onDiagnostic?.(result.diagnostic)
      else {
        options.onDiagnostic?.({
          code: 'unsupported-image',
          reason: 'unsupported-profile',
          imageId: image.imageId,
          payloadHash: image.payloadHash,
          protocol: image.protocol,
        })
      }
    }
    return operations
  }

  const resolvedNext = new Map<string, FrameImagePlacement>()
  for (const image of nextImages) {
    const result = resolveForPlan(image, next, options)
    if (result.status === 'fallback') {
      options.onDiagnostic?.(result.diagnostic)
      continue
    }
    resolvedNext.set(image.imageId, result.placement)
  }

  const forceFull = options.forceFull === true
  const changedKeys = new Set<string>()
  for (const oldImage of previousImages) {
    const current = resolvedNext.get(oldImage.imageId)
    if (forceFull || current === undefined || !sameImage(oldImage, current)) changedKeys.add(oldImage.storeKey)
  }
  for (const current of resolvedNext.values()) {
    const oldImage = previousById.get(current.imageId)
    if (forceFull || oldImage === undefined || !sameImage(oldImage, current)) changedKeys.add(current.storeKey)
  }

  // Kitty delete is keyed by uploaded image id, so changing one placement of
  // a shared payload removes every placement of that payload. Re-place the
  // complete next-key group after each delete. Full redraw clears everything.
  if (forceFull && previousImages.length > 0) operations.push({ kind: 'image-clear' })
  else {
    for (const storeKey of changedKeys) {
      if (previousImages.some((image) => image.storeKey === storeKey)) {
        operations.push({ kind: 'image-delete', storeKey })
      }
    }
  }

  for (const [storeKey, group] of Map.groupBy([...resolvedNext.values()], (image) => image.storeKey)) {
    if (!forceFull && !changedKeys.has(storeKey)) continue
    const first = group[0] as FrameImagePlacement
    // Kitty uploads once and supports many placement references. iTerm2 has
    // no persistent placement command, so each placement is a bounded OSC
    // 1337 upload at its own cursor position.
    if (first.protocol === 'kitty') {
      operations.push({ kind: 'image-upload', storeKey, protocol: first.protocol, payloadHash: first.payloadHash })
      for (const placement of group) operations.push({ kind: 'image-place', placement })
    } else {
      for (const placement of group) {
        operations.push({ kind: 'cursor', x: placement.x, y: placement.y, visible: false })
        operations.push({ kind: 'image-upload', storeKey, protocol: placement.protocol, payloadHash: placement.payloadHash })
        operations.push({ kind: 'image-place', placement })
      }
    }
  }
  return operations
}
