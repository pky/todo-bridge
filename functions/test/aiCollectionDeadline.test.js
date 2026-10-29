const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')
const Parser = require('rss-parser')
const { fetchHNArticles } = require('../lib/news/fetchers/hnFetcher')
const rss = require('../lib/news/fetchers/rssFetcher')
const admin = require('firebase-admin')
if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}
const collect = require('../lib/news/collectArticles')
const { scrapeArticle } = require('../lib/news/scraper')

const raws = count => Array.from({ length: count }, (_, index) => ({
  title: `LLM article ${index}`,
  url: `https://example.com/articles/${index}`,
  description: 'LLM development',
  thumbnailUrl: null,
  source: 'hn',
  sourceName: 'Hacker News',
  score: index,
  generalSource: true,
  publishedAt: new Date('2026-10-28T00:00:00Z'),
}))

test('AI RSS は5並列で全27フィードを取得し完了順によらず入力順を保つ', async t => {
  let active = 0
  let peak = 0
  let callCount = 0
  const timeouts = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(Parser.prototype, 'parseURL', async function () {
    const index = callCount++
    timeouts.push(this.options.timeout)
    active++
    peak = Math.max(peak, active)
    try {
      await new Promise(resolve => setTimeout(resolve, 6 - index % 5))
      return { items: [{
        title: `LLM article ${index}`,
        link: `https://example.com/articles/${index}`,
        contentSnippet: 'LLM development',
      }] }
    } finally {
      active--
    }
  })

  const articles = await rss.fetchRSSArticles()

  assert.equal(callCount, 27)
  assert.equal(peak, 5)
  assert.ok(timeouts.every(timeout => timeout === 10000))
  assert.equal(articles.length, 27)
  assert.deepEqual(articles.map(article => article.title),
    Array.from({ length: 27 }, (_, index) => `LLM article ${index}`))
  assert.deepEqual(articles.map(article => article.sourceName), rss.AI_RSS_FEEDS.map(feed => feed.name))
})

test('AI RSS は一部のフィードが失敗しても全フィードの取得機会を保つ', async t => {
  let calls = 0
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  t.mock.method(Parser.prototype, 'parseURL', async function () {
    const index = calls++
    if (index % 4 === 0) throw new Error('取得失敗の模擬')
    return { items: [{
      title: `LLM article ${index}`,
      link: `https://example.com/articles/${index}`,
    }] }
  })
  const articles = await rss.fetchRSSArticles()
  assert.equal(calls, 27)
  assert.equal(articles.length, 20)
})

test('HN はトップ100件すべてを取得しトップと詳細の通信を10秒に制限する', async t => {
  const detailIds = []
  const timeouts = []
  t.mock.method(axios, 'get', async (url, options) => {
    timeouts.push(options && options.timeout)
    if (url.endsWith('/topstories.json')) {
      return { data: Array.from({ length: 150 }, (_, index) => index + 1) }
    }
    const id = Number(url.match(/\/item\/(\d+)\.json$/)[1])
    detailIds.push(id)
    return { data: {
      id,
      title: `LLM article ${id}`,
      url: `https://example.com/articles/${id}`,
      type: 'story',
    } }
  })

  const articles = await fetchHNArticles()

  assert.deepEqual(detailIds, Array.from({ length: 100 }, (_, index) => index + 1))
  assert.equal(timeouts.length, 101)
  assert.ok(timeouts.every(timeout => timeout === 10000))
  assert.equal(articles.length, 100)
  assert.ok(articles.every(article => article.generalSource === true))
})

test('HN は先頭の詳細取得が失敗しても100件を試行し正常な99件を残す', async t => {
  const detailIds = []
  t.mock.method(console, 'warn', () => {})
  t.mock.method(console, 'error', () => {})
  t.mock.method(axios, 'get', async url => {
    if (url.endsWith('/topstories.json')) {
      return { data: Array.from({ length: 100 }, (_, index) => index + 1) }
    }
    const id = Number(url.match(/\/item\/(\d+)\.json$/)[1])
    detailIds.push(id)
    if (id === 1) throw new Error('詳細取得タイムアウトの模擬')
    return { data: {
      id,
      title: `LLM article ${id}`,
      url: `https://example.com/articles/${id}`,
      type: 'story',
    } }
  })

  const articles = await fetchHNArticles()

  assert.deepEqual(detailIds, Array.from({ length: 100 }, (_, index) => index + 1))
  assert.equal(articles.length, 99)
  assert.deepEqual(articles.map(article => article.url),
    Array.from({ length: 99 }, (_, index) => `https://example.com/articles/${index + 2}`))
})

