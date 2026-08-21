/** Safe v2 theme registry (WP-08f).
 *
 * This module is pure registry state: it does not read environment, files or
 * legacy global theme preferences. Hosts convert persisted theme files into
 * validated descriptors before registering them.
 */
import { lineStyle, type LineStyle } from '../renderer/lines.js'
import type { ComponentTheme } from '../components/theme.js'

export const THEME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export type ThemeBase = 'default' | 'dark' | 'light' | 'ansi'

export interface ThemeDescriptor {
  readonly id: string
  readonly displayName: string
  readonly base: ThemeBase
  readonly roles?: Partial<ComponentTheme['roles']>
}

export interface ThemeValidationResult {
  readonly ok: boolean
  readonly descriptor?: ThemeDescriptor
  readonly errors: readonly string[]
}

export interface ThemeRegistry {
  register(input: unknown): ThemeValidationResult
  resolve(id: string): ComponentTheme
  has(id: string): boolean
  list(): readonly ThemeDescriptor[]
  fallbackId(): string
}

const REQUIRED_ROLE_NAMES = [
  'text', 'subtle', 'accent', 'error', 'success', 'warning', 'code', 'link',
  'toolName', 'toolBackground', 'toolBackgroundExpanded', 'searchMatch', 'searchCurrent',
] as const

const COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:ansi16|ansi256):[0-9]+|(?:black|red|green|yellow|blue|magenta|cyan|white|bright-black|bright-red|bright-green|bright-yellow|bright-blue|bright-magenta|bright-cyan|bright-white)|rgb:[0-9a-f]{6})$/i

function isLineStyle(value: unknown): value is LineStyle {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const style = value as Record<string, unknown>
  for (const key of ['bold', 'dim', 'italic', 'underline', 'inverse', 'strike']) {
    if (typeof style[key] !== 'boolean') return false
  }
  for (const key of ['foreground', 'background']) {
    const color = style[key]
    if (color !== null && (typeof color !== 'string' || !COLOR_RE.test(color))) return false
  }
  return true
}

function validateDescriptor(input: unknown): ThemeValidationResult {
  const errors: string[] = []
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['theme descriptor must be an object'] }
  }
  const raw = input as Record<string, unknown>
  const id = raw.id
  const displayName = raw.displayName
  const base = raw.base
  if (typeof id !== 'string' || !THEME_NAME_RE.test(id)) errors.push('id must be a safe theme name')
  if (typeof displayName !== 'string' || displayName.trim() === '' || /[\x00-\x1f\x7f-\x9f]/.test(displayName)) {
    errors.push('displayName must be a non-empty single-line string')
  }
  if (base !== 'default' && base !== 'dark' && base !== 'light' && base !== 'ansi') errors.push('base must be default|dark|light|ansi')
  const roles = raw.roles
  if (roles !== undefined) {
    if (roles === null || typeof roles !== 'object' || Array.isArray(roles)) errors.push('roles must be an object')
    else {
      for (const [role, value] of Object.entries(roles)) {
        if (!(REQUIRED_ROLE_NAMES as readonly string[]).includes(role)) errors.push(`unknown role: ${role}`)
        else if (!isLineStyle(value)) errors.push(`invalid style for role: ${role}`)
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  const descriptor: ThemeDescriptor = {
    id: id as string,
    displayName: (displayName as string).trim().replace(/[\r\n]+/g, ' '),
    base: base as ThemeBase,
    ...(roles === undefined ? {} : { roles: roles as Partial<ComponentTheme['roles']> }),
  }
  return { ok: true, descriptor, errors: [] }
}

function fallbackTheme(id: string, base: ThemeBase): ComponentTheme {
  const neutral = lineStyle()
  const subtle = lineStyle({ foreground: base === 'light' ? 'ansi256:8' : 'bright-black' })
  const accent = lineStyle({ foreground: base === 'light' ? 'ansi256:12' : 'cyan' })
  return Object.freeze({
    id,
    roles: {
      text: neutral,
      subtle,
      accent,
      error: lineStyle({ foreground: 'red' }),
      success: lineStyle({ foreground: 'green' }),
      warning: lineStyle({ foreground: 'yellow' }),
      code: lineStyle({ foreground: 'yellow' }),
      link: lineStyle({ foreground: 'cyan', underline: true }),
      toolName: lineStyle({ bold: true }),
      toolBackground: lineStyle({ background: 'ansi256:236' }),
      toolBackgroundExpanded: lineStyle({ background: 'ansi256:238' }),
      searchMatch: lineStyle({ foreground: 'black', background: 'yellow' }),
      searchCurrent: lineStyle({ foreground: 'black', background: 'cyan', bold: true }),
    },
  })
}

export function createThemeRegistry(options: {
  readonly fallback?: ThemeDescriptor
  readonly initial?: readonly ThemeDescriptor[]
} = {}): ThemeRegistry {
  const fallback = options.fallback ?? { id: 'default', displayName: 'Default', base: 'default' }
  const descriptors = new Map<string, ThemeDescriptor>()
  const themes = new Map<string, ComponentTheme>()
  const fallbackValidated = validateDescriptor(fallback)
  if (fallbackValidated.descriptor === undefined) throw new TypeError(`invalid fallback theme: ${fallbackValidated.errors.join('; ')}`)
  descriptors.set(fallbackValidated.descriptor.id, fallbackValidated.descriptor)
  themes.set(fallbackValidated.descriptor.id, fallbackTheme(fallbackValidated.descriptor.id, fallbackValidated.descriptor.base))
  for (const candidate of options.initial ?? []) {
    const result = validateDescriptor(candidate)
    if (result.ok && result.descriptor !== undefined) {
      descriptors.set(result.descriptor.id, result.descriptor)
      const baseTheme = fallbackTheme(result.descriptor.id, result.descriptor.base)
      themes.set(result.descriptor.id, Object.freeze({
        ...baseTheme,
        roles: { ...baseTheme.roles, ...(result.descriptor.roles ?? {}) },
      }))
    }
  }
  return {
    register(input) {
      const result = validateDescriptor(input)
      if (!result.ok || result.descriptor === undefined) return result
      descriptors.set(result.descriptor.id, result.descriptor)
      const baseTheme = fallbackTheme(result.descriptor.id, result.descriptor.base)
      themes.set(result.descriptor.id, Object.freeze({
        ...baseTheme,
        roles: { ...baseTheme.roles, ...(result.descriptor.roles ?? {}) },
      }))
      return result
    },
    resolve(id) {
      return themes.get(id) ?? themes.get(fallbackValidated.descriptor!.id) as ComponentTheme
    },
    has: (id) => descriptors.has(id),
    list: () => [...descriptors.values()].map((descriptor) => Object.freeze({ ...descriptor })),
    fallbackId: () => fallbackValidated.descriptor!.id,
  }
}
