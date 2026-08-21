/**
 * Pure external-editor command helpers.
 *
 * The v2 external-editor controller owns temp files, terminal takeover and
 * child-process execution. This module only parses `$EDITOR` argv, resolves
 * Windows PATH/PATHEXT shims, and builds a safe `cmd.exe /d /s /c` descriptor.
 * It intentionally imports no Ink instance or terminal lifecycle module.
 */
import { existsSync } from 'node:fs'
import { delimiter, join, win32 } from 'node:path'
import { cmdEscapeArgument, cmdEscapeCommand } from './shellQuote.js'

/**
 * Split an `$EDITOR`-style command line into argv, honoring single/double
 * quotes (`code --wait`, `"C:\Program Files\...\nvim.exe" -f`).
 */
export function splitEditorCommand(commandLine: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: string | null = null
  let hasToken = false
  for (const ch of commandLine) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (current !== '' || hasToken) args.push(current)
      current = ''
      hasToken = false
      continue
    }
    current += ch
  }
  if (current !== '' || hasToken) args.push(current)
  return args
}

/**
 * Resolve the editor argv from the environment. `$VISUAL` wins over
 * `$EDITOR` (readline convention); POSIX falls back to `vi`, Windows has no
 * blocking console editor fallback and returns undefined. `platform` is a
 * parameter so the Windows branch is unit-testable from CI's Linux runners.
 */
export function resolveEditorCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  const raw = (env.VISUAL ?? '').trim() || (env.EDITOR ?? '').trim()
  if (raw !== '') {
    const args = splitEditorCommand(raw)
    return args.length > 0 ? args : undefined
  }
  return platform === 'win32' ? undefined : ['vi']
}

/**
 * Windows shim resolution: a bare command like `code` usually lives on PATH
 * as `code.cmd`, which libuv refuses to execute directly. Walk PATH with
 * PATHEXT (case-insensitive on Windows; both casings tried for tests on
 * case-sensitive filesystems) and report whether the resolved file needs
 * cmd.exe to run. Commands carrying an explicit extension are used as-is;
 * unresolved names fall back to the bare command (spawn then resolves
 * `.exe`, or fails into the `failed` outcome).
 */
export function resolveWindowsShim(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; viaCmd: boolean } {
  if (/\.[a-z0-9]+$/i.test(command)) {
    return { command, viaCmd: /\.(cmd|bat)$/i.test(command) }
  }
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(ext => ext.trim())
    .filter(ext => ext !== '')
  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    for (const ext of extensions) {
      for (const casing of [ext, ext.toLowerCase()]) {
        const candidate = join(dir, command + casing)
        if (existsSync(candidate)) {
          return { command: candidate, viaCmd: /\.(cmd|bat)$/i.test(candidate) }
        }
      }
    }
  }
  return { command, viaCmd: false }
}

/** npm-generated node shims re-invoke node, parsing the line a second time. */
const CMD_SHIM_RE = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i

/**
 * Build the `comspec /d /s /c` spawn descriptor for a `.cmd`/`.bat` editor,
 * following the cross-spawn protocol: the command is normalized first
 * (explicit forward-slash paths like `C:/Program Files/.../code.cmd` must
 * become backslash form — cross-spawn's path.normalize step, without which
 * Windows can ENOENT), then command and arguments are escaped, joined, and
 * wrapped in one pair of quotes (`/s` strips exactly those), and passed
 * with `windowsVerbatimArguments` so libuv does not re-quote the payload.
 * Exported for tests — the assembly is pure.
 */
export function buildCmdExeSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; verbatim: true } {
  const normalized = win32.normalize(command)
  const line = [
    cmdEscapeCommand(normalized),
    ...args.map(arg => cmdEscapeArgument(arg, CMD_SHIM_RE.test(normalized))),
  ].join(' ')
  return {
    // `||`, not `??`: a present-but-empty ComSpec must fall back too
    // (cross-spawn semantics); spawning an empty file name fails outright.
    file: env.comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  }
}
