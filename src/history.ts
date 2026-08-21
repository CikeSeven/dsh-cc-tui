import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const HISTORY_DIR = DATA_DIR

/** One persisted input-history entry. */
export type HistoryEntry = {
  text: string
  /** Unix ms timestamp. */
  ts: number
}

const HISTORY_LIMIT = 200

function historyFile(dir: string): string {
  return join(dir, 'history.jsonl')
}

function loadRaw(dir: string): HistoryEntry[] {
  const file = historyFile(dir)
  if (!existsSync(file)) return []
  const entries: HistoryEntry[] = []
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as Partial<HistoryEntry>
        if (typeof parsed.text === 'string' && parsed.text.length > 0) {
          entries.push({ text: parsed.text, ts: typeof parsed.ts === 'number' ? parsed.ts : 0 })
        }
      } catch {
        // Skip malformed lines; the file is best-effort.
      }
    }
  } catch {
    return []
  }
  return entries
}

/**
 * Append an input to persisted history, deduping the immediately previous
 * entry and capping the file at 200 entries.
 * @param text - Input to persist; blank inputs are ignored.
 * @param dir - History directory (injectable for tests).
 */
export function appendHistory(text: string, dir: string = HISTORY_DIR): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const entries = loadRaw(dir)
  const last = entries[entries.length - 1]
  if (last && last.text === trimmed) {
    last.ts = Date.now()
  } else {
    entries.push({ text: trimmed, ts: Date.now() })
  }
  const sliced = entries.slice(-HISTORY_LIMIT)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      historyFile(dir),
      sliced.map(e => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    )
  } catch {
    // Best-effort persistence; in-process history remains available.
  }
}

/**
 * Read persisted history, newest first.
 * @param dir - History directory (injectable for tests).
 * @returns The persisted entries in reverse-chronological order.
 */
export function loadHistory(dir: string = HISTORY_DIR): HistoryEntry[] {
  return loadRaw(dir).reverse()
}

/** Stable id derived from entry text for list identity and deduplication. */
export function historyEntryId(entry: HistoryEntry): string {
  return createHash('sha1').update(entry.text).digest('hex').slice(0, 12)
}
