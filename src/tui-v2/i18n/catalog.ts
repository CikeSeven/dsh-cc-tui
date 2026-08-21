/** Pure v2 localization catalog (WP-08f).
 *
 * Translation lookup is explicit and injectable. Missing keys fall back to the
 * provided default or the key, and values are sanitized before rendering.
 */
import { sanitizeChildText } from '../capabilities/external-actions.js'

export type LanguageId = 'zh' | 'en'
export type TranslationTable = Readonly<Record<string, Readonly<Partial<Record<LanguageId, string>>>>>

export interface Translator {
  readonly language: LanguageId
  t(key: string, fallback?: string, params?: Readonly<Record<string, string | number>>): string
}

export function isLanguageId(value: unknown): value is LanguageId {
  return value === 'zh' || value === 'en'
}

export function createTranslator(language: LanguageId, table: TranslationTable): Translator {
  return {
    language,
    t(key, fallback, params = {}) {
      const raw = table[key]?.[language] ?? fallback ?? key
      const clean = sanitizeChildText(raw, { maxChars: 2000, maxLines: 4 }).text
      return clean.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_match, name: string) => {
        const value = params[name]
        return value === undefined ? `{{${name}}}` : sanitizeChildText(String(value), { maxChars: 256, maxLines: 1 }).text
      })
    },
  }
}

export const DEFAULT_TRANSLATIONS: TranslationTable = Object.freeze({
  'command.local.running': { en: 'Running local command…', zh: '正在运行本地命令…' },
  'command.local.cancelled': { en: 'Local command cancelled', zh: '本地命令已取消' },
  'command.local.timeout': { en: 'Local command timed out', zh: '本地命令超时' },
  'clipboard.empty': { en: 'Clipboard is empty', zh: '剪贴板为空' },
  'clipboard.unavailable': { en: 'Clipboard is unavailable', zh: '剪贴板不可用' },
  'clipboard.unsupported': { en: 'Clipboard is unsupported by this terminal', zh: '当前终端不支持剪贴板' },
  'editor.unavailable': { en: 'No safe external editor is configured', zh: '未配置安全的外部编辑器' },
  'update.running': { en: 'Updating dsh-tui…', zh: '正在更新 dsh-tui…' },
  'update.failed': { en: 'Update failed; the current session was preserved', zh: '更新失败，当前会话已保留' },
  'preference.theme.changed': { en: 'Theme changed: {{name}}', zh: '主题已切换：{{name}}' },
  'preference.language.changed': { en: 'Language changed: {{name}}', zh: '语言已切换：{{name}}' },
})
