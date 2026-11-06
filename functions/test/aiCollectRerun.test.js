const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
const { AI_TRIAGE_VERSION } = require('../lib/news/aiSelection')

const DAY_MS = 24 * 60 * 60 * 1000
const jstDate = offset => new Date(Date.now() + 9 * 60 * 60 * 1000 - offset * DAY_MS).toISOString().slice(0, 10)

function raw(id, overrides = {}) {
  return {
    title: `架空の記事 ${id}`, url: `https://example.com/${id}`, description: `架空の説明 ${id}`,
    thumbnailUrl: `https://example.com/images/${id}.png`, source: 'rss', sourceName: '架空のAIフィード',
    publisherDomain: 'example.com', generalSource: false, score: 12, topic: 'ai',
    publishedAt: new Date('2026-10-28T00:00:00Z'),
    ...overrides,
  }
}

function stored(id, article, overrides = {}) {
  return { id, data: { ...article, date: jstDate(0), triageStatus: 'pending', ...overrides } }
}

function done(overrides = {}) {
  return {
    triageStatus: 'done', triageVersion: AI_TRIAGE_VERSION, triageDecision: 'include',
    triagedAt: Date.now() - DAY_MS, relevant: true, category: 'llm_engineering',
    importance: 'normal', developerValue: 'normal', readReason: '架空の読む理由', tags: ['llm'],
    ...overrides,
  }
}

// 通信先と永続化先はメモリー上に置き、保存内容と保存先IDの両方を記録する。
async function collect(raws, decisions = {}, existing = []) {
  const saved = []
  const scraped = []
  const triaged = []
  const events = []
  let nextId = 0
  function collection(name, filters = [], max = Infinity) {
    assert.equal(name, 'topics/ai/articles')
    return {
      where: (...filter) => collection(name, [...filters, filter], max),
      limit: count => collection(name, filters, count),
      doc: id => ({ id: id ?? `generated-${++nextId}` }),
      get: async () => {
        let found = existing
        for (const [field, operator, value] of filters) {
          found = found.filter(({ data }) => {
            if (operator === '==') return data[field] === value
            if (operator === 'in') return value.includes(data[field])
            if (operator === '<') return data[field] < value
            throw new Error('未対応の検索条件')
          })
        }
        found = found.slice(0, max)
        return {
          empty: found.length === 0,
          docs: found.map(({ id, data }) => ({ id, data: () => data, ref: { id } })),
        }
      },
    }
  }
  const db = {
    collection,
    batch: () => ({
      set: (ref, data) => { saved.push({ id: ref.id, data }); events.push(`save:${data.title}`) },
      delete: () => { throw new Error('このテストでは削除対象なし') },
      commit: async () => {},
    }),
  }
  const firestore = Object.assign(() => db, { Timestamp: admin.firestore.Timestamp })
  const replacements = [
    ['firebase-admin', { firestore }],
    ['../lib/news/fetchers/hnFetcher', { fetchHNArticles: async onSuccess => { onSuccess(); return [] } }],
    ['../lib/news/fetchers/githubTrendingFetcher', { fetchGitHubTrending: async onSuccess => { onSuccess(); return [] } }],
    ['../lib/news/fetchers/rssFetcher', { fetchRSSArticles: async (_limit, onSuccess) => { onSuccess(); return raws } }],
    ['../lib/news/scraper', {
      scrapeArticle: async url => {
        scraped.push(url)
        events.push(`scrape:${url}`)
        return { ogImage: null, content: '架空の取得本文' }
      },
    }],
    ['../lib/news/claudeClient', { createClaudeMessagesClient: () => null }],
    ['../lib/news/aiClaudeTriage', {
      getAiTriageConfig: () => ({ model: 'test-model', effort: 'low', dailyMaxRequests: 10 }),
      triageAiArticles: async inputs => {
        triaged.push(...inputs)
        events.push('triage')
        const results = new Map()
        for (const input of inputs) {
          const decision = decisions[input.title]
          if (decision) {
            results.set(input.id, {
              id: input.id, relevant: decision !== 'exclude', decision,
              category: decision === 'exclude' ? 'promotion' : 'llm_engineering',
              importance: 'normal', developerValue: decision === 'exclude' ? 'low' : 'normal',
              readReason: decision === 'exclude' ? '' : '架空の具体的な読む理由', tags: ['llm'],
            })
          }
        }
        return { results, pendingIds: inputs.filter(input => !results.has(input.id)).map(input => input.id), requestCount: 1 }
      },
    }],
  ]
  const target = require.resolve('../lib/news/collectArticles')
  const originals = replacements.map(([name]) => {
    const key = require.resolve(name)
    return [key, require.cache[key]]
  })
  const originalTarget = require.cache[target]
  try {
    for (const [name, exports] of replacements) {
      const key = require.resolve(name)
      require.cache[key] = { id: key, filename: key, loaded: true, exports }
    }
    delete require.cache[target]
    await require(target).runCollectArticles()
  } finally {
    if (originalTarget) require.cache[target] = originalTarget
    else delete require.cache[target]
    for (const [key, original] of originals) {
      if (original) require.cache[key] = original
      else delete require.cache[key]
    }
  }
  return { saved, scraped, triaged, events }
}

