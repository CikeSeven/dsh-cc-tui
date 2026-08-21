/** v2 theme registry and persisted-preference domain gate. */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseThemePref, readThemePref, writeThemePref } from '../src/themePrefs.js'
import { lineStyle } from '../src/tui-v2/renderer/lines.js'
import { createThemeRegistry, resolveThemeForProfile, THEME_NAME_RE } from '../src/tui-v2/theme/registry.js'
import { unknownConservativeDefaults } from '../src/tui-v2/terminal/profile.js'

let checks = 0
const check = (name, run) => {
  run()
  checks += 1
  console.log(`  ok   ${name}`)
}

const registry = createThemeRegistry({
  initial: [{
    id: 'night-owl',
    displayName: 'Night Owl',
    base: 'dark',
    roles: { accent: lineStyle({ foreground: '#ff00aa', bold: true }) },
  }],
})

check('safe ids accept registry names and reject traversal/control input', () => {
  assert.equal(THEME_NAME_RE.test('night-owl'), true)
  assert.equal(THEME_NAME_RE.test('../night'), false)
  assert.equal(THEME_NAME_RE.test('night/owl'), false)
  assert.equal(THEME_NAME_RE.test('night\n'), false)
})

check('registered descriptors resolve and unknown ids fall back', () => {
  assert.equal(registry.has('night-owl'), true)
  assert.equal(registry.resolve('night-owl').roles.accent.bold, true)
  assert.equal(registry.resolve('missing').id, registry.fallbackId())
})

check('invalid descriptor fields fail closed', () => {
  assert.equal(registry.register({ id: '../bad', displayName: 'Bad', base: 'dark' }).ok, false)
  assert.equal(registry.register({ id: 'bad-role', displayName: 'Bad', base: 'dark', roles: { unknown: lineStyle() } }).ok, false)
  assert.equal(registry.register({ id: 'bad-color', displayName: 'Bad', base: 'dark', roles: { accent: { ...lineStyle(), foreground: 'hotpink' } } }).ok, false)
})

check('unsupported truecolor deterministically degrades to ANSI-256', () => {
  const profile = { ...unknownConservativeDefaults(), supportsTrueColor: 'no' }
  const resolved = resolveThemeForProfile(registry, 'night-owl', profile)
  assert.equal(resolved.degraded, true)
  assert.match(resolved.theme.roles.accent.foreground ?? '', /^ansi256:/)
})

const prefsDir = mkdtempSync(join(tmpdir(), 'dsh-tui-theme-v2-'))
check('safe preference round-trips', () => {
  assert.equal(writeThemePref('night-owl', prefsDir), true)
  assert.equal(readThemePref(prefsDir), 'night-owl')
  assert.equal(parseThemePref('{"theme":"night-owl"}'), 'night-owl')
})

check('unsafe/corrupt preferences never reach the registry', () => {
  assert.equal(writeThemePref('../bad', prefsDir), false)
  assert.equal(parseThemePref('{"theme":"../bad"}'), undefined)
  writeFileSync(join(prefsDir, 'theme.json'), '{broken', 'utf8')
  assert.equal(readThemePref(prefsDir), undefined)
})

console.log(`verify-themes: PASS (${checks} checks)`)
