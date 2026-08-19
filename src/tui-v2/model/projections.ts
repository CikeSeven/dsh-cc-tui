/**
 * tui-v2 model projections (WP-04, plan §5.2/§5.3).
 *
 * Pure mappings from adapter-side row material (shape aligned with the legacy
 * `ChatRow`/`ToolRow` domain, but defined here — the model never imports
 * dsh-adapter) into immutable `UiRowSnapshot`s, plus the deterministic
 * snapshot hash shared by the adapter (rows-reset publisher) and the reducer
 * (rows-reset validator). Both sides MUST call `computeSnapshotHash` from this
 * module so a reset payload and its re-computation never drift.
 *
 * Dependency rule (§4.3): model imports nothing from other layers.
 */
import { canonicalSha256 } from './canonical-json.js'
import { encodeRowId } from './row-id.js'
import type {
  SerializableError,
  SerializableValue,
  ToolLifecycleSnapshot,
  UiRowSnapshot,
} from './schema.js'

// ---------------------------------------------------------------------------
// Projection input (model-side mirror of the legacy ChatRow/ToolRow shape)
// ---------------------------------------------------------------------------

/** Tool card material; `status` mirrors the legacy ToolRow lifecycle. */
export interface ProjectionToolInput {
  readonly status: 'running' | 'ok' | 'error'
  /** Increases only on tool lifecycle changes; spinner/notification noise must not bump it. */
  readonly lifecycleRevision: number
  readonly durationMs?: number
  readonly callView?: SerializableValue
  readonly resultView?: SerializableValue
  readonly error?: SerializableError
}

export type ProjectionRowKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'notice'
  | 'interrupt'
  | 'local'
  | 'local-output'
  | 'compact'

/**
 * Everything the adapter knows about one transcript row, in model terms.
 * Identity fields (session/epoch/source/sourceSeq) come from the adapter's
 * identity assignment (§5.3); content fields mirror the legacy `ChatRow`.
 */
export interface ProjectionRowInput {
  readonly durableSessionId: string
  readonly uiSessionGeneration: string
  readonly sessionEpoch: string
  readonly source: UiRowSnapshot['source']
  readonly sourceId: string
  readonly sourceSeq: string
  readonly durableRowId?: string
  readonly durableEventId?: string
  /** Adapter-assigned row revision (see revisions.ts); must increase per row. */
  readonly revision: number
  readonly kind: ProjectionRowKind
  readonly text: string
  readonly streaming?: boolean
  readonly label?: string
  readonly time?: number
  readonly durationMs?: number
  readonly folded?: boolean
  readonly restored?: boolean
  readonly tool?: ProjectionToolInput
}

// ---------------------------------------------------------------------------
// Block layout (§5.2 blocks are SerializableValue; components interpret them)
// ---------------------------------------------------------------------------

export type RowBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'markdown'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string; readonly durationMs?: number }
  | { readonly type: 'label'; readonly text: string }
  | { readonly type: 'notice'; readonly text: string }
  | { readonly type: 'interrupt'; readonly text: string }
  | { readonly type: 'compact'; readonly text: string }
  | { readonly type: 'meta'; readonly time?: number; readonly folded?: boolean; readonly restored?: boolean }

function contentBlocks(input: ProjectionRowInput): RowBlock[] {
  const blocks: RowBlock[] = []
  if (input.kind === 'user' && input.label !== undefined && input.label !== '') {
    blocks.push({ type: 'label', text: input.label })
  }
  switch (input.kind) {
    case 'user':
    case 'local':
    case 'local-output':
      blocks.push({ type: 'text', text: input.text })
      break
    case 'assistant':
      blocks.push({ type: 'markdown', text: input.text })
      break
    case 'reasoning':
      blocks.push({
        type: 'reasoning',
        text: input.text,
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      })
      break
    case 'tool':
      // Tool cards render from `tool` (ToolLifecycleSnapshot); `text` is the
      // fallback/plain summary line.
      if (input.text !== '') blocks.push({ type: 'text', text: input.text })
      break
    case 'notice':
      blocks.push({ type: 'notice', text: input.text })
      break
    case 'interrupt':
      blocks.push({ type: 'interrupt', text: input.text })
      break
    case 'compact':
      blocks.push({ type: 'compact', text: input.text })
      break
  }
  if (input.time !== undefined || input.folded === true || input.restored === true) {
    blocks.push({
      type: 'meta',
      ...(input.time !== undefined ? { time: input.time } : {}),
      ...(input.folded === true ? { folded: true } : {}),
      ...(input.restored === true ? { restored: true } : {}),
    })
  }
  return blocks
}

function projectTool(tool: ProjectionToolInput): ToolLifecycleSnapshot {
  const phase = tool.status === 'running' ? 'running' : tool.status === 'ok' ? 'result' : 'error'
  return {
    phase,
    lifecycleRevision: tool.lifecycleRevision,
    ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
    ...(tool.callView !== undefined ? { callView: tool.callView } : {}),
    ...(tool.resultView !== undefined ? { resultView: tool.resultView } : {}),
    ...(tool.error !== undefined ? { error: tool.error } : {}),
  }
}

/**
 * Map adapter row material to an immutable UI row snapshot. The rowId is
 * derived from the canonical identity tuple (§5.3) via `encodeRowId`; the
 * caller never supplies a rowId directly.
 */
export function projectRow(input: ProjectionRowInput): UiRowSnapshot {
  return {
    rowId: encodeRowId(input.sessionEpoch, input.source, input.sourceId, input.sourceSeq),
    ...(input.durableRowId !== undefined ? { durableRowId: input.durableRowId } : {}),
    durableSessionId: input.durableSessionId,
    uiSessionGeneration: input.uiSessionGeneration,
    sessionEpoch: input.sessionEpoch,
    source: input.source,
    sourceId: input.sourceId,
    sourceSeq: input.sourceSeq,
    ...(input.durableEventId !== undefined ? { durableEventId: input.durableEventId } : {}),
    revision: input.revision,
    kind: input.kind,
    blocks: contentBlocks(input),
    settled: input.streaming !== true,
    ...(input.tool !== undefined ? { tool: projectTool(input.tool) } : {}),
  }
}

// ---------------------------------------------------------------------------
// Snapshot hash (shared by adapter rows-reset publisher and reducer validator)
// ---------------------------------------------------------------------------

export const SNAPSHOT_HASH_PREFIX = 'snap-'
export const SNAPSHOT_HASH_HEX_LENGTH = 16

/**
 * Deterministic hash over a reset's full row list: canonical JSON of the row
 * snapshots (all stable fields), sha256, truncated hex. This is byte-identical
 * to the fixture generator's algorithm, so corpus traces validate as-is.
 */
export function computeSnapshotHash(rows: readonly UiRowSnapshot[]): string {
  return `${SNAPSHOT_HASH_PREFIX}${canonicalSha256(rows).slice(0, SNAPSHOT_HASH_HEX_LENGTH)}`
}
