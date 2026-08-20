/**
 * tui-v2 testkit canonical grid + golden comparison (WP-02, plan §9.2).
 *
 * `compareGrid` is the ONLY assertion entry point for rendered output; tests
 * must never deep-compare cell grids directly and must never decode a
 * `sha256-v1` golden back into "readable" text. Diff reports contain only
 * sanitized coordinates and expected/actual cell hashes — never the original
 * grapheme payloads.
 *
 * Dependency rule: testkit may reference contracts from every layer
 * (model/renderer/terminal) but is itself only used by test/ and scripts/.
 */
import { createHash } from 'node:crypto'
// canonicalJson moved to the model layer in WP-04 so model and testkit share
// one implementation (§4.3: testkit -> model, never model -> testkit). The
// re-export keeps this module's public API unchanged.
import { canonicalJson } from '../model/canonical-json.js'
import type { SerializableValue } from '../model/schema.js'
import type {
  Frame,
  HyperlinkDescriptor,
  StyleDescriptor,
  TerminalModeSnapshot,
} from '../renderer/frame.js'
import { canonicalImageId } from '../terminal/image-protocol.js'

export type CanonicalStyle = Omit<StyleDescriptor, 'id'>
export type CanonicalHyperlink = Omit<HyperlinkDescriptor, 'id'>
export interface CanonicalCell {
  readonly grapheme: string
  readonly width: 0 | 1 | 2
  readonly continuation: boolean
  readonly resolvedStyle: CanonicalStyle
  readonly hyperlink: CanonicalHyperlink | null
}
export interface CanonicalImagePlacement {
  readonly imageId: string
  readonly protocol: 'kitty' | 'iterm2'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly payloadHash: string
}
export interface CanonicalGridV1 {
  readonly width: number
  readonly height: number
  readonly cells: readonly CanonicalCell[]
  readonly cursor: SerializableValue
  readonly modes: TerminalModeSnapshot
  readonly scrollback: readonly (readonly CanonicalCell[])[]
  readonly images: readonly CanonicalImagePlacement[]
}

/** Golden shape is fixed (§9.2): readable holds a full canonical grid, never a text digest. */
export type GoldenGrid =
  | { readonly gridEncoding: 'readable'; readonly value: CanonicalGridV1 }
  | { readonly gridEncoding: 'sha256-v1'; readonly value: string }

export type GridDiff =
  | { readonly kind: 'cell'; readonly x: number; readonly y: number; readonly expectedHash: string; readonly actualHash: string }
  | { readonly kind: 'dimensions'; readonly expectedHash: string; readonly actualHash: string }
  | { readonly kind: 'cursor'; readonly expectedHash: string; readonly actualHash: string }
  | { readonly kind: 'modes'; readonly expectedHash: string; readonly actualHash: string }
  | { readonly kind: 'scrollback'; readonly expectedHash: string; readonly actualHash: string }
  | { readonly kind: 'images'; readonly expectedHash: string; readonly actualHash: string }
  | { readonly kind: 'grid'; readonly expectedHash: string; readonly actualHash: string }

export type GridComparison = { readonly ok: true } | { readonly ok: false; readonly diffs: readonly GridDiff[] }

function fail(field: string): never {
  throw new TypeError(`invalid CanonicalGridV1: ${field}`)
}

// ---------------------------------------------------------------------------
// canonicalJson: UTF-8, keys in Unicode code-point order, arrays in semantic
// order, numbers in ECMAScript shortest round-trip form, no whitespace, no
// trailing newline (§9.2). Implementation: ../model/canonical-json.ts.
// ---------------------------------------------------------------------------

export { canonicalJson } from '../model/canonical-json.js'

/** sha256 over the UTF-8 bytes of the canonical JSON, lowercase hex (§9.2 `sha256-v1`). */
export function gridSha256(canonical: CanonicalGridV1): string {
  return createHash('sha256').update(canonicalJson(canonical), 'utf8').digest('hex')
}

function partSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// canonicalizeFrame: expand frame-local styleId/hyperlinkId into full
// resolved objects (§9.2). A missing id is a contract violation — throw.
// ---------------------------------------------------------------------------