function assertRawFields(saved, article) {
  for (const field of ['title', 'url', 'description', 'thumbnailUrl', 'source', 'sourceName', 'publisherDomain', 'generalSource', 'score']) {
    assert.equal(saved[field], article[field], `${field} を保存済みの値から復元する`)
  }
  assert.equal(saved.publishedAt.toMillis(), article.publishedAt.toDate instanceof Function
    ? article.publishedAt.toMillis() : article.publishedAt.getTime())
  assert.equal(saved.date, jstDate(0))
}

test('当日のpending Xと新着Zだけを判定しXは元IDへ保存して判定済みYは保存しない', async () => {
  const x = raw('x')
  const y = raw('y')
  const z = raw('z')
  const result = await collect([x, y, z], { [x.title]: 'include', [z.title]: 'hold' }, [
    stored('saved-x', x), stored('saved-y', y, done()),
  ])
  assert.deepEqual(result.triaged.map(input => input.title).sort(), [x.title, z.title].sort())
  assert.equal(result.triaged.find(input => input.title === x.title).id, 'saved-x')
  assert.equal(result.saved.length, 2)
  const savedX = result.saved.find(item => item.data.url === x.url)
  const savedZ = result.saved.find(item => item.data.url === z.url)
  assert.equal(savedX.id, 'saved-x')
  assert.match(savedZ.id, /^generated-/)
  assert.notEqual(savedZ.id, 'saved-x')
  assert.notEqual(savedZ.id, 'saved-y')
  assert.equal(result.saved.some(item => item.data.url === y.url), false)
  assert.equal(new Set(result.saved.map(item => item.data.url)).size, 2)
  assert.deepEqual(result.scraped.sort(), [x.url, z.url].sort())
  for (const item of result.saved) {
    assert.equal(item.data.triageStatus, 'done')
    assert.equal(item.data.triageVersion, AI_TRIAGE_VERSION)
    assert.equal(item.data.content, '架空の取得本文')
  }
})

for (const publishedAtKind of ['Date', 'Timestamp']) {
  test(`取得結果にない当日pendingも保存済み項目と${publishedAtKind}から復元して元IDへ保存する`, async () => {
    const article = raw('stored-only', { generalSource: true, score: 37 })
    if (publishedAtKind === 'Timestamp') article.publishedAt = admin.firestore.Timestamp.fromDate(article.publishedAt)
    const result = await collect([], { [article.title]: 'include' }, [stored('stored-only-id', article)])
    assert.deepEqual(result.triaged, [{
      id: 'stored-only-id', title: article.title, sourceName: article.sourceName,
      description: article.description, domain: 'example.com',
    }])
    assert.deepEqual(result.scraped, [article.url])
    assert.equal(result.saved.length, 1)
    assert.equal(result.saved[0].id, 'stored-only-id')
    assertRawFields(result.saved[0].data, article)
    assert.equal(result.saved[0].data.triageStatus, 'done')
    assert.equal(result.saved[0].data.content, '架空の取得本文')
    assert.ok(result.events.indexOf('triage') < result.events.indexOf(`scrape:${article.url}`))
  })
}

