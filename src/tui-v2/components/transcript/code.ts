/**
 * tui-v2 fenced-code line component (WP-08b).
 *
 * Code stays one source line per terminal row and is clipped, never wrapped.
 * A small synchronous lexer highlights the deterministic subset needed by the
 * transcript (`ts/js/py/bash/json`, plus aliases); unknown languages retain the
 * uniform code role. The lexer emits only keyword/string/comment/number runs —
 * no parser dependency, async load, HTML, or foreign ANSI enters the v2 cell
 * pipeline. Fence info strings may contain options; their first token selects
 * the language. The optional normalized language badge remains opt-in
 * (`showLanguage`, default false) so highlighting never adds transcript height.
 *
 * Trust boundary (§6.1): source and info strings are sanitized before lexing.
 * Styles are generated only by `styleText`, then the complete trusted line is
 * parsed once by `lineToCells`, preserving current-column tab expansion.
 */
import type { TerminalProfile } from '../../terminal/profile.js'
import {
  assertLineWidth,
  cellsToString,
  lineStyle,
  lineToCells,
  sanitizeText,
  styleText,
  truncateCells,
  type LineCell,
  type LineStyle,
} from '../../renderer/lines.js'
import type { ComponentTheme } from '../theme.js'
import { withStyle } from './block-lines.js'
import { renderDiffLines } from './diff.js'

export type CodeLanguage = 'ts' | 'js' | 'py' | 'bash' | 'json' | 'diff' | 'plain'

export interface CodeRenderOptions {
  readonly theme: ComponentTheme
  readonly profile: TerminalProfile
  /** Fence info string; the first whitespace-delimited token selects the lexer. */
  readonly language?: string
  /** Prepend the normalized language token (default false). */
  readonly showLanguage?: boolean
  readonly indent?: string
  readonly firstIndent?: string
}

type SyntaxKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number'

interface SyntaxRun {
  readonly text: string
  readonly kind: SyntaxKind
}

interface LexerState {
  blockComment: boolean
  stringDelimiter: "'" | '"' | '`' | "'''" | '"""' | null
}

const LANGUAGE_ALIASES: Readonly<Record<string, CodeLanguage>> = Object.freeze({
  ts: 'ts',
  typescript: 'ts',
  tsx: 'ts',
  js: 'js',
  javascript: 'js',
  jsx: 'js',
  node: 'js',
  mjs: 'js',
  cjs: 'js',
  py: 'py',
  py3: 'py',
  python: 'py',
  python3: 'py',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  json: 'json',
  jsonc: 'json',
  diff: 'diff',
  patch: 'diff',
  plaintext: 'plain',
  text: 'plain',
  txt: 'plain',
})

const KEYWORDS: Readonly<Record<Exclude<CodeLanguage, 'diff' | 'plain'>, ReadonlySet<string>>> = {
  ts: new Set([
    'abstract', 'any', 'as', 'asserts', 'async', 'await', 'bigint', 'boolean', 'break', 'case',
    'catch', 'class', 'const', 'constructor', 'continue', 'debugger', 'declare', 'default', 'delete',
    'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get',
    'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let',
    'module', 'namespace', 'never', 'new', 'null', 'number', 'object', 'of', 'override', 'private',
    'protected', 'public', 'readonly', 'return', 'satisfies', 'set', 'static', 'string', 'super',
    'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unknown',
    'using', 'var', 'void', 'while', 'with', 'yield',
  ]),
  js: new Set([
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get',
    'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'set', 'static',
    'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while',
    'with', 'yield',
  ]),
  py: new Set([
    'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue', 'def', 'del',
    'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
    'is', 'lambda', 'match', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True',
    'try', 'while', 'with', 'yield',
  ]),
  bash: new Set([
    'case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if',
    'in', 'local', 'readonly', 'select', 'then', 'time', 'until', 'while',
  ]),
  json: new Set(['false', 'null', 'true']),
}

/** Normalize the first fence-info token; unknown tokens select plain code. */
export function normalizeCodeLanguage(info: string | undefined): CodeLanguage {
  if (info === undefined) return 'plain'
  const token = sanitizeText(info).trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''
  const unwrapped = token.replace(/^\{?\.?/, '').replace(/[},].*$/, '')
  return LANGUAGE_ALIASES[unwrapped] ?? 'plain'
}

/** Label shown by an explicit language badge; empty for an absent info string. */
function languageBadge(info: string | undefined): string {
  if (info === undefined) return ''
  const token = sanitizeText(info).trim().split(/\s+/, 1)[0] ?? ''
  if (token === '') return ''
  const normalized = normalizeCodeLanguage(token)
  return normalized === 'plain' && !['plain', 'text', 'txt', 'plaintext'].includes(token.toLowerCase())
    ? token.replace(/^\{?\.?/, '').replace(/[},].*$/, '')
    : normalized
}

function pushRun(runs: SyntaxRun[], text: string, kind: SyntaxKind): void {
  if (text === '') return
  const last = runs[runs.length - 1]
  if (last?.kind === kind) {
    runs[runs.length - 1] = { text: last.text + text, kind }
  } else {
    runs.push({ text, kind })
  }
}

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch)
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch)
}

