/** Offline V1CaptureRenderer backed by a frozen, versioned artifact. */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { UiSnapshot } from '../../src/tui-v2/model/schema.js'
import type { TerminalProfile } from '../../src/tui-v2/terminal/profile.js'
import type { Frame, FrameResources, HyperlinkDescriptor, StyleDescriptor, TerminalCell } from '../../src/tui-v2/renderer/frame.js'
import { canonicalJson, canonicalizeFrame, compareGrid, type CanonicalGridV1 } from '../../src/tui-v2/testkit/canonical.js'
import { VirtualTerminal } from '../../src/tui-v2/testkit/virtual-terminal.js'
import {
  assertSerializable,
  captureKey,
  redactedDiagnostic,
  sha256Hex,
  validateFrozenBaselineArtifact,
  validateFrozenBaselineManifest,
  type FrozenBaselineManifest,
  type FrozenCaptureArtifact,
  type FrozenCaptureRecord,
  type V1CaptureRenderer,
  type V1CaptureResult,
} from './contract.js'
import { createFakeClock, createFakeStdin, createNoopChannelAdapter, createSideEffectSpy, type SideEffectSpy } from './side-effect-spy.js'

export interface CaptureRendererOptions {
  readonly artifact: FrozenCaptureArtifact
  readonly sideEffects?: SideEffectSpy
}

function styleKey(style: CanonicalGridV1['cells'][number]['resolvedStyle']): string {
  return canonicalJson(style)
}

function frameFromGrid(grid: CanonicalGridV1, profile: TerminalProfile, frameId: string): Frame {
  const styleIds = new Map<string, number>()
  const styles: StyleDescriptor[] = []
  const hyperlinkIds = new Map<string, number>()
  const hyperlinks: HyperlinkDescriptor[] = []
  const cells: TerminalCell[] = grid.cells.map((cell) => {
    const key = styleKey(cell.resolvedStyle)
    let styleId = styleIds.get(key)
    if (styleId === undefined) {
      styleId = styles.length
      styleIds.set(key, styleId)
      styles.push({ id: styleId, ...cell.resolvedStyle })
    }
    let hyperlinkId: number | undefined
    if (cell.hyperlink !== null) {
      const linkKey = canonicalJson(cell.hyperlink)
      hyperlinkId = hyperlinkIds.get(linkKey)
      if (hyperlinkId === undefined) {
        hyperlinkId = hyperlinks.length
        hyperlinkIds.set(linkKey, hyperlinkId)
        hyperlinks.push({ id: hyperlinkId, ...cell.hyperlink })
      }
    }
    return {
      grapheme: cell.grapheme,
      width: cell.width,
      styleId,
      ...(hyperlinkId === undefined ? {} : { hyperlinkId }),
    }
  })
  const resources: FrameResources = { styles, hyperlinks }
  return {
    frameId,
    stateRevision: 0,
    width: grid.width,
    height: grid.height,
    stride: grid.width,
    cells,
    cursor: grid.cursor as Frame['cursor'],
    modes: {
      ...grid.modes,
      scrollRegion: { ...grid.modes.scrollRegion },
      progress: { ...grid.modes.progress },
    },
    resources,
    images: grid.images.map((image) => ({ ...image, storeKey: `${image.protocol}:${image.imageId}` })),
    layers: [{ id: 'baseline', z: 0, revision: 0 }],
    generation: 0,
    fullRedraw: true,
    metadata: {
      changedRows: grid.height,
      renderMs: 0,
      diffMs: 0,
      terminalProfileId: profile.id,
      fullRedrawReason: 'initial',
    },
  }
}

function findRecord(artifact: FrozenCaptureArtifact, traceId: string, profile: string, snapshotHash: string): FrozenCaptureRecord {
  const exact = artifact.captures.find((record) => captureKey(record.traceId, record.profile, record.snapshotHash) === captureKey(traceId, profile, snapshotHash))
  if (exact !== undefined) return exact
  const byTrace = artifact.captures.find((record) => record.traceId === traceId && record.profile === profile)
  if (byTrace !== undefined) {
    throw new Error(`baseline snapshot hash mismatch for ${traceId}@${profile}`)
  }
  throw new Error(`baseline capture missing for ${traceId}@${profile}`)
}

function assertSameScalar(name: string, actual: unknown, expected: unknown): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`baseline ${name} mismatch`)
  }
}

