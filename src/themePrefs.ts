/**
 * Persisted v2 color-theme preference. The `/theme` choice survives restarts
 * in `~/.dsh-tui/theme.json`; missing, unsafe or corrupt data falls back to the
 * v2 registry default. `DSH_TUI_THEME` remains the startup override.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'
import { isSafeThemeName } from './utils/themeName.js'

const PREFS_DIR = DATA_DIR

/**
 * Parse a persisted `{ theme }` value; anything else yields undefined.
 * @param text - Raw file contents.
 * @returns The theme name when valid, else undefined.
 */
export function parseThemePref(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const theme = (parsed as Record<string, unknown>).theme
    return isSafeThemeName(theme) ? theme : undefined
  } catch {
    return undefined
  }
}

/**
 * The persisted theme name, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted theme name, if any.
 */
export function readThemePref(dir: string = PREFS_DIR): string | undefined {
  try {
    return parseThemePref(readFileSync(join(dir, 'theme.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Persist a safe v2 registry id (best effort).
 * @param name - Theme id to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on invalid input or I/O failure.
 */
export function writeThemePref(name: string, dir: string = PREFS_DIR): boolean {
  if (!isSafeThemeName(name)) return false
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'theme.json'), JSON.stringify({ theme: name }, null, 2))
    return true
  } catch {
    return false
  }
}
