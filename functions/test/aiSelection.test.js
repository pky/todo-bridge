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
  const existingLimits = Object.fromEntries(Object.entries(m.AI_FEED_SOURCE_LIMITS).filter(([source]) => source !== 'reddit'))
  assert.deepEqual(existingLimits, { hn: 5, github: 4, japanese: 8, otherRss: 6 })
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

test('calcAiBaseScore は developerValue と importance と反応を合算する', () => {
  const { calcAiBaseScore } = mod()
  const max = { maxHnScore: 100, maxGithubScore: 100 }
  assert.equal(calcAiBaseScore(candidate('a', { developerValue: 'high', importance: 'normal' }), max), 130)
  assert.equal(calcAiBaseScore(candidate('b', { developerValue: 'normal', importance: 'normal' }), max), 90)
  assert.equal(calcAiBaseScore(candidate('c', { developerValue: 'high', importance: 'high' }), max), 150)
  assert.equal(calcAiBaseScore(candidate('d', { developerValue: 'high', importance: 'low' }), max), 120)
  assert.equal(calcAiBaseScore(candidate('e', { developerValue: 'low', importance: 'normal' }), max), 30)
})

test('calcAiBaseScore は情報源別の最大値との対数の比を使い、反応の加点を 0 から 60 に収める', () => {
  const { calcAiBaseScore } = mod()
  const max = { maxHnScore: 255, maxGithubScore: 80, maxRedditScore: 63, maxZennScore: 26, maxQiitaScore: 15 }
  const cases = [
    // 1 + score と 1 + 最大値を同じ底の累乗にし、対数の比を指数から求める。
    ['hn-half', { source: 'hn', score: 15 }, 90],
    ['github-quarter', { source: 'github', score: 2 }, 75],
    ['reddit-half', { source: 'reddit', score: 7 }, 90],
    ['zenn-third', { sourceName: 'Zenn ai', score: 2 }, 80],
    ['qiita-three-quarters', { sourceName: 'Qiita ai', score: 7 }, 105],
    ['hn-max', { source: 'hn', score: 255 }, 120],
    ['github-over', { source: 'github', score: 500 }, 120],
    ['hn-negative', { source: 'hn', score: -4 }, 60],
    ['reddit-zero', { source: 'reddit', score: 0 }, 60],
    ['zenn-zero', { sourceName: 'Zenn ai', score: 0 }, 60],
    ['rss-without-reactions', { score: 500 }, 90],
  ]
  for (const [id, article, expected] of cases) {
    const actual = calcAiBaseScore(candidate(id, article), max)
    assert.ok(Math.abs(actual - expected) < 1e-9, `${id}: 期待値 ${expected}、実際 ${actual}`)
  }
})

test('calcAiBaseScore は HN・GitHub・Reddit の score 欠損または最大値なしで反応を 0 にする', () => {
  const { calcAiBaseScore } = mod()
  for (const source of ['hn', 'github', 'reddit']) {
    const max = { maxHnScore: 100, maxGithubScore: 100, maxRedditScore: 100 }
    assert.equal(calcAiBaseScore(candidate('missing-score', { source, score: null }), max), 60, source)
    const noMax = { maxHnScore: 0, maxGithubScore: 0 }
    assert.equal(calcAiBaseScore(candidate('missing-max', { source, score: 30 }), noMax), 60, source)
  }
})

test('calcAiBaseScore は importance が同じなら反応の多い normal が反応のない high を上回る', () => {
  const { calcAiBaseScore } = mod()
  const max = { maxHnScore: 100, maxGithubScore: 100 }
  for (const importance of ['high', 'normal', 'low']) {
    const popularNormal = calcAiBaseScore(candidate('n', { developerValue: 'normal', importance, source: 'hn', score: 100 }), max)
    const quietHigh = calcAiBaseScore(candidate('h', { developerValue: 'high', importance, source: 'hn', score: 0 }), max)
    assert.ok(popularNormal > quietHigh, `${importance}: ${popularNormal} > ${quietHigh}`)
  }
})

