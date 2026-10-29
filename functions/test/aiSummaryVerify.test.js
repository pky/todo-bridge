const test = require('node:test')
const assert = require('node:assert/strict')

const {
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
  id, include: true, titleJa: `タイトル-${id}`, summaryJa: `要約-${id}`, ...overrides,
})
const config = { model: 'claude-sonnet-5-5', effort: 'low', dailyMaxRequests: 10 }
const input = id => ({ id, title: `title-${id}`, text: `text-${id}` })

const userText = params => {
  const content = params.messages.find(m => m.role === 'user').content
  if (typeof content === 'string') return content
  return content.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n')
}
const idsOf = params => [...userText(params).matchAll(/<article id="([^"]+)">/g)].map(m => m[1])
const stubClient = handler => {
  const calls = []
  return { calls, create: async params => { calls.push(params); return handler(params) } }
}
const schemaItems = params => params.output_config.format.schema.properties.articles.items

test('verify=true の schema は include を必須の boolean にする', () => {
  const params = buildSummaryRequest([input('x1'), input('x2')], config, true)
  const items = schemaItems(params)
  assert.deepEqual([...items.required].sort(), ['id', 'include', 'summaryJa', 'titleJa'])
  assert.equal(items.properties.include.type, 'boolean')
  assert.equal(items.additionalProperties, false)
  assert.deepEqual(idsOf(params), ['x1', 'x2'])
})

test('verify=true の system は確認基準を含み include の語を持つ', () => {
  const params = buildSummaryRequest([input('x1')], config, true)
  assert.match(JSON.stringify(params.system), /include/)
  assert.notEqual(params.system, buildSummaryRequest([input('x1')], config).system)
})

test('verify を省略した buildSummaryRequest は従来どおり include を持たない', () => {
  const omitted = buildSummaryRequest([input('x1')], config)
  const explicitFalse = buildSummaryRequest([input('x1')], config, false)
  assert.deepEqual(omitted, explicitFalse)
  assert.deepEqual(schemaItems(omitted).required, ['id', 'titleJa', 'summaryJa'])
  assert.equal('include' in schemaItems(omitted).properties, false)
})

test('verify=true で include=true の記事は include を保持して返す', () => {
  const { results, missingIds } = parseSummaryResponse(message([item('a1'), item('a2')]), ['a1', 'a2'], true)
  assert.deepEqual(missingIds, [])
  assert.deepEqual(results.map(r => r.id), ['a1', 'a2'])
  assert.ok(results.every(r => r.include === true))
  assert.equal(results[0].titleJa, 'タイトル-a1')
  assert.equal(results[1].summaryJa, '要約-a2')
})

test('verify=true で include=false は titleJa と summaryJa が空でも結果として返す', () => {
  const msg = message([item('a1'), item('a2', { include: false, titleJa: '', summaryJa: '' })])
  const { results, missingIds } = parseSummaryResponse(msg, ['a1', 'a2'], true)
  assert.deepEqual(missingIds, [])
  assert.deepEqual(results.map(r => r.id), ['a1', 'a2'])
  assert.equal(results[1].include, false)
})

test('verify=true で include=true なのに titleJa か summaryJa が空なら missing にする', () => {
  for (const overrides of [{ summaryJa: '' }, { titleJa: '' }, { summaryJa: '  ' }]) {
    const { results, missingIds } = parseSummaryResponse(message([item('a1'), item('a2', overrides)]), ['a1', 'a2'], true)
    assert.deepEqual(results.map(r => r.id), ['a1'], JSON.stringify(overrides))
    assert.deepEqual(missingIds, ['a2'], JSON.stringify(overrides))
  }
})

test('verify=true で include が boolean でなければ missing にする', () => {
  for (const include of ['true', 1, null, undefined]) {
    const { results, missingIds } = parseSummaryResponse(message([item('a1'), item('a2', { include })]), ['a1', 'a2'], true)
    assert.deepEqual(results.map(r => r.id), ['a1'], String(include))
    assert.deepEqual(missingIds, ['a2'], String(include))
  }
})

test('verify を省略すると summaryJa が空の記事は従来どおり missing にする', () => {
  const msg = message([item('a1'), item('a2', { include: false, titleJa: '', summaryJa: '' })])
  const { results, missingIds } = parseSummaryResponse(msg, ['a1', 'a2'])
  assert.deepEqual(results.map(r => r.id), ['a1'])
  assert.deepEqual(missingIds, ['a2'])
})

test('summarizeAiArticles は deps.verify=true なら include を要求し include=false の結果も返す', async () => {
  const client = stubClient(params => message(idsOf(params).map((id, index) => (
    index === 1 ? item(id, { include: false, titleJa: '', summaryJa: '' }) : item(id)
  ))))
  const out = await summarizeAiArticles([input('a1'), input('a2'), input('a3')], { client, config, verify: true })
  assert.deepEqual(schemaItems(client.calls[0]).required.slice().sort(), ['id', 'include', 'summaryJa', 'titleJa'])
  assert.deepEqual(out.pendingIds, [])
  assert.equal(out.results.size, 3)
  assert.equal(out.results.get('a2').include, false)
  assert.equal(out.results.get('a1').include, true)
})

test('summarizeAiArticles は verify を省略すると従来の schema で送る', async () => {
  const client = stubClient(params => message(idsOf(params).map(id => ({ id, titleJa: `t-${id}`, summaryJa: `s-${id}` }))))
  const out = await summarizeAiArticles([input('a1')], { client, config })
  assert.deepEqual(schemaItems(client.calls[0]).required, ['id', 'titleJa', 'summaryJa'])
  assert.equal(out.results.size, 1)
})
