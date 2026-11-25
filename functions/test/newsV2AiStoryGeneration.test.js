const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })

function article(id, developerValue, summarizedAt) {
  return {
    id, title: `架空の更新 ${id}`, url: `https://example.test/${id}`, source: 'rss', sourceName: '架空通信',
    triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', developerValue, importance: 'normal',
    summaryVersion: 'ai-v2', summaryStatus: 'generated', summarizedAt, summaryJa: '架空の概要',
  }
}

test('話題のグルーピングで通信が失敗しても公開用フィードを生成し、個人フィードを保存する', async t => {
  const now = Date.now()
  const articles = [article('normal', 'normal', now), article('high', 'high', now)]
  const uid = 'fictional-curator'
  const feedPath = `users/${uid}/newsFeed/ai/articles`
  const saved = []
  const stages = []
  const ref = path => ({ path, get: async () => ({ exists: false }) })
  const snapshot = docs => ({ empty: docs.length === 0, docs })
  function collection(path, filters = []) {
    return {
      where: (...filter) => collection(path, [...filters, filter]),
      limit: () => collection(path, filters),
      doc: id => ref(`${path}/${id}`),
      get: async () => {
        if (path === 'users') return snapshot([{ id: uid }])
        if (path === 'topics/ai/articles' && filters.some(([field]) => field === 'date')) {
          return snapshot(articles.map(row => ({ id: row.id, data: () => row })))
        }
        return snapshot([])
      },
    }
  }
  const db = { collection, doc: ref, batch: () => ({
    update() {}, delete() {},
    set: (document, row) => { if (document.path.startsWith(`${feedPath}/`)) saved.push(row) },
    commit: async () => {},
  }) }
  const create = t.mock.fn(async () => { throw new Error('架空の話題判定通信エラー') })
  const log = t.mock.method(console, 'log', () => {})
  const warn = t.mock.method(console, 'warn', () => {})
  const claude = require('../lib/news/claudeClient')
  const replacements = [
    ['firebase-admin', { firestore: Object.assign(() => db, {
      Timestamp: admin.firestore.Timestamp, FieldValue: admin.firestore.FieldValue,
    }) }],
    ['../lib/news/claudeClient', { ...claude, createClaudeMessagesClient: () => ({ create }) }],
    ['../lib/news/claudeDailyBudget', { createClaudeDailyRequestReservation: (_db, stage) => async () => {
      stages.push(stage)
      return true
    } }],
  ]
  const target = require.resolve('../lib/news/generatePersonalizedFeed')
  const savedModules = [target, ...replacements.map(([name]) => require.resolve(name))]
    .map(path => [path, require.cache[path]])
  try {
    for (const [name, exports] of replacements) {
      const path = require.resolve(name)
      require.cache[path] = { id: path, filename: path, loaded: true, exports }
    }
    delete require.cache[target]
    const { runGeneratePersonalizedFeed } = require(target)
    const result = await runGeneratePersonalizedFeed({ curatorUid: uid, learningCutoffAt: new Date(now) })

    assert.equal(result.ok, true)
    assert.deepEqual(result.curatorArticles.map(item => item.id), ['high', 'normal'])
    assert.deepEqual(saved.map(item => item.id), ['high', 'normal'])
    assert.deepEqual(stages, ['ai-story'])
    assert.equal(create.mock.callCount(), 1)
    const logs = [...log.mock.calls, ...warn.mock.calls].map(call => call.arguments.join(' '))
    assert.ok(logs.some(line => line.includes('[generatePersonalizedFeed] storyGrouping status=error groups=0 requests=1')))
  } finally {
    for (const [path, previous] of savedModules) {
      if (previous) require.cache[path] = previous
      else delete require.cache[path]
    }
  }
})

function storyArticles(summarizedAt) {
  const common = {
    triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', importance: 'normal',
    description: '架空のモデル更新で推論時のメモリ使用量が減った。',
    ...(summarizedAt === undefined ? {} : {
      summaryVersion: 'ai-v2', summaryStatus: 'generated', summarizedAt, summaryJa: '架空のモデル更新の概要',
    }),
  }
  const official = {
    ...common, id: 'official', title: '架空のモデル更新のお知らせ',
    url: 'https://example.test/official-release', publisherDomain: 'openai.com',
    source: 'rss', sourceName: '架空の公式ブログ', developerValue: 'normal',
  }
  const hn = {
    ...common, id: 'hn', title: '架空のモデル更新を試した結果',
    url: 'https://example.test/hn-article', discussionUrl: 'https://example.test/hn-discussion',
    source: 'hn', sourceName: 'Hacker News', developerValue: 'high', score: 825,
  }
  return [hn, official]
}

