const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

const DAY_MS = 24 * 60 * 60 * 1000
const jstDate = offsetDays => new Date(Date.now() + 9 * 60 * 60 * 1000 - offsetDays * DAY_MS).toISOString().slice(0, 10)

function raw(id, overrides = {}) {
  return {
    title: id, url: `https://example.com/${id}`, description: `架空の説明 ${id}`,
    thumbnailUrl: null, source: 'rss', sourceName: '架空のAIフィード', topic: 'ai',
    score: null, generalSource: false, publishedAt: new Date('2026-10-28T00:00:00Z'),
    ...overrides,
  }
}

// 現行版で判定済みの過去記事。タイトルは raw と一致させる。
function previousOf(current, overrides = {}) {
  return {
    ...current, date: jstDate(1), triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include',
    category: 'llm_engineering', triagedAt: Date.now() - DAY_MS, relevant: true, importance: 'normal',
    developerValue: 'normal', readReason: '保存済みの読む理由', tags: ['llm'],
    ...overrides,
  }
}

// 収集から保存までを実行するが、通信先と永続化先はすべてメモリー上に置く。
// decisions は記事タイトルから decision（include | hold | exclude）への対応。
async function collect(raws, decisions = {}, existing = []) {
  const saved = []
  const scraped = []
  const triaged = []
  const events = []
  const queries = []
  let nextId = 0
  const today = jstDate(0)
  function collection(name, filters = [], max = Infinity) {
    assert.equal(name, 'topics/ai/articles')
    return {
      where: (...filter) => collection(name, [...filters, filter], max),
      limit: count => collection(name, filters, count),
      doc: id => ({ id: id ?? `generated-${++nextId}` }),
      get: async () => {
        queries.push(filters)
        let found = existing
        for (const [field, operator, value] of filters) {
          found = found.filter(article => {
            if (operator === '==') return article[field] === value
            if (operator === 'in') return value.includes(article[field])
            if (operator === '<') return article[field] < value
            throw new Error('未対応の検索条件')
          })
        }
        found = found.slice(0, max)
        return {
          empty: found.length === 0,
          docs: found.map((article, index) => ({ id: `old-${index}`, data: () => article, ref: { id: `old-${index}` } })),
        }
      },
    }
  }
  const db = {
    collection,
    batch: () => ({
      set: (_ref, data) => { saved.push(data); events.push(`save:${data.title}`) },
      delete: () => { throw new Error('このテストでは削除対象なし') },
      commit: async () => {},
    }),
  }
  const firestore = Object.assign(() => db, { Timestamp: admin.firestore.Timestamp })
  const replacements = [
    ['firebase-admin', { firestore }],
    ['../lib/news/fetchers/hnFetcher', { fetchHNArticles: async () => [] }],
    ['../lib/news/fetchers/githubTrendingFetcher', { fetchGitHubTrending: async () => [] }],
    ['../lib/news/fetchers/rssFetcher', { fetchRSSArticles: async () => raws }],
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
              readReason: decision === 'exclude' ? '' : '具体的な内容を読める', tags: ['llm'],
            })
          }
        }
        return { results, pendingIds: inputs.filter(i => !results.has(i.id)).map(i => i.id), requestCount: 1 }
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
  return { saved, scraped, triaged, events, queries, today }
}

test('収集は全新着を判定し、include と hold だけ本文取得し、excludeとpendingは本文なしで保存する', async () => {
  const result = await collect([
    raw('included'), raw('held'), raw('excluded'), raw('pending-ai'), raw('pending-general', { generalSource: true }),
  ], { included: 'include', held: 'hold', excluded: 'exclude' })
  assert.deepEqual(result.triaged.map(input => input.title).sort(), ['excluded', 'held', 'included', 'pending-ai', 'pending-general'])
  assert.deepEqual(result.scraped.sort(), ['https://example.com/held', 'https://example.com/included'])
  assert.equal(result.saved.length, 5)
  const byTitle = new Map(result.saved.map(article => [article.title, article]))
  for (const title of ['included', 'held']) {
    assert.equal(byTitle.get(title).content, '架空の取得本文', title)
    assert.equal(byTitle.get(title).triageStatus, 'done')
    assert.equal(byTitle.get(title).triageVersion, 'ai-v2')
    assert.equal(byTitle.get(title).relevant, true)
    assert.equal(typeof byTitle.get(title).triagedAt, 'number', title)
  }
  assert.equal(byTitle.get('included').triageDecision, 'include')
  assert.equal(byTitle.get('held').triageDecision, 'hold')
  assert.equal(byTitle.get('excluded').relevant, false)
  assert.equal(byTitle.get('excluded').triageDecision, 'exclude')
  assert.equal(byTitle.get('excluded').triageStatus, 'done')
  for (const title of ['excluded', 'pending-ai', 'pending-general']) {
    assert.equal(Boolean(byTitle.get(title).content), false)
  }
  for (const title of ['pending-ai', 'pending-general']) {
    assert.equal(byTitle.get(title).triageStatus, 'pending')
  }
  assert.equal(byTitle.get('pending-general').generalSource, true)
  assert.ok(result.events.indexOf('triage') < result.events.indexOf('scrape:https://example.com/included'))
})

