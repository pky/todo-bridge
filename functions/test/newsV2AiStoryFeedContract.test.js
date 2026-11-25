const test = require('node:test')
const assert = require('node:assert/strict')
const { toAiFeedV2Article, validateAiFeedV2 } = require('../lib/news/v2/feedContract')
const { validFeeds } = require('./fixtures/aiFeedV2Contract.json')

function doc(id, overrides = {}) {
  return {
    id, title: `架空の記事 ${id}`, sourceName: '架空通信', source: 'rss',
    summaryJa: '架空の記事の概要', url: `https://example.test/${id}`, ...overrides,
  }
}

function reaction(source, count, url) {
  return { source, sourceName: '架空掲示板', count, url }
}

test('代表とメンバーの反応を順に公開し、同じ情報源とURLの組を重複させない', () => {
  const discussion = 'https://example.test/discussion'
  const otherDiscussion = 'https://example.test/other-discussion'
  const member = doc('member', { source: 'hn', score: 15, discussionUrl: discussion, extraReactions: [reaction('hn', 8.1, otherDiscussion)] })
  const httpMember = doc('http-member', { url: 'http://example.test/insecure', source: 'reddit', score: 3.6 })
  const representative = doc('representative', {
    source: 'hn', score: 15, discussionUrl: discussion,
    extraReactions: [reaction('github', 9.7, discussion)], storyMembers: [member, httpMember],
  })
  const article = toAiFeedV2Article(representative)

  assert.deepEqual(article?.reactions, [
    { source: 'hn', count: 15, url: discussion },
    { source: 'github', count: 10, url: discussion },
    { source: 'hn', count: 8, url: otherDiscussion },
    { source: 'reddit', count: 4 },
  ])
  assert.deepEqual(article.related, [{ title: member.title, sourceName: member.sourceName, url: member.url }])
})

test('反応は先頭10件、関連リンクはHTTPSの記事から先頭5件を公開する', () => {
  const members = Array.from({ length: 12 }, (_, n) => doc(`member-${n}`, { source: 'hn', score: n }))
  const representative = doc('representative', { storyMembers: [doc('http-member', { url: 'http://example.test/insecure' }), ...members] })
  const article = toAiFeedV2Article(representative)

  assert.deepEqual(article?.reactions, members.slice(0, 10).map(item => ({ source: 'hn', count: item.score, url: item.url })))
  assert.deepEqual(article.related, members.slice(0, 5).map(({ title, sourceName, url }) => ({ title, sourceName, url })))
})

test('公開できる反応や関連リンクが0件なら項目を付けない', () => {
  const article = toAiFeedV2Article(doc('solo', {
    extraReactions: [reaction('hn', -1, 'https://example.test/discussion')],
    storyMembers: [doc('http-member', { url: 'http://example.test/insecure' })],
  }))
  assert.ok(article)
  assert.ok(!Object.hasOwn(article, 'reactions'))
  assert.ok(!Object.hasOwn(article, 'related'))
})

function feedWith(fields) {
  const { feed } = validFeeds.find(scenario => scenario.feed.articles.length > 0)
  return { ...feed, articles: [{ ...feed.articles[0], ...fields }], totalCount: 1 }
}

const validReaction = { source: 'hn', count: 0 }
const validLink = { title: '別の架空記事', sourceName: '架空技術誌', url: 'https://example.test/related' }

test('配信契約は反応10件と関連5件を受理し、反応のURLは省略できる', () => {
  const sources = ['hn', 'github', 'reddit', 'zenn', 'qiita']
  const reactions = Array.from({ length: 10 }, (_, n) => ({
    source: sources[n % sources.length], count: n, ...(n ? { url: `https://example.test/discussion/${n}` } : {}),
  }))
  const related = Array.from({ length: 5 }, (_, n) => ({ ...validLink, url: `${validLink.url}/${n}` }))
  const feed = feedWith({ reactions, related })
  assert.deepEqual(validateAiFeedV2(feed), { ok: true, feed })
})

for (const [name, fields] of [
  ['反応が配列でない', { reactions: validReaction }],
  ['反応が空', { reactions: [] }],
  ['反応が11件', { reactions: Array(11).fill(validReaction) }],
  ['情報源が不明', { reactions: [{ ...validReaction, source: 'rss' }] }],
  ['反応数が負', { reactions: [{ ...validReaction, count: -1 }] }],
  ['反応数が小数', { reactions: [{ ...validReaction, count: 1.5 }] }],
  ['反応数が文字列', { reactions: [{ ...validReaction, count: '1' }] }],
  ['反応のURLがHTTP', { reactions: [{ ...validReaction, url: 'http://example.test/discussion' }] }],
  ['関連が配列でない', { related: validLink }],
  ['関連が空', { related: [] }],
  ['関連が6件', { related: Array(6).fill(validLink) }],
  ['関連のタイトルが空白', { related: [{ ...validLink, title: ' ' }] }],
  ['関連の情報源名が空', { related: [{ ...validLink, sourceName: '' }] }],
  ['関連のURLがHTTP', { related: [{ ...validLink, url: 'http://example.test/related' }] }],
]) {
  test(`配信契約は「${name}」に該当する記事を拒否する`, () => {
    assert.deepEqual(validateAiFeedV2(feedWith(fields)), { ok: false, reason: 'invalid-feed' })
  })
}
