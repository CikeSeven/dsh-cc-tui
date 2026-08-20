/**
 * tui-v2 basic markdown line component (WP-06c, plan WP-06 "Markdown 基本
 * line component"; the full renderer is WP-08).
 *
 * Scope (basic, line-oriented — NOT CommonMark):
 *  - ATX headings `#`..`######` render bold, hashes stripped;
 *  - paragraphs: one logical line per source line (no paragraph joining),
 *    word-aware wrap through the §6.1 pipeline;
 *  - unordered (`-`/`*`/`+`) and ordered (`1.`/`1)`) list items keep their
 *    marker; wrapped continuations align under the item text;
 *  - blockquotes (`> `) render under a dim `│ ` gutter, inline spans honored;
 *  - inline spans: `` `code` `` (code role), `**bold**`, `*italic*` (opening
 *    delimiter may not be followed by whitespace, so `2 * 3 * 4` stays
 *    literal), `[text](url)`;
 *  - links emit an OSC 8 hyperlink + underline (theme link role) only when the
 *    TerminalProfile says `supportsOsc8Hyperlinks === 'yes'` and the scheme is
 *    http(s)/mailto; otherwise they degrade to plain `text (url)`;
 *  - fenced code blocks (``` with optional language) delegate to code.ts
 *    (clipped, never wrapped; the fence marker lines render nothing);
 *  - tables degrade minimally: consecutive `|`-led lines render verbatim in
 *    the text role, clipped (full table layout is WP-08).
 *
 * Known basic-vs-full gaps registered for WP-08 (§15.1): paragraph joining,
 * `_underscore_` italic, nested emphasis, `~~~` fences, setext headings,
 * thematic breaks, reference links, table alignment, syntax highlighting.
 *
 * Trust boundary (§6.1): the markdown source is untrusted (assistant/tool
 * text); it is sanitized ONCE on entry and re-styled exclusively through the
 * trusted builders (theme roles + cellsToString). Link targets come from the
 * sanitized text, so no ESC/BEL can reach the OSC 8 sequence.
 *
 * Dependency rule (§4.3): renderer/terminal contracts + component theme only.
 */
import type { TerminalProfile } from '../../terminal/profile.js'
import {
  assertLineWidth,
  cellsToString,
  cellsWidth,
  lineStyle,
  lineToCells,
  sanitizeText,
  truncateCells,
  wrapCells,
  type LineCell,
  type LineStyle,
} from '../../renderer/lines.js'
import type { ComponentTheme } from '../theme.js'
import { withStyle } from './block-lines.js'
import { renderCodeLines } from './code.js'
import { renderDiffLines } from './diff.js'

export interface MarkdownRenderOptions {
  readonly theme: ComponentTheme
  readonly profile: TerminalProfile
  /** First-line prefix (trusted, e.g. the assistant `'● '`). Default `''`. */
  readonly prefix?: string
  /** Continuation prefix; MUST be the same column width as `prefix`. Default `''`. */
  readonly indent?: string
}

// ---------------------------------------------------------------------------
// Inline spans
// ---------------------------------------------------------------------------

interface InlineSegment {
  readonly text: string
  readonly style: LineStyle
  readonly hyperlink: string | null
}

