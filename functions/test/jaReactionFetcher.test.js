const test = require('node:test')
const assert = require('node:assert/strict')

function raw(title, sourceName, url, overrides = {}) {
  return {
    source: 'rss', title, sourceName, url, description: '架空の記事の説明',
    thumbnailUrl: null, score: null, publishedAt: new Date('2026-10-28T00:00:00Z'),
    ...overrides,
  }
}

function mockGetJson(responses, calls) {
  return async input => {
    const url = new URL(input)
    const endpoint = `${url.origin}${url.pathname}`
    let group
    if (endpoint === 'https://zenn.dev/api/articles' && url.searchParams.get('order') === 'latest') {
      group = `zenn:${url.searchParams.get('topicname')}`
    } else if (endpoint === 'https://qiita.com/api/v2/items' && url.searchParams.get('per_page') === '20') {
      group = `qiita:${url.searchParams.get('query')}`
    }
    calls.push(group ?? input)
    if (!responses.has(group)) throw new Error('想定外の取得先です')
    const response = responses.get(group)
    if (response instanceof Error) throw response
    return response
  }
}

test('同じ topic・tag は一度だけ取得し、URL のクエリ・フラグメント・末尾スラッシュの違いを吸収する', async () => {
  const { enrichJapaneseReactions } = require('../lib/news/fetchers/jaReactionFetcher')
  const articles = [
    raw('zenn-a', 'Zenn fixture-ai', 'https://zenn.dev/fixture-author/articles/sample-a/?ref=rss#section'),
    raw('qiita-a', 'Qiita fixture-ai', 'https://qiita.com/fixture-author/items/sample-a'),
    raw('other', '架空のフィード', 'https://example.com/other?ref=rss#section', { score: 99 }),
    raw('zenn-b', 'Zenn fixture-ai', 'https://zenn.dev/fixture-author/articles/sample-b'),
    raw('qiita-b', 'Qiita fixture-ai', 'https://qiita.com/fixture-author/items/sample-b/?ref=rss'),
    raw('zenn-c', 'Zenn fixture-ml', 'https://zenn.dev/fixture-author/articles/sample-c'),
    raw('qiita-c', 'Qiita fixture-ml', 'https://qiita.com/fixture-author/items/sample-c'),
  ]
  const responses = new Map([
    ['zenn:fixture-ai', { articles: [
      { path: '/fixture-author/articles/sample-b', liked_count: 0 },
      { path: '/fixture-author/articles/sample-a', liked_count: 21 },
    ] }],
    ['qiita:tag:fixture-ai', [
      { url: 'https://qiita.com/fixture-author/items/sample-b#section', likes_count: 18 },
      { url: 'https://qiita.com/fixture-author/items/sample-a/?from=api', likes_count: 7 },
    ]],
    ['zenn:fixture-ml', { articles: [{ path: '/fixture-author/articles/sample-c', liked_count: 42 }] }],
    ['qiita:tag:fixture-ml', [{ url: 'https://qiita.com/fixture-author/items/sample-c', likes_count: 31 }]],
  ])
  const scores = [21, 7, 99, 0, 18, 42, 31]
  const expected = articles.map((article, index) => ({ ...article, score: scores[index] }))
  const calls = []
  const actual = await enrichJapaneseReactions(articles, { getJson: mockGetJson(responses, calls) })
  assert.deepEqual(actual, expected)
  assert.deepEqual(calls.sort(), [...responses.keys()].sort())
})

test('取得が失敗した topic・tag の点を null のまま返し、成功した tag の点は入れる', async t => {
  const { enrichJapaneseReactions } = require('../lib/news/fetchers/jaReactionFetcher')
  const errorLog = t.mock.method(console, 'error', () => {})
  const failedZenn = raw('zenn-offline', 'Zenn fixture-offline', 'https://zenn.dev/fixture-author/articles/offline')
  const failedQiita = raw('qiita-offline', 'Qiita fixture-offline', 'https://qiita.com/fixture-author/items/offline')
  const reachable = raw('reachable', 'Qiita fixture-ai', 'https://qiita.com/fixture-author/items/reachable')
  const responses = new Map([
    ['zenn:fixture-offline', new Error('架空の Zenn 通信エラー')],
    ['qiita:tag:fixture-offline', new Error('架空の Qiita 通信エラー')],
    ['qiita:tag:fixture-ai', [{ url: reachable.url, likes_count: 14 }]],
  ])
  const expected = [{ ...failedZenn }, { ...failedQiita }, { ...reachable, score: 14 }]
  const calls = []
  const actual = await enrichJapaneseReactions([failedZenn, failedQiita, reachable], { getJson: mockGetJson(responses, calls) })
  assert.deepEqual(actual, expected)
  assert.deepEqual(calls.sort(), [...responses.keys()].sort())
  assert.ok(errorLog.mock.callCount() > 0, '通信エラーを console.error に記録する')
})

test('反応数の取得で通常の Error が発生したら、例外メッセージを記録する', async t => {
  const { enrichJapaneseReactions } = require('../lib/news/fetchers/jaReactionFetcher')
  const errorLog = t.mock.method(console, 'error', () => {})
  const error = new Error('架空の Zenn 接続エラー')
  const article = raw('zenn-offline', 'Zenn fixture-offline', 'https://example.com/zenn-offline')

  const actual = await enrichJapaneseReactions([article], { getJson: async () => { throw error } })

  assert.deepEqual(actual, [article])
  const logs = errorLog.mock.calls.map(({ arguments: args }) => args.map(String).join(' '))
  assert.ok(logs.some(line => line.includes(error.message)), '例外メッセージをログに残す')
})

test('応答の形式が異なる記事と URL が見つからない記事は点を変えずに返す', async t => {
  const { enrichJapaneseReactions } = require('../lib/news/fetchers/jaReactionFetcher')
  t.mock.method(console, 'error', () => {})
  const articles = [
    raw('invalid-zenn', 'Zenn fixture-invalid', 'https://zenn.dev/fixture-author/articles/bad-shape'),
    raw('invalid-qiita', 'Qiita fixture-invalid', 'https://qiita.com/fixture-author/items/bad-shape'),
    raw('missing-zenn', 'Zenn fixture-ai', 'https://zenn.dev/fixture-author/articles/missing'),
    raw('known-zenn', 'Zenn fixture-ai', 'https://zenn.dev/fixture-author/articles/known'),
  ]
  const responses = new Map([
    ['zenn:fixture-invalid', { articles: {} }],
    ['qiita:tag:fixture-invalid', { items: [] }],
    ['zenn:fixture-ai', { articles: [{ path: '/fixture-author/articles/known', liked_count: 19 }] }],
  ])
  const expected = articles.map(article => ({ ...article, score: article.title === 'known-zenn' ? 19 : null }))
  const calls = []
  const actual = await enrichJapaneseReactions(articles, { getJson: mockGetJson(responses, calls) })
  assert.deepEqual(actual, expected)
  assert.deepEqual(calls.sort(), [...responses.keys()].sort())
})
