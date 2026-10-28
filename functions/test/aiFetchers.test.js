const test = require('node:test')
const assert = require('node:assert/strict')

const { selectHnStories } = require('../lib/news/fetchers/hnFetcher')
const { parseGitHubTrending } = require('../lib/news/fetchers/githubTrendingFetcher')
const { AI_RSS_FEEDS } = require('../lib/news/fetchers/rssFetcher')

const story = (id, overrides = {}) => ({
  id,
  title: `Rust release ${id}`,
  url: `https://example.com/articles/${id}`,
  type: 'story',
  score: 42,
  time: 1700000000,
  ...overrides,
})

test('selectHnStories はキーワードに関係なく story を取る', () => {
  const items = [
    story(1, { title: 'Show HN: A new email client', text: 'メールの開発事例' }),
    story(2, { title: 'Rust 2.0 released' }),
    story(3, { url: undefined }),
    story(4, { type: 'comment' }),
    story(5, { title: undefined }),
  ]

  const articles = selectHnStories(items, 100)

  assert.deepEqual(articles.map(article => article.title), [
    'Show HN: A new email client',
    'Rust 2.0 released',
  ])
  assert.deepEqual(articles.map(article => article.url), [items[0].url, items[1].url])
  assert.ok(articles.every(article => article.generalSource === true))
  assert.ok(articles.every(article => article.source === 'hn'))
  assert.equal(articles[0].description, 'メールの開発事例')
  assert.equal(articles[1].description, '')
  assert.equal(articles[0].score, 42)
  assert.equal(articles[0].publishedAt.getTime(), 1700000000000)
})

test('selectHnStories は limit 件で止める', () => {
  const items = [story(1, { type: 'comment' }), story(2), story(3), story(4)]

  assert.deepEqual(selectHnStories(items, 2).map(article => article.url), [
    items[1].url,
    items[2].url,
  ])
  assert.deepEqual(selectHnStories(items, 0), [])
})

test('parseGitHubTrending は全リポジトリを取る', () => {
  const repositories = [
    { path: 'sample/llm-tool', description: 'LLM assistant' },
    { path: 'sample/rust-parser', description: 'A fast parser written in Rust' },
    { path: 'sample/claude-tool', description: 'Claude development tool' },
  ]
  const html = repositories.map(repo => `
    <article class="Box-row">
      <h2><a href="/${repo.path}">${repo.path}</a></h2>
      <p>${repo.description}</p>
      <span class="float-sm-right">1,234 stars today</span>
    </article>
  `).join('\n')

  const articles = parseGitHubTrending(html)

  assert.equal(articles.length, 3)
  assert.deepEqual(articles.map(article => article.title), repositories.map(repo => repo.path))
  assert.deepEqual(articles.map(article => article.description), repositories.map(repo => repo.description))
  assert.ok(articles.every(article => article.score === 1234))
  assert.ok(articles.every(article => article.generalSource === true))
  assert.ok(articles.every(article => article.source === 'github'))
})

test('AI_RSS_FEEDS の generalSource は4本だけ true', () => {
  assert.ok(Array.isArray(AI_RSS_FEEDS))
  assert.ok(AI_RSS_FEEDS.length > 4)
  const generalFeeds = AI_RSS_FEEDS.filter(feed => feed.generalSource === true)

  assert.equal(generalFeeds.length, 4)
  assert.deepEqual(generalFeeds.map(feed => feed.name).sort(), [
    'DevelopersIO',
    'Menthas',
    'MIT Tech Review',
    'はてなブックマーク IT',
  ].sort())
  assert.equal(AI_RSS_FEEDS.find(feed => feed.name === 'DevelopersIO').limit, 8)
})

async function withStubbedFeeds(linkFor, run) {
  const parserKey = require.resolve('rss-parser')
  const fetcherKey = require.resolve('../lib/news/fetchers/rssFetcher')
  const originalParser = require.cache[parserKey]
  const originalFetcher = require.cache[fetcherKey]
  class StubParser {
    async parseURL(url) {
      const feed = AI_RSS_FEEDS.find(candidate => candidate.url === url)
      return { items: [{
        title: `架空のモデル評価手順 ${feed.name}`, link: linkFor(feed),
        contentSnippet: '開発時の比較方法を紹介する技術記事',
      }] }
    }
  }
  try {
    require.cache[parserKey] = { id: parserKey, filename: parserKey, loaded: true, exports: StubParser }
    delete require.cache[fetcherKey]
    return await run(await require(fetcherKey).fetchRSSArticles())
  } finally {
    if (originalParser) require.cache[parserKey] = originalParser
    else delete require.cache[parserKey]
    if (originalFetcher) require.cache[fetcherKey] = originalFetcher
    else delete require.cache[fetcherKey]
  }
}

test('集約RSSの記事は sourceName にフィード名を保ち、publisherDomain にリンク先ホストを設定する', async () => {
  const aggregators = AI_RSS_FEEDS.filter(feed => feed.aggregator === true).map(feed => feed.name).sort()
  assert.deepEqual(aggregators, ['Menthas', 'はてなブックマーク IT'].sort())
  await withStubbedFeeds(() => 'https://www.publisher.example.com/post/1', articles => {
    for (const name of aggregators) {
      const article = articles.find(item => item.sourceName === name)
      assert.ok(article, `${name} の記事がない`)
      assert.equal(article.publisherDomain, 'publisher.example.com', 'www. を除いたリンク先ホスト')
      assert.equal(article.url, 'https://www.publisher.example.com/post/1')
      assert.equal(article.generalSource, true)
    }
  })
})

test('集約RSSの掲載元が www. なしでもそのままのホストを publisherDomain にする', async () => {
  await withStubbedFeeds(() => 'https://blog.publisher.example.com/entry', articles => {
    const article = articles.find(item => item.sourceName === 'はてなブックマーク IT')
    assert.equal(article.publisherDomain, 'blog.publisher.example.com')
  })
})

test('集約でないRSSは sourceName がフィード名のままで publisherDomain を持たない', async () => {
  await withStubbedFeeds(() => 'https://www.publisher.example.com/post/2', articles => {
    const plain = articles.filter(item => !AI_RSS_FEEDS.find(feed => feed.name === item.sourceName).aggregator)
    assert.equal(plain.length, AI_RSS_FEEDS.length - 2)
    assert.deepEqual(plain.map(item => item.sourceName), AI_RSS_FEEDS.filter(feed => !feed.aggregator).map(feed => feed.name))
    assert.ok(plain.every(item => !('publisherDomain' in item)))
  })
})

test('selectHnStories は publisherDomain にリンク先ホストを設定し www. を除く', () => {
  const articles = selectHnStories([
    story(1, { url: 'https://www.publisher.example.com/a' }),
    story(2, { url: 'https://blog.publisher.example.com/b' }),
  ], 10)
  assert.deepEqual(articles.map(article => article.publisherDomain), ['publisher.example.com', 'blog.publisher.example.com'])
  assert.ok(articles.every(article => article.sourceName === 'Hacker News'))
})

test('selectHnStories は不正なURLの記事に publisherDomain を付けない', () => {
  const articles = selectHnStories([
    story(1, { url: 'https://www.publisher.example.com/valid' }),
    story(2, { url: 'not a valid url' }),
  ], 10)
  assert.equal(articles.length, 2)
  assert.equal(articles[0].publisherDomain, 'publisher.example.com')
  assert.equal('publisherDomain' in articles[1], false)
})
