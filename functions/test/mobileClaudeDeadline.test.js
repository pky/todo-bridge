const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
const Anthropic = require('@anthropic-ai/sdk')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const classifier = require('../lib/news/mobileClaudeClassifier')
const { classifyMobileArticles } = classifier
const collect = require('../lib/news/collectArticles')

const message = (items, stop = 'end_turn') => ({
  stop_reason: stop,
  content: [{ type: 'text', text: JSON.stringify({ articles: items }) }],
  usage: { input_tokens: 100, output_tokens: 50 },
})
const item = (id, overrides = {}) => ({
  id, category: 'security', importantLevel: 'urgent', actionRequired: true,
  requiredByDate: '2026-11-30', platform: 'ios', titleJa: 'タイトル',
  summary: { overview: '概要', target: 'iOS 27', deadline: '2026-11-30', action: '更新する' },
  ...overrides,
})

const config = { model: 'claude-opus-5-5', effort: 'low', dailyMaxRequests: 20 }
const input = (id) => ({
  id, title: `title-${id}`, sourceName: 'source', publishedDate: '2026-10-01', text: `body-${id}`,
})
const inputs = (n) => Array.from({ length: n }, (_, i) => input(`a${i + 1}`))

const userText = (params) => {
  const content = params.messages.find((m) => m.role === 'user').content
  if (typeof content === 'string') return content
  return content.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n')
}
const idsOf = (params) => [...userText(params).matchAll(/<article id="([^"]+)">/g)].map((m) => m[1])

const stubClient = (handler) => {
  const calls = []
  return {
    calls,
    create: async (params) => {
      calls.push(params)
      return handler(params, calls.length - 1)
    },
  }
}
const echoAll = (params) => message(idsOf(params).map((id) => item(id)))

const APIError = Anthropic.APIError || Anthropic.default.APIError
const apiError = (status) =>
  APIError.generate(status, { error: { type: 'api_error', message: `status ${status}` } }, `status ${status}`, new Headers())

test('Claude クライアントの待ち時間は120秒、再試行は1回', () => {
  assert.equal(classifier.CLAUDE_REQUEST_TIMEOUT_MS, 120000)
  assert.equal(classifier.CLAUDE_MAX_RETRIES, 1)
})

test('MOBILE_CLASSIFICATION_DEADLINE_MS は 240000', () => {
  assert.equal(collect.MOBILE_CLASSIFICATION_DEADLINE_MS, 240000)
})

test('締め切りを過ぎていれば呼び出さずに全件 pending', async () => {
  const client = stubClient(echoAll)
  const list = inputs(5)
  const out = await classifyMobileArticles(list, { client, config, deadlineAt: 1000, now: () => 1000 })
  assert.equal(client.calls.length, 0)
  assert.equal(out.results.size, 0)
  assert.equal(out.pendingIds.length, 5)
  assert.deepEqual([...out.pendingIds].sort(), list.map((i) => i.id).sort())
  assert.equal(out.requestCount, 0)
})

test('最初の送信後に締め切りを過ぎたら残りは pending', async () => {
  const client = stubClient(echoAll)
  const list = inputs(15)
  const now = () => (client.calls.length === 0 ? 0 : 2000)
  const out = await classifyMobileArticles(list, { client, config, deadlineAt: 1000, now })
  assert.equal(out.results.size, 10)
  assert.equal(client.calls.length, 1)
  assert.deepEqual([...out.pendingIds].sort(), list.slice(10).map((i) => i.id).sort())
})

test('締め切りを過ぎたら欠けた記事の再送もしない', async () => {
  const client = stubClient((params) => message(idsOf(params).filter((id) => id !== 'a3').map((id) => item(id))))
  const list = inputs(10)
  const now = () => (client.calls.length === 0 ? 0 : 2000)
  const out = await classifyMobileArticles(list, { client, config, deadlineAt: 1000, now })
  assert.equal(client.calls.length, 1)
  assert.equal(out.results.size, 9)
  assert.deepEqual(out.pendingIds, ['a3'])
})

test('429 以外の 4xx では1件ずつ再送しない', async () => {
  const client = stubClient(() => {
    throw apiError(400)
  })
  const list = inputs(5)
  const out = await classifyMobileArticles(list, { client, config })
  assert.equal(client.calls.length, 1)
  assert.equal(out.results.size, 0)
  assert.deepEqual([...out.pendingIds].sort(), list.map((i) => i.id).sort())
})

test('429 では従来どおり1件ずつ再送する', async () => {
  const client = stubClient((params, index) => {
    if (index === 0) throw apiError(429)
    return echoAll(params)
  })
  const list = inputs(3)
  const out = await classifyMobileArticles(list, { client, config })
  assert.equal(client.calls.length, 1 + 3)
  assert.equal(out.results.size, 3)
  assert.deepEqual(out.pendingIds, [])
})