const INLINE_TOKEN_RE =
  /(`[^`\n]+`)|(\*\*[^\s*](?:[^*\n]*[^\s*])?\*\*)|(\*[^\s*](?:[^*\n]*[^\s*])?\*)|(\[[^\]\n]+\]\([^)\s\n]+\))/g
const LINK_RE = /^\[([^\]\n]+)\]\(([^)\s\n]+)\)$/
/** Conservative scheme allowlist for OSC 8 emission (already sanitized text). */
const LINK_SAFE_SCHEME_RE = /^(https?:|mailto:)/i

function inlineSegments(
  line: string,
  theme: ComponentTheme,
  profile: TerminalProfile,
): InlineSegment[] {
  const plain = (text: string): InlineSegment => ({ text, style: theme.roles.text, hyperlink: null })
  const out: InlineSegment[] = []
  let last = 0
  for (const match of line.matchAll(INLINE_TOKEN_RE)) {
    const index = match.index
    if (index > last) out.push(plain(line.slice(last, index)))
    const [token, code, bold, italic, link] = match as unknown as [string, string?, string?, string?, string?]
    if (code !== undefined) {
      out.push({ text: code.slice(1, -1), style: theme.roles.code, hyperlink: null })
    } else if (bold !== undefined) {
      out.push({ text: bold.slice(2, -2), style: lineStyle({ bold: true }), hyperlink: null })
    } else if (italic !== undefined) {
      out.push({ text: italic.slice(1, -1), style: lineStyle({ italic: true }), hyperlink: null })
    } else if (link !== undefined) {
      const parsed = LINK_RE.exec(link)
      const linkText = parsed?.[1] ?? link
      const url = parsed?.[2] ?? ''
      if (profile.supportsOsc8Hyperlinks === 'yes' && LINK_SAFE_SCHEME_RE.test(url)) {
        out.push({ text: linkText, style: theme.roles.link, hyperlink: url })
      } else {
        out.push(plain(`${linkText} (${url})`))
      }
    }
    last = index + token.length
  }
  if (last < line.length) out.push(plain(line.slice(last)))
  return out
}

function segmentCells(segments: readonly InlineSegment[], profile: TerminalProfile): LineCell[] {
  return segments.flatMap((segment) =>
    lineToCells(segment.text, profile).map((cell) => ({
      ...cell,
      style: segment.style,
      hyperlink: segment.hyperlink,
    })),
  )
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const FENCE_OPEN_RE = /^```(\S*)\s*$/
const FENCE_CLOSE_RE = /^```\s*$/
const LIST_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const TABLE_ROW_RE = /^\s*\|/

/**
 * Render markdown source to width-guaranteed logical lines (§3.3 I-06).
 * `prefix` hangs on the first emitted line, `indent` on every later one.
 */
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

  const out: string[] = []
  let first = true

  /** Wrapped content (paragraph/heading/list/quote): word-aware wrap + hang. */
  const emitWrapped = (content: LineCell[], firstExtra: LineCell[], contExtra: LineCell[]): void => {
    const budget = Math.max(1, width - hangWidth - cellsWidth(contExtra))
    for (const [i, line] of wrapCells(content, budget).entries()) {
      const lead = i === 0 ? [...(first ? prefixCells : indentCells), ...firstExtra] : [...indentCells, ...contExtra]
      out.push(assertLineWidth(cellsToString([...lead, ...line]), profile, width))
      first = false
    }
  }

  /** Pre-clipped content cells (table lines): prepend the lead, clip to fit. */
  const emitClipped = (cells: LineCell[]): void => {
    const lead = first ? prefixCells : indentCells
    const budget = Math.max(1, width - hangWidth)
    out.push(assertLineWidth(cellsToString([...lead, ...truncateCells(cells, budget)]), profile, width))
    first = false
  }

  const clean = sanitizeText(text)
  const lines = clean.split('\n')
  // A single trailing newline is a terminator, not a line (upstream rule).
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  let i = 0
  while (i < lines.length) {
    const raw = lines[i] as string
    if (raw.trim() === '') {
      emitWrapped([], [], [])
      i += 1
      continue
    }
    const trimmed = raw.trimStart()

    // fenced code block (unclosed fences render gathered lines — streaming)
    const fence = FENCE_OPEN_RE.exec(trimmed)
    if (fence !== null) {
      const language = fence[1] ?? ''
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !FENCE_CLOSE_RE.test((lines[i] as string).trimStart())) {
        codeLines.push(lines[i] as string)
        i += 1
      }
      i += 1 // consume the closing fence (or run off the end while streaming)
      // A ```diff fence gets diff coloring; every other language is code.
      const fenceText = codeLines.join('\n')
      const rendered =
        language === 'diff'
          ? renderDiffLines(fenceText, { theme, profile, indent, ...(first ? { firstIndent: prefix } : {}) }, width)
          : renderCodeLines(fenceText, { theme, profile, language, indent, ...(first ? { firstIndent: prefix } : {}) }, width)
      if (rendered.length > 0) {
        out.push(...rendered)
        first = false
      }
      continue
    }

    // table: minimal degradation — verbatim text-role lines, clipped
    if (TABLE_ROW_RE.test(raw)) {
      while (i < lines.length && TABLE_ROW_RE.test(lines[i] as string)) {
        emitClipped(withStyle(lineToCells(lines[i] as string, profile), theme.roles.text))
        i += 1
      }
      continue
    }

    const heading = HEADING_RE.exec(trimmed)
    if (heading !== null) {
      emitWrapped(withStyle(lineToCells(heading[2] as string, profile), lineStyle({ bold: true })), [], [])
      i += 1
      continue
    }

    const quote = QUOTE_RE.exec(raw)
    if (quote !== null) {
      const gutter = withStyle(lineToCells('│ ', profile), theme.roles.subtle)
      while (i < lines.length) {
        const inner = QUOTE_RE.exec(lines[i] as string)
        if (inner === null) break
        emitWrapped(segmentCells(inlineSegments(inner[1] as string, theme, profile), profile), gutter, gutter)
        i += 1
      }
      continue
    }

    const item = LIST_ITEM_RE.exec(raw)
    if (item !== null) {
      const marker = `${item[1] as string}${item[2] as string} `
      const markerCells = withStyle(lineToCells(marker, profile), theme.roles.text)
      const contCells = withStyle(lineToCells(' '.repeat(marker.length), profile), theme.roles.text)
      emitWrapped(
        segmentCells(inlineSegments(item[3] as string, theme, profile), profile),
        markerCells,
        contCells,
      )
      i += 1
      continue
    }

    emitWrapped(segmentCells(inlineSegments(raw, theme, profile), profile), [], [])
    i += 1
  }
  return out
}
