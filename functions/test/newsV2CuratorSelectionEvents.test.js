const test = require('node:test')
const assert = require('node:assert/strict')
const { Timestamp } = require('firebase-admin/firestore')
const { selectCuratorAiFeed } = require('../lib/news/v2/curatorSelection')
const { calcAiBaseScore } = require('../lib/news/aiSelection')

const CUTOFF = Date.parse('2026-11-04T00:00:00.000Z')
const DAY_MS = 86400000
const scoreLimits = { maxHnScore: 100, maxGithubScore: 100 }

function article(id, extra = {}) {
  return {
    id, title: id, url: `https://example.invalid/${id}`, source: 'rss', sourceName: '架空通信',
    triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', developerValue: 'normal', ...extra,
  }
}

function event(articleId, action, extra = {}) {
  return { topic: 'ai', articleId, action, receivedAt: new Date(CUTOFF), title: 'fabletoken', ...extra }
}

function select(articles, events = []) {
  return selectCuratorAiFeed({ articles, preferences: { keywords: [] }, events, learningCutoffMs: CUTOFF, scoreLimits })
}

test('eventsのreadLaterによる正の学習で順位が上がる', () => {
  const articles = [article('baseline'), article('learned', { title: 'fabletoken' })]
  assert.deepEqual(select(articles).map(item => item.article.id), ['baseline', 'learned'])
  const result = select(articles, [event('saved-source', 'readLater')])
  assert.deepEqual(result.map(item => item.article.id), ['learned', 'baseline'])
  assert.equal(result[0].displayScore, calcAiBaseScore(articles[1], scoreLimits) * 1.5)
})

test('eventsの独立したdismiss2件による負の学習で順位が下がるが候補には残る', () => {
  const articles = [article('dismissed', { title: 'fabletoken' }), article('baseline')]
  assert.deepEqual(select(articles).map(item => item.article.id), ['dismissed', 'baseline'])
  const result = select(articles, [event('source-a', 'dismiss'), event('source-b', 'dismiss')])
  assert.deepEqual(result.map(item => item.article.id), ['baseline', 'dismissed'])
  assert.equal(result[1].displayScore, calcAiBaseScore(articles[0], scoreLimits) * 0.7)
})

test('cutoff直後のイベントを無視し、cutoffと同時刻のイベントは学習する', () => {
  const articles = [article('baseline'), article('past', { title: 'pasttoken' }), article('future', { title: 'futuretoken' })]
  const baseline = new Map(select(articles).map(item => [item.article.id, item.displayScore]))
  const result = select(articles, [
    event('past-source', 'readLater', { title: 'pasttoken', receivedAt: Timestamp.fromMillis(CUTOFF) }),
    event('future-source', 'readLater', { title: 'futuretoken', receivedAt: Timestamp.fromMillis(CUTOFF + 1) }),
  ])
  const scores = new Map(result.map(item => [item.article.id, item.displayScore]))
  assert.equal(result[0].article.id, 'past')
  assert.equal(scores.get('past'), baseline.get('past') * 1.5)
  assert.equal(scores.get('future'), baseline.get('future'))
})

test('90日窓外のイベントを複数渡しても学習しない', () => {
  const articles = [article('baseline'), article('old', { title: 'fabletoken' })]
  const events = Array.from({ length: 10 }, (_, i) => event(`old-${i}`, 'readLater', { receivedAt: new Date(CUTOFF - 91 * DAY_MS) }))
  assert.deepEqual(select(articles, events), select(articles))
})

// 新しいイベント形式を、既存の学習純粋関数が扱う信号へ変換する公開境界。
function learning() {
  const mod = require('../lib/news/interactionLearning')
  assert.equal(typeof mod.buildEventSignals, 'function', 'interactionLearningにbuildEventSignalsを公開する')
  return mod
}

for (const [action, weight] of [['readLater', 2], ['dismiss', -1]]) {
  for (const asTimestamp of [false, true]) {
    test(`buildEventSignalsは${action}の重み${weight}とreceivedAt（${asTimestamp ? 'Timestamp' : 'Date'}）を使う`, () => {
      const mod = learning()
      const atMs = CUTOFF - DAY_MS
      const signals = mod.buildEventSignals(event('source', action, {
        receivedAt: asTimestamp ? Timestamp.fromMillis(atMs) : new Date(atMs),
        readLaterAt: new Date(CUTOFF), dismissedAt: new Date(CUTOFF),
      }))
      assert.equal(signals.length, 1)
      assert.equal(signals[0].kind, action)
      assert.equal(signals[0].atMs, atMs)
      assert.equal(mod.SIGNAL_WEIGHTS[signals[0].kind], weight)
    })
  }
}

for (const [field, value, word] of [['title', 'Titletoken', 'titletoken'], ['summary', 'Summarytokenの概要', 'summarytoken'], ['tags', ['Tagtoken'], 'tagtoken']]) {
  test(`buildEventSignalsはイベントの${field}だけからでもキーワードを学習できる`, () => {
    const mod = learning()
    const data = { topic: 'ai', action: 'readLater', receivedAt: new Date(CUTOFF), [field]: value }
    const signals = mod.buildEventSignals(data)
    assert.equal(signals.length, 1)
    assert.ok(mod.learnKeywordPreferences(signals, CUTOFF).positive.includes(word))
  })
}