export function canonicalizeFrame(frame: Frame): CanonicalGridV1 {
  const styles = new Map<number, StyleDescriptor>()
  for (const style of frame.resources.styles) {
    if (styles.has(style.id)) throw new TypeError(`canonicalizeFrame: duplicate style id ${style.id}`)
    styles.set(style.id, style)
  }
  const hyperlinks = new Map<number, HyperlinkDescriptor>()
  for (const link of frame.resources.hyperlinks) {
    if (hyperlinks.has(link.id)) throw new TypeError(`canonicalizeFrame: duplicate hyperlink id ${link.id}`)
    hyperlinks.set(link.id, link)
  }
  if (frame.cells.length !== frame.width * frame.height) {
    throw new TypeError(`canonicalizeFrame: cells length ${frame.cells.length} !== width*height ${frame.width * frame.height}`)
  }

  const cells: CanonicalCell[] = frame.cells.map((cell, index) => {
    const style = styles.get(cell.styleId)
    if (!style) {
      throw new TypeError(`canonicalizeFrame: cell ${index} references missing styleId ${cell.styleId}`)
    }
    let hyperlink: CanonicalHyperlink | null = null
    if (cell.hyperlinkId !== undefined) {
      const link = hyperlinks.get(cell.hyperlinkId)
      if (!link) {
        throw new TypeError(`canonicalizeFrame: cell ${index} references missing hyperlinkId ${cell.hyperlinkId}`)
      }
      hyperlink = link.params === undefined ? { uri: link.uri } : { uri: link.uri, params: link.params }
    }
    const resolvedStyle: CanonicalStyle = {
      foreground: style.foreground,
      background: style.background,
      bold: style.bold,
      dim: style.dim,
      italic: style.italic,
      underline: style.underline,
      inverse: style.inverse,
      strike: style.strike,
    }
    return {
      grapheme: cell.grapheme,
      width: cell.width,
      continuation: cell.width === 0 && cell.grapheme === '',
      resolvedStyle,
      hyperlink,
    }
  })

  const images: CanonicalImagePlacement[] = frame.images.map((image) => ({
    imageId: canonicalImageId(image.protocol, image.imageId),
    protocol: image.protocol,
    x: image.x,
    y: image.y,
    width: image.width,
    height: image.height,
    payloadHash: image.payloadHash,
  }))

  return {
    width: frame.width,
    height: frame.height,
    cells,
    cursor: { x: frame.cursor.x, y: frame.cursor.y, visible: frame.cursor.visible },
    modes: frame.modes,
    // Frame carries no scrollback field; callers that replay a VirtualTerminal
    // supply scrollback separately. Defaults to empty for this WP.
    scrollback: [],
    images,
  }
}

// ---------------------------------------------------------------------------
// Schema validation (readable goldens are validated before comparison).
// ---------------------------------------------------------------------------

function validateCanonicalCell(value: unknown, field: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
  const c = value as Record<string, unknown>
  if (typeof c.grapheme !== 'string') fail(`${field}.grapheme must be a string`)
  if (c.width !== 0 && c.width !== 1 && c.width !== 2) fail(`${field}.width must be 0|1|2`)
  if (typeof c.continuation !== 'boolean') fail(`${field}.continuation must be boolean`)
  if (c.continuation !== (c.width === 0 && c.grapheme === '')) fail(`${field}.continuation must be derived from width===0 && grapheme===''`)
  const style = c.resolvedStyle
  if (style === null || typeof style !== 'object' || Array.isArray(style)) fail(`${field}.resolvedStyle must be an object`)
  const s = style as Record<string, unknown>
  if (!(s.foreground === null || typeof s.foreground === 'string')) fail(`${field}.resolvedStyle.foreground must be string|null`)
  if (!(s.background === null || typeof s.background === 'string')) fail(`${field}.resolvedStyle.background must be string|null`)
  for (const flag of ['bold', 'dim', 'italic', 'underline', 'inverse', 'strike'] as const) {
    if (typeof s[flag] !== 'boolean') fail(`${field}.resolvedStyle.${flag} must be boolean`)
  }
  if (c.hyperlink !== null) {
    if (typeof c.hyperlink !== 'object' || Array.isArray(c.hyperlink)) fail(`${field}.hyperlink must be object|null`)
    const h = c.hyperlink as Record<string, unknown>
    if (typeof h.uri !== 'string') fail(`${field}.hyperlink.uri must be a string`)
    if (h.params !== undefined && typeof h.params !== 'string') fail(`${field}.hyperlink.params must be a string`)
  }
}

export function validateCanonicalGrid(value: unknown): CanonicalGridV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('grid must be an object')
  const g = value as Record<string, unknown>
  if (!Number.isInteger(g.width) || (g.width as number) < 0) fail('width must be a non-negative integer')
  if (!Number.isInteger(g.height) || (g.height as number) < 0) fail('height must be a non-negative integer')
  if (!Array.isArray(g.cells)) fail('cells must be an array')
  if ((g.cells as unknown[]).length !== (g.width as number) * (g.height as number)) {
    fail(`cells length ${(g.cells as unknown[]).length} !== width*height ${(g.width as number) * (g.height as number)}`)
  }
  for (const [i, cell] of (g.cells as unknown[]).entries()) validateCanonicalCell(cell, `cells[${i}]`)
  if (g.cursor === null || typeof g.cursor !== 'object' || Array.isArray(g.cursor)) fail('cursor must be an object')
  if (g.modes === null || typeof g.modes !== 'object' || Array.isArray(g.modes)) fail('modes must be an object')
  if (!Array.isArray(g.scrollback)) fail('scrollback must be an array')
  for (const [i, line] of (g.scrollback as unknown[]).entries()) {
    if (!Array.isArray(line)) fail(`scrollback[${i}] must be an array of cells`)
    for (const [j, cell] of line.entries()) validateCanonicalCell(cell, `scrollback[${i}][${j}]`)
  }
  if (!Array.isArray(g.images)) fail('images must be an array')
  for (const [i, image] of (g.images as unknown[]).entries()) {
    if (image === null || typeof image !== 'object' || Array.isArray(image)) fail(`images[${i}] must be an object`)
    const im = image as Record<string, unknown>
    if (typeof im.imageId !== 'string') fail(`images[${i}].imageId must be a string`)
    if (im.protocol !== 'kitty' && im.protocol !== 'iterm2') fail(`images[${i}].protocol must be kitty|iterm2`)
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      if (!Number.isInteger(im[field]) || (im[field] as number) < 0) fail(`images[${i}].${field} must be a non-negative integer`)
    }
    if (typeof im.payloadHash !== 'string') fail(`images[${i}].payloadHash must be a string`)
  }
  return g as unknown as CanonicalGridV1
}

