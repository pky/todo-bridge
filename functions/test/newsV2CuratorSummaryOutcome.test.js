const test = require('node:test')
const assert = require('node:assert/strict')

const cases = [
  ['正常0件', [], [], true],
  ['選別記事がすべて要約済み', ['selected-a', 'selected-b'], [], true],
  ['根拠なしだけで欠けた記事', ['selected-a'], [['selected-a', 'no-evidence']], true],
  ['要約利用不可で欠けた記事', ['selected-a'], [['selected-a', 'summary-unavailable']], false],
  ['一部だけ要約利用不可', ['selected-a', 'selected-b'], [['selected-b', 'summary-unavailable']], false],
  ['根拠なしと要約利用不可が混在', ['selected-a', 'selected-b'], [['selected-a', 'no-evidence'], ['selected-b', 'summary-unavailable']], false],
  ['選別対象外の要約利用不可', ['selected-a'], [['other', 'summary-unavailable']], true],
  ['正常0件で選別対象外だけ利用不可', [], [['other', 'summary-unavailable']], true],
  ['選別対象は根拠なし、対象外は利用不可', ['selected-a'], [['selected-a', 'no-evidence'], ['other', 'summary-unavailable']], true],
]

for (const [name, selectedIds, entries, ok] of cases) {
  test(`${name}を公開成功判定に反映する`, () => {
    const { evaluateCuratorSummaryOutcome } = require('../lib/news/v2/curatorSummaryOutcome')
    const result = evaluateCuratorSummaryOutcome({ selectedIds, skipped: new Map(entries) })
    assert.equal(result.ok, ok)
  })
}
