const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const NOW = Date.now()
const article = (id, extra = {}) => ({ id, title: id === 'learned' ? 'fabletoken' : `架空記事${id}`, url: `https://example.invalid/${id}`, content: '架空の本文', description: '架空説明', source: 'rss', sourceName: '架空通信', tags: ['fable'], triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', developerValue: 'normal', importance: 'normal', ...extra })
const saved = id => article(id, { summaryVersion: 'ai-v2', summaryStatus: 'generated', summarySource: 'content', summarizedAt: NOW, summaryJa: '架空概要' })
const event = { topic: 'ai', articleId: 'saved-history', action: 'readLater', title: 'fabletoken', receivedAt: new Date(NOW) }

async function generate(articles, { events = [event], mode = 'judged', rejectFirst = false } = {}) {
  // 先に存在を検証し、未実装時にfake側の障害へすり替えない。
  const fitModule = require('../lib/news/v2/curatorPersonalFit')
  const calls = { judge: 0, batches: 0, summary: 0, budget: [] }
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
    if (mode === 'throw') throw new Error('架空判定障害')
    const ids = [...request.messages[0].content.matchAll(/<article id="([^"]+)"/g)].map(match => match[1])
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ articles: mode === 'unavailable' ? [] : ids.map(id => ({ id, personalFit: id === 'preferred' ? 'high' : id === 'learned' ? 'low' : 'normal' })) }) }], usage: { input_tokens: 1, output_tokens: 1 } }
  } }
  const replacements = [
    ['firebase-admin', { firestore: Object.assign(() => db, { Timestamp: admin.firestore.Timestamp, FieldValue: admin.firestore.FieldValue }) }],
    ['../lib/news/claudeClient', { ...require('../lib/news/claudeClient'), createClaudeMessagesClient: () => client }],
    ['../lib/news/claudeDailyBudget', { createClaudeDailyRequestReservation: (_db, stage, max) => { calls.budget.push([stage, max]); return async () => true } }],
    ['../lib/news/v2/curatorPersonalFit', { ...fitModule, getAiFitConfig: () => ({ model: 'fiction-fit', effort: 'low', dailyMaxRequests: 9 }), judgeCuratorPersonalFit: async (...args) => { calls.judge++; if (mode === 'exception') throw new Error('架空判定例外'); return fitModule.judgeCuratorPersonalFit(...args) } }],
    ['../lib/news/aiClaudeSummary', { getAiSummaryConfig: () => ({ model: 'fiction-summary', effort: 'low', dailyMaxRequests: 10 }), summarizeAiArticles: async inputs => {
      calls.summary++
      return { requestCount: 1, pendingIds: [], results: new Map(inputs.map(input => [input.id, { id: input.id, include: !(rejectFirst && calls.summary === 1), titleJa: '架空題名', summaryJa: '架空要約' }])) }
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

test('生成は判定結果の順に公開用記事を返しai-fit予算を使う', async () => {
  const { result, calls } = await generate([saved('learned'), saved('preferred')])
  assert.equal(result.ok, true)
  assert.deepEqual(result.curatorArticles.map(row => row.id), ['preferred', 'learned'])
  assert.equal(calls.judge, 1)
  assert.ok(calls.budget.some(([stage, max]) => stage === 'ai-fit' && max === 9))
  assert.equal(calls.batches, 1)
  for (const row of result.curatorArticles) assert.ok(!('personalFit' in row))
})
for (const mode of ['exception', 'unavailable', 'throw']) test(`判定${mode}でも公開可能でキーワード学習の並びを維持する`, async () => {
  const { result, calls } = await generate([saved('preferred'), saved('learned')], { mode })
  assert.equal(result.ok, true)
  assert.deepEqual(result.curatorArticles.map(row => row.id), ['learned', 'preferred'])
  assert.equal(calls.judge, 1)
})
test('履歴なしは判定Claudeを呼ばず公開する', async () => {
  const { result, calls } = await generate([saved('preferred')], { events: [] })
  assert.equal(result.ok, true)
  assert.equal(calls.batches, 0)
})
test('要約を複数ラウンド行っても判定Claudeは候補のバッチ数だけ呼ぶ', async () => {
  const rows = Array.from({ length: 31 }, (_, n) => article(`fable-${n}`))
  const { result, calls } = await generate(rows, { rejectFirst: true })
  assert.equal(result.ok, true)
  assert.ok(calls.summary >= 2, '不採用補充で要約を複数回呼ぶ')
  assert.equal(calls.judge, 1)
  assert.equal(calls.batches, 2)
})
