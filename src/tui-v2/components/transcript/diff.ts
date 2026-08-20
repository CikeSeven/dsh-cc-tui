/**
 * tui-v2 unified-diff line component (WP-06c basic form, plan WP-06
 * "Markdown、代码、diff、tool card 的基本 line component").
 *
 * Scope (basic): line-oriented unified-diff rendering — `+`/`-` additions and
 * deletions in the success/error roles, `@@` hunk headers in the accent role,
 * file headers (`diff `, `index `, `--- `, `+++ `, `Binary `) and the
 * `\ No newline at end of file` marker dimmed, context lines in the text
 * role. Diff lines are clipped, never wrapped (a wrapped diff line loses its
 * prefix alignment). Optional `lineNumbers` prefixes a dim new-file line
 * number gutter (tracked from `@@ -a,b +c,d @@` headers; deletions get a
 * blank gutter). Side-by-side panes, intra-line token highlight and word-diff
 * are WP-08.
 *
 * Trust boundary (§6.1): the diff text is untrusted (tool output); it is
 * sanitized once here and re-styled only through the trusted builders.
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
  type LineStyle,
} from '../../renderer/lines.js'
import type { ComponentTheme } from '../theme.js'
import { withStyle } from './block-lines.js'

export interface DiffRenderOptions {
  readonly theme: ComponentTheme
  readonly profile: TerminalProfile
  /** Prefix a dim new-file line-number gutter (default false). */
  readonly lineNumbers?: boolean
  /** Leading gutter for every emitted line (markdown/tool-card hanging indent). */
  readonly indent?: string
  /** Lead for the FIRST emitted line only (defaults to `indent`). */
  readonly firstIndent?: string
}

type DiffLineKind = 'header' | 'hunk' | 'add' | 'del' | 'marker' | 'context'

/** Classify one sanitized unified-diff line; unknown shapes are context. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'header'
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('Binary ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ')
  ) {
    return 'header'
  }
  if (line.startsWith('\\')) return 'marker'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

function styleFor(kind: DiffLineKind, theme: ComponentTheme): LineStyle {
  switch (kind) {
    case 'add':
      return theme.roles.success
    case 'del':
      return theme.roles.error
    case 'hunk':
      return theme.roles.accent
    case 'header':
    case 'marker':
      return theme.roles.subtle
    default:
      return theme.roles.text
  }
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Render unified-diff text to logical lines, one per source line (clipped,
 * never wrapped). Every line is width-guaranteed (§3.3 I-06).
 */
export function renderDiffLines(
  diffText: string,
  options: DiffRenderOptions,
  width: number,
): string[] {
  if (width <= 0) return []
  const { theme, profile } = options
  const indent = options.indent ?? ''
  const indentCells = withStyle(lineToCells(indent, profile), theme.roles.subtle)
  const firstIndentCells = withStyle(lineToCells(options.firstIndent ?? indent, profile), theme.roles.subtle)
  const firstLeadWidth = firstIndentCells.reduce((sum, cell) => sum + cell.width, 0)
  const restLeadWidth = indentCells.reduce((sum, cell) => sum + cell.width, 0)

  const clean = sanitizeText(diffText)
  const sourceLines = clean.split('\n')
  if (sourceLines.length > 1 && sourceLines[sourceLines.length - 1] === '') sourceLines.pop()

  // Number gutter width: enough for the largest new-file line number seen.
  let maxLine = 0
  if (options.lineNumbers === true) {
    let counter = 0
    for (const line of sourceLines) {
      const hunk = HUNK_RE.exec(line)
      if (hunk !== null) {
        counter = Number.parseInt(hunk[1] as string, 10) - 1
        continue
      }
      const kind = classifyDiffLine(line)
      if (kind === 'add' || kind === 'context') counter += 1
      if (counter > maxLine) maxLine = counter
    }
  }
  const gutterWidth = options.lineNumbers === true ? Math.max(2, String(Math.max(1, maxLine)).length) + 1 : 0

  const out: string[] = []
  let newLine = 0
  for (const [index, line] of sourceLines.entries()) {
    const kind = classifyDiffLine(line)
    const hunk = HUNK_RE.exec(line)
    if (hunk !== null) newLine = Number.parseInt(hunk[1] as string, 10) - 1
    const leadCells = index === 0 ? firstIndentCells : indentCells
    const leadWidth = index === 0 ? firstLeadWidth : restLeadWidth
    const budget = Math.max(1, width - leadWidth - gutterWidth)
    const gutterCells: LineCell[] = []
    if (options.lineNumbers === true) {
      let label = ''
      if (kind === 'add' || kind === 'context') {
        newLine += 1
        label = `${String(newLine).padStart(gutterWidth - 1, ' ')} `
      } else {
        label = ' '.repeat(gutterWidth)
      }
      gutterCells.push(...withStyle(lineToCells(label, profile), theme.roles.subtle))
    }
    const cells = withStyle(lineToCells(line, profile), styleFor(kind, theme))
    const clipped = truncateCells(cells, budget)
    out.push(assertLineWidth(cellsToString([...leadCells, ...gutterCells, ...clipped]), profile, width))
  }
  return out
}