test('AI スクレイプ全体の時間予算は60秒', () => {
  assert.equal(collect.AI_SCRAPE_DEADLINE_MS, 60000)
})

test('AI スクレイプは5並列で全件を入力順に返し本文と画像を保持する', async () => {
  const list = raws(12)
  list[0].thumbnailUrl = 'https://example.com/original.png'
  let active = 0
  let peak = 0
  let calls = 0
  const out = await collect.scrapeAiArticles(list, {
    deadlineAt: Date.now() + 1000,
    scrape: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal)
      assert.equal(options.signal.aborted, false)
      active++
      peak = Math.max(peak, active)
      calls++
      try {
        await new Promise(resolve => setTimeout(resolve, 2))
        return { content: `本文:${url}`, ogImage: 'https://example.com/og.png' }
      } finally {
        active--
      }
    },
  })
  assert.equal(calls, 12)
  assert.equal(peak, 5)
  assert.deepEqual(out.map(item => item.raw.url), list.map(raw => raw.url))
  assert.deepEqual(out.map(item => item.content), list.map(raw => `本文:${raw.url}`))
  assert.equal(out[0].raw.thumbnailUrl, 'https://example.com/original.png')
  assert.ok(out.slice(1).every(item => item.raw.thumbnailUrl === 'https://example.com/og.png'))
})

test('AI スクレイプは締め切り済みなら通信せず全件を本文空で残す', async () => {
  const list = raws(8)
  let calls = 0
  const out = await collect.scrapeAiArticles(list, {
    deadlineAt: 1000,
    now: () => 1000,
    scrape: async () => {
      calls++
      throw new Error('呼び出してはいけない')
    },
  })
  assert.equal(calls, 0)
  assert.deepEqual(out.map(item => item.raw), list)
  assert.ok(out.every(item => item.content === ''))
})

test('AI スクレイプは進行中通信を締め切りで中断し未取得分も落とさない', { timeout: 3000 }, async () => {
  const list = raws(12)
  const signals = []
  let active = 0
  let peak = 0
  let aborted = 0
  const start = Date.now()
  // AbortSignal.timeout がイベントループを維持しない実装でも待機できるようにする。
  const keepAlive = setTimeout(() => {}, 2000)
  try {
    const out = await collect.scrapeAiArticles(list, {
      deadlineAt: start + 50,
      scrape: (url, { signal }) => {
        signals.push(signal)
        active++
        peak = Math.max(peak, active)
        if (url === list[0].url) {
          active--
          return Promise.resolve({ content: '取得済み本文', ogImage: null })
        }
        return new Promise((_resolve, reject) => {
          if (!(signal instanceof AbortSignal)) return reject(new Error('中断用 signal がない'))
          const stop = () => {
            active--
            aborted++
            reject(signal.reason)
          }
          if (signal.aborted) stop()
          else signal.addEventListener('abort', stop, { once: true })
        })
      },
    })
    assert.ok(Date.now() - start < 1000)
    assert.ok(peak <= 5)
    assert.ok(aborted > 0)
    assert.ok(signals.length < list.length)
    assert.ok(signals.slice(1).every(signal => signal.aborted))
    assert.deepEqual(out.map(item => item.raw), list)
    assert.equal(out[0].content, '取得済み本文')
    assert.ok(out.slice(1).every(item => item.content === ''))
  } finally {
    clearTimeout(keepAlive)
  }
})

test('scrapeArticle は受け取った signal を HTTP 通信へ渡す', async t => {
  const controller = new AbortController()
  let receivedSignal
  t.mock.method(axios, 'get', async (_url, options) => {
    receivedSignal = options.signal
    return { data: '<html><body>短い本文</body></html>' }
  })
  await scrapeArticle('https://example.com/articles/tool', { signal: controller.signal })
  assert.equal(receivedSignal, controller.signal)
})
