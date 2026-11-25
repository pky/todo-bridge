const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
const axios = require('axios')

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const { deduplicateArticles } = require('../lib/news/collectArticles')
const { calcAiBaseScore } = require('../lib/news/aiSelection')
const { getOwnArticleReaction } = require('../lib/news/aiStories')
const { fetchHNArticles } = require('../lib/news/fetchers/hnFetcher')
const { fetchRedditArticles } = require('../lib/news/fetchers/redditFetcher')

function article(overrides = {}) {
  return {
    title: '架空の新製品', url: 'https://example.test/release', description: '', thumbnailUrl: null,
    source: 'rss', sourceName: '架空通信', score: null, publishedAt: new Date('2026-11-25T00:00:00Z'), ...overrides,
  }
}

function zennTagCopies() {
  return ['ai', 'llm', 'llmengineering'].map(tag => article({
    sourceName: `Zenn ${tag}`, score: 100, url: 'https://example.test/zenn-article',
  }))
}

test('同じ正規化URLの先頭記事を残し、後続の情報源の有効な反応を既存の反応に足す', () => {
  const previous = { source: 'zenn', sourceName: 'Zenn 架空欄', count: 7, url: 'https://example.test/zenn' }
  const first = article({ extraReactions: [previous] })
  const hn = article({
    title: '架空の製品を議論', url: `${first.url}/?utm_source=hn`, source: 'hn', sourceName: '架空HN',
    score: 52, discussionUrl: 'https://example.test/hn-discussion',
  })
  const reddit = article({ url: `${first.url}?utm_medium=fiction`, source: 'reddit', sourceName: '架空掲示板', score: 0 })
  const unrelated = article({ url: 'https://example.test/unrelated' })
  const result = deduplicateArticles([
    first, hn, article({ source: 'github', score: -1 }), article({ source: 'hn', score: Infinity }),
    article({ source: 'rss', score: 40 }), reddit, unrelated,
  ])

  assert.deepEqual(result.map(({ title, url, source }) => ({ title, url, source })), [first, unrelated].map(
    ({ title, url, source }) => ({ title, url, source }),
  ))
  assert.deepEqual(result[0].extraReactions, [
    previous,
    { source: 'hn', sourceName: hn.sourceName, count: 52, url: hn.discussionUrl },
    { source: 'reddit', sourceName: reddit.sourceName, count: 0, url: reddit.url },
  ])
  assert.ok(!Object.hasOwn(result[1], 'extraReactions'))
})

test('同じZenn記事が3つのタグフィードから届いても反応は1件だけ残す', () => {
  const copies = zennTagCopies()
  const result = deduplicateArticles(copies)
  assert.equal(result.length, 1)
  const [merged] = result
  const reactions = [getOwnArticleReaction(merged), ...merged.extraReactions ?? []]
  assert.deepEqual(reactions.map(({ source, url, count }) => ({ source, url, count })), [
    { source: 'zenn', url: copies[0].url, count: 100 },
  ])
})

test('基礎点はタグフィードをまとめた記事も重複が保存済みの記事も1件分の反応で計算する', () => {
  const copies = zennTagCopies()
  const [merged] = deduplicateArticles(copies)
  const [single] = deduplicateArticles(copies.slice(0, 1))
  const storedWithDuplicate = { ...single, extraReactions: [getOwnArticleReaction(copies[1])] }
  const limits = { maxHnScore: 0, maxGithubScore: 0, maxZennScore: 100 }
  const expected = calcAiBaseScore(single, limits)

  assert.deepEqual({
    merged: calcAiBaseScore(merged, limits),
    storedWithDuplicate: calcAiBaseScore(storedWithDuplicate, limits),
  }, { merged: expected, storedWithDuplicate: expected })
})

test('HNはリンク先を保ち、投稿IDを使った議論URLを返す', async t => {
  const id = 700000001
  const url = 'https://example.test/hn-link'
  t.mock.method(axios, 'get', async requestUrl => ({
    data: requestUrl.endsWith('/topstories.json') ? [id] : { id, url, title: '架空の発表', type: 'story', score: 25 },
  }))
  const articles = await fetchHNArticles()
  assert.deepEqual(articles.map(item => [item.url, item.discussionUrl]), [[url, `https://news.ycombinator.com/item?id=${id}`]])
})

test('Redditはリンク投稿に議論URLを付け、本文だけの投稿は記事URLにpermalinkを使う', async () => {
  const link = 'https://example.test/reddit-link'
  const linkPermalink = '/r/fictional-ai/comments/fictional-link/'
  const textPermalink = '/r/fictional-ai/comments/fictional-text/'
  const children = [
    { data: { title: '架空のリンク投稿', url: link, permalink: linkPermalink, is_self: false, created_utc: 1700000000 } },
    { data: { title: '架空の本文投稿', selftext: '架空の本文', permalink: textPermalink, is_self: true, created_utc: 1700000000 } },
  ]
  let first = true
  const getJson = async () => {
    const posts = first ? children : []
    first = false
    return { data: { children: posts } }
  }
  const articles = await fetchRedditArticles(10, undefined, { getJson })

  assert.deepEqual(articles.map(item => item.url), [link, `https://www.reddit.com${textPermalink}`])
  assert.equal(articles[0].discussionUrl, `https://www.reddit.com${linkPermalink}`)
  assert.ok(!Object.hasOwn(articles[1], 'discussionUrl'))
})
