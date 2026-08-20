/**
 * tui-v2 component theme (WP-04b).
 *
 * Role -> LineStyle map shared by transcript, dialogs and search highlights.
 * Color strings use the canonical spellings of the width pipeline
 * (renderer/lines.ts) so they map onto `StyleDescriptor` 1:1. This is
 * deliberately NOT the legacy `src/theme.ts` palette; custom-theme loading is
 * a later WP-08 surface, while one deterministic default serves every profile.
 *
 * Dependency rule (§4.3): components import renderer contracts only.
 */
import { DEFAULT_LINE_STYLE, lineStyle, type LineStyle } from '../renderer/lines.js'

export interface ComponentTheme {
  readonly id: string
  readonly roles: {
    /** Body text. */
    readonly text: LineStyle
    /** Prefix glyphs, gutters, metadata, hints. */
    readonly subtle: LineStyle
    /** Accent glyphs (running tool dot, user pointer). */
    readonly accent: LineStyle
    readonly error: LineStyle
    readonly success: LineStyle
    readonly warning: LineStyle
    /** Inline code / fenced code blocks. */
    readonly code: LineStyle
    /** Hyperlink text (underline + OSC 8 when the profile allows, §6.1). */
    readonly link: LineStyle
    /** Tool display name in card headers. */
    readonly toolName: LineStyle
    /** Full-row tool card surfaces; foreground styles are merged on top. */
    readonly toolBackground: LineStyle
    readonly toolBackgroundExpanded: LineStyle
    /** Transcript search matches; current match is visually stronger. */
    readonly searchMatch: LineStyle
    readonly searchCurrent: LineStyle
  }
}

export const DEFAULT_COMPONENT_THEME: ComponentTheme = Object.freeze({
  id: 'default',
  roles: {
    text: DEFAULT_LINE_STYLE,
    subtle: lineStyle({ foreground: 'bright-black' }),
    accent: lineStyle({ foreground: 'cyan' }),
    error: lineStyle({ foreground: 'red' }),
    success: lineStyle({ foreground: 'green' }),
    warning: lineStyle({ foreground: 'yellow' }),
    code: lineStyle({ foreground: 'yellow' }),
    // WP-06a 15.1 note: component-emitted link text must carry SGR 4 itself.
    link: lineStyle({ foreground: 'cyan', underline: true }),
    toolName: lineStyle({ bold: true }),
    toolBackground: lineStyle({ background: 'ansi256:236' }),
    toolBackgroundExpanded: lineStyle({ background: 'ansi256:238' }),
    searchMatch: lineStyle({ foreground: 'black', background: 'yellow' }),
    searchCurrent: lineStyle({ foreground: 'black', background: 'cyan', bold: true }),
  },
})
