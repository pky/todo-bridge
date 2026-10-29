const test = require('node:test')
const assert = require('node:assert/strict')

// 未実装のモジュールでファイル全体が落ちないよう、読み込み失敗は各テスト内の失敗として報告する。
let selection = null
let loadError = null
try {
  selection = require('../lib/news/aiSelection')
} catch (error) {
  loadError = error
}
function mod() {
  if (!selection) throw new Error(`aiSelection が未実装です: ${loadError && loadError.message}`)
  return selection
}

const INCLUDE_CATEGORIES = ['coding_agent', 'llm_engineering', 'ai_security', 'model_capability', 'ml_engineering', 'ai_dev_tool']
const EXCLUDE_CATEGORIES = ['business_policy', 'promotion', 'end_user_usage', 'incidental_ai', 'general_commentary', 'not_ai']

function candidate(id, overrides = {}) {
  return {
    id, url: `https://example.com/${id}`, title: `Fictional article ${id}`, description: '架空の説明です',
    source: 'rss', sourceName: 'Fictional Feed', score: null,
    triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', category: 'llm_engineering',
    relevant: true, developerValue: 'normal', importance: 'normal',
    ...overrides,
  }
}
const generated = (id, overrides = {}) => candidate(id, {
  summaryVersion: 'ai-v2', summaryStatus: 'generated', summarySource: 'content', summarizedAt: Date.now(),
  titleJa: '架空のタイトル', summaryJa: '架空の概要です', ...overrides,
})
const ids = items => items.map(item => item.article.id)

test('定数は仕様どおり', () => {
  const m = mod()
  assert.equal(m.AI_TRIAGE_VERSION, 'ai-v2')
  assert.equal(m.AI_SUMMARY_VERSION, 'ai-v2')
  assert.equal(m.AI_REUSE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000)
  assert.deepEqual(m.AI_INCLUDE_CATEGORIES, INCLUDE_CATEGORIES)
  assert.deepEqual(m.AI_EXCLUDE_CATEGORIES, EXCLUDE_CATEGORIES)
  assert.equal(m.AI_FEED_MAX_ARTICLES, 20)
  assert.deepEqual(m.AI_FEED_SOURCE_LIMITS, { hn: 5, github: 4, japanese: 8, otherRss: 6 })
})

test('isSyntheticGithubDescription は合成説明文だけ true', () => {
  const { isSyntheticGithubDescription } = mod()
  assert.equal(isSyntheticGithubDescription('GitHub trending repository: sample-owner/sample-repo'), true)
  assert.equal(isSyntheticGithubDescription('GitHub trending repository:'), true)
  assert.equal(isSyntheticGithubDescription('A fictional parser library'), false)
  assert.equal(isSyntheticGithubDescription(''), false)
  assert.equal(isSyntheticGithubDescription('About GitHub trending repository: sample'), false)
})

test('isAiFeedCandidate は v2 の include と hold で high と normal を通す', () => {
  const { isAiFeedCandidate } = mod()
  for (const triageDecision of ['include', 'hold']) {
    for (const developerValue of ['high', 'normal']) {
      assert.equal(isAiFeedCandidate(candidate('ok', { triageDecision, developerValue })), true, `${triageDecision}/${developerValue}`)
    }
  }
})

test('isAiFeedCandidate は判定待ち・旧版・exclude・low・価値なしを通さない', () => {
  const { isAiFeedCandidate } = mod()
  assert.equal(isAiFeedCandidate(candidate('pending', { triageStatus: 'pending' })), false)
  assert.equal(isAiFeedCandidate(candidate('no-version', { triageVersion: undefined })), false)
  assert.equal(isAiFeedCandidate(candidate('old-version', { triageVersion: 'ai-v1' })), false)
  assert.equal(isAiFeedCandidate(candidate('excluded', { triageDecision: 'exclude', relevant: false })), false)
  assert.equal(isAiFeedCandidate(candidate('no-decision', { triageDecision: undefined })), false)
  assert.equal(isAiFeedCandidate(candidate('low', { developerValue: 'low' })), false)
  assert.equal(isAiFeedCandidate(candidate('no-value', { developerValue: undefined })), false)
  assert.equal(isAiFeedCandidate({}), false)
})