function syntaxStyle(kind: SyntaxKind, theme: ComponentTheme): LineStyle {
  switch (kind) {
    case 'keyword':
      return lineStyle({ ...theme.roles.accent, bold: true })
    case 'string':
      return theme.roles.success
    case 'comment':
      return theme.roles.subtle
    case 'number':
      return lineStyle({ ...theme.roles.warning, bold: true })
    default:
      return theme.roles.code
  }
}

function commentStart(language: CodeLanguage, line: string, index: number): number {
  if ((language === 'ts' || language === 'js') && line.startsWith('//', index)) return 2
  if ((language === 'py' || language === 'bash') && line[index] === '#') return 1
  return 0
}

function stringDelimiterAt(language: CodeLanguage, line: string, index: number): LexerState['stringDelimiter'] {
  if (language === 'py') {
    if (line.startsWith("'''", index)) return "'''"
    if (line.startsWith('"""', index)) return '"""'
  }
  const ch = line[index]
  if (ch === '"') return '"'
  if ((language === 'ts' || language === 'js' || language === 'py' || language === 'bash') && ch === "'") return "'"
  if ((language === 'ts' || language === 'js') && ch === '`') return '`'
  return null
}

function consumeString(line: string, index: number, delimiter: NonNullable<LexerState['stringDelimiter']>): { end: number; closed: boolean } {
  let i = index
  while (i < line.length) {
    if (line.startsWith(delimiter, i)) return { end: i + delimiter.length, closed: true }
    if (line[i] === '\\' && delimiter !== "'''" && delimiter !== '"""') i += 2
    else i += 1
  }
  return { end: line.length, closed: false }
}

function lexLine(line: string, language: CodeLanguage, state: LexerState): SyntaxRun[] {
  if (language === 'plain' || language === 'diff') return [{ text: line, kind: 'plain' }]
  const runs: SyntaxRun[] = []
  const keywords = KEYWORDS[language]
  let i = 0

  while (i < line.length) {
    if (state.blockComment) {
      const end = line.indexOf('*/', i)
      if (end === -1) {
        pushRun(runs, line.slice(i), 'comment')
        return runs
      }
      pushRun(runs, line.slice(i, end + 2), 'comment')
      state.blockComment = false
      i = end + 2
      continue
    }

    if (state.stringDelimiter !== null) {
      const consumed = consumeString(line, i, state.stringDelimiter)
      pushRun(runs, line.slice(i, consumed.end), 'string')
      if (consumed.closed) state.stringDelimiter = null
      i = consumed.end
      continue
    }

    if ((language === 'ts' || language === 'js') && line.startsWith('/*', i)) {
      const end = line.indexOf('*/', i + 2)
      if (end === -1) {
        pushRun(runs, line.slice(i), 'comment')
        state.blockComment = true
        return runs
      }
      pushRun(runs, line.slice(i, end + 2), 'comment')
      i = end + 2
      continue
    }

    const commentLength = commentStart(language, line, i)
    if (commentLength > 0) {
      pushRun(runs, line.slice(i), 'comment')
      break
    }

    const delimiter = stringDelimiterAt(language, line, i)
    if (delimiter !== null) {
      const consumed = consumeString(line, i + delimiter.length, delimiter)
      pushRun(runs, line.slice(i, consumed.end), 'string')
      if (!consumed.closed && (delimiter === '`' || delimiter === "'''" || delimiter === '"""')) {
        state.stringDelimiter = delimiter
      }
      i = consumed.end
      continue
    }

    const number = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(line.slice(i))
    if (number !== null) {
      pushRun(runs, number[0], 'number')
      i += number[0].length
      continue
    }

    const ch = line[i] as string
    if (isIdentifierStart(ch)) {
      let end = i + 1
      while (end < line.length && isIdentifierPart(line[end] as string)) end += 1
      const word = line.slice(i, end)
      pushRun(runs, word, keywords.has(word) ? 'keyword' : 'plain')
      i = end
      continue
    }

    pushRun(runs, ch, 'plain')
    i += 1
  }

  return runs
}

function highlightedCells(
  sourceLine: string,
  language: CodeLanguage,
  state: LexerState,
  theme: ComponentTheme,
  profile: TerminalProfile,
): LineCell[] {
  const trusted = lexLine(sourceLine, language, state)
    .map((run) => styleText(run.text, syntaxStyle(run.kind, theme)))
    .join('')
  return lineToCells(trusted, profile)
}

/** Render one clipped terminal row per source line. */
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
  const badge = languageBadge(options.language)
  if (options.showLanguage === true && badge !== '') {
    emit(withStyle(lineToCells(badge, profile), theme.roles.subtle), true)
    emitted = true
  }

  const clean = sanitizeText(code)
  if (clean === '') return out
  const language = normalizeCodeLanguage(options.language)
  if (language === 'diff') {
    out.push(...renderDiffLines(clean, {
      theme,
      profile,
      indent,
      firstIndent: emitted ? indent : (options.firstIndent ?? indent),
    }, width))
    return out
  }

  const sourceLines = clean.split('\n')
  if (sourceLines.length > 1 && sourceLines[sourceLines.length - 1] === '') sourceLines.pop()
  const state: LexerState = { blockComment: false, stringDelimiter: null }
  for (const sourceLine of sourceLines) {
    emit(highlightedCells(sourceLine, language, state, theme, profile), !emitted)
    emitted = true
  }
  return out
}