async function generateStoryFeed(t, articles, now, rejectedId) {
  const ref = path => ({ path, get: async () => ({ exists: false }) })
  function collection(path, filters = []) {
    return {
      where: (...filter) => collection(path, [...filters, filter]),
      get: async () => {
        const docs = path === 'topics/ai/articles' && filters.some(([field]) => field === 'date')
          ? articles.map(row => ({ id: row.id, data: () => row }))
          : []
        return { empty: docs.length === 0, docs }
      },
    }
  }
  const db = { collection, doc: ref, batch: () => ({ update() {}, commit: async () => {} }) }
  const summaryRequests = []
  const create = t.mock.fn(async request => {
    const ids = Array.from(request.messages[0].content.matchAll(/<article id="([^"]+)">/g), match => match[1])
    const properties = request.output_config.format.schema.properties
    let response
    if (properties.groups) {
      response = { groups: [{ ids }] }
    } else if (properties.articles) {
      summaryRequests.push(ids)
      response = { articles: ids.map(id => id === rejectedId
        ? { id, include: false, titleJa: '', summaryJa: '' }
        : { id, include: true, titleJa: '架空のモデル更新', summaryJa: '推論時のメモリ使用量が減った。' }) }
    } else {
      throw new Error('想定外のClaudeリクエスト')
    }
    return {
      stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(response) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  })
  t.mock.method(console, 'log', () => {})
  const claude = require('../lib/news/claudeClient')
  const replacements = [
    ['firebase-admin', { firestore: Object.assign(() => db, {
      Timestamp: admin.firestore.Timestamp, FieldValue: admin.firestore.FieldValue,
    }) }],
    ['../lib/news/claudeClient', { ...claude, createClaudeMessagesClient: () => ({ create }) }],
    ['../lib/news/claudeDailyBudget', { createClaudeDailyRequestReservation: () => async () => true }],
  ]
  const target = require.resolve('../lib/news/generatePersonalizedFeed')
  const savedModules = [target, ...replacements.map(([name]) => require.resolve(name))]
    .map(path => [path, require.cache[path]])
  try {
    for (const [name, exports] of replacements) {
      const path = require.resolve(name)
      require.cache[path] = { id: path, filename: path, loaded: true, exports }
    }
    delete require.cache[target]
    const { runGeneratePersonalizedFeed } = require(target)
    const result = await runGeneratePersonalizedFeed({ curatorUid: 'fictional-curator', learningCutoffAt: new Date(now) })
    return { result, summaryRequests }
  } finally {
    for (const [path, previous] of savedModules) {
      if (previous) require.cache[path] = previous
      else delete require.cache[path]
    }
  }
}

test('同じ出来事は公式記事だけを掲載し、HNの反応と関連記事を公開用JSONに載せる', async t => {
  const now = Date.now()
  const articles = storyArticles(now)
  const [hn, official] = articles
  const { result } = await generateStoryFeed(t, articles, now)

  assert.equal(result.ok, true)
  assert.deepEqual(result.curatorArticles.map(item => item.id), [official.id])
  const { toAiFeedV2Article } = require('../lib/news/v2/feedContract')
  const published = toAiFeedV2Article(result.curatorArticles[0])
  assert.ok(published)
  assert.equal(published.url, official.url)
  assert.deepEqual(published.reactions, [{ source: 'hn', count: hn.score, url: hn.discussionUrl }])
  assert.deepEqual(published.related, [{ title: hn.title, sourceName: hn.sourceName, url: hn.url }])
})

test('公式記事の要約が不採用なら、同じ組のHN記事を代表に選び直す', async t => {
  const now = Date.now()
  const articles = storyArticles()
  const [hn, official] = articles
  const { result, summaryRequests } = await generateStoryFeed(t, articles, now, official.id)

  assert.deepEqual(summaryRequests, [[official.id], [hn.id]])
  assert.equal(result.ok, true)
  assert.deepEqual(result.curatorArticles.map(item => item.id), [hn.id])
})
