/**
 * tui-v2 unified/side-by-side diff line component (WP-08b).
 *
 * Adjacent deletion/addition blocks are paired by source-row order. Paired
 * lines receive deterministic token-level LCS highlighting; unchanged tokens
 * keep the line tone while changed tokens are bold+inverse. At 110 columns or
 * wider the default/`split` layout renders aligned old/new panes; narrower
 * viewports always degrade to unified rows. Source lines are clipped, never
 * wrapped, so pairing cannot tear across terminal rows. A literal `⋯` is the
 * same-file hunk separator.
 *
 * Trust boundary (§6.1): the complete diff is sanitized once, and every style
 * run is rebuilt through trusted builders before cell clipping.
 */
import type { TerminalProfile } from '../../terminal/profile.js'
import {
  assertLineWidth,
  cellsToString,
  lineStyle,
  lineToCells,
  padCells,
  sanitizeText,
  styleText,
  truncateCells,
  type LineCell,
  type LineStyle,
} from '../../renderer/lines.js'
import type { ComponentTheme } from '../theme.js'
import { withStyle } from './block-lines.js'

/** Total component width at which two readable panes become available. */
export const SIDE_BY_SIDE_MIN_WIDTH = 110

export interface DiffRenderOptions {
  readonly theme: ComponentTheme
  readonly profile: TerminalProfile
  /** Prefix a dim new-file line-number gutter (unified layout only). */
  readonly lineNumbers?: boolean
  readonly indent?: string
  readonly firstIndent?: string
  /** `split` still degrades below SIDE_BY_SIDE_MIN_WIDTH. Default `auto`. */
  readonly layout?: 'auto' | 'unified' | 'split'
}

export type DiffLineKind = 'header' | 'hunk' | 'separator' | 'add' | 'del' | 'marker' | 'context'

interface WordRun {
  readonly text: string
  readonly changed: boolean
}

interface PairedWords {
  readonly old: readonly WordRun[]
  readonly next: readonly WordRun[]
}

type SideRow =
  | { readonly kind: 'meta'; readonly index: number }
  | {
      readonly kind: 'pair'
      readonly oldIndex?: number
      readonly newIndex?: number
      readonly context?: string
      readonly words?: PairedWords
    }

/** Classify one sanitized unified-diff line; unknown shapes are context. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.trim() === '⋯') return 'separator'
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
    case 'separator':
      return theme.roles.subtle
    default:
      return theme.roles.text
  }
}

function changedStyle(kind: 'add' | 'del', theme: ComponentTheme): LineStyle {
  return lineStyle({ ...styleFor(kind, theme), bold: true, inverse: true })
}

function tokenizeWords(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu) ?? []
}

function runsFromTokens(tokens: readonly string[], unchanged: ReadonlySet<number>): WordRun[] {
  const out: WordRun[] = []
  for (const [index, text] of tokens.entries()) {
    const changed = !unchanged.has(index)
    const last = out[out.length - 1]
    if (last?.changed === changed) out[out.length - 1] = { text: last.text + text, changed }
    else out.push({ text, changed })
  }
  return out
}

/** Bounded token LCS; pathological lines degrade to whole-line changed runs. */
function wordDiff(oldText: string, newText: string): PairedWords {
  if (oldText === newText) {
    return {
      old: oldText === '' ? [] : [{ text: oldText, changed: false }],
      next: newText === '' ? [] : [{ text: newText, changed: false }],
    }
  }
  const oldTokens = tokenizeWords(oldText)
  const newTokens = tokenizeWords(newText)
  if (oldTokens.length * newTokens.length > 4096) {
    return {
      old: oldText === '' ? [] : [{ text: oldText, changed: true }],
      next: newText === '' ? [] : [{ text: newText, changed: true }],
    }
  }

  const dp = Array.from({ length: oldTokens.length + 1 }, () => new Uint16Array(newTokens.length + 1))
  for (let oi = oldTokens.length - 1; oi >= 0; oi -= 1) {
    for (let ni = newTokens.length - 1; ni >= 0; ni -= 1) {
      dp[oi]![ni] = oldTokens[oi] === newTokens[ni]
        ? (dp[oi + 1]![ni + 1] as number) + 1
        : Math.max(dp[oi + 1]![ni] as number, dp[oi]![ni + 1] as number)
    }
  }

  const oldUnchanged = new Set<number>()
  const newUnchanged = new Set<number>()
  let oi = 0
  let ni = 0
  while (oi < oldTokens.length && ni < newTokens.length) {
    if (oldTokens[oi] === newTokens[ni]) {
      oldUnchanged.add(oi)
      newUnchanged.add(ni)
      oi += 1
      ni += 1
    } else if ((dp[oi + 1]![ni] as number) >= (dp[oi]![ni + 1] as number)) {
      oi += 1
    } else {
      ni += 1
    }
  }
  return {
    old: runsFromTokens(oldTokens, oldUnchanged),
    next: runsFromTokens(newTokens, newUnchanged),
  }
}