/** Create a renderer that can only replay frozen bytes. */
export function createV1CaptureRenderer(options: CaptureRendererOptions): V1CaptureRenderer {
  const sideEffects = options.sideEffects ?? createSideEffectSpy()
  return {
    async render(snapshot, renderOptions) {
      assertSerializable(snapshot, 'capture snapshot')
      const record = findRecord(options.artifact, renderOptions.traceId, renderOptions.profile.id, snapshot.snapshotHash)
      if (renderOptions.profile.columns !== record.width || renderOptions.profile.rows !== record.height) {
        throw new Error(`baseline profile geometry ${renderOptions.profile.columns}x${renderOptions.profile.rows} does not match ${record.width}x${record.height}`)
      }
      const scope = sideEffects.install()
      const environment = {
        clock: createFakeClock(sideEffects),
        stdin: createFakeStdin(),
        channel: createNoopChannelAdapter(sideEffects),
      }
      void environment
      try {
        renderOptions.writer.reset()
        renderOptions.virtualTerminal.reset()
        const bytes = Buffer.from(record.ansiBase64, 'base64').toString('utf8')
        // A single injected write is intentional: the artifact is already a
        // frozen frame boundary, not a live stream subscription. VT replay is
        // explicit so arbitrary FakeTerminalWriter implementations stay valid.
        renderOptions.writer.write(bytes)
        renderOptions.virtualTerminal.write(bytes)
        const actualGrid = renderOptions.virtualTerminal.snapshot()
        const comparison = compareGrid(actualGrid, { gridEncoding: 'readable', value: record.grid })
        if (!comparison.ok) throw new Error(`baseline grid mismatch (${comparison.diffs.length} sanitized diffs)`)
        assertSameScalar('cursor', actualGrid.cursor, record.grid.cursor)
        assertSameScalar('modes', actualGrid.modes, record.grid.modes)
        assertSameScalar('width', actualGrid.width, record.grid.width)
        assertSameScalar('height', actualGrid.height, record.grid.height)
        const frame = frameFromGrid(record.grid, renderOptions.profile, `${renderOptions.traceId}:v1`)
        const frameGrid = canonicalizeFrame(frame)
        const frameComparison = compareGrid(frameGrid, { gridEncoding: 'readable', value: record.grid })
        if (!frameComparison.ok) throw new Error(`baseline frame/grid mismatch (${frameComparison.diffs.length} sanitized diffs)`)
        const ansiBytesHash = sha256Hex(bytes)
        if (ansiBytesHash !== record.ansiBytesHash) throw new Error(`baseline ANSI hash mismatch for ${renderOptions.traceId}`)
        return {
          frame,
          grid: actualGrid,
          ansiBytesHash,
          diagnostics: [...record.diagnostics],
        }
      } catch (error) {
        if (error instanceof Error) throw error
        throw new Error(String(error))
      } finally {
        scope.close()
        sideEffects.assertNoForbiddenSideEffects()
      }
    },
  }
}

export async function loadFrozenBaselineArtifact(filePath: string): Promise<FrozenCaptureArtifact> {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'))
  return validateFrozenBaselineArtifact(parsed)
}

export async function loadFrozenBaselineManifest(filePath: string): Promise<FrozenBaselineManifest> {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'))
  return validateFrozenBaselineManifest(parsed)
}

export interface BaselineBundleVerification {
  readonly manifest: FrozenBaselineManifest
  readonly artifact: FrozenCaptureArtifact
  readonly artifactPath: string
  readonly missingSourceFiles: readonly string[]
  readonly sourceMismatches: readonly string[]
}

/**
 * Verify the immutable provenance envelope without requiring old source files
 * to remain present. WP-09b may remove them; the pinned artifact/hash remains
 * the replay authority. Existing files, when present, must still match.
 */
export async function loadAndVerifyBaselineBundle(
  manifestPath: string,
  repoRoot: string,
): Promise<BaselineBundleVerification> {
  const manifest = await loadFrozenBaselineManifest(manifestPath)
  const artifactPath = path.resolve(repoRoot, manifest.artifact.path)
  const artifactBytes = await readFile(artifactPath)
  if (sha256Hex(artifactBytes) !== manifest.artifact.sha256) {
    throw new Error('baseline artifact hash does not match manifest')
  }
  const artifact = validateFrozenBaselineArtifact(JSON.parse(artifactBytes.toString('utf8')))
  if (artifact.sourceCommit !== manifest.source.commit || artifact.sourceTreeSha256 !== manifest.source.treeSha256) {
    throw new Error('baseline artifact source provenance does not match manifest')
  }
  if (artifact.license.sha256 !== manifest.source.license.sha256 || artifact.license.spdx !== manifest.source.license.spdx) {
    throw new Error('baseline artifact license provenance does not match manifest')
  }
  const missingSourceFiles: string[] = []
  const sourceMismatches: string[] = []
  for (const file of manifest.source.files) {
    try {
      const bytes = await readFile(path.resolve(repoRoot, file.path))
      if (sha256Hex(bytes) !== file.sha256) sourceMismatches.push(file.path)
    } catch {
      missingSourceFiles.push(file.path)
    }
  }
  try {
    const licenseBytes = await readFile(path.resolve(repoRoot, manifest.source.license.path))
    if (sha256Hex(licenseBytes) !== manifest.source.license.sha256) sourceMismatches.push(manifest.source.license.path)
  } catch {
    // The repository license is expected to remain; report it as a source
    // absence rather than trying to read or fabricate a replacement.
    missingSourceFiles.push(manifest.source.license.path)
  }
  return { manifest, artifact, artifactPath, missingSourceFiles, sourceMismatches }
}

/** Utility used by tests and the verifier to create an offline snapshot. */
export function baselineSnapshot(snapshotHash: string, width: number, height: number): UiSnapshot {
  return {
    schemaVersion: 1,
    adapterInstanceId: 'offline-baseline',
    durableSessionId: 'offline-baseline-session',
    uiSessionGeneration: 'offline-baseline-generation',
    resetEpoch: 0,
    sessionEpoch: 'offline-baseline-generation:0',
    revision: 0,
    rows: [],
    snapshotHash,
    status: { width, height },
  }
}

/** Stable relative path for diagnostics; no user data is included. */
export function artifactRelativePath(filePath: string, repoRoot: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/')
}

export { redactedDiagnostic }
