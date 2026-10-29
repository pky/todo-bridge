const test = require('node:test')
const assert = require('node:assert/strict')

const {
  getAiSummaryConfig,
  buildSummaryRequest,
  parseSummaryResponse,
  summarizeAiArticles,
} = require('../lib/news/aiClaudeSummary')

const message = (items, stop = 'end_turn') => ({
  stop_reason: stop,
  content: [{ type: 'text', text: JSON.stringify({ articles: items }) }],
  usage: { input_tokens: 100, output_tokens: 50 },
})
const item = (id, overrides = {}) => ({
  id, titleJa: `タイトル-${id}`, summaryJa: `要約-${id}`, ...overrides,
})

const config = { model: 'claude-sonnet-5-5', effort: 'low', dailyMaxRequests: 10 }
const input = (id) => ({ id, title: `title-${id}`, text: `text-${id}` })
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

test('getAiSummaryConfig は既定値を返す', () => {
  assert.deepEqual(getAiSummaryConfig({}), {
    model: 'claude-sonnet-5-5', effort: 'low', dailyMaxRequests: 6,
  })
})

test('getAiSummaryConfig は環境変数で上書きできる', () => {
  assert.deepEqual(
    getAiSummaryConfig({
      CLAUDE_AI_SUMMARY_MODEL: 'claude-haiku-5-5',
      CLAUDE_AI_SUMMARY_EFFORT: 'medium',
      CLAUDE_AI_SUMMARY_DAILY_MAX_REQUESTS: '5',
    }),
    { model: 'claude-haiku-5-5', effort: 'medium', dailyMaxRequests: 5 }
  )
})

test('buildSummaryRequest はフォールバックと JSON schema を設定する', () => {
  const params = buildSummaryRequest([input('x1'), input('x2')], config)
  assert.equal(params.model, 'claude-sonnet-5-5')
  assert.equal(params.max_tokens, 8000)
  assert.equal(params.fallbacks, 'default')
  assert.ok(params.betas.includes('server-side-fallback-2026-07-01'))
  assert.equal(params.output_config.effort, 'low')
  assert.equal(params.output_config.format.type, 'json_schema')
  const items = params.output_config.format.schema.properties.articles.items
  assert.deepEqual(items.required, ['id', 'titleJa', 'summaryJa'])
  assert.equal(items.additionalProperties, false)
  assert.ok(JSON.stringify(params.system).includes('あなたは開発者向け AI ニュースの翻訳と要約の担当です。'))
  const text = userText(params)
  assert.deepEqual(idsOf(params), ['x1', 'x2'])
  assert.ok(text.includes('<title>title-x1</title>'))
  assert.ok(text.includes('<text>text-x2</text>'))
})

test('parseSummaryResponse は正常な応答を全件返す', () => {
  const { results, missingIds } = parseSummaryResponse(message([item('a1'), item('a2')]), ['a1', 'a2'])
  assert.deepEqual(results.map((r) => r.id), ['a1', 'a2'])
  assert.equal(results[0].titleJa, 'タイトル-a1')
  assert.equal(results[1].summaryJa, '要約-a2')
  assert.deepEqual(missingIds, [])
})

test('parseSummaryResponse は summaryJa が空の記事を missing にする', () => {
  const msg = message([item('a1'), item('a2', { summaryJa: '' })])
  const { results, missingIds } = parseSummaryResponse(msg, ['a1', 'a2'])
  assert.deepEqual(results.map((r) => r.id), ['a1'])
  assert.deepEqual(missingIds, ['a2'])
})

test('parseSummaryResponse は titleJa が空の記事を missing にする', () => {
  const msg = message([item('a1'), item('a2', { titleJa: '' })])
  const { results, missingIds } = parseSummaryResponse(msg, ['a1', 'a2'])
  assert.deepEqual(results.map((r) => r.id), ['a1'])
  assert.deepEqual(missingIds, ['a2'])
})

test('summarizeAiArticles は10件ずつ送る', async () => {
  const client = stubClient(echoAll)
  const out = await summarizeAiArticles(inputs(23), { client, config })
  assert.equal(client.calls.length, 3)
  assert.deepEqual(client.calls.map((c) => idsOf(c).length), [10, 10, 3])
  assert.equal(out.results.size, 23)
  assert.deepEqual(out.pendingIds, [])
  assert.equal(out.requestCount, 3)
})

test('summarizeAiArticles は client が null なら全件 pending', async () => {
  const out = await summarizeAiArticles(inputs(3), { client: null, config })
  assert.equal(out.requestCount, 0)
  assert.equal(out.results.size, 0)
  assert.deepEqual([...out.pendingIds].sort(), ['a1', 'a2', 'a3'])
})
