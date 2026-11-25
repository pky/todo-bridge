const test = require('node:test')
const assert = require('node:assert/strict')
const { calcAiBaseScore, collectAiScoreLimits } = require('../lib/news/aiSelection')

function article(overrides = {}) {
  return { source: 'rss', sourceName: '架空通信', url: 'https://example.test/release', ...overrides }
}

function reaction(source, count, url = `https://example.test/discussion/${source}`) {
  return { source, sourceName: `架空の${source}`, count, url }
}

function assertScore(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `点数 ${actual} が期待値 ${expected} と一致する`)
}

test('記事自身の反応は議論URLを使い、正しい追加反応をその後ろに保つ', () => {
  const { getArticleReactions } = require('../lib/news/aiStories')
  const extra = reaction('qiita', 13)
  const zero = reaction('zenn', 0)
  const discussionUrl = 'https://example.test/discussion/hn'
  const item = article({
    source: 'hn', sourceName: '架空HN', score: 0, discussionUrl,
    extraReactions: [extra, reaction('unknown', 3), reaction('github', -1), reaction('reddit', Infinity),
      reaction('hn', 10, null), zero],
  })
  assert.deepEqual(getArticleReactions(item), [
    { source: 'hn', sourceName: item.sourceName, count: 0, url: discussionUrl }, extra, zero,
  ])
})

test('議論URLがなければ記事URLを使い、反応数が不正な記事や通常のRSSには自身の反応を作らない', () => {
  const { getArticleReactions } = require('../lib/news/aiStories')
  const item = article({ source: 'reddit', score: 22 })
  assert.deepEqual(getArticleReactions(item), [
    { source: 'reddit', sourceName: item.sourceName, count: 22, url: item.url },
  ])
  for (const score of [-1, NaN, Infinity, null, '22']) {
    assert.deepEqual(getArticleReactions({ ...item, score }), [], String(score))
  }
  const extra = reaction('hn', 8)
  assert.deepEqual(getArticleReactions(article({ score: 22, extraReactions: [extra] })), [extra])
})

test('情報源ごとの最大値で対数正規化し、反応単位で1を上限として合計する', () => {
  const { calcReactionStrengthSum } = require('../lib/news/aiStories')
  const strengths = [reaction('hn', 9), reaction('github', 399), reaction('reddit', 12), reaction('qiita', 80)]
  const limits = { maxHnScore: 99, maxGithubScore: 99, maxRedditScore: 0, maxQiitaScore: -1 }
  assertScore(calcReactionStrengthSum(strengths, limits), 1.5)
})

test('正規化できる反応がなければnullを返し、正規化できる0件の反応は0を返す', () => {
  const { calcReactionStrengthSum } = require('../lib/news/aiStories')
  const limits = { maxHnScore: 99, maxGithubScore: 0 }
  assert.equal(calcReactionStrengthSum([], limits), null)
  assert.equal(calcReactionStrengthSum([reaction('github', 9), reaction('zenn', 30)], limits), null)
  assert.equal(calcReactionStrengthSum([reaction('hn', 0)], limits), 0)
})

test('話題の点数は代表の有用性と重要度に反応の合計を足し、RSSごとに中立値を加えない', () => {
  const { calcAiStoryScore } = require('../lib/news/aiStories')
  const representative = article({ developerValue: 'normal', importance: 'high', extraReactions: [reaction('hn', 9)] })
  const members = [article({ source: 'github', score: 99, developerValue: 'high', importance: 'high' }), article()]
  assertScore(calcAiStoryScore(representative, members, { maxHnScore: 99, maxGithubScore: 99 }), 60 + 20 + 60 * 1.5)
})

test('全員の反応がなければ中立値0.5を一度だけ使い、正規化できる0件は中立値に置き換えない', () => {
  const { calcAiStoryScore } = require('../lib/news/aiStories')
  const representative = article({ developerValue: 'high', importance: 'low' })
  const limits = { maxHnScore: 99, maxGithubScore: 0 }
  assert.equal(calcAiStoryScore(representative, [article(), article()], limits), 100 - 10 + 60 * 0.5)
  assert.equal(calcAiStoryScore(representative, [article({ source: 'hn', score: 0 })], limits), 100 - 10)
})

