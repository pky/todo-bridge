const test = require('node:test')
const assert = require('node:assert/strict')

const {
  getAiTriageConfig,
  buildTriageRequest,
  parseTriageResponse,
  triageAiArticles,
} = require('../lib/news/aiClaudeTriage')

const message = (items, stop = 'end_turn') => ({
  stop_reason: stop,
  content: [{ type: 'text', text: JSON.stringify({ articles: items }) }],
  usage: { input_tokens: 100, output_tokens: 50 },
})
const item = (id, overrides = {}) => ({
  id, relevant: true, importance: 'normal', tags: ['llm', 'rag'], ...overrides,
})

const config = { model: 'claude-haiku-5-5', effort: 'low', dailyMaxRequests: 10 }
const input = (id) => ({
  id, sourceName: 'source', title: `title-${id}`, description: `desc-${id}`, domain: 'example.com',
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

test('getAiTriageConfig は既定値を返す', () => {
  assert.deepEqual(getAiTriageConfig({}), {
    model: 'claude-haiku-5-5', effort: 'low', dailyMaxRequests: 10,
  })
})

test('getAiTriageConfig は環境変数で上書きできる', () => {
  assert.deepEqual(
    getAiTriageConfig({
      CLAUDE_AI_TRIAGE_MODEL: 'claude-sonnet-5-5',
      CLAUDE_AI_TRIAGE_EFFORT: 'medium',
      CLAUDE_AI_TRIAGE_DAILY_MAX_REQUESTS: '5',
    }),
    { model: 'claude-sonnet-5-5', effort: 'medium', dailyMaxRequests: 5 }
  )
})

test('buildTriageRequest はモデル、effort、JSON schema を設定し fallbacks を付けない', () => {
  const list = [input('x1'), input('x2')]
  const params = buildTriageRequest(list, config)
  assert.equal(params.model, 'claude-haiku-5-5')
  assert.equal(params.max_tokens, 8000)
  assert.equal(params.output_config.effort, 'low')
  assert.equal(params.output_config.format.type, 'json_schema')
  assert.deepEqual(params.output_config.format.schema.properties.articles.items.required, [
    'id', 'relevant', 'importance', 'tags',
  ])
  assert.deepEqual(params.output_config.format.schema.properties.articles.items.properties.importance.enum, [
    'high', 'normal', 'low',
  ])
  assert.equal(params.fallbacks, undefined)
  assert.equal(params.betas, undefined)
  assert.equal(params.thinking, undefined)
  const text = userText(params)
  assert.deepEqual(idsOf(params), ['x1', 'x2'])
  assert.ok(text.includes('<title>title-x1</title>'))
  assert.ok(text.includes('<description>desc-x2</description>'))
  assert.ok(text.includes('<domain>example.com</domain>'))
})

test('parseTriageResponse は正常な応答を全件返す', () => {
  const { results, missingIds } = parseTriageResponse(message([item('a1'), item('a2', { importance: 'high' })]), ['a1', 'a2'])
  assert.deepEqual(results.map((r) => r.id), ['a1', 'a2'])
  assert.equal(results[1].importance, 'high')
  assert.deepEqual(missingIds, [])
})

test('parseTriageResponse は relevant が boolean でない記事を missing にする', () => {
  const msg = message([item('a1'), item('a2', { relevant: 'yes' })])
  const { results, missingIds } = parseTriageResponse(msg, ['a1', 'a2'])
  assert.deepEqual(results.map((r) => r.id), ['a1'])
  assert.deepEqual(missingIds, ['a2'])
})

test('parseTriageResponse は importance が列挙値以外の記事を missing にする', () => {
  const msg = message([item('a1'), item('a2', { importance: 'urgent' })])
  const { results, missingIds } = parseTriageResponse(msg, ['a1', 'a2'])
  assert.deepEqual(results.map((r) => r.id), ['a1'])
  assert.deepEqual(missingIds, ['a2'])
})

test('parseTriageResponse は tags が配列でない記事を missing にする', () => {
  const msg = message([item('a1'), item('a2', { tags: 'llm' })])
  const { results, missingIds } = parseTriageResponse(msg, ['a1', 'a2'])
  assert.deepEqual(results.map((r) => r.id), ['a1'])
  assert.deepEqual(missingIds, ['a2'])
})

test('parseTriageResponse は tags を正規化する', () => {
  const msg = message([item('a1', { tags: ['LLM', 'Claude Code'] })])
  const { results } = parseTriageResponse(msg, ['a1'])
  assert.deepEqual(results[0].tags, ['llm', 'claude-code'])
})

test('triageAiArticles は30件ずつ送る', async () => {
  const client = stubClient(echoAll)
  const out = await triageAiArticles(inputs(65), { client, config })
  assert.equal(client.calls.length, 3)
  assert.deepEqual(client.calls.map((c) => idsOf(c).length), [30, 30, 5])
  assert.equal(out.results.size, 65)
  assert.deepEqual(out.pendingIds, [])
  assert.equal(out.requestCount, 3)
})

test('triageAiArticles は client が null なら全件 pending', async () => {
  const out = await triageAiArticles(inputs(3), { client: null, config })
  assert.equal(out.requestCount, 0)
  assert.equal(out.results.size, 0)
  assert.deepEqual([...out.pendingIds].sort(), ['a1', 'a2', 'a3'])
})
