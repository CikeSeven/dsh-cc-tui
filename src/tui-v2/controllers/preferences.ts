/** Theme/language preference controller (WP-08f).
 *
 * Preference persistence and host language application are capabilities. The
 * controller publishes immutable ids and never reads legacy global modules.
 */
import type { ExternalActionTraceSink, LanguageCapability, PreferencePersistence } from '../capabilities/external-actions.js'
import { isLanguageId, type LanguageId } from '../i18n/catalog.js'
import type { ThemeRegistry } from '../theme/registry.js'

export type PreferenceKind = 'theme' | 'language'

export interface PreferenceControllerOptions {
  readonly themes: ThemeRegistry
  readonly languages: LanguageCapability
  readonly persistence?: PreferencePersistence
  readonly notify: (text: string, options?: { color?: 'error' | 'warning' | 'success' }) => void
  readonly onChange?: (change: { kind: PreferenceKind; value: string }) => void
  readonly trace?: ExternalActionTraceSink
}

export interface PreferenceControllerDiagnostics {
  readonly themeChanges: number
  readonly languageChanges: number
  readonly rejected: number
  readonly persistFailures: number
  readonly fallbackThemes: number
}

export interface PreferenceController {
  setTheme(id: string): Promise<boolean>
  setLanguage(id: string): Promise<boolean>
  theme(): string
  language(): string
  listThemes(): readonly { id: string; displayName: string }[]
  diagnostics(): PreferenceControllerDiagnostics
}

export function createPreferencesController(options: PreferenceControllerOptions): PreferenceController {
  let activeTheme = options.persistence?.readTheme?.() ?? options.themes.fallbackId()
  if (!options.themes.has(activeTheme)) activeTheme = options.themes.fallbackId()
  let activeLanguage: LanguageId = isLanguageId(options.persistence?.readLanguage?.()) ? options.persistence?.readLanguage?.() as LanguageId : 'en'
  const counts = { themeChanges: 0, languageChanges: 0, rejected: 0, persistFailures: 0, fallbackThemes: 0 }

  const trace = (kind: PreferenceKind, value: string, phase: 'completed' | 'failed'): void => {
    try {
      options.trace?.record({ kind: 'preferences', phase, operationId: `${kind}-${value}`, generation: 0 })
    } catch {
      // Best effort.
    }
  }

  return {
    async setTheme(id) {
      if (!options.themes.has(id)) {
        counts.rejected += 1
        counts.fallbackThemes += 1
        options.notify(`Unknown theme: ${id}`, { color: 'warning' })
        trace('theme', options.themes.fallbackId(), 'failed')
        return false
      }
      let persisted = true
      try {
        const write = options.persistence?.writeTheme
        if (write !== undefined) persisted = await write(id)
      } catch {
        persisted = false
      }
      activeTheme = id
      counts.themeChanges += 1
      options.onChange?.({ kind: 'theme', value: id })
      trace('theme', id, persisted ? 'completed' : 'failed')
      if (!persisted) counts.persistFailures += 1
      options.notify(`Theme changed: ${id}${persisted ? '' : ' (not saved)'}`, persisted ? { color: 'success' } : { color: 'warning' })
      return persisted
    },
    async setLanguage(id) {
      if (!isLanguageId(id) || !options.languages.supported.includes(id)) {
        counts.rejected += 1
        options.notify(`Unknown language: ${id}`, { color: 'warning' })
        trace('language', id, 'failed')
        return false
      }
      const result = await options.languages.set(id)
      if (result.status !== 'changed') {
        counts.rejected += 1
        options.notify('Language change is unsupported', { color: 'warning' })
        trace('language', id, 'failed')
        return false
      }
      let persisted = true
      try {
        const write = options.persistence?.writeLanguage
        if (write !== undefined) persisted = await write(id)
      } catch {
        persisted = false
      }
      activeLanguage = id
      counts.languageChanges += 1
      options.onChange?.({ kind: 'language', value: id })
      trace('language', id, persisted ? 'completed' : 'failed')
      if (!persisted) counts.persistFailures += 1
      options.notify(`Language changed: ${id}${persisted ? '' : ' (not saved)'}`, persisted ? { color: 'success' } : { color: 'warning' })
      return persisted
    },
    theme: () => activeTheme,
    language: () => activeLanguage,
    listThemes: () => options.themes.list().map((theme) => ({ id: theme.id, displayName: theme.displayName })),
    diagnostics: () => ({ ...counts }),
  }
}
