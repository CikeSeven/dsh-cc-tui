/**
 * tui-v2 streaming-safe Markdown line component (WP-08b).
 *
 * Supported blocks: joined soft-line paragraphs, ATX/setext headings,
 * thematic breaks, lists, blockquotes, backtick/tilde fences, reference
 * definitions/links, and aligned pipe tables. Inline parsing supports code,
 * links, `*`/`_` emphasis, strong emphasis, and nested mixed delimiters.
 * Incomplete streaming structures are rendered from all complete source lines:
 * an unclosed fence shows its gathered code and unmatched inline delimiters
 * stay literal.
 *
 * Tables size and align columns in terminal cells. When even one-cell columns
 * plus separators cannot fit, the source rows degrade to cell-safe clipping.
 * Fenced code and diff lines are always clipped, never wrapped.
 *
 * Trust boundary (§6.1): Markdown source is sanitized on entry; all styling and
 * OSC 8 links are rebuilt through trusted line/cell builders. Link targets use
 * a conservative http(s)/mailto allowlist.
 */
import type { TerminalProfile } from '../../terminal/profile.js'
import {
  assertLineWidth,
  cellsToString,
  cellsWidth,
  lineStyle,
  lineStyleEquals,
  lineToCells,
  padCells,
  sanitizeText,
  styleText,
  truncateCells,
  wrapCells,
  type LineCell,
  type LineStyle,
} from '../../renderer/lines.js'
import type { ComponentTheme } from '../theme.js'
import { withStyle } from './block-lines.js'
import { normalizeCodeLanguage, renderCodeLines } from './code.js'
import { renderDiffLines } from './diff.js'

export interface MarkdownRenderOptions {
  readonly theme: ComponentTheme
  readonly profile: TerminalProfile
  readonly prefix?: string
  readonly indent?: string
}

interface InlineSegment {
  readonly text: string
  readonly style: LineStyle
  readonly hyperlink: string | null
}

interface InlineContext {
  readonly theme: ComponentTheme
  readonly profile: TerminalProfile
  readonly references: ReadonlyMap<string, string>
}

type TableAlignment = 'left' | 'center' | 'right'

interface ParsedTable {
  readonly rows: readonly (readonly string[])[]
  readonly align: readonly TableAlignment[]
  readonly source: readonly string[]
}