test('isAiFeedCandidate は現行版で rejected の記事を通さず、旧版の rejected や generated は通す', () => {
  const { isAiFeedCandidate } = mod()
  assert.equal(isAiFeedCandidate(candidate('rejected', { summaryVersion: 'ai-v2', summaryStatus: 'rejected', summarizedAt: Date.now() })), false)
  assert.equal(isAiFeedCandidate(candidate('old-rejected', { summaryVersion: 'ai-v1', summaryStatus: 'rejected' })), true)
  assert.equal(isAiFeedCandidate(generated('generated')), true)
})

test('isDisplayableAiArticle は現行版で generated かつ概要が空でない候補だけ true', () => {
  const { isDisplayableAiArticle } = mod()
  assert.equal(isDisplayableAiArticle(generated('ok')), true)
  assert.equal(isDisplayableAiArticle(candidate('no-summary')), false)
  assert.equal(isDisplayableAiArticle(generated('empty', { summaryJa: '' })), false)
  assert.equal(isDisplayableAiArticle(generated('blank', { summaryJa: '  \n ' })), false)
  assert.equal(isDisplayableAiArticle(generated('old-summary', { summaryVersion: 'ai-v1' })), false)
  assert.equal(isDisplayableAiArticle(generated('fallback', { summaryStatus: 'fallback' })), false)
  assert.equal(isDisplayableAiArticle(generated('rejected', { summaryStatus: 'rejected' })), false)
  assert.equal(isDisplayableAiArticle(generated('pending', { triageStatus: 'pending' })), false)
  assert.equal(isDisplayableAiArticle(generated('low', { developerValue: 'low' })), false)
})

test('needsAiSummary は候補で、現行版の generated と rejected 以外だけ true', () => {
  const { needsAiSummary } = mod()
  assert.equal(needsAiSummary(candidate('fresh')), true)
  assert.equal(needsAiSummary(candidate('old-version', { summaryVersion: 'ai-v1', summaryStatus: 'generated', summaryJa: '旧概要' })), true)
  assert.equal(needsAiSummary(candidate('fallback', { summaryVersion: 'ai-v2', summaryStatus: 'fallback' })), true)
  assert.equal(needsAiSummary(candidate('no-status', { summaryVersion: 'ai-v2' })), true)
  assert.equal(needsAiSummary(generated('done')), false)
  assert.equal(needsAiSummary(candidate('rejected', { summaryVersion: 'ai-v2', summaryStatus: 'rejected', summarizedAt: Date.now() })), false)
  assert.equal(needsAiSummary(candidate('not-candidate', { triageDecision: 'exclude' })), false)
  assert.equal(needsAiSummary(candidate('pending', { triageStatus: 'pending' })), false)
})

test('getAiSourceBucket はソースと掲載元名で分類する', () => {
  const { getAiSourceBucket } = mod()
  assert.equal(getAiSourceBucket({ source: 'hn', sourceName: 'Hacker News' }), 'hn')
  assert.equal(getAiSourceBucket({ source: 'github', sourceName: 'GitHub Trending' }), 'github')
  assert.equal(getAiSourceBucket({ source: 'rss', sourceName: 'Zenn ai' }), 'japanese')
  assert.equal(getAiSourceBucket({ source: 'rss', sourceName: 'Qiita llm' }), 'japanese')
  assert.equal(getAiSourceBucket({ source: 'rss', sourceName: 'Fictional Feed' }), 'otherRss')
  assert.equal(getAiSourceBucket({ source: 'rss', sourceName: 'はてなブックマーク IT' }), 'otherRss')
})

test('calcAiBaseScore は developerValue と importance と人気を合算する', () => {
  const { calcAiBaseScore } = mod()
  const max = { maxHnScore: 100, maxGithubScore: 100 }
  assert.equal(calcAiBaseScore(candidate('a', { developerValue: 'high', importance: 'normal' }), max), 110)
  assert.equal(calcAiBaseScore(candidate('b', { developerValue: 'normal', importance: 'normal' }), max), 70)
  assert.equal(calcAiBaseScore(candidate('c', { developerValue: 'high', importance: 'high' }), max), 130)
  assert.equal(calcAiBaseScore(candidate('d', { developerValue: 'high', importance: 'low' }), max), 100)
  assert.equal(calcAiBaseScore(candidate('e', { developerValue: 'low', importance: 'normal' }), max), 10)
})

