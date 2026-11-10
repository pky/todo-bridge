const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const NOW = Date.now()
const article = (id, extra = {}) => ({ id, title: id === 'learned' ? 'fabletoken' : `架空記事${id}`, url: `https://example.invalid/${id}`, content: '架空の本文', description: '架空説明', source: 'rss', sourceName: '架空通信', tags: ['fable'], triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', developerValue: 'normal', importance: 'normal', ...extra })
const saved = id => article(id, { summaryVersion: 'ai-v2', summaryStatus: 'generated', summarySource: 'content', summarizedAt: NOW, summaryJa: '架空概要' })
const { excludeActedArticles } = require('../lib/news/v2/curatorSelection')

async function generate(articles, { events = [] } = {}) {
  // 先に存在を検証し、未実装時にfake側の障害へすり替えない。
  const fitModule = require('../lib/news/v2/curatorPersonalFit')
  const calls = { judge: 0, batches: 0, summary: 0, budget: [], requests: [] }
  const snapshot = rows => ({ empty: rows.length === 0, docs: rows.map(row => ({ id: row.id ?? 'fable-event', data: () => row })) })
  const ref = path => ({ path, get: async () => ({ exists: false }), set: async () => {}, update: async () => {} })
  function collection(path, filters = []) {
    return { where: (...filter) => collection(path, [...filters, filter]), limit: () => collection(path, filters), doc: id => ref(`${path}/${id}`), get: async () => {
      if (path.endsWith('/newsActionEvents')) return snapshot(events)
      if (path === 'topics/ai/articles') return snapshot(filters.some(([field]) => field === 'date') ? articles : [])
      return snapshot([])
    } }
  }
  const db = { collection, doc: ref, batch: () => ({ update() {}, set() {}, delete() {}, commit: async () => {} }) }
  const client = { create: async request => {
    calls.batches++
    calls.requests.push(request)
    const ids = [...request.messages[0].content.matchAll(/<article id="([^"]+)"/g)].map(match => match[1])
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ articles: ids.map(id => ({ id, personalFit: id === 'preferred' ? 'high' : id === 'learned' ? 'low' : 'normal' })) }) }], usage: { input_tokens: 1, output_tokens: 1 } }
  } }
  const replacements = [
    ['firebase-admin', { firestore: Object.assign(() => db, { Timestamp: admin.firestore.Timestamp, FieldValue: admin.firestore.FieldValue }) }],
    ['../lib/news/claudeClient', { ...require('../lib/news/claudeClient'), createClaudeMessagesClient: () => client }],
    ['../lib/news/claudeDailyBudget', { createClaudeDailyRequestReservation: (_db, stage, max) => { calls.budget.push([stage, max]); return async () => true } }],
    ['../lib/news/v2/curatorPersonalFit', { ...fitModule, getAiFitConfig: () => ({ model: 'fiction-fit', effort: 'low', dailyMaxRequests: 9 }), judgeCuratorPersonalFit: async (...args) => { calls.judge++; return fitModule.judgeCuratorPersonalFit(...args) } }],
    ['../lib/news/aiClaudeSummary', { getAiSummaryConfig: () => ({ model: 'fiction-summary', effort: 'low', dailyMaxRequests: 10 }), summarizeAiArticles: async inputs => {
      calls.summary++
      return { requestCount: 1, pendingIds: [], results: new Map(inputs.map(input => [input.id, { id: input.id, include: true, titleJa: '架空題名', summaryJa: '架空要約' }])) }
    } }],
  ]
  const target = require.resolve('../lib/news/generatePersonalizedFeed')
  const original = require.cache[target]
  const originals = replacements.map(([name]) => [require.resolve(name), require.cache[require.resolve(name)]])
  try {
    for (const [name, exports] of replacements) { const key = require.resolve(name); require.cache[key] = { id: key, filename: key, loaded: true, exports } }
    delete require.cache[target]
    const result = await require(target).runGeneratePersonalizedFeed({ curatorUid: 'fiction-curator', learningCutoffAt: new Date(NOW) })
    return { result, calls }
  } finally {
    require.cache[target] = original
    for (const [key, value] of originals) { if (value) require.cache[key] = value; else delete require.cache[key] }
  }
}

