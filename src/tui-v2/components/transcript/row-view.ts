/**
 * tui-v2 transcript row ViewModel (WP-04b, plan §5.1).
 *
 * Components receive immutable ViewModels only: `{ rowId, revision, blocks,
 * streaming, theme }` — never a Channel, never adapter state. `RowBlock`
 * comes from model/projections; `asRowBlocks` narrows the serializable
 * `UiRowSnapshot.blocks` array to it at the boundary (unknown shapes degrade
 * to plain text instead of throwing, so a newer adapter field cannot crash
 * the render path).
 *
 * Dependency rule (§4.3): components import model/renderer contracts only.
 */
import type { RowBlock } from '../../model/projections.js'
import type { SerializableValue, ToolLifecycleSnapshot } from '../../model/schema.js'
import type { ComponentTheme } from '../theme.js'

/** §5.1 example ViewModel, extended with the tool lifecycle for tool rows. */
export interface TranscriptRowView {
  readonly rowId: string
  readonly revision: number
  readonly blocks: readonly RowBlock[]
  readonly streaming: boolean
  readonly tool?: ToolLifecycleSnapshot
  /** Immutable tool-card display state supplied by the renderer/model view. */
  readonly verbose?: boolean
  readonly expanded?: boolean
  /** Recessive pointer rendered outside the collapsed body budget. */
  readonly footnote?: string
  readonly theme: ComponentTheme
}

const KNOWN_BLOCK_TYPES = new Set(['text', 'markdown', 'reasoning', 'label', 'notice', 'interrupt', 'compact', 'meta'])

/** Narrow `UiRowSnapshot.blocks` (SerializableValue[]) to typed RowBlocks. */
export function asRowBlocks(blocks: readonly SerializableValue[]): RowBlock[] {
  const out: RowBlock[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      out.push({ type: 'text', text: String(block) })
      continue
    }
    const type = (block as { type?: unknown }).type
    if (typeof type !== 'string' || !KNOWN_BLOCK_TYPES.has(type)) {
      out.push({ type: 'text', text: JSON.stringify(block) })
      continue
    }
    out.push(block as unknown as RowBlock)
  }
  return out
}
