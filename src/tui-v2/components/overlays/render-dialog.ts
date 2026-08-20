/**
 * tui-v2 dialog overlay renderer bridge (WP-06b).
 *
 * The compositor (renderer layer) cannot import components (§4.3), so the
 * coordinator injects this bridge: narrow the opaque `OverlayState.payload`
 * (`parseDialogOverlayPayload`) and render the matching minimal dialog
 * component at the resolved content width. Foreign payloads render as zero
 * lines — components never guess at shapes they do not recognize (WP-05b
 * contract), and a zero-line overlay paints nothing.
 */
import { parseDialogOverlayPayload } from '../../model/overlay-payloads.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'
import { createApprovalDialog } from './approval-dialog.js'
import { createPluginDialog } from './plugin-dialog.js'
import { createQuestionDialog } from './question-dialog.js'

export interface DialogOverlayRenderOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

/** Trusted logical lines for a dialog overlay payload at `width` columns. */
export function renderDialogOverlayLines(
  payload: unknown,
  width: number,
  options: DialogOverlayRenderOptions,
): readonly string[] {
  const parsed = parseDialogOverlayPayload(payload)
  if (parsed === null || width <= 0) return []
  switch (parsed.kind) {
    case 'approval':
      return createApprovalDialog(parsed, options).render(width)
    case 'question':
      return createQuestionDialog(parsed, options).render(width)
    case 'plugin-dialog':
      return createPluginDialog(parsed, options).render(width)
  }
}