test('readLaterのURL一致は前日の別IDでも除外する', () => {
  const rows = [article('fiction-today')]
  const events = [{ action: 'readLater', articleId: 'fiction-yesterday', url: rows[0].url }]
  assert.deepEqual(excludeActedArticles(rows, events), [])
})

test('URLのないdismissでも記事ID一致なら除外する', () => {
  const rows = [article('fiction-dismissed')]
  assert.deepEqual(excludeActedArticles(rows, [{ action: 'dismiss', articleId: rows[0].id }]), [])
})

test('openやその他の操作はURLとIDが一致しても残す', () => {
  const rows = [article('fiction-opened')]
  const events = ['open', 'fiction-other'].map(action => ({ action, articleId: rows[0].id, url: rows[0].url }))
  assert.deepEqual(excludeActedArticles(rows, events), rows)
})

test('URLがなく記事IDも異なるイベントではURLのない記事も残す', () => {
  const rows = [article('fiction-with-url'), article('fiction-without-url', { url: undefined })]
  const events = [{ action: 'readLater', articleId: 'fiction-unrelated' }, { action: 'dismiss', articleId: 'fiction-other' }]
  assert.deepEqual(excludeActedArticles(rows, events), rows)
})

test('イベントと記事の空URLを一致として扱わない', () => {
  const rows = [article('fiction-empty-url', { url: '' })]
  const events = ['readLater', 'dismiss'].map(action => ({ action, articleId: 'fiction-unrelated', url: '' }))
  assert.deepEqual(excludeActedArticles(rows, events), rows)
})

test('残す記事の順序を保ち記事とイベントの両入力を変更しない', () => {
  const rows = [article('fiction-first'), article('fiction-removed'), article('fiction-last')]
  const events = [{ action: 'dismiss', articleId: rows[1].id }, { action: 'open', articleId: rows[0].id }]
  const originalRows = structuredClone(rows)
  const originalEvents = structuredClone(events)
  const result = excludeActedArticles(rows, events)
  assert.deepEqual(result.map(row => row.id), ['fiction-first', 'fiction-last'])
  assert.deepEqual(rows, originalRows)
  assert.deepEqual(events, originalEvents)
})

function actedFixture(action) {
  const acted = saved('fiction-today-acted')
  const kept = saved('fiction-kept')
  const events = [{ topic: 'ai', action, articleId: 'fiction-yesterday-acted', url: acted.url, title: '架空の過去記事', receivedAt: new Date(NOW - 1000) }]
  return { acted, kept, events }
}

for (const action of ['readLater', 'dismiss']) {
  test(`${action}済みの記事は翌日の別IDでも公開結果から除外する`, async () => {
    const { acted, kept, events } = actedFixture(action)
    const { result } = await generate([acted, kept], { events })
    assert.equal(result.ok, true)
    assert.deepEqual(result.curatorArticles.map(row => row.id), [kept.id])
  })

  test(`${action}済みの記事IDをどの好み判定リクエストにも送らない`, async () => {
    const { acted, kept, events } = actedFixture(action)
    const { result, calls } = await generate([acted, kept], { events })
    assert.equal(result.ok, true)
    assert.ok(calls.requests.length > 0, '好み判定を実際に呼び不送信の空振りを防ぐ')
    const contents = calls.requests.flatMap(request => request.messages.map(message => JSON.stringify(message.content)))
    assert.ok(contents.some(content => content.includes(kept.id)), '残す記事は好み判定に送る')
    for (const content of contents) {
      assert.ok(!content.includes(acted.id), '操作済み記事IDを全リクエストから除外する')
    }
  })
}

test('openだけの記事は公開結果にも好み判定にも残す', async () => {
  const { acted, kept, events } = actedFixture('open')
  events[0].articleId = acted.id
  const { result, calls } = await generate([acted, kept], { events })
  assert.equal(result.ok, true)
  assert.deepEqual(new Set(result.curatorArticles.map(row => row.id)), new Set([acted.id, kept.id]))
  assert.ok(calls.requests.some(request => request.messages.some(message => JSON.stringify(message.content).includes(acted.id))))
})