test('calcAiBaseScore の人気は HN と GitHub が最大値で正規化した 0 から 20、RSS は 10', () => {
  const { calcAiBaseScore } = mod()
  const max = { maxHnScore: 200, maxGithubScore: 50 }
  const base = { developerValue: 'normal', importance: 'normal' }
  assert.equal(calcAiBaseScore(candidate('hn-max', { ...base, source: 'hn', score: 200 }), max), 80)
  assert.equal(calcAiBaseScore(candidate('hn-half', { ...base, source: 'hn', score: 100 }), max), 70)
  assert.equal(calcAiBaseScore(candidate('hn-zero', { ...base, source: 'hn', score: 0 }), max), 60)
  assert.equal(calcAiBaseScore(candidate('gh-half', { ...base, source: 'github', score: 25 }), max), 70)
  assert.equal(calcAiBaseScore(candidate('gh-over', { ...base, source: 'github', score: 500 }), max), 80)
  assert.equal(calcAiBaseScore(candidate('rss', { ...base, source: 'rss' }), max), 70)
  assert.equal(calcAiBaseScore(candidate('hn-no-max', { ...base, source: 'hn', score: 30 }), { maxHnScore: 0, maxGithubScore: 0 }), 60)
})

test('calcAiBaseScore は HN と GitHub で score が null なら人気を 0 にする', () => {
  const { calcAiBaseScore } = mod()
  const max = { maxHnScore: 100, maxGithubScore: 100 }
  const base = { developerValue: 'normal', importance: 'normal' }
  assert.equal(calcAiBaseScore(candidate('hn-null', { ...base, source: 'hn', score: null }), max), 60)
  assert.equal(calcAiBaseScore(candidate('gh-null', { ...base, source: 'github', score: null }), max), 60)
})

test('calcAiBaseScore は importance が同じなら人気が developerValue の差を覆さない', () => {
  const { calcAiBaseScore } = mod()
  const max = { maxHnScore: 100, maxGithubScore: 100 }
  for (const importance of ['high', 'normal', 'low']) {
    const popularNormal = calcAiBaseScore(candidate('n', { developerValue: 'normal', importance, source: 'hn', score: 100 }), max)
    const quietHigh = calcAiBaseScore(candidate('h', { developerValue: 'high', importance, source: 'hn', score: 0 }), max)
    assert.ok(quietHigh > popularNormal, `${importance}: ${quietHigh} > ${popularNormal}`)
  }
})

function ranked(prefix, count, overrides, startScore) {
  return Array.from({ length: count }, (_, index) => ({
    article: candidate(`${prefix}-${index}`, overrides),
    displayScore: startScore - index,
  }))
}

test('selectAiFeed はソース別上限を守り、合計 23 件から 20 件に切る', () => {
  const { selectAiFeed } = mod()
  const items = [
    ...ranked('hn', 8, { source: 'hn', sourceName: 'Hacker News' }, 200),
    ...ranked('gh', 6, { source: 'github', sourceName: 'GitHub Trending' }, 190),
    ...ranked('jp', 10, { source: 'rss', sourceName: 'Zenn ai' }, 180),
    ...ranked('other', 10, { source: 'rss', sourceName: 'Fictional Feed' }, 100),
  ]
  const selected = selectAiFeed(items)
  assert.equal(selected.length, 20)
  const byPrefix = prefix => ids(selected).filter(id => id.startsWith(prefix)).length
  assert.equal(byPrefix('hn-'), 5)
  assert.equal(byPrefix('gh-'), 4)
  assert.equal(byPrefix('jp-'), 8)
  // 上限合計は 23 件。20 件で切ると最も点数の低い otherRss が 3 件落ちる。
  assert.equal(byPrefix('other-'), 3)
  assert.deepEqual(ids(selected).filter(id => id.startsWith('other-')), ['other-0', 'other-1', 'other-2'])
  assert.deepEqual(ids(selected).filter(id => id.startsWith('hn-')), ['hn-0', 'hn-1', 'hn-2', 'hn-3', 'hn-4'])
})

