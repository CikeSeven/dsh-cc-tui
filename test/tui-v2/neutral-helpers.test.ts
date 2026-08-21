import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FRAME_PRESETS, PRESET_NAMES, isPresetName, resolvePreset } from '../../src/utils/activityFrames.js'
import type { SpinnerMode } from '../../src/utils/spinnerMode.js'
import { capCells, cleanRenderText, cleanScalarText } from '../../src/dsh-adapter/sanitize.js'
import { textWidth, truncateTextCells } from '../../src/utils/textWidth.js'

// Keep the type in the test's compile surface without creating a runtime import.
const spinnerModes: readonly SpinnerMode[] = ['requesting', 'thinking', 'responding', 'tool-use', 'tool-input']

test('neutral activity helper preserves every legacy preset and selector order', () => {
  assert.ok(FRAME_PRESETS.claude)
  assert.ok(FRAME_PRESETS.moon8)
  assert.equal(PRESET_NAMES[0], 'random')
  assert.equal(PRESET_NAMES.length, Object.keys(FRAME_PRESETS).length + 1)
  for (const name of Object.keys(FRAME_PRESETS)) {
    assert.equal(isPresetName(name), true)
    assert.equal(resolvePreset(name), FRAME_PRESETS[name])
    assert.ok(FRAME_PRESETS[name]?.frames.length)
    assert.ok((FRAME_PRESETS[name]?.intervalMs ?? 0) > 0)
  }
  assert.equal(isPresetName('random'), true)
  assert.equal(isPresetName('not-a-preset'), false)
  assert.equal(resolvePreset(undefined), FRAME_PRESETS.moon8)
  assert.equal(spinnerModes.length, 5)
})

test('neutral text width and adapter sanitization use grapheme cell budgets', () => {
  assert.equal(textWidth('abc'), 3)
  assert.equal(textWidth('界'), 2)
  assert.equal(textWidth('e\u0301'), 1)
  assert.equal(textWidth('🙂'), 2)
  assert.equal(truncateTextCells('a界b', 3), 'a界')
  assert.equal(capCells('a界b', 3), 'a界')
  assert.equal(cleanRenderText('  hello\u001b[31m world  ', 20), 'hello [31m world')
  assert.equal(cleanRenderText('界界界', 5), '界界…')
  assert.equal(cleanScalarText({ nope: true }, 20), '')
  assert.equal(cleanScalarText(true, 20), 'true')
})