const LINK_SAFE_SCHEME_RE = /^(https?:|mailto:)/i
const HEADING_RE = /^\s{0,3}(#{1,6})(?:\s+|$)(.*)$/
const SETEXT_RE = /^\s{0,3}(=+|-+)\s*$/
const LIST_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const REFERENCE_DEF_RE = /^\s{0,3}\[([^\]\n]+)\]:\s*(?:<([^>\s]+)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/
const TABLE_SEPARATOR_CELL_RE = /^:?-{3,}:?$/

function mergeStyle(base: LineStyle, overlay: LineStyle, attrs: Partial<LineStyle> = {}): LineStyle {
  return lineStyle({
    foreground: overlay.foreground ?? base.foreground,
    background: overlay.background ?? base.background,
    bold: base.bold || overlay.bold,
    dim: base.dim || overlay.dim,
    italic: base.italic || overlay.italic,
    underline: base.underline || overlay.underline,
    inverse: base.inverse || overlay.inverse,
    strike: base.strike || overlay.strike,
    ...attrs,
  })
}

function pushInline(out: InlineSegment[], segment: InlineSegment): void {
  if (segment.text === '') return
  const last = out[out.length - 1]
  if (last !== undefined && last.hyperlink === segment.hyperlink && lineStyleEquals(last.style, segment.style)) {
    out[out.length - 1] = { ...last, text: last.text + segment.text }
  } else {
    out.push(segment)
  }
}

function referenceKey(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

function delimiterCanOpen(text: string, index: number, delimiter: string): boolean {
  const next = text[index + delimiter.length]
  if (next === undefined || /\s/.test(next)) return false
  if (delimiter === '_' && delimiter.length === 1) {
    const previous = text[index - 1]
    if (previous !== undefined && /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next)) return false
  }
  return true
}

/** Find a close run. Mixed delimiter nesting is recursive; unmatched runs stay literal. */
function findClosingDelimiter(text: string, start: number, delimiter: string): number {
  const ch = delimiter[0] as string
  let i = start
  while (i < text.length) {
    if (text[i] !== ch) {
      i += 1
      continue
    }
    const runStart = i
    while (i < text.length && text[i] === ch) i += 1
    const runLength = i - runStart
    const before = text[runStart - 1]
    if (runLength < delimiter.length || before === undefined || /\s/.test(before)) continue
    if (delimiter.length === 1) {
      const close = runStart + runLength - 1
      if (delimiter === '_') {
        const after = text[close + 1]
        if (after !== undefined && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) continue
      }
      return close
    }
    return runStart
  }
  return -1
}

function appendLink(
  out: InlineSegment[],
  label: string,
  url: string,
  context: InlineContext,
  baseStyle: LineStyle,
  parentLink: string | null,
): void {
  if (context.profile.supportsOsc8Hyperlinks === 'yes' && LINK_SAFE_SCHEME_RE.test(url)) {
    const linkStyle = mergeStyle(baseStyle, context.theme.roles.link)
    for (const segment of inlineSegments(label, context, linkStyle, url)) pushInline(out, segment)
    return
  }
  for (const segment of inlineSegments(label, context, baseStyle, parentLink)) pushInline(out, segment)
  pushInline(out, { text: ` (${url})`, style: baseStyle, hyperlink: parentLink })
}

function inlineSegments(
  text: string,
  context: InlineContext,
  baseStyle: LineStyle = context.theme.roles.text,
  hyperlink: string | null = null,
): InlineSegment[] {
  const out: InlineSegment[] = []
  let plainStart = 0
  let i = 0
  const flushPlain = (end: number): void => {
    if (end > plainStart) pushInline(out, { text: text.slice(plainStart, end), style: baseStyle, hyperlink })
  }

  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && /[\\`*_[\]()]/.test(text[i + 1] as string)) {
      flushPlain(i)
      pushInline(out, { text: text[i + 1] as string, style: baseStyle, hyperlink })
      i += 2
      plainStart = i
      continue
    }

    if (text[i] === '`') {
      let ticks = 1
      while (text[i + ticks] === '`') ticks += 1
      const marker = '`'.repeat(ticks)
      const close = text.indexOf(marker, i + ticks)
      if (close !== -1) {
        flushPlain(i)
        let code = text.slice(i + ticks, close).replace(/\s+/g, ' ')
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1)
        pushInline(out, {
          text: code,
          style: mergeStyle(baseStyle, context.theme.roles.code),
          hyperlink,
        })
        i = close + ticks
        plainStart = i
        continue
      }
    }

    if (text[i] === '[') {
      const labelEnd = text.indexOf(']', i + 1)
      if (labelEnd !== -1) {
        const label = text.slice(i + 1, labelEnd)
        let url: string | undefined
        let end = labelEnd + 1
        if (text[end] === '(') {
          const urlEnd = text.indexOf(')', end + 1)
          const candidate = urlEnd === -1 ? '' : text.slice(end + 1, urlEnd).trim().replace(/^<|>$/g, '')
          if (urlEnd !== -1 && candidate !== '' && !/\s/.test(candidate)) {
            url = candidate
            end = urlEnd + 1
          }
        } else if (text[end] === '[') {
          const refEnd = text.indexOf(']', end + 1)
          if (refEnd !== -1) {
            const ref = text.slice(end + 1, refEnd) || label
            url = context.references.get(referenceKey(ref))
            if (url !== undefined) end = refEnd + 1
          }
        } else {
          url = context.references.get(referenceKey(label))
        }
        if (url !== undefined) {
          flushPlain(i)
          appendLink(out, label, url, context, baseStyle, hyperlink)
          i = end
          plainStart = i
          continue
        }
      }
    }

    const strong = text.startsWith('**', i) ? '**' : text.startsWith('__', i) ? '__' : null
    const emphasis = strong ?? (text[i] === '*' ? '*' : text[i] === '_' ? '_' : null)
    if (emphasis !== null && delimiterCanOpen(text, i, emphasis)) {
      const close = findClosingDelimiter(text, i + emphasis.length, emphasis)
      if (close !== -1) {
        flushPlain(i)
        const innerStyle = emphasis.length === 2
          ? mergeStyle(baseStyle, lineStyle(), { bold: true })
          : mergeStyle(baseStyle, lineStyle(), { italic: true })
        for (const segment of inlineSegments(text.slice(i + emphasis.length, close), context, innerStyle, hyperlink)) {
          pushInline(out, segment)
        }
        i = close + emphasis.length
        plainStart = i
        continue
      }
    }
    i += 1
  }
  flushPlain(text.length)
  return out
}

