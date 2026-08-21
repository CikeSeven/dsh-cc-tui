import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import { createTranslator, DEFAULT_TRANSLATIONS, languageDirection, localeDirection } from '../../src/tui-v2/i18n/catalog.js'
import { measureLineWidth } from '../../src/tui-v2/renderer/lines.js'
import { createThemeRegistry, resolveThemeForProfile } from '../../src/tui-v2/theme/registry.js'
import { getProfile } from '../../src/tui-v2/testkit/terminal-profiles.js'


test('custom themes: validated roles are deeply immutable and invalid colors/control text fall back', () => {
  const themes = createThemeRegistry({ initial: [{
    id: 'ocean',
    displayName: 'Ocean',
    base: 'dark',
    roles: { accent: { ...DEFAULT_COMPONENT_THEME.roles.accent, foreground: '#010203' } },
  }] })
  assert.equal(themes.has('ocean'), true)
  assert.equal(themes.resolve('ocean').roles.accent.foreground, '#010203')
  assert.equal(Object.isFrozen(themes.resolve('ocean')), true)
  assert.equal(Object.isFrozen(themes.resolve('ocean').roles), true)
  assert.equal(themes.resolve('missing').id, 'default')
  assert.equal(themes.register({ id: '../escape', displayName: 'x', base: 'dark' }).ok, false)
  assert.equal(themes.register({ id: 'bad-color', displayName: 'Bad', base: 'dark', roles: { text: { ...DEFAULT_COMPONENT_THEME.roles.text, foreground: '#fff' } } }).ok, false)
  assert.equal(themes.register({ id: 'bad-index', displayName: 'Bad index', base: 'dark', roles: { text: { ...DEFAULT_COMPONENT_THEME.roles.text, foreground: 'ansi256:999' } } }).ok, false)
  assert.equal(themes.register({ id: 'bad-text', displayName: 'bad\u001b[31m', base: 'dark' }).ok, false)
  const degraded = resolveThemeForProfile(themes, 'ocean', getProfile('unicode-ambiguous-narrow'))
  assert.equal(degraded.degraded, true)
  assert.match(degraded.theme.roles.accent.foreground ?? '', /^ansi256:/)
  assert.equal(resolveThemeForProfile(themes, 'ocean', getProfile('kitty-sync')).degraded, false)
})

test('i18n/width: logical-order translations sanitize controls and preserve profile-specific width', () => {
  const english = createTranslator('en', DEFAULT_TRANSLATIONS)
  const chinese = createTranslator('zh', DEFAULT_TRANSLATIONS)
  assert.equal(english.direction, 'ltr')
  assert.equal(languageDirection('zh'), 'ltr')
  assert.equal(localeDirection('he-IL'), 'rtl')
  assert.equal(localeDirection('ar_EG.UTF-8'), 'rtl')
  assert.equal(localeDirection('en-US'), 'ltr')
  assert.equal(english.t('preference.theme.changed', undefined, { name: '\u001b[31mOcean\u001b[0m' }), 'Theme changed: Ocean')
  assert.equal(chinese.t('missing.key', '你好 👩‍💻'), '你好 👩‍💻')

  const narrow = getProfile('unicode-ambiguous-narrow')
  const wide = getProfile('unicode-ambiguous-wide')
  const logicalRtl = 'אבג · 你好 e\u0301'
  assert.equal(measureLineWidth(logicalRtl, narrow), 12)
  assert.equal(measureLineWidth(logicalRtl, wide), 13)
  for (const width of [0, 1, 2, 3, 8, 20]) {
    assert.ok(measureLineWidth('控制\u001b[31m文本\u001b[0m', narrow) >= 0)
    assert.ok(width >= 0)
  }
})