test('selectAiFeed は displayScore 降順に並べ、入力の順序に依存しない', () => {
  const { selectAiFeed } = mod()
  const items = [
    { article: candidate('low'), displayScore: 10 },
    { article: candidate('top'), displayScore: 99 },
    { article: candidate('mid'), displayScore: 50 },
  ]
  const selected = selectAiFeed(items)
  assert.deepEqual(ids(selected), ['top', 'mid', 'low'])
  assert.deepEqual(selected.map(item => item.displayScore), [99, 50, 10])
})

test('selectAiFeed は rejected と候補でない記事を飛ばして次の候補を選ぶ', () => {
  const { selectAiFeed } = mod()
  const items = [
    { article: candidate('rejected', { summaryVersion: 'ai-v2', summaryStatus: 'rejected', summarizedAt: Date.now() }), displayScore: 300 },
    { article: candidate('pending', { triageStatus: 'pending' }), displayScore: 290 },
    { article: candidate('low', { developerValue: 'low' }), displayScore: 280 },
    { article: candidate('excluded', { triageDecision: 'exclude' }), displayScore: 270 },
    ...ranked('other', 7, { source: 'rss', sourceName: 'Fictional Feed' }, 100),
  ]
  const selected = selectAiFeed(items)
  assert.deepEqual(ids(selected), ['other-0', 'other-1', 'other-2', 'other-3', 'other-4', 'other-5'])
})

test('selectAiFeed は 20 件に満たなくても他ソースで埋めない', () => {
  const { selectAiFeed } = mod()
  const items = [
    ...ranked('hn', 7, { source: 'hn', sourceName: 'Hacker News' }, 100),
    ...ranked('other', 2, { source: 'rss', sourceName: 'Fictional Feed' }, 50),
  ]
  const selected = selectAiFeed(items)
  assert.equal(selected.length, 7)
  assert.equal(ids(selected).filter(id => id.startsWith('hn-')).length, 5)
  assert.deepEqual(selectAiFeed([]), [])
})

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-28T00:00:00Z')

test('記事自身の summarizedAt が7日超なら generated でも表示できず再確認が必要になる', () => {
  const { isDisplayableAiArticle, needsAiSummary, isAiFeedCandidate } = mod()
  const fresh = generated('fresh', { summarizedAt: NOW - 7 * DAY_MS })
  assert.equal(isDisplayableAiArticle(fresh, NOW), true, 'ちょうど7日は有効')
  assert.equal(needsAiSummary(fresh, NOW), false)
  const expired = generated('expired', { summarizedAt: NOW - 7 * DAY_MS - 1 })
  assert.equal(isDisplayableAiArticle(expired, NOW), false)
  assert.equal(needsAiSummary(expired, NOW), true)
  assert.equal(isAiFeedCandidate(expired, NOW), true)
  for (const summarizedAt of [undefined, null, 'later']) {
    const broken = generated('no-time', { summarizedAt })
    assert.equal(isDisplayableAiArticle(broken, NOW), false, String(summarizedAt))
    assert.equal(needsAiSummary(broken, NOW), true, String(summarizedAt))
  }
})

test('記事自身の summarizedAt が7日超の rejected は候補に戻り、有効な rejected は候補から外れる', () => {
  const { isAiFeedCandidate, needsAiSummary } = mod()
  const rejected = at => candidate('rejected', { summaryVersion: 'ai-v2', summaryStatus: 'rejected', summarizedAt: at })
  assert.equal(isAiFeedCandidate(rejected(NOW - DAY_MS), NOW), false)
  assert.equal(isAiFeedCandidate(rejected(NOW - 7 * DAY_MS - 1), NOW), true)
  assert.equal(needsAiSummary(rejected(NOW - 7 * DAY_MS - 1), NOW), true)
  assert.equal(isAiFeedCandidate(rejected(undefined), NOW), true)
})

test('selectAiFeed は now を受け取り、期限切れの rejected を候補に戻す', () => {
  const { selectAiFeed } = mod()
  const items = [
    { article: candidate('old-rejected', { summaryVersion: 'ai-v2', summaryStatus: 'rejected', summarizedAt: NOW - 8 * DAY_MS }), displayScore: 90 },
    { article: candidate('live-rejected', { summaryVersion: 'ai-v2', summaryStatus: 'rejected', summarizedAt: NOW - DAY_MS }), displayScore: 80 },
    { article: candidate('plain'), displayScore: 70 },
  ]
  assert.deepEqual(ids(selectAiFeed(items, NOW)), ['old-rejected', 'plain'])
})
