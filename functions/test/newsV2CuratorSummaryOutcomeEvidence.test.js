const test = require('node:test')
const assert = require('node:assert/strict')

const cases = [
  ['選別記事の本文取得失敗', ['selected-a'], [['selected-a', 'evidence-unavailable']], false],
  ['一部だけ本文取得失敗', ['selected-a', 'selected-b'], [['selected-b', 'evidence-unavailable']], false],
  ['3件中1件だけ本文取得失敗', ['selected-a', 'selected-b', 'selected-c'], [['selected-b', 'evidence-unavailable']], true],
  ['4件中1件だけ本文取得失敗', ['selected-a', 'selected-b', 'selected-c', 'selected-d'], [['selected-a', 'evidence-unavailable']], true],
  ['4件中2件が本文取得失敗（ちょうど半数）', ['selected-a', 'selected-b', 'selected-c', 'selected-d'], [['selected-a', 'evidence-unavailable'], ['selected-b', 'evidence-unavailable']], false],
  ['3件中2件が本文取得失敗（過半）', ['selected-a', 'selected-b', 'selected-c'], [['selected-a', 'evidence-unavailable'], ['selected-b', 'evidence-unavailable']], false],
  ['本文取得失敗は1件だが要約不可が混在', ['selected-a', 'selected-b', 'selected-c', 'selected-d'], [['selected-a', 'evidence-unavailable'], ['selected-b', 'summary-unavailable']], false],
  ['選別対象外の本文取得失敗', ['selected-a'], [['other', 'evidence-unavailable']], true],
  ['本文なしだけ', ['selected-a'], [['selected-a', 'no-evidence']], true],
  ['本文なしと本文取得失敗が混在', ['selected-a', 'selected-b'], [['selected-a', 'no-evidence'], ['selected-b', 'evidence-unavailable']], false],
  ['選別対象は本文なし、対象外は本文取得失敗', ['selected-a'], [['selected-a', 'no-evidence'], ['other', 'evidence-unavailable']], true],
]

for (const [name, selectedIds, entries, ok] of cases) {
  test(`${name}を公開成功判定に反映する`, () => {
    const { evaluateCuratorSummaryOutcome } = require('../lib/news/v2/curatorSummaryOutcome')
    const result = evaluateCuratorSummaryOutcome({ selectedIds, skipped: new Map(entries) })
    assert.equal(result.ok, ok)
  })
}
