const test = require('node:test')
const assert = require('node:assert/strict')
const { selectCuratorAiFeed } = require('../lib/news/v2/curatorSelection')
const { calcAiBaseScore, AI_FEED_SOURCE_LIMITS, getAiSourceBucket } = require('../lib/news/aiSelection')

const cutoff = Date.parse('2026-11-03T21:00:00.000Z')
const preferences = { keywords: [] }
const scoreLimits = { maxHnScore: 100, maxGithubScore: 100 }
function article(id, extra = {}) {
  return { id, title: id, url: `https://example.com/${id}`, source: 'rss', sourceName: '架空通信', triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', developerValue: 'normal', ...extra }
}
function select(articles, interactions = [], extra = {}) {
  return selectCuratorAiFeed({ articles, preferences, interactions, learningCutoffMs: cutoff, scoreLimits, ...extra })
}

test('cutoff後の学習操作は採用せず、同じ文書のcutoff以前の操作は採用する', () => {
  const articles = [article('baseline'), article('future', { title: 'futuretoken' }), article('past', { title: 'pasttoken' })]
  const baseline = select(articles)
  const result = select(articles, [
    { titleEn: 'futuretoken', clickedAt: new Date(cutoff), readLaterAt: new Date(cutoff + 1) },
    { titleEn: 'pasttoken', clickedAt: new Date(cutoff), readLaterAt: new Date(cutoff + 1) },
    { titleEn: 'pasttoken', clickedAt: new Date(cutoff) },
  ])
  const scores = new Map(result.map(item => [item.article.id, item.displayScore]))
  assert.equal(scores.get('future'), baseline.find(item => item.article.id === 'future').displayScore)
  assert.equal(result[0].article.id, 'past')
  assert.equal(scores.get('past'), calcAiBaseScore(articles[2], scoreLimits) * 1.5)
})

test('dismissed・クリック済み・表示回数2以上でも候補に残し、表示可否の絞り込みを行わない', () => {
  const articles = ['dismissed', 'clicked', 'shown'].map(id => article(id))
  const interactions = [
    { articleId: articles[0].id, url: articles[0].url, dismissed: true, dismissedAt: new Date(cutoff) },
    { articleId: articles[1].id, url: articles[1].url, clickedAt: new Date(cutoff) },
    { articleId: articles[2].id, url: articles[2].url, shownCount: 20 },
  ]
  assert.deepEqual(new Set(select(articles, interactions).map(item => item.article.id)), new Set(articles.map(item => item.id)))
})

test('正の学習と明示キーワードの倍率を基礎点に適用して順位を上げる', () => {
  const articles = [article('high', { developerValue: 'high', source: 'hn', score: 0 }), article('learned', { title: 'fabletoken' }), article('preferred', { title: 'manualtoken' })]
  assert.deepEqual(select(articles).map(item => item.article.id), ['high', 'learned', 'preferred'])
  const result = select(articles, [{ titleEn: 'fabletoken', readLaterAt: new Date(cutoff) }], { preferences: { keywords: [{ word: 'manualtoken', weight: 2 }] } })
  assert.deepEqual(result.map(item => item.article.id), ['preferred', 'learned', 'high'])
  assert.equal(result[0].displayScore, calcAiBaseScore(articles[2], scoreLimits) * 2)
})

for (const [bucket, limit] of Object.entries(AI_FEED_SOURCE_LIMITS)) {
  test(`${bucket}のsource上限${limit}件を守る`, () => {
    const source = bucket === 'hn' || bucket === 'github' ? bucket : 'rss'
    const sourceName = bucket === 'japanese' ? 'Zenn 架空欄' : '架空通信'
    const result = select(Array.from({ length: 30 }, (_, i) => article(`item-${i}`, { source, sourceName })))
    assert.equal(result.length, limit)
    assert.ok(result.every(item => getAiSourceBucket(item.article) === bucket))
  })
}

test('複数sourceでも総件数20件以下かつ点数降順にする', () => {
  const articles = Object.keys(AI_FEED_SOURCE_LIMITS).flatMap((bucket, index) => Array.from({ length: 30 }, (_, i) => article(`${bucket}-${i}`, { source: bucket === 'hn' || bucket === 'github' ? bucket : 'rss', sourceName: bucket === 'japanese' ? 'Qiita 架空欄' : '架空通信', score: index + i })))
  const result = select(articles)
  assert.equal(result.length, 20)
  assert.ok(result.every((item, i) => i === 0 || result[i - 1].displayScore >= item.displayScore))
  for (const [bucket, limit] of Object.entries(AI_FEED_SOURCE_LIMITS)) assert.ok(result.filter(item => getAiSourceBucket(item.article) === bucket).length <= limit)
})