function segmentCells(segments: readonly InlineSegment[], profile: TerminalProfile): LineCell[] {
  const trusted = segments.map((segment) => {
    const styled = styleText(segment.text, segment.style)
    return segment.hyperlink === null
      ? styled
      : `\x1b]8;;${segment.hyperlink}\x07${styled}\x1b]8;;\x07`
  }).join('')
  // Parse once so tabs expand against the complete styled line's current cell.
  return lineToCells(trusted, profile)
}

function fenceOpen(line: string): { marker: string; info: string } | null {
  const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (match === null) return null
  const marker = match[1] as string
  const info = (match[2] as string).trim()
  if (marker[0] === '`' && info.includes('`')) return null
  return { marker, info }
}

function fenceClose(line: string, marker: string): boolean {
  const trimmed = line.trimStart()
  const indent = line.length - trimmed.length
  if (indent > 3 || trimmed[0] !== marker[0]) return false
  let count = 0
  while (trimmed[count] === marker[0]) count += 1
  return count >= marker.length && trimmed.slice(count).trim() === ''
}

function thematicBreak(line: string): boolean {
  const compact = line.trim().replace(/\s+/g, '')
  return compact.length >= 3 && (/^\*+$/.test(compact) || /^_+$/.test(compact) || /^-+$/.test(compact))
}

function splitTableRow(line: string): string[] {
  let source = line.trim()
  if (source.startsWith('|')) source = source.slice(1)
  if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1)
  const cells: string[] = []
  let current = ''
  let escaped = false
  let ticks = 0
  for (const ch of source) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '`') {
      ticks = ticks === 0 ? 1 : 0
      current += ch
      continue
    }
    if (ch === '|' && ticks === 0) {
      cells.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (escaped) current += '\\'
  cells.push(current.trim())
  return cells
}

function parseTable(lines: readonly string[], index: number): ParsedTable | null {
  const headerLine = lines[index]
  const separatorLine = lines[index + 1]
  if (headerLine === undefined || separatorLine === undefined || !headerLine.includes('|')) return null
  const header = splitTableRow(headerLine)
  const separator = splitTableRow(separatorLine)
  if (separator.length === 0 || separator.some((cell) => !TABLE_SEPARATOR_CELL_RE.test(cell.replace(/\s+/g, '')))) return null
  const columns = separator.length
  const align = separator.map((raw): TableAlignment => {
    const cell = raw.replace(/\s+/g, '')
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
    if (cell.endsWith(':')) return 'right'
    return 'left'
  })
  const rows: string[][] = [Array.from({ length: columns }, (_, column) => header[column] ?? '')]
  const source = [headerLine, separatorLine]
  let i = index + 2
  while (i < lines.length && (lines[i] as string).trim() !== '' && (lines[i] as string).includes('|')) {
    const raw = lines[i] as string
    const cells = splitTableRow(raw)
    rows.push(Array.from({ length: columns }, (_, column) => cells[column] ?? ''))
    source.push(raw)
    i += 1
  }
  return { rows, align, source }
}

function alignedCell(
  cells: readonly LineCell[],
  width: number,
  alignment: TableAlignment,
  style: LineStyle,
  profile: TerminalProfile,
): LineCell[] {
  const clipped = truncateCells(cells, width)
  const missing = Math.max(0, width - cellsWidth(clipped))
  const left = alignment === 'right' ? missing : alignment === 'center' ? Math.floor(missing / 2) : 0
  const right = missing - left
  return [
    ...withStyle(lineToCells(' '.repeat(left), profile), style),
    ...clipped,
    ...withStyle(lineToCells(' '.repeat(right), profile), style),
  ]
}