test('既存記事の読み込みは triageVersion が現行版の記事だけに絞る', async () => {
  const current = raw('query-shape')
  await collect([current], {}, [previousOf(current)]).then(result => {
    assert.ok(result.queries.some(filters => filters.some(([field, operator, value]) =>
      field === 'triageVersion' && operator === '==' && value === 'ai-v2')),
    `triageVersion の絞り込みがない: ${JSON.stringify(result.queries)}`)
  })
})

test('現行版で7日以内の同URL記事はClaudeと本文取得を呼ばず、判定時刻と要約結果を元の値で保存する', async () => {
  const current = raw('reused')
  const triagedAt = Date.now() - 2 * DAY_MS
  const summarizedAt = Date.now() - DAY_MS
  const previous = previousOf(current, {
    relevant: false, triageDecision: 'exclude', category: 'promotion', importance: 'low', developerValue: 'low',
    triagedAt, content: '再利用する本文', titleJa: '再利用するタイトル', summaryJa: '再利用する要約',
    summaryVersion: 'ai-v2', summaryStatus: 'rejected', summarizedAt,
  })
  const result = await collect([current], {}, [previous])
  assert.deepEqual(result.triaged, [])
  assert.deepEqual(result.scraped, [])
  assert.equal(result.saved.length, 1)
  const saved = result.saved[0]
  assert.equal(saved.triageStatus, 'done')
  assert.equal(saved.triageVersion, 'ai-v2')
  assert.equal(saved.triageDecision, 'exclude')
  assert.equal(saved.category, 'promotion')
  assert.equal(saved.relevant, false)
  assert.equal(saved.importance, 'low')
  assert.equal(saved.content, previous.content)
  assert.equal(saved.summaryJa, previous.summaryJa)
  assert.equal(saved.summaryStatus, 'rejected')
  assert.equal(saved.triagedAt, triagedAt)
  assert.equal(saved.summarizedAt, summarizedAt)
  assert.deepEqual(saved.tags, previous.tags)
  assert.equal(saved.date, result.today)
})

test('旧バージョンの判定は再利用せず再判定して現行版で保存する', async () => {
  const current = raw('old-version')
  const result = await collect([current], { 'old-version': 'include' }, [
    previousOf(current, { triageVersion: 'ai-v1' }),
    previousOf(current, { triageVersion: undefined }),
  ])
  assert.deepEqual(result.triaged.map(input => input.title), ['old-version'])
  assert.deepEqual(result.scraped, [current.url])
  assert.equal(result.saved.length, 1)
  assert.equal(result.saved[0].triageVersion, 'ai-v2')
  assert.equal(result.saved[0].triageDecision, 'include')
})

test('判定から7日を超えた記事は再判定し、判定時刻を更新して保存する', async () => {
  const current = raw('expired')
  const result = await collect([current], { expired: 'include' }, [
    previousOf(current, { triagedAt: Date.now() - 8 * DAY_MS }),
  ])
  assert.deepEqual(result.triaged.map(input => input.title), ['expired'])
  assert.equal(result.saved.length, 1)
  assert.ok(result.saved[0].triagedAt > Date.now() - 60000, '再判定した記事の triagedAt は現在時刻になる')
})

test('同じURLでタイトルが変わった記事は再判定する', async () => {
  const current = raw('retitled')
  const result = await collect([current], { retitled: 'exclude' }, [
    previousOf({ ...current, title: 'Previous headline for the same page' }),
  ])
  assert.deepEqual(result.triaged.map(input => input.title), ['retitled'])
  assert.equal(result.saved.length, 1)
  assert.equal(result.saved[0].triageDecision, 'exclude')
})

test('pendingの過去記事は再利用せず再判定し、当日保存済みURLは再処理しない', async () => {
  const pending = raw('retry')
  const alreadySaved = raw('today')
  const result = await collect([pending, alreadySaved], { retry: 'include' }, [
    { ...pending, triageStatus: 'pending', date: jstDate(1) },
    { ...alreadySaved, triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', relevant: true, date: jstDate(0) },
  ])
  assert.deepEqual(result.triaged.map(input => input.title), ['retry'])
  assert.deepEqual(result.scraped, [pending.url])
  assert.deepEqual(result.saved.map(article => article.title), ['retry'])
})

test('追跡パラメータと末尾スラッシュが異なる同一記事も本文取得とClaudeを呼ばず再利用する', async () => {
  const current = raw('tracking-reuse', { url: 'https://example.com/post/?utm_source=new-feed' })
  const previous = previousOf(current, {
    url: 'https://example.com/post?utm_source=previous-feed', importance: 'high',
    content: '過去の本文', titleJa: '過去の日本語タイトル', summaryJa: '過去の日本語要約',
    summaryVersion: 'ai-v2', summaryStatus: 'generated', summarySource: 'content', summarizedAt: Date.now() - DAY_MS,
  })
  const result = await collect([current], {}, [previous])
  assert.deepEqual(result.triaged, [])
  assert.deepEqual(result.scraped, [])
  assert.equal(result.saved.length, 1)
  assert.equal(result.saved[0].url, current.url)
  assert.equal(result.saved[0].triageStatus, 'done')
  assert.equal(result.saved[0].relevant, true)
  assert.equal(result.saved[0].importance, 'high')
  assert.equal(result.saved[0].content, previous.content)
  assert.equal(result.saved[0].summaryJa, previous.summaryJa)
  assert.equal(result.saved[0].summaryStatus, 'generated')
  assert.equal(result.saved[0].triagedAt, previous.triagedAt)
})
