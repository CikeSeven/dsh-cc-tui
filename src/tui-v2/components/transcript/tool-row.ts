/**
 * tui-v2 tool row component (WP-04b skeleton; WP-06c basic tool card).
 *
 * Visual form mirrors the legacy `AssistantToolUseMessage.tsx` in basic-card
 * scope: a status-glyph + summary header (`● Bash(ls -la)`-shaped plain
 * summary from the projection's text block, falling back to the presentation
 * view's `title`), running/result/error glyph states (● running/accent,
 * ● result/success, ✗ error), a dim duration suffix, and the structured card
 * body hung under the ` ⎿ ` gutter (first body line) / blank continuation —
 * the body comes from the tool's presentation view (`resultView ?? callView`):
 *
 *  - `diff` card: synthesized unified diff (`--- a/path`/`+++ b/path` file
 *    headers when several files, `@@` between hunks of one file, `- `/`+ `
 *    lines) rendered through `diff.ts` (add/del/hunk roles, clipped, capped
 *    at DIFF_BODY_MAX_LINES);
 *  - `terminal` card: dim output lines + `Exit code N`/`Killed by signal S`
 *    error lines;
 *  - `read`/`generic` cards: joined text content, dim;
 *  - `search` card: plain paths, or path + `line: match` dim lines, with a
 *    `… (N total)` trailer when truncated;
 *  - strings/arrays/unknown shapes degrade to their text content (dim).
 *
 * Non-diff bodies wrap through the §6.1 pipeline and cap at
 * TOOL_BODY_MAX_LINES with a `… +N lines` hint. Side-by-side diffs, verbose
 * (ctrl+o) uncapping, `⋯` hunk separators, pending-call diff preview while
 * running and line-level backgrounds are WP-08. Untrusted payloads always
 * pass sanitizeText before styling (§6.1).
 */
import type { Component } from '../../renderer/component.js'
import { lineStyle, type LineStyle } from '../../renderer/lines.js'
import type { SerializableValue, ToolLifecycleSnapshot } from '../../model/schema.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import { hangingTextLines, singleLine, type HangingLayoutOptions } from './block-lines.js'
import { renderDiffLines } from './diff.js'
import type { TranscriptRowView } from './row-view.js'

/** Text-body line budget, mirroring the legacy collapsed card (renderTruncatedContent). */
const TOOL_BODY_MAX_LINES = 3
/** Diff bodies cap at the upstream chat row's 8 (CHAT_DIFF_MAX_LINES). */
const DIFF_BODY_MAX_LINES = 8

const GLYPH: Record<ToolLifecycleSnapshot['phase'], string> = {
  running: '●',
  result: '●',
  error: '✗',
}