/** Pair replacement blocks and retain a map for unified intra-line styling. */
function pairSourceLines(sourceLines: readonly string[]): {
  readonly sideRows: readonly SideRow[]
  readonly wordsByIndex: ReadonlyMap<number, readonly WordRun[]>
} {
  const sideRows: SideRow[] = []
  const wordsByIndex = new Map<number, readonly WordRun[]>()
  let i = 0
  while (i < sourceLines.length) {
    const kind = classifyDiffLine(sourceLines[i] as string)
    if (kind === 'del') {
      const oldIndexes: number[] = []
      while (i < sourceLines.length && classifyDiffLine(sourceLines[i] as string) === 'del') oldIndexes.push(i++)
      const newIndexes: number[] = []
      while (i < sourceLines.length && classifyDiffLine(sourceLines[i] as string) === 'add') newIndexes.push(i++)
      const count = Math.max(oldIndexes.length, newIndexes.length)
      for (let row = 0; row < count; row += 1) {
        const oldIndex = oldIndexes[row]
        const newIndex = newIndexes[row]
        let words: PairedWords | undefined
        if (oldIndex !== undefined && newIndex !== undefined) {
          words = wordDiff((sourceLines[oldIndex] as string).slice(1), (sourceLines[newIndex] as string).slice(1))
          wordsByIndex.set(oldIndex, words.old)
          wordsByIndex.set(newIndex, words.next)
        }
        sideRows.push({
          kind: 'pair',
          ...(oldIndex !== undefined ? { oldIndex } : {}),
          ...(newIndex !== undefined ? { newIndex } : {}),
          ...(words !== undefined ? { words } : {}),
        })
      }
      continue
    }
    if (kind === 'add') {
      sideRows.push({ kind: 'pair', newIndex: i })
      i += 1
      continue
    }
    if (kind === 'context') {
      const line = sourceLines[i] as string
      sideRows.push({ kind: 'pair', context: line.startsWith(' ') ? line.slice(1) : line })
      i += 1
      continue
    }
    sideRows.push({ kind: 'meta', index: i })
    i += 1
  }
  return { sideRows, wordsByIndex }
}

