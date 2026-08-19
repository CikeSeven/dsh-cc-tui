/**
 * tui-v2 component theme (WP-04b).
 *
 * Minimal role -> LineStyle map for the walking-skeleton components. Color
 * strings use the canonical spellings of the width pipeline
 * (renderer/lines.ts) so WP-06 can map them onto `StyleDescriptor` 1:1.
 * This is deliberately NOT the legacy `src/theme.ts` palette — WP-08 wires
 * the full theme system; until then one default theme serves every profile.
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
    /** Tool display name in card headers. */
    readonly toolName: LineStyle
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
    toolName: lineStyle({ bold: true }),
  },
})