for (const version of ['ai-v1', undefined]) {
  test(`当日のdoneでもtriageVersionが${version === undefined ? '未設定' : '旧版'}なら判定し直す`, async () => {
    const article = raw('old-version')
    const result = await collect([article], { [article.title]: 'exclude' }, [
      stored('old-version-id', article, done({ triageVersion: version })),
    ])
    assert.deepEqual(result.triaged.map(input => input.id), ['old-version-id'])
    assert.deepEqual(result.scraped, [])
    assert.equal(result.saved.length, 1)
    assert.equal(result.saved[0].id, 'old-version-id')
    assert.equal(result.saved[0].data.triageVersion, AI_TRIAGE_VERSION)
    assert.equal(result.saved[0].data.triageDecision, 'exclude')
    assert.equal(result.saved[0].data.triageStatus, 'done')
  })
}

test('当日の判定状態が未設定なら現行版が付いていても判定し直す', async () => {
  const article = raw('missing-status')
  const result = await collect([], { [article.title]: 'include' }, [
    stored('missing-status-id', article, { triageStatus: undefined, triageVersion: AI_TRIAGE_VERSION }),
  ])
  assert.deepEqual(result.triaged.map(input => input.id), ['missing-status-id'])
  assert.equal(result.saved.length, 1)
  assert.equal(result.saved[0].id, 'missing-status-id')
  assert.equal(result.saved[0].data.triageStatus, 'done')
})

test('当日のpendingに再利用できる過去記事があれば判定と本文取得を省いて元IDへ保存する', async () => {
  const article = raw('reused-pending')
  const previous = stored('previous-id', article, {
    ...done(), date: jstDate(1), content: '架空の過去本文',
    titleJa: '架空の保存済みタイトル', summaryJa: '架空の保存済み要約',
    summaryVersion: AI_TRIAGE_VERSION, summaryStatus: 'generated', summarizedAt: Date.now() - DAY_MS,
  })
  const result = await collect([], {}, [stored('pending-id', article), previous])
  assert.deepEqual(result.triaged, [])
  assert.deepEqual(result.scraped, [])
  assert.equal(result.saved.length, 1)
  assert.equal(result.saved[0].id, 'pending-id')
  const saved = result.saved[0].data
  assertRawFields(saved, article)
  for (const field of ['triageStatus', 'triageVersion', 'triageDecision', 'triagedAt', 'content', 'titleJa', 'summaryJa', 'summaryVersion', 'summaryStatus', 'summarizedAt']) {
    assert.equal(saved[field], previous.data[field], `${field} を再利用する`)
  }
})

test('再判定してもpendingなら同じdoc IDにpendingを保存し重複を作らない', async () => {
  const article = raw('still-pending')
  const result = await collect([article], {}, [stored('still-pending-id', article)])
  assert.deepEqual(result.triaged.map(input => input.id), ['still-pending-id'])
  assert.deepEqual(result.scraped, [])
  assert.equal(result.saved.length, 1)
  assert.equal(result.saved[0].id, 'still-pending-id')
  assert.equal(result.saved[0].data.triageStatus, 'pending')
  assert.equal(Boolean(result.saved[0].data.content), false)
  assertRawFields(result.saved[0].data, article)
})

test('当日記事がない初回はincludeとholdだけ本文取得し全新着を元の内容で保存する', async () => {
  const articles = ['included', 'held', 'excluded', 'pending'].map(id => raw(id))
  const result = await collect(articles, {
    [articles[0].title]: 'include', [articles[1].title]: 'hold', [articles[2].title]: 'exclude',
  })
  assert.deepEqual(result.triaged.map(input => input.title), articles.map(article => article.title))
  assert.deepEqual(result.scraped.sort(), articles.slice(0, 2).map(article => article.url).sort())
  assert.equal(result.saved.length, articles.length)
  assert.equal(new Set(result.saved.map(item => item.id)).size, articles.length)
  for (const [index, article] of articles.entries()) {
    const saved = result.saved.find(item => item.data.url === article.url)
    assert.match(saved.id, /^generated-/)
    assertRawFields(saved.data, article)
    assert.equal(saved.data.triageStatus, index === 3 ? 'pending' : 'done')
    assert.equal(saved.data.content, index < 2 ? '架空の取得本文' : undefined)
    if (index < 3) {
      assert.equal(saved.data.triageVersion, AI_TRIAGE_VERSION)
      assert.equal(saved.data.triageDecision, ['include', 'hold', 'exclude'][index])
    }
  }
})
