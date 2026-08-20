/**
 * tui-v2 complete tool-card row component (WP-08b).
 *
 * The component is a pure projection of an immutable `TranscriptRowView`:
 * `verbose` uncaps output, `expanded` selects the row background, and
 * `footnote` is rendered outside the body cap. Running diff calls preview the
 * pending `callView`; settled cards prefer `resultView ?? callView`. Text cards
 * keep 3 physical rows, diffs 8, with a ctrl+o hint unless only one row would
 * be hidden. Error cards include message/code/recoverability/details.
 *
 * Every card row receives a background through parsed `LineCell`s and is padded
 * to the viewport width, so CJK/emoji, ANSI styles, and OSC links retain the
 * single width pipeline. Payload strings remain untrusted and are sanitized by
 * the hanging/diff renderers before trusted styling.
 */
import type { Component } from '../../renderer/component.js'
import {
  assertLineWidth,
  cellsToString,
  lineStyle,
  lineToCells,
  padCells,
  truncateCells,
  type LineStyle,
} from '../../renderer/lines.js'
import type { SerializableValue, ToolLifecycleSnapshot } from '../../model/schema.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import { hangingTextLines, type HangingLayoutOptions } from './block-lines.js'
import { renderDiffLines } from './diff.js'
import type { TranscriptRowView } from './row-view.js'

export const TOOL_BODY_MAX_LINES = 3
export const DIFF_BODY_MAX_LINES = 8

const GUTTER_FIRST = ' ⎿ '
const GUTTER_REST = '   '

const GLYPH: Record<ToolLifecycleSnapshot['phase'], string> = {
  running: '●',
  result: '●',
  error: '✗',
}