export function validateGoldenGrid(value: unknown): GoldenGrid {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid GoldenGrid: must be an object')
  }
  const g = value as Record<string, unknown>
  if (g.gridEncoding === 'readable') {
    validateCanonicalGrid(g.value)
    return g as unknown as GoldenGrid
  }
  if (g.gridEncoding === 'sha256-v1') {
    if (typeof g.value !== 'string' || !/^[0-9a-f]{64}$/.test(g.value)) {
      throw new TypeError('invalid GoldenGrid: sha256-v1 value must be 64 lowercase hex chars')
    }
    return g as unknown as GoldenGrid
  }
  throw new TypeError("invalid GoldenGrid: gridEncoding must be 'readable' or 'sha256-v1'")
}

// ---------------------------------------------------------------------------
// compareGrid — the only assertion entry point (§9.2).
// ---------------------------------------------------------------------------

/**
 * Compare an actual canonical grid against a golden. `readable` validates the
 * schema first, then performs canonical deep-equal; `sha256-v1` hashes the
 * actual canonical bytes and compares the versioned hex. Failures report
 * sanitized coordinates and expected/actual hashes only — never graphemes.
 */
export function compareGrid(actual: CanonicalGridV1, expected: GoldenGrid): GridComparison {
  validateCanonicalGrid(actual)
  if (expected.gridEncoding === 'sha256-v1') {
    const actualHash = gridSha256(actual)
    if (actualHash === expected.value) return { ok: true }
    return { ok: false, diffs: [{ kind: 'grid', expectedHash: expected.value, actualHash }] }
  }

  const expectedGrid = validateCanonicalGrid(expected.value)
  // Canonical deep-equal over canonical JSON bytes (key order normalized).
  if (canonicalJson(actual) === canonicalJson(expectedGrid)) return { ok: true }

  const diffs: GridDiff[] = []
  if (actual.width !== expectedGrid.width || actual.height !== expectedGrid.height) {
    diffs.push({
      kind: 'dimensions',
      expectedHash: partSha256({ width: expectedGrid.width, height: expectedGrid.height }),
      actualHash: partSha256({ width: actual.width, height: actual.height }),
    })
  }
  const cellCount = Math.min(actual.cells.length, expectedGrid.cells.length)
  for (let i = 0; i < cellCount; i++) {
    const a = actual.cells[i]
    const e = expectedGrid.cells[i]
    const actualHash = partSha256(a)
    const expectedHash = partSha256(e)
    if (actualHash !== expectedHash) {
      diffs.push({ kind: 'cell', x: i % actual.width, y: Math.floor(i / actual.width), expectedHash, actualHash })
    }
  }
  if (actual.cells.length !== expectedGrid.cells.length) {
    diffs.push({
      kind: 'dimensions',
      expectedHash: partSha256({ cells: expectedGrid.cells.length }),
      actualHash: partSha256({ cells: actual.cells.length }),
    })
  }
  if (canonicalJson(actual.cursor) !== canonicalJson(expectedGrid.cursor)) {
    diffs.push({ kind: 'cursor', expectedHash: partSha256(expectedGrid.cursor), actualHash: partSha256(actual.cursor) })
  }
  if (canonicalJson(actual.modes) !== canonicalJson(expectedGrid.modes)) {
    diffs.push({ kind: 'modes', expectedHash: partSha256(expectedGrid.modes), actualHash: partSha256(actual.modes) })
  }
  if (canonicalJson(actual.scrollback) !== canonicalJson(expectedGrid.scrollback)) {
    diffs.push({ kind: 'scrollback', expectedHash: partSha256(expectedGrid.scrollback), actualHash: partSha256(actual.scrollback) })
  }
  if (canonicalJson(actual.images) !== canonicalJson(expectedGrid.images)) {
    diffs.push({ kind: 'images', expectedHash: partSha256(expectedGrid.images), actualHash: partSha256(actual.images) })
  }
  return { ok: false, diffs }
}
