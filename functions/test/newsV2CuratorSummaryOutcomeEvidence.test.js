const test = require('node:test')
const assert = require('node:assert/strict')

const cases = [
  ['選別記事の本文取得失敗', ['selected-a'], [['selected-a', 'evidence-unavailable']], false],
  ['一部だけ本文取得失敗', ['selected-a', 'selected-b'], [['selected-b', 'evidence-unavailable']], false],
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
