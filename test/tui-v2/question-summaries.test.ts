/** WP-08c real QuestionStore running/completed summary contract. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { QuestionStore } from '../../src/dsh-adapter/questions.js'

test('question store: answeredSummary and takeSummaries share redaction-safe formatting', async () => {
  const store = new QuestionStore()
  const answer = store.ask({
    questions: [
      { id: 'token', question: 'API token?' },
      { id: 'region', question: 'Region?', options: [{ label: 'west' }] },
    ],
  }, { redact: true })

  assert.deepEqual(store.getSnapshot()?.answeredSummary, [])
  store.answerCurrent({ selected: [], custom: 'super-secret' })
  const running = store.getSnapshot()
  assert.equal(running?.position, 2)
  assert.equal(running?.answeredSummary.length, 1)
  assert.match(running?.answeredSummary[0] ?? '', /••••••/)
  assert.ok(!(running?.answeredSummary[0] ?? '').includes('super-secret'))

  store.answerCurrent({ selected: ['west'] })
  assert.deepEqual((await answer).answers, [
    { id: 'token', selected: [], custom: 'super-secret' },
    { id: 'region', selected: ['west'] },
  ])
  const summaries = store.takeSummaries()
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0]?.lines.length, 2)
  assert.ok(summaries[0]?.lines.every((line) => line.includes('••••••')))
  assert.ok(!JSON.stringify(summaries).includes('super-secret'))
  assert.deepEqual(store.takeSummaries(), [], 'drain is one-shot')
})