/** `12 ms` / `1.2 s` / `2 m 5 s`. */
export function formatToolDuration(durationMs: number): string {
  const ms = Math.max(0, Math.floor(durationMs))
  if (ms < 1000) return `${ms} ms`
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes} m` : `${minutes} m ${seconds} s`
}

type BodyTone = 'dim' | 'plain' | 'error' | 'hint'

interface CardLine {
  readonly text: string
  readonly tone: BodyTone
}

interface CardBody {
  readonly lines: readonly CardLine[]
  readonly isDiff: boolean
}

const dim = (text: string): CardLine => ({ text, tone: 'dim' })
const plain = (text: string): CardLine => ({ text, tone: 'plain' })
const errorLine = (text: string): CardLine => ({ text, tone: 'error' })

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

function printable(value: SerializableValue): string {
  if (typeof value === 'string') return value
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function truncatedTrailer(record: { readonly [key: string]: SerializableValue }): CardLine {
  const total = asNumber(record.total)
  return dim(total !== undefined ? `… (${total} total)` : '… (truncated)')
}

/** Empty text is zero lines; one trailing newline is a terminator. */
function sideLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function dimLines(text: string): CardLine[] {
  return sideLines(text).map(dim)
}

function contentCardLines(content: SerializableValue | undefined): CardLine[] {
  if (!Array.isArray(content)) return []
  const text = content
    .map((block) => {
      const record = asRecord(block as SerializableValue)
      return record !== null ? (asString(record.text) ?? '') : printable(block as SerializableValue)
    })
    .join('')
    .trimEnd()
  return text === '' ? [] : dimLines(text)
}

/**
 * Structured file hunks -> unified text. Different files get headers; another
 * hunk of the same path gets the WP-08 `⋯` separator.
 */
export function synthesizeUnifiedDiff(
  diffs: readonly { readonly path: string; readonly oldText: string | null; readonly newText: string }[],
): string {
  const out: string[] = []
  let previousPath: string | undefined
  for (const diff of diffs) {
    if (diffs.length > 1) {
      if (diff.path !== previousPath) out.push(`--- a/${diff.path}`, `+++ b/${diff.path}`)
      else out.push('⋯')
    }
    previousPath = diff.path
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

/** Presentation card narrowing; unknown records degrade through common text keys. */
function cardBodyLines(view: SerializableValue | undefined): CardBody {
  if (view === undefined || view === null) return { lines: [], isDiff: false }
  if (typeof view === 'string') return { lines: dimLines(view), isDiff: false }
  if (typeof view === 'number' || typeof view === 'boolean') return { lines: [dim(String(view))], isDiff: false }
  if (Array.isArray(view)) {
    const bodies = view.map((item) => cardBodyLines(item as SerializableValue))
    return { lines: bodies.flatMap((body) => body.lines), isDiff: bodies.some((body) => body.isDiff) }
  }
  const record = asRecord(view)
  if (record === null) return { lines: [], isDiff: false }
  switch (record.card) {
    case 'diff':
      return { lines: [], isDiff: asDiffEntries(record.diffs).length > 0 }
    case 'terminal': {
      const lines = dimLines(asString(record.output) ?? '')
      const exitCode = asNumber(record.exitCode)
      if (exitCode !== undefined && exitCode !== 0) lines.push(errorLine(`Exit code ${exitCode}`))
      const signal = asString(record.signal)
      if (signal !== undefined) lines.push(errorLine(`Killed by signal ${signal}`))
      return { lines, isDiff: false }
    }
    case 'read':
    case 'generic':
      return { lines: contentCardLines(record.content), isDiff: false }
    case 'search': {
      if (record.shape === 'paths' && Array.isArray(record.paths)) {
        const lines = record.paths.map((path) => plain(printable(path as SerializableValue)))
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
              lines.push(dim(lineNumber === undefined ? matchText : `${lineNumber}: ${matchText}`))
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
  const output = asString(record.output)
  if (output !== undefined) return { lines: dimLines(output), isDiff: false }
  const content = contentCardLines(record.content)
  if (content.length > 0) return { lines: content, isDiff: false }
  const text = asString(record.text)
  if (text !== undefined) return { lines: dimLines(text), isDiff: false }
  const title = asString(record.title)
  if (title !== undefined) return { lines: [dim(title)], isDiff: false }
  return { lines: [], isDiff: false }
}

function toneStyle(tone: BodyTone, view: TranscriptRowView): LineStyle {
  switch (tone) {
    case 'error':
      return view.theme.roles.error
    case 'plain':
      return view.theme.roles.text
    case 'hint':
    case 'dim':
      return view.theme.roles.subtle
  }
}

function renderCardLines(
  cardLines: readonly CardLine[],
  view: TranscriptRowView,
  profile: TerminalProfile,
  width: number,
): string[] {
  const bodyLayout: HangingLayoutOptions = {
    prefix: GUTTER_FIRST,
    indent: GUTTER_REST,
    prefixStyle: view.theme.roles.subtle,
    textStyle: view.theme.roles.subtle,
    profile,
  }
  return cardLines.flatMap((line, index) =>
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

function errorLines(tool: ToolLifecycleSnapshot | undefined): CardLine[] {
  const error = tool?.error
  if (error === undefined) return [errorLine('Tool failed')]
  const out = [
    errorLine(error.message),
    errorLine(`Code: ${error.code}`),
    dim(`Recoverable: ${error.recoverable ? 'yes' : 'no'}`),
  ]
  if (error.details !== undefined) out.push(dim(`Details: ${printable(error.details)}`))
  return out
}

/** Apply one semantic background to every existing/padded cell in each row. */
function cardBackground(
  lines: readonly string[],
  backgroundStyle: LineStyle,
  profile: TerminalProfile,
  width: number,
): string[] {
  const background = backgroundStyle.background
  const padStyle = lineStyle({ background })
  return lines.map((line) => {
    const cells = lineToCells(line, profile).map((cell) => ({
      ...cell,
      style: lineStyle({ ...cell.style, background }),
    }))
    return assertLineWidth(cellsToString(padCells(truncateCells(cells, width), width, padStyle)), profile, width)
  })
}

function capBody(
  body: readonly string[],
  cap: number,
  verbose: boolean,
  view: TranscriptRowView,
  profile: TerminalProfile,
  width: number,
): string[] {
  const hidden = body.length - cap
  if (verbose || hidden <= 0 || hidden === 1) return [...body]
  const hint = hangingTextLines(
    `… +${hidden} lines (ctrl+o to expand)`,
    {
      prefix: GUTTER_REST,
      indent: GUTTER_REST,
      prefixStyle: view.theme.roles.subtle,
      textStyle: lineStyle({ ...view.theme.roles.subtle, dim: true }),
      profile,
    },
    width,
  )
  return [...body.slice(0, cap), ...hint]
}

export function createToolRow(view: TranscriptRowView, profile: TerminalProfile): Component {
  let cache: { width: number; lines: string[] } | null = null
  const tool = view.tool
  const phase: ToolLifecycleSnapshot['phase'] = tool?.phase ?? 'result'
  const glyphStyle = phase === 'error'
    ? view.theme.roles.error
    : phase === 'running'
      ? view.theme.roles.accent
      : view.theme.roles.success

  return {
    render(width: number): string[] {
      if (width <= 0) return []
      if (cache !== null && cache.width === width) return cache.lines

      const cardView = tool?.resultView ?? tool?.callView
      const cardRecord = asRecord(cardView)
      const summary = view.blocks.find((block) => block.type === 'text')
      const headerText = summary !== undefined && summary.type === 'text'
        ? summary.text
        : (cardRecord === null ? undefined : asString(cardRecord.title)) ?? '(tool)'
      const duration = tool?.durationMs === undefined ? '' : ` (${formatToolDuration(tool.durationMs)})`
      const header = hangingTextLines(
        headerText + duration,
        {
          prefix: `${GLYPH[phase]} `,
          indent: '  ',
          prefixStyle: glyphStyle,
          textStyle: view.theme.roles.text,
          profile,
        },
        width,
      )

      let body: string[] = []
      let cap = TOOL_BODY_MAX_LINES
      if (phase === 'error') {
        body = renderCardLines(errorLines(tool), view, profile, width)
      } else if (cardView !== undefined) {
        const card = cardBodyLines(cardView)
        if (card.isDiff) {
          cap = DIFF_BODY_MAX_LINES
          const record = asRecord(cardView)
          const diffs = asDiffEntries(record?.diffs)
          body = renderDiffLines(
            synthesizeUnifiedDiff(diffs),
            { theme: view.theme, profile, indent: GUTTER_REST, firstIndent: GUTTER_FIRST },
            width,
          )
        } else {
          body = renderCardLines(card.lines, view, profile, width)
        }
      }
      if (phase === 'running' && body.length === 0) {
        body = renderCardLines([dim('Running…')], view, profile, width)
      }

      const visibleBody = capBody(body, cap, view.verbose === true, view, profile, width)
      const footnote = view.footnote === undefined
        ? []
        : hangingTextLines(
            view.footnote,
            {
              prefix: body.length === 0 ? GUTTER_FIRST : GUTTER_REST,
              indent: GUTTER_REST,
              prefixStyle: view.theme.roles.subtle,
              textStyle: view.theme.roles.subtle,
              profile,
            },
            width,
          )
      const background = view.expanded === true
        ? view.theme.roles.toolBackgroundExpanded
        : view.theme.roles.toolBackground
      const lines = cardBackground([...header, ...visibleBody, ...footnote], background, profile, width)
      cache = { width, lines }
      return lines
    },
    invalidate() {
      cache = null
    },
  }
}
