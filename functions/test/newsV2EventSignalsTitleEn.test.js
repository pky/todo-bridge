const test = require('node:test')
const assert = require('node:assert/strict')
const { buildEventSignals, learnKeywordPreferences } = require('../lib/news/interactionLearning')
const { selectCuratorAiFeed } = require('../lib/news/v2/curatorSelection')

const CUTOFF = Date.parse('2026-11-04T00:00:00.000Z')
const DAY_MS = 86400000
const scoreLimits = { maxHnScore: 100, maxGithubScore: 100 }

// newsActionStore が書く実イベントの形: title は日本語、titleEn が英語原題
function liveEvent(extra = {}) {
  return {
    topic: 'ai', articleId: 'source-1', action: 'readLater',
    title: '架空社、推論モデル新版を発表', titleEn: 'Fictional launches new reasoning model',
    summary: '概要', receivedAt: new Date(CUTOFF - DAY_MS), ...extra,
  }
}

function article(id, extra = {}) {
  return {
    id, title: id, url: `https://example.invalid/${id}`, source: 'rss', sourceName: '架空通信',
    triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', developerValue: 'normal', ...extra,
  }
}

test('buildEventSignalsはtitleEnの英単語をキーワード抽出の対象に含める', () => {
  const signals = buildEventSignals(liveEvent())
  assert.equal(signals.length, 1)
  assert.equal(signals[0].kind, 'readLater')
  assert.ok(learnKeywordPreferences(signals, CUTOFF).positive.includes('reasoning'))
})

test('buildEventSignalsはtitleEnが無いイベントでも従来どおりtitleから学習する', () => {
  const { titleEn, ...rest } = liveEvent({ title: 'Titletoken' })
  assert.ok(titleEn)
  const signals = buildEventSignals(rest)
  assert.equal(signals.length, 1)
  assert.ok(learnKeywordPreferences(signals, CUTOFF).positive.includes('titletoken'))
})

test('selectCuratorAiFeedはreadLaterイベントの英語原題に含まれる語を含む記事を上位にする', () => {
  const articles = [article('baseline'), article('learned', { title: 'A reasoning benchmark' })]
  const without = selectCuratorAiFeed({ articles, preferences: { keywords: [] }, events: [], learningCutoffMs: CUTOFF, scoreLimits })
  assert.deepEqual(without.map(item => item.article.id), ['baseline', 'learned'])
  const result = selectCuratorAiFeed({ articles, preferences: { keywords: [] }, events: [liveEvent()], learningCutoffMs: CUTOFF, scoreLimits })
  assert.deepEqual(result.map(item => item.article.id), ['learned', 'baseline'])
})