test('情報源ごとの最大値に記事自身と有効な追加反応の両方を含める', () => {
  const limits = collectAiScoreLimits([
    article({ source: 'hn', score: 9, extraReactions: [reaction('github', 99), reaction('hn', 49), reaction('zenn', Infinity)] }),
    article({ sourceName: 'Zenn 架空欄', score: 14, extraReactions: [reaction('qiita', 120), reaction('github', 2)] }),
    article({ source: 'reddit', score: 30 }),
  ])
  assert.deepEqual(limits, { maxHnScore: 49, maxGithubScore: 99, maxRedditScore: 30, maxZennScore: 14, maxQiitaScore: 120 })
})

test('基礎点は追加反応があれば自身の反応との合計を使い、合計を1で打ち切らない', () => {
  const item = article({ source: 'hn', score: 9, developerValue: 'normal', extraReactions: [reaction('github', 99)] })
  assertScore(calcAiBaseScore(item, { maxHnScore: 99, maxGithubScore: 99 }), 60 + 60 * 1.5)
})

test('公式判定はwwwとサブドメインを許し、ドメイン名の境界を確認する', () => {
  const { isOfficialAiSource } = require('../lib/news/aiStories')
  for (const host of ['openai.com', 'www.openai.com', 'releases.openai.com']) {
    assert.equal(isOfficialAiSource(article({ url: `https://${host}/fictional-release` })), true, host)
  }
  for (const url of ['https://notopenai.com/fictional-release', 'https://openai.com.example.test/fictional-release', '読めないURL']) {
    assert.equal(isOfficialAiSource(article({ url })), false, url)
  }
})

test('公式判定はリンクのホストよりpublisherDomainを優先する', () => {
  const { isOfficialAiSource } = require('../lib/news/aiStories')
  assert.equal(isOfficialAiSource(article({ publisherDomain: 'releases.openai.com' })), true)
  assert.equal(isOfficialAiSource(article({ publisherDomain: 'example.test', url: 'https://openai.com/fictional-release' })), false)
})

test('代表は開発者への有用性や反応より公式を優先する', () => {
  const { pickStoryRepresentative } = require('../lib/news/aiStories')
  const official = article({ id: 'official', publisherDomain: 'openai.com', developerValue: 'normal' })
  const popular = article({ id: 'popular', source: 'hn', score: 99, developerValue: 'high' })
  assert.equal(pickStoryRepresentative([popular, official])?.id, 'official')
})

test('公式判定が同じなら開発者への有用性はhigh、normal、それ以外の順になる', () => {
  const { pickStoryRepresentative } = require('../lib/news/aiStories')
  const popular = article({ id: 'popular', source: 'hn', score: 99 })
  const normal = article({ id: 'normal', developerValue: 'normal' })
  const high = article({ id: 'high', developerValue: 'high' })
  assert.equal(pickStoryRepresentative([popular, normal])?.id, 'normal')
  assert.equal(pickStoryRepresentative([normal, popular, high])?.id, 'high')
})

test('有用性まで同じなら記事自身と追加反応の強さを合計して代表を選ぶ', () => {
  const { pickStoryRepresentative } = require('../lib/news/aiStories')
  const one = article({ id: 'one', source: 'hn', score: 99, developerValue: 'normal' })
  const two = article({ id: 'two', source: 'hn', score: 9, developerValue: 'normal', extraReactions: [reaction('github', 99)] })
  assert.equal(pickStoryRepresentative([one, two])?.id, 'two')
})

test('反応の強さまで同じなら入力順の先の記事を代表にする', () => {
  const { pickStoryRepresentative } = require('../lib/news/aiStories')
  const items = [article({ id: 'z-first' }), article({ id: 'a-second' })]
  assert.equal(pickStoryRepresentative(items)?.id, 'z-first')
  assert.equal(pickStoryRepresentative([...items].reverse())?.id, 'a-second')
})