function tableLines(
  table: ParsedTable,
  context: InlineContext,
  contentWidth: number,
): LineCell[][] | null {
  const columns = table.align.length
  const overhead = 1 + columns * 3 // | + two spaces and one | per column
  if (contentWidth < overhead + columns) return null

  const parsedRows = table.rows.map((row) => row.map((cell) => segmentCells(inlineSegments(cell, context), context.profile)))
  const ideal = Array.from({ length: columns }, (_, column) =>
    Math.max(1, ...parsedRows.map((row) => cellsWidth(row[column] ?? []))),
  )
  const available = contentWidth - overhead
  const widths = new Array<number>(columns).fill(1)
  let remaining = available - columns
  while (remaining > 0) {
    let progressed = false
    for (let column = 0; column < columns && remaining > 0; column += 1) {
      if ((widths[column] as number) < (ideal[column] as number)) {
        widths[column] = (widths[column] as number) + 1
        remaining -= 1
        progressed = true
      }
    }
    if (!progressed) break
  }

  const pipe = withStyle(lineToCells('|', context.profile), context.theme.roles.subtle)
  const space = withStyle(lineToCells(' ', context.profile), context.theme.roles.text)
  const renderRow = (row: readonly (readonly LineCell[])[]): LineCell[] => {
    const out: LineCell[] = [...pipe]
    for (let column = 0; column < columns; column += 1) {
      out.push(...space)
      out.push(...alignedCell(row[column] ?? [], widths[column] as number, table.align[column] as TableAlignment, context.theme.roles.text, context.profile))
      out.push(...space, ...pipe)
    }
    return out
  }

  const separator: LineCell[] = [...pipe]
  for (let column = 0; column < columns; column += 1) {
    separator.push(
      ...withStyle(lineToCells(` ${'-'.repeat(widths[column] as number)} `, context.profile), context.theme.roles.subtle),
      ...pipe,
    )
  }
  return [renderRow(parsedRows[0] ?? []), separator, ...parsedRows.slice(1).map(renderRow)]
}

function isBlockStart(
  lines: readonly string[],
  index: number,
  definitionLines: ReadonlySet<number>,
): boolean {
  const line = lines[index]
  if (line === undefined || line.trim() === '' || definitionLines.has(index)) return true
  if (fenceOpen(line) !== null || HEADING_RE.test(line) || QUOTE_RE.test(line) || LIST_ITEM_RE.test(line) || thematicBreak(line)) return true
  if (parseTable(lines, index) !== null) return true
  return lines[index + 1] !== undefined && SETEXT_RE.test(lines[index + 1] as string)
}

