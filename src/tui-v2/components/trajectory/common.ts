import { cellsToString, lineStyle, styledCells, truncateCells } from '../../renderer/lines.js'
import type { TerminalProfile } from '../../terminal/profile.js'

export function safeLine(text: string, width: number, profile: TerminalProfile, foreground: string | null = null): string {
  if (width <= 0) return ''
  return cellsToString(truncateCells(styledCells(text, lineStyle({ foreground }), profile), width))
}

export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1_000)}s`
}

export function tokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1_000) return String(Math.floor(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}
