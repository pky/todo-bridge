const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')
const admin = require('firebase-admin')
if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}
const collect = require('../lib/news/collectArticles')
const { scrapeArticle } = require('../lib/news/scraper')

const raw = (name, source = 'rss') => ({
  title: `Fictional article ${name}`,
  url: `https://example.com/articles/${name}`,
  description: 'Fictional description',
  thumbnailUrl: null,
  source,
  sourceName: '架空通信',
  score: 0,
  generalSource: true,
  publishedAt: new Date('2026-10-28T00:00:00Z'),
})

test('scrapeArticle は通信例外を取得失敗として返す', async t => {
  t.mock.method(axios, 'get', async () => { throw new Error('connection reset') })
  const out = await scrapeArticle('https://example.com/articles/a')
  assert.equal(out.content, '')
  assert.equal(out.fetchFailed, true)
})

test('scrapeArticle は500応答を取得失敗として返す', async t => {
  t.mock.method(axios, 'get', async () => {
    const err = new Error('Request failed with status code 500')
    err.response = { status: 500 }
    throw err
  })
  const out = await scrapeArticle('https://example.com/articles/b')
  assert.equal(out.fetchFailed, true)
})

test('scrapeArticle は中断・タイムアウトを取得失敗として返す', async t => {
  t.mock.method(axios, 'get', async () => {
    const err = new Error('canceled')
    err.code = 'ERR_CANCELED'
    throw err
  })
  const out = await scrapeArticle('https://example.com/articles/c', { signal: AbortSignal.abort() })
  assert.equal(out.fetchFailed, true)
})

test('scrapeArticle は本文が空でも取得に成功していれば取得失敗にしない', async t => {
  t.mock.method(axios, 'get', async () => ({ status: 200, data: '<html><body></body></html>' }))
  const out = await scrapeArticle('https://example.com/articles/d')
  assert.equal(out.content, '')
  assert.equal(out.fetchFailed, false)
})

test('scrapeAiArticles は scrape の例外を取得失敗として残す', async () => {
  const out = await collect.scrapeAiArticles([raw('e')], {
    deadlineAt: Date.now() + 1000,
    scrape: async () => { throw new Error('connection reset') },
  })
  assert.equal(out[0].content, '')
  assert.equal(out[0].fetchFailed, true)
})

test('scrapeAiArticles は scrape が返した取得失敗を引き継ぐ', async () => {
  const out = await collect.scrapeAiArticles([raw('f')], {
    deadlineAt: Date.now() + 1000,
    scrape: async () => ({ content: '', ogImage: null, fetchFailed: true }),
  })
  assert.equal(out[0].fetchFailed, true)
})

test('scrapeAiArticles は締め切り済みで未取得の記事を取得失敗として残す', async () => {
  let calls = 0
  const out = await collect.scrapeAiArticles([raw('g'), raw('h')], {
    deadlineAt: 1000,
    now: () => 1000,
    scrape: async () => { calls++; return { content: '本文', ogImage: null } },
  })
  assert.equal(calls, 0)
  assert.ok(out.every(item => item.content === '' && item.fetchFailed === true))
})

test('scrapeAiArticles は本文が空でも取得成功なら取得失敗にしない', async () => {
  const out = await collect.scrapeAiArticles([raw('i')], {
    deadlineAt: Date.now() + 1000,
    scrape: async () => ({ content: '', ogImage: null, fetchFailed: false }),
  })
  assert.equal(out[0].content, '')
  assert.equal(out[0].fetchFailed, false)
})

test('scrapeAiArticles は本文を取得できた記事を取得失敗にしない', async () => {
  const out = await collect.scrapeAiArticles([raw('j')], {
    deadlineAt: Date.now() + 1000,
    scrape: async () => ({ content: '架空の本文', ogImage: null }),
  })
  assert.equal(out[0].content, '架空の本文')
  assert.equal(out[0].fetchFailed, false)
})