/** `12 ms` / `1.2 s` / `2 m 5 s` (reduced form of cc/format.ts formatDuration). */
export function formatToolDuration(durationMs: number): string {
  const ms = Math.max(0, Math.floor(durationMs))
  if (ms < 1000) return `${ms} ms`
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes} m` : `${minutes} m ${seconds} s`
}

// ---------------------------------------------------------------------------
// Presentation-view narrowing (SerializableValue -> structural card shapes)
// ---------------------------------------------------------------------------

type BodyTone = 'add' | 'del' | 'hunk' | 'dim' | 'plain' | 'error'

interface CardLine {
  readonly text: string
  readonly tone: BodyTone
}

const dim = (text: string): CardLine => ({ text, tone: 'dim' })
const plain = (text: string): CardLine => ({ text, tone: 'plain' })

function asRecord(value: SerializableValue | undefined): { readonly [key: string]: SerializableValue } | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { readonly [key: string]: SerializableValue })
    : null
}

function asString(value: SerializableValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: SerializableValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** `… (N total)` trailer for truncated search cards. */
function truncatedTrailer(record: { readonly [key: string]: SerializableValue }): CardLine {
  const total = asNumber(record.total)
  return dim(total !== undefined ? `… (${total} total)` : '… (truncated)')
}

/** One side's text -> display lines (upstream contentLines rule). */
function sideLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function dimLines(text: string): CardLine[] {
  return sideLines(text).map(dim)
}

/** Join the text blocks of a view's content payload (read/generic cards). */
function contentCardLines(content: SerializableValue | undefined): CardLine[] {
  if (!Array.isArray(content)) return []
  const text = content
    .map((block) => {
      const record = asRecord(block as SerializableValue)
      return record !== null ? (asString(record.text) ?? '') : ''
    })
    .join('')
    .trimEnd()
  return text === '' ? [] : dimLines(text)
}

/**
 * Synthesize unified-diff text from structured `{path, oldText, newText}`
 * file diffs (dsh-tools FileDiff) so one renderer (`diff.ts`) owns diff
 * coloring. Single-file cards omit the header (the card header carries the
 * path); multi-file cards get `---/+++` headers and `@@` between hunks of
 * one file. The `⋯` same-file separator is WP-08.
 */
export function synthesizeUnifiedDiff(
  diffs: readonly { readonly path: string; readonly oldText: string | null; readonly newText: string }[],
): string {
  const out: string[] = []
  let prevPath: string | undefined
  for (const diff of diffs) {
    if (diffs.length > 1) {
      if (diff.path !== prevPath) {
        out.push(`--- a/${diff.path}`, `+++ b/${diff.path}`)
      } else {
        out.push('@@')
      }
    }
    prevPath = diff.path
    if (diff.oldText !== null) {
      for (const line of sideLines(diff.oldText)) out.push(`- ${line}`)
    }
    for (const line of sideLines(diff.newText)) out.push(`+ ${line}`)
  }
  return out.join('\n')
}

interface DiffEntry {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

function asDiffEntries(value: SerializableValue | undefined): DiffEntry[] {
  if (!Array.isArray(value)) return []
  const out: DiffEntry[] = []
  for (const item of value) {
    const record = asRecord(item as SerializableValue)
    if (record === null) continue
    const path = asString(record.path)
    const newText = asString(record.newText)
    if (path === undefined || newText === undefined) continue
    out.push({ path, oldText: asString(record.oldText) ?? null, newText })
  }
  return out
}

/** Per-card body lines; unknown/absent shapes yield the text fallback. */
function cardBodyLines(view: SerializableValue | undefined): { readonly lines: CardLine[]; readonly isDiff: boolean } {
  if (view === undefined || view === null) return { lines: [], isDiff: false }
  if (typeof view === 'string') return { lines: dimLines(view), isDiff: false }
  if (Array.isArray(view)) {
    const lines = view.flatMap((item) => cardBodyLines(item as SerializableValue).lines)
    return { lines, isDiff: false }
  }
  const record = asRecord(view)
  if (record === null) return { lines: [], isDiff: false }
  switch (record.card) {
    case 'diff':
      return { lines: [], isDiff: asDiffEntries(record.diffs).length > 0 }
    case 'terminal': {
      const lines = dimLines(asString(record.output) ?? '')
      const exitCode = typeof record.exitCode === 'number' ? record.exitCode : undefined
      if (exitCode !== undefined && exitCode !== 0) lines.push({ text: `Exit code ${exitCode}`, tone: 'error' })
      const signal = asString(record.signal)
      if (signal !== undefined) lines.push({ text: `Killed by signal ${signal}`, tone: 'error' })
      return { lines, isDiff: false }
    }
    case 'read':
    case 'generic':
      return { lines: contentCardLines(record.content), isDiff: false }
    case 'search': {
      if (record.shape === 'paths' && Array.isArray(record.paths)) {
        const lines = record.paths.map((p) => plain(String(p)))
        if (record.truncated === true) lines.push(truncatedTrailer(record))
        return { lines, isDiff: false }
      }
      if (record.shape === 'matches' && Array.isArray(record.files)) {
        const lines: CardLine[] = []
        for (const file of record.files) {
          const fileRecord = asRecord(file as SerializableValue)
          if (fileRecord === null) continue
          lines.push(plain(asString(fileRecord.path) ?? ''))
          if (Array.isArray(fileRecord.matches)) {
            for (const match of fileRecord.matches) {
              const matchRecord = asRecord(match as SerializableValue)
              if (matchRecord === null) continue
              const lineNumber = asNumber(matchRecord.lineNumber)
              const matchText = asString(matchRecord.line) ?? ''
              lines.push(dim(lineNumber !== undefined ? `${lineNumber}: ${matchText}` : matchText))
            }
          }
        }
        if (record.truncated === true) lines.push(truncatedTrailer(record))
        return { lines, isDiff: false }
      }
      return { lines: [], isDiff: false }
    }
    default:
      break
  }
  // Card-less records: degrade to their text content (payloadLines parity).
  const output = asString(record.output)
  if (output !== undefined) return { lines: dimLines(output), isDiff: false }
  const content = contentCardLines(record.content)
  if (content.length > 0) return { lines: content, isDiff: false }
  const title = asString(record.title)
  if (title !== undefined) return { lines: [dim(title)], isDiff: false }
  return { lines: [], isDiff: false }
}

function toneStyle(tone: BodyTone, view: TranscriptRowView): LineStyle {
  switch (tone) {
    case 'add':
      return view.theme.roles.success
    case 'del':
      return view.theme.roles.error
    case 'hunk':
      return view.theme.roles.accent
    case 'error':
      return view.theme.roles.error
    case 'plain':
      return view.theme.roles.text
    default:
      return view.theme.roles.subtle
  }
}

export function createToolRow(view: TranscriptRowView, profile: TerminalProfile): Component {
  let cache: { width: number; lines: string[] } | null = null
  const tool = view.tool
  const phase: ToolLifecycleSnapshot['phase'] = tool?.phase ?? 'result'
  const glyphStyle: LineStyle =
    phase === 'error'
      ? view.theme.roles.error
      : phase === 'running'
        ? view.theme.roles.accent
        : view.theme.roles.success

  const headerLayout: HangingLayoutOptions = {
    prefix: `${GLYPH[phase]} `,
    indent: '  ',
    prefixStyle: glyphStyle,
    textStyle: view.theme.roles.text,
    profile,
  }
  const GUTTER_FIRST = ' ⎿ '
  const GUTTER_REST = '   '
  const bodyLayout: HangingLayoutOptions = {
    prefix: GUTTER_FIRST,
    indent: GUTTER_REST,
    prefixStyle: view.theme.roles.subtle,
    textStyle: view.theme.roles.subtle,
    profile,
  }

  return {
    render(width: number): string[] {
      if (width <= 0) return []
      if (cache !== null && cache.width === width) return cache.lines
      const lines: string[] = []

      // Header: the projection's summary line, else the presentation title.
      const cardView = tool?.resultView ?? tool?.callView
      const cardRecord = asRecord(cardView)
      const summary = view.blocks.find((block) => block.type === 'text')
      const headerText =
        summary !== undefined && summary.type === 'text'
          ? summary.text
          : (cardRecord !== null ? asString(cardRecord.title) : undefined) ?? '(tool)'
      const duration = tool?.durationMs !== undefined ? ` (${formatToolDuration(tool.durationMs)})` : ''
      lines.push(...hangingTextLines(headerText + duration, headerLayout, width))

      // Body: card-aware lines from the settled view (running rows stay
      // header-only in the basic card; pending-diff preview is WP-08).
      let body: string[] = []
      let cap = TOOL_BODY_MAX_LINES
      if (phase === 'error' && tool?.error !== undefined) {
        body = hangingTextLines(tool.error.message, { ...bodyLayout, textStyle: view.theme.roles.error }, width)
      } else if (phase === 'result' && cardView !== undefined) {
        const card = cardBodyLines(cardView)
        if (card.isDiff) {
          cap = DIFF_BODY_MAX_LINES
          const record = asRecord(cardView)
          const diffs = asDiffEntries(record?.diffs)
          body = renderDiffLines(synthesizeUnifiedDiff(diffs), {
            theme: view.theme,
            profile,
            indent: GUTTER_REST,
            firstIndent: GUTTER_FIRST,
          }, width)
        } else {
          body = card.lines.flatMap((line, index) =>
            hangingTextLines(
              line.text,
              {
                ...bodyLayout,
                prefix: index === 0 ? GUTTER_FIRST : GUTTER_REST,
                textStyle: toneStyle(line.tone, view),
              },
              width,
            ),
          )
        }
      }
      if (body.length > cap) {
        const hidden = body.length - cap
        body = [
          ...body.slice(0, cap),
          ...hangingTextLines(`… +${hidden} lines`, { ...bodyLayout, prefix: GUTTER_REST, textStyle: lineStyle({ dim: true }) }, width),
        ]
      }
      lines.push(...body)
      if (lines.length === 0) lines.push(singleLine('(tool)', view.theme.roles.subtle, profile, width))
      cache = { width, lines }
      return lines
    },
    invalidate() {
      cache = null
    },
  }
}