function styledLineCells(
  line: string,
  kind: DiffLineKind,
  theme: ComponentTheme,
  profile: TerminalProfile,
  wordRuns?: readonly WordRun[],
): LineCell[] {
  if ((kind !== 'add' && kind !== 'del') || wordRuns === undefined) {
    return lineToCells(styleText(line, styleFor(kind, theme)), profile)
  }
  const prefix = line.slice(0, 1)
  const trusted = styleText(prefix, styleFor(kind, theme)) + wordRuns
    .map((run) => styleText(run.text, run.changed ? changedStyle(kind, theme) : styleFor(kind, theme)))
    .join('')
  return lineToCells(trusted, profile)
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function numberGutterWidth(sourceLines: readonly string[], enabled: boolean): number {
  if (!enabled) return 0
  let maxLine = 0
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
  return Math.max(2, String(Math.max(1, maxLine)).length) + 1
}

function renderUnified(
  sourceLines: readonly string[],
  wordsByIndex: ReadonlyMap<number, readonly WordRun[]>,
  options: DiffRenderOptions,
  width: number,
  indentCells: readonly LineCell[],
  firstIndentCells: readonly LineCell[],
): string[] {
  const { theme, profile } = options
  const gutterWidth = numberGutterWidth(sourceLines, options.lineNumbers === true)
  const out: string[] = []
  let newLine = 0
  for (const [index, line] of sourceLines.entries()) {
    const kind = classifyDiffLine(line)
    const hunk = HUNK_RE.exec(line)
    if (hunk !== null) newLine = Number.parseInt(hunk[1] as string, 10) - 1
    const leadCells = index === 0 ? firstIndentCells : indentCells
    const leadWidth = leadCells.reduce((sum, cell) => sum + cell.width, 0)
    const budget = Math.max(1, width - leadWidth - gutterWidth)
    const gutterCells: LineCell[] = []
    if (options.lineNumbers === true) {
      let label: string
      if (kind === 'add' || kind === 'context') {
        newLine += 1
        label = `${String(newLine).padStart(gutterWidth - 1, ' ')} `
      } else {
        label = ' '.repeat(gutterWidth)
      }
      gutterCells.push(...withStyle(lineToCells(label, profile), theme.roles.subtle))
    }
    const cells = styledLineCells(line, kind, theme, profile, wordsByIndex.get(index))
    out.push(assertLineWidth(cellsToString([...leadCells, ...gutterCells, ...truncateCells(cells, budget)]), profile, width))
  }
  return out
}

function paneCells(
  marker: ' ' | '-' | '+',
  text: string,
  words: readonly WordRun[] | undefined,
  width: number,
  theme: ComponentTheme,
  profile: TerminalProfile,
): LineCell[] {
  const kind: 'context' | 'del' | 'add' = marker === '-' ? 'del' : marker === '+' ? 'add' : 'context'
  const base = styleFor(kind, theme)
  const trusted = styleText(`${marker} `, base) + (words ?? (text === '' ? [] : [{ text, changed: false }]))
    .map((run) => styleText(run.text, run.changed && kind !== 'context' ? changedStyle(kind, theme) : base))
    .join('')
  return padCells(truncateCells(lineToCells(trusted, profile), width), width, base)
}

function renderSplit(
  sourceLines: readonly string[],
  sideRows: readonly SideRow[],
  options: DiffRenderOptions,
  width: number,
  indentCells: readonly LineCell[],
  firstIndentCells: readonly LineCell[],
): string[] {
  const { theme, profile } = options
  const out: string[] = []
  for (const [outputIndex, row] of sideRows.entries()) {
    const lead = outputIndex === 0 ? firstIndentCells : indentCells
    const leadWidth = lead.reduce((sum, cell) => sum + cell.width, 0)
    const bodyWidth = Math.max(1, width - leadWidth)
    if (row.kind === 'meta') {
      const line = sourceLines[row.index] as string
      const cells = styledLineCells(line, classifyDiffLine(line), theme, profile)
      out.push(assertLineWidth(cellsToString([...lead, ...truncateCells(cells, bodyWidth)]), profile, width))
      continue
    }

    const dividerWidth = bodyWidth >= 3 ? 1 : 0
    const oldWidth = Math.floor((bodyWidth - dividerWidth) / 2)
    const newWidth = bodyWidth - dividerWidth - oldWidth
    if (oldWidth <= 0 || newWidth <= 0) {
      const fallback = row.oldIndex !== undefined
        ? sourceLines[row.oldIndex] as string
        : row.newIndex !== undefined
          ? sourceLines[row.newIndex] as string
          : ` ${row.context ?? ''}`
      const kind = classifyDiffLine(fallback)
      out.push(assertLineWidth(cellsToString([...lead, ...truncateCells(styledLineCells(fallback, kind, theme, profile), bodyWidth)]), profile, width))
      continue
    }

    const oldText = row.context ?? (row.oldIndex !== undefined ? (sourceLines[row.oldIndex] as string).slice(1) : '')
    const newText = row.context ?? (row.newIndex !== undefined ? (sourceLines[row.newIndex] as string).slice(1) : '')
    const oldMarker: ' ' | '-' = row.context !== undefined || row.oldIndex === undefined ? ' ' : '-'
    const newMarker: ' ' | '+' = row.context !== undefined || row.newIndex === undefined ? ' ' : '+'
    const old = paneCells(oldMarker, oldText, row.words?.old, oldWidth, theme, profile)
    const next = paneCells(newMarker, newText, row.words?.next, newWidth, theme, profile)
    const divider = dividerWidth === 0 ? [] : withStyle(lineToCells('│', profile), theme.roles.subtle)
    out.push(assertLineWidth(cellsToString([...lead, ...old, ...divider, ...next]), profile, width))
  }
  return out
}

/** Render sanitized diff text through unified or width-gated split layout. */
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

  const clean = sanitizeText(diffText)
  if (clean === '') return []
  const sourceLines = clean.split('\n')
  if (sourceLines.length > 1 && sourceLines[sourceLines.length - 1] === '') sourceLines.pop()
  const paired = pairSourceLines(sourceLines)

  const split = options.layout !== 'unified' && options.lineNumbers !== true && width >= SIDE_BY_SIDE_MIN_WIDTH
  return split
    ? renderSplit(sourceLines, paired.sideRows, options, width, indentCells, firstIndentCells)
    : renderUnified(sourceLines, paired.wordsByIndex, options, width, indentCells, firstIndentCells)
}