test('反応の重みは 60、反応を取得できないときの中立値は 0.5', () => {
  const { AI_REACTION_WEIGHT, AI_REACTION_NEUTRAL, calcAiBaseScore } = mod()
  assert.equal(AI_REACTION_WEIGHT, 60)
  assert.equal(AI_REACTION_NEUTRAL, 0.5)
  const max = { maxHnScore: 0, maxGithubScore: 0, maxZennScore: 40, maxQiitaScore: 80 }
  for (const sourceName of ['Zenn ai', 'Qiita ai']) {
    assert.equal(calcAiBaseScore(candidate('failed', { sourceName, score: null }), max), 90, sourceName)
    const noMax = { maxHnScore: 0, maxGithubScore: 0 }
    assert.equal(calcAiBaseScore(candidate('no-max', { sourceName, score: 4 }), noMax), 90, sourceName)
  }
})

test('calcAiBaseScore はその日の Zenn と HN の 1 位に同じ点を付ける', () => {
  const { calcAiBaseScore } = mod()
  const zennTop = candidate('zenn-top', { sourceName: 'Zenn ai', score: 20 })
  const hnTop = candidate('hn-top', { source: 'hn', score: 800 })
  const max = { maxHnScore: 800, maxGithubScore: 0, maxZennScore: 20 }
  assert.deepEqual([calcAiBaseScore(zennTop, max), calcAiBaseScore(hnTop, max)], [120, 120])
})

test('getAiReactionSource は source を優先し、Zenn と Qiita は掲載元名の先頭で判定する', () => {
  const { getAiReactionSource } = mod()
  const inputs = [
    { source: 'hn', sourceName: 'Hacker News' },
    { source: 'github', sourceName: 'GitHub Trending' },
    { source: 'reddit', sourceName: 'Zenn ai' },
    { source: 'rss', sourceName: 'Zenn ai' },
    { source: 'rss', sourceName: 'Qiita' },
    { source: 'rss', sourceName: 'Fictional Zenn Feed' },
  ]
  assert.deepEqual(inputs.map(getAiReactionSource), ['hn', 'github', 'reddit', 'zenn', 'qiita', null])
})

test('collectAiScoreLimits は情報源ごとの最大反応数を集める', () => {
  const { collectAiScoreLimits } = mod()
  const inputs = [
    { source: 'hn', sourceName: 'Hacker News', score: 210 },
    { source: 'github', sourceName: 'GitHub Trending', score: 36 },
    { source: 'reddit', sourceName: 'r/fictional-one', score: 12 },
    { source: 'reddit', sourceName: 'r/fictional-two', score: 90 },
    { source: 'hn', sourceName: 'Hacker News', score: 18 },
    { source: 'rss', sourceName: 'Zenn ai', score: 51 },
    { source: 'rss', sourceName: 'Zenn llm', score: null },
    { source: 'rss', sourceName: 'Qiita ai', score: 17 },
    { source: 'rss', sourceName: 'Fictional Feed', score: 1000 },
  ]
  assert.deepEqual(collectAiScoreLimits(inputs), {
    maxHnScore: 210, maxGithubScore: 36, maxRedditScore: 90, maxZennScore: 51, maxQiitaScore: 17,
  })
})

test('collectAiScoreLimits は負数や数値以外しかない情報源も 0 にする', () => {
  const { collectAiScoreLimits } = mod()
  assert.deepEqual(collectAiScoreLimits([
    { source: 'hn', sourceName: 'Hacker News', score: -1 },
    { source: 'rss', sourceName: 'Qiita ai', score: null },
    { source: 'reddit', sourceName: 'r/fictional', score: '300' },
  ]), { maxHnScore: 0, maxGithubScore: 0, maxRedditScore: 0, maxZennScore: 0, maxQiitaScore: 0 })
})

function ranked(prefix, count, overrides, startScore) {
  return Array.from({ length: count }, (_, index) => ({
    article: candidate(`${prefix}-${index}`, overrides),
    displayScore: startScore - index,
  }))
}

test('selectAiFeed は Reddit を独立した枠に入れて上位 3 件を選ぶ', () => {
  const { AI_FEED_SOURCE_LIMITS, getAiSourceBucket, selectAiFeed } = mod()
  const reddit = { source: 'reddit', sourceName: 'r/fictional' }
  const items = [
    ...ranked('reddit', 5, reddit, 200),
    ...ranked('other', 6, { source: 'rss', sourceName: 'Fictional Feed' }, 100),
  ]
  assert.deepEqual(ids(selectAiFeed(items)), [
    'reddit-0', 'reddit-1', 'reddit-2', 'other-0', 'other-1', 'other-2', 'other-3', 'other-4', 'other-5',
  ])
  assert.equal(getAiSourceBucket(reddit), 'reddit')
  assert.equal(AI_FEED_SOURCE_LIMITS.reddit, 3)
})

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
