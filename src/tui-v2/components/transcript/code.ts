/**
 * tui-v2 fenced-code line component (WP-06c basic form, plan WP-06
 * "Markdown、代码、diff、tool card 的基本 line component").
 *
 * Scope (basic): monospaced source lines in the theme's code role, hard-clipped
 * at the width budget — code lines never wrap (a wrapped statement reads worse
 * than a clipped one; `truncateCells` drops a wide grapheme straddling the
 * boundary instead of splitting it, so clipping never breaks a grapheme).
 * Tabs expand through the §6.1 pipeline (tabstop 3). An optional dim language
 * badge line can precede the block (`showLanguage`, default off — the badge
 * rides with WP-08's syntax highlighting). Unknown/aliased languages render
 * uniformly; per-token highlighting is WP-08.
 *
 * Trust boundary (§6.1): `code` is untrusted text — it is sanitized once here
 * and re-styled only through the trusted builders (`lineToCells` + theme
 * roles + `cellsToString`). No byte of the source can smuggle CSI/OSC.
 *
 * Dependency rule (§4.3): renderer/terminal contracts and the component theme
 * only; never dsh-adapter/cordis.
 */
import type { TerminalProfile } from '../../terminal/profile.js'
import {
  assertLineWidth,
  cellsToString,
  lineToCells,
  sanitizeText,
  truncateCells,
  type LineCell,
} from '../../renderer/lines.js'
import type { ComponentTheme } from '../theme.js'
import { withStyle } from './block-lines.js'

export interface CodeRenderOptions {
  readonly theme: ComponentTheme
  readonly profile: TerminalProfile
  /** Fence info-string language (already sanitized); badge/highlight input. */
  readonly language?: string
  /** Prepend a dim language badge line (default false; WP-08 wires highlight). */
  readonly showLanguage?: boolean
  /**
   * Leading gutter for every emitted line (e.g. the markdown hanging indent
   * `'  '` or the tool-card `' ⎿ '`). Trusted text, styled subtle.
   */
  readonly indent?: string
  /** Lead for the FIRST emitted line only (defaults to `indent`); lets a host
   *  component hang its first-line marker (e.g. `'● '`) on the code block. */
  readonly firstIndent?: string
}

/**
 * Render source code to logical lines, one per source line (clipped, never
 * wrapped). An empty source renders nothing (upstream contentLines rule);
 * interior blank lines survive as blank (gutter-only) lines. Every line is
 * width-guaranteed (§3.3 I-06).
 */
export function renderCodeLines(
  code: string,
  options: CodeRenderOptions,
  width: number,
): string[] {
  if (width <= 0) return []
  const { theme, profile } = options
  const indent = options.indent ?? ''
  const indentCells = withStyle(lineToCells(indent, profile), theme.roles.subtle)
  const firstIndentCells = withStyle(lineToCells(options.firstIndent ?? indent, profile), theme.roles.subtle)
  const firstWidth = firstIndentCells.reduce((sum, cell) => sum + cell.width, 0)
  const restWidth = indentCells.reduce((sum, cell) => sum + cell.width, 0)

  const out: string[] = []
  const emit = (content: LineCell[], isFirst: boolean): void => {
    const lead = isFirst ? firstIndentCells : indentCells
    const budget = Math.max(1, width - (isFirst ? firstWidth : restWidth))
    out.push(assertLineWidth(cellsToString([...lead, ...truncateCells(content, budget)]), profile, width))
  }

  let emitted = false
  if (options.showLanguage === true && options.language !== undefined && options.language !== '') {
    emit(withStyle(lineToCells(options.language, profile), theme.roles.subtle), true)
    emitted = true
  }
  const clean = sanitizeText(code)
  if (clean === '') return out
  // A single trailing newline is a terminator, not a line (upstream rule).
  const sourceLines = clean.split('\n')
  if (sourceLines.length > 1 && sourceLines[sourceLines.length - 1] === '') sourceLines.pop()
  for (const sourceLine of sourceLines) {
    emit(withStyle(lineToCells(sourceLine, profile), theme.roles.code), !emitted)
    emitted = true
  }
  return out
}
