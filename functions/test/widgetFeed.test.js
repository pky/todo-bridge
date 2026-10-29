const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// 未実装のモジュールでファイル全体が落ちないよう、読み込み失敗は各テスト内の失敗として報告する。
let feed = null
let loadError = null
try {
  feed = require('../lib/news/widgetFeed')
} catch (error) {
  loadError = error
}
function mod() {
  if (!feed) throw new Error(`widgetFeed が未実装です: ${loadError && loadError.message}`)
  return feed
}

const contract = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'widgetFeedContract.json'), 'utf8'))

function inputOf(scenario) {
  const { topic, personalDate, personalDocs, sharedDate, sharedDocs, interactions } = scenario
  return { topic, personalDate, personalDocs, sharedDate, sharedDocs, interactions }
}

for (const scenario of contract.scenarios) {
  test(`契約フィクスチャ: ${scenario.name} (${scenario.topic})`, () => {
    const { selectWidgetFeed } = mod()
    const result = selectWidgetFeed(inputOf(structuredClone(scenario)))
    assert.deepEqual(
      {
        feedDate: result.feedDate,
        isSharedFallback: result.isSharedFallback,
        articleIds: result.articles.map(article => article.id),
      },
      scenario.expected,
    )
  })
}

test('入力配列を破壊しない', () => {
  const { selectWidgetFeed } = mod()
  // displayScore の並べ替えと除外が走るシナリオ（先頭）を使う。
  const scenario = contract.scenarios[0]
  const input = inputOf(structuredClone(scenario))
  const before = structuredClone(input)
  selectWidgetFeed(input)
  assert.deepEqual(input.personalDocs, before.personalDocs)
  assert.deepEqual(input.sharedDocs, before.sharedDocs)
  assert.deepEqual(input.interactions, before.interactions)
  assert.deepEqual(input, before)
})

test('入力配列を破壊しない（共有fallbackで並べ替えと上限が走る場合）', () => {
  const { selectWidgetFeed } = mod()
  const scenario = contract.scenarios[1]
  const input = inputOf(structuredClone(scenario))
  const before = structuredClone(input)
  selectWidgetFeed(input)
  assert.deepEqual(input, before)
})
