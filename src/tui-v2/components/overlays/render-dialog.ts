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
import { parseCatalogOverlayPayload } from '../../model/catalog-overlay-payloads.js'
import { parseInteractiveOverlayPayload } from '../../model/interactive-overlay-payloads.js'
import { parseSettingsRoutingOverlayPayload } from '../../model/settings-routing-overlay-payloads.js'
import { parseDialogOverlayPayload } from '../../model/overlay-payloads.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { ComponentTheme } from '../theme.js'
import { createContextPanel } from '../panes/context-panel.js'
import type { LoadedContextView } from '../../model/surfaces.js'
import { createApprovalDialog } from './approval-dialog.js'
import { createEffortDialog, createRoutingPickerDialog } from './channel-options-dialog.js'
import { createHelpDialog } from './help-dialog.js'
import { createHistorySearchDialog } from './history-search-dialog.js'
import { createPickerDialog } from './picker-dialog.js'
import { createPluginDialog } from './plugin-dialog.js'
import { createQuestionDialog } from './question-dialog.js'
import { createSessionBrowserDialog } from './session-browser-dialog.js'
import { createSettingsDialog } from './settings-dialog.js'
import { createTranscriptSearchDialog } from './transcript-search-dialog.js'
import { createWorkspaceDialog } from './workspace-dialog.js'

export interface DialogOverlayRenderOptions {
  readonly profile: TerminalProfile
  readonly theme: ComponentTheme
}

function isLoadedContextView(value: unknown): value is LoadedContextView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return typeof raw.available === 'boolean'
    && typeof raw.loading === 'boolean'
    && typeof raw.summary === 'string'
    && Array.isArray(raw.sections)
    && Array.isArray(raw.contexts)
    && Array.isArray(raw.files)
    && Array.isArray(raw.skills)
    && Array.isArray(raw.tools)
}

/** Trusted logical lines for any managed interactive overlay at `width`. */
export function renderDialogOverlayLines(
  payload: unknown,
  width: number,
  options: DialogOverlayRenderOptions,
): readonly string[] {
  if (width <= 0) return []
  const dialog = parseDialogOverlayPayload(payload)
  if (dialog !== null) {
    switch (dialog.kind) {
      case 'approval':
        return createApprovalDialog(dialog, options).render(width)
      case 'question':
        return createQuestionDialog(dialog, options).render(width)
      case 'plugin-dialog':
        return createPluginDialog(dialog, options).render(width)
    }
  }

  const catalog = parseCatalogOverlayPayload(payload)
  if (catalog !== null) {
    switch (catalog.kind) {
      case 'session-browser-dialog':
        return createSessionBrowserDialog(catalog, options).render(width)
      case 'workspace-dialog':
        return createWorkspaceDialog(catalog, options).render(width)
    }
  }

  const settingsRouting = parseSettingsRoutingOverlayPayload(payload)
  if (settingsRouting !== null) {
    switch (settingsRouting.kind) {
      case 'settings-dialog':
        return createSettingsDialog(settingsRouting, options).render(width)
      case 'routing-picker-dialog':
        return createRoutingPickerDialog(settingsRouting, options).render(width)
      case 'effort-dialog':
        return createEffortDialog(settingsRouting, options).render(width)
    }
  }

  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const raw = payload as Record<string, unknown>
    if (raw.kind === 'context-panel' && isLoadedContextView(raw.context)) {
      return createContextPanel(raw.context, options.profile, raw.open === true).render(width)
    }
  }

  const interactive = parseInteractiveOverlayPayload(payload)
  if (interactive === null) return []
  switch (interactive.kind) {
    case 'picker-dialog':
      return createPickerDialog(interactive, options).render(width)
    case 'help-dialog':
      return createHelpDialog(interactive, options).render(width)
    case 'history-search-dialog':
      return createHistorySearchDialog(interactive, options).render(width)
    case 'transcript-search-dialog':
      return createTranscriptSearchDialog(interactive, options).render(width)
  }
}