/** Render Markdown to width-guaranteed trusted logical lines. */
export function renderMarkdownLines(
  text: string,
  options: MarkdownRenderOptions,
  width: number,
): string[] {
  if (width <= 0) return []
  const { theme, profile } = options
  const prefix = options.prefix ?? ''
  const indent = options.indent ?? ''
  const prefixCells = lineToCells(prefix, profile)
  const indentCells = lineToCells(indent, profile)
  const hangWidth = cellsWidth(indentCells)

  const clean = sanitizeText(text)
  const lines = clean.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  const references = new Map<string, string>()
  const definitionLines = new Set<number>()
  for (const [index, line] of lines.entries()) {
    const definition = REFERENCE_DEF_RE.exec(line)
    if (definition !== null) {
      references.set(referenceKey(definition[1] as string), (definition[2] ?? definition[3]) as string)
      definitionLines.add(index)
    }
  }
  const inlineContext: InlineContext = { theme, profile, references }

  const out: string[] = []
  let first = true
  const emitWrapped = (content: LineCell[], firstExtra: LineCell[] = [], contExtra: LineCell[] = firstExtra): void => {
    const extraWidth = Math.max(cellsWidth(firstExtra), cellsWidth(contExtra))
    const budget = Math.max(1, width - hangWidth - extraWidth)
    for (const [lineIndex, wrapped] of wrapCells(content, budget).entries()) {
      const lead = lineIndex === 0
        ? [...(first ? prefixCells : indentCells), ...firstExtra]
        : [...indentCells, ...contExtra]
      out.push(assertLineWidth(cellsToString([...lead, ...wrapped]), profile, width))
      first = false
    }
  }
  const emitClipped = (content: LineCell[]): void => {
    const lead = first ? prefixCells : indentCells
    const budget = Math.max(1, width - cellsWidth(lead))
    out.push(assertLineWidth(cellsToString([...lead, ...truncateCells(content, budget)]), profile, width))
    first = false
  }

  let i = 0
  while (i < lines.length) {
    if (definitionLines.has(i)) {
      i += 1
      continue
    }
    const raw = lines[i] as string
    if (raw.trim() === '') {
      emitWrapped([])
      i += 1
      continue
    }

    const fence = fenceOpen(raw)
    if (fence !== null) {
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !fenceClose(lines[i] as string, fence.marker)) {
        codeLines.push(lines[i] as string)
        i += 1
      }
      if (i < lines.length) i += 1
      const fenceText = codeLines.join('\n')
      const rendered = normalizeCodeLanguage(fence.info) === 'diff'
        ? renderDiffLines(fenceText, { theme, profile, indent, ...(first ? { firstIndent: prefix } : {}) }, width)
        : renderCodeLines(fenceText, { theme, profile, language: fence.info, indent, ...(first ? { firstIndent: prefix } : {}) }, width)
      if (rendered.length > 0) {
        out.push(...rendered)
        first = false
      }
      continue
    }

    const table = parseTable(lines, i)
    if (table !== null) {
      const rendered = tableLines(table, inlineContext, Math.max(1, width - hangWidth))
      if (rendered === null) {
        for (const sourceLine of table.source) {
          emitClipped(withStyle(lineToCells(sourceLine, profile), theme.roles.text))
        }
      } else {
        for (const row of rendered) emitClipped(row)
      }
      i += table.source.length
      continue
    }

    const setext = lines[i + 1] === undefined ? null : SETEXT_RE.exec(lines[i + 1] as string)
    if (setext !== null && !definitionLines.has(i + 1)) {
      const headingStyle = lineStyle({ ...theme.roles.text, bold: true })
      emitWrapped(segmentCells(inlineSegments(raw.trim(), inlineContext, headingStyle), profile))
      i += 2
      continue
    }

    const heading = HEADING_RE.exec(raw)
    if (heading !== null) {
      const content = (heading[2] as string).replace(/\s+#+\s*$/, '')
      const headingStyle = lineStyle({ ...theme.roles.text, bold: true })
      emitWrapped(segmentCells(inlineSegments(content, inlineContext, headingStyle), profile))
      i += 1
      continue
    }

    if (thematicBreak(raw)) {
      const leadWidth = cellsWidth(first ? prefixCells : indentCells)
      const ruleWidth = Math.max(1, width - leadWidth)
      emitClipped(withStyle(lineToCells('─'.repeat(ruleWidth), profile), theme.roles.subtle))
      i += 1
      continue
    }

    const quote = QUOTE_RE.exec(raw)
    if (quote !== null) {
      const gutter = withStyle(lineToCells('│ ', profile), theme.roles.subtle)
      const paragraph: string[] = []
      while (i < lines.length) {
        const inner = QUOTE_RE.exec(lines[i] as string)
        if (inner === null) break
        const content = inner[1] as string
        if (content.trim() === '') {
          if (paragraph.length > 0) {
            emitWrapped(segmentCells(inlineSegments(paragraph.join(' '), inlineContext), profile), gutter, gutter)
            paragraph.length = 0
          }
          emitWrapped([], gutter, gutter)
        } else {
          paragraph.push(content.trim())
        }
        i += 1
      }
      if (paragraph.length > 0) emitWrapped(segmentCells(inlineSegments(paragraph.join(' '), inlineContext), profile), gutter, gutter)
      continue
    }

    const item = LIST_ITEM_RE.exec(raw)
    if (item !== null) {
      const marker = `${item[1] as string}${item[2] as string} `
      const markerCells = withStyle(lineToCells(marker, profile), theme.roles.text)
      const contCells = withStyle(lineToCells(' '.repeat(marker.length), profile), theme.roles.text)
      emitWrapped(segmentCells(inlineSegments(item[3] as string, inlineContext), profile), markerCells, contCells)
      i += 1
      continue
    }

    const paragraph = [raw.trim()]
    i += 1
    while (i < lines.length && !isBlockStart(lines, i, definitionLines)) {
      paragraph.push((lines[i] as string).trim())
      i += 1
    }
    emitWrapped(segmentCells(inlineSegments(paragraph.join(' '), inlineContext), profile))
  }
  return out
}
