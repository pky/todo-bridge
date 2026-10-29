const test = require('node:test')
const assert = require('node:assert/strict')

const {
  getClaudeNewsConfig,
  buildClassificationRequest,
  parseClassificationResponse,
  classifyMobileArticles,
  createClaudeMessagesClient,
} = require('../lib/news/mobileClaudeClassifier')

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

// handler(params, callIndex) returns a message or throws
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

test('getClaudeNewsConfig は既定値を返す', () => {
  assert.deepEqual(getClaudeNewsConfig({}), {
    model: 'claude-sonnet-5-5', effort: 'low', dailyMaxRequests: 5,
  })
})

test('getClaudeNewsConfig は環境変数で上書きできる', () => {
  assert.deepEqual(
    getClaudeNewsConfig({
      CLAUDE_NEWS_MODEL: 'claude-sonnet-5-5',
      CLAUDE_NEWS_EFFORT: 'medium',
      CLAUDE_NEWS_DAILY_MAX_REQUESTS: '5',
    }),
    { model: 'claude-sonnet-5-5', effort: 'medium', dailyMaxRequests: 5 }
  )
  assert.equal(getClaudeNewsConfig({ CLAUDE_NEWS_DAILY_MAX_REQUESTS: 'abc' }).dailyMaxRequests, 5)
})

test('buildClassificationRequest はモデル、effort、フォールバック、JSON schema を設定する', () => {
  const list = [input('x1'), input('x2')]
  const params = buildClassificationRequest(list, config)
  assert.equal(params.model, 'claude-opus-5-5')
  assert.equal(params.output_config.effort, 'low')
  assert.equal(params.output_config.format.type, 'json_schema')
  assert.equal(params.fallbacks, 'default')
  assert.ok(params.betas.includes('server-side-fallback-2026-07-01'))
  assert.equal(params.thinking, undefined)
  const text = userText(params)
  for (const i of list) {
    assert.ok(text.includes(i.id), `id ${i.id}`)
    assert.ok(text.includes(i.text), `text ${i.text}`)
  }
})

test('parseClassificationResponse は正常な応答を全件返す', () => {
  const { results, missingIds } = parseClassificationResponse(message([item('a1'), item('a2')]), ['a1', 'a2'])
  assert.equal(results.length, 2)
  assert.deepEqual(results.map((r) => r.id), ['a1', 'a2'])
  assert.equal(results[0].category, 'security')
  assert.equal(results[0].requiredByDate, '2026-11-30')
  assert.equal(results[0].summary.action, '更新する')
  assert.deepEqual(missingIds, [])
})

test('parseClassificationResponse は欠けた id を missingIds に入れる', () => {
  const { results, missingIds } = parseClassificationResponse(message([item('a1')]), ['a1', 'a2'])
  assert.deepEqual(results.map((r) => r.id), ['a1'])
  assert.deepEqual(missingIds, ['a2'])
})

test('parseClassificationResponse は送っていない id を無視し、重複は最初の1件を採用する', () => {
  const msg = message([
    item('a1', { titleJa: '最初' }),
    item('zzz'),
    item('a1', { titleJa: '二番目' }),
  ])
  const { results, missingIds } = parseClassificationResponse(msg, ['a1'])
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'a1')
  assert.equal(results[0].titleJa, '最初')
  assert.deepEqual(missingIds, [])
})

test('parseClassificationResponse は不正な requiredByDate の記事を missingIds に入れる', () => {
  const msg = message([item('a1'), item('a2', { requiredByDate: '11月末' })])
  const { results, missingIds } = parseClassificationResponse(msg, ['a1', 'a2'])
  assert.deepEqual(results.map((r) => r.id), ['a1'])
  assert.deepEqual(missingIds, ['a2'])
})

test('parseClassificationResponse は不正な category の記事を missingIds に入れる', () => {
  const msg = message([item('a1'), item('a2', { category: 'unknown' })])
  const { results, missingIds } = parseClassificationResponse(msg, ['a1', 'a2'])
  assert.deepEqual(results.map((r) => r.id), ['a1'])
  assert.deepEqual(missingIds, ['a2'])
})

test('parseClassificationResponse は stop_reason が end_turn 以外なら全件 missing', () => {
  for (const stop of ['max_tokens', 'refusal']) {
    const { results, missingIds } = parseClassificationResponse(
      message([item('a1'), item('a2')], stop),
      ['a1', 'a2']
    )
    assert.equal(results.length, 0, stop)
    assert.deepEqual([...missingIds].sort(), ['a1', 'a2'], stop)
  }
})

test('parseClassificationResponse は JSON でない応答なら全件 missing', () => {
  const msg = {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'これは JSON ではありません' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  const { results, missingIds } = parseClassificationResponse(msg, ['a1', 'a2'])
  assert.equal(results.length, 0)
  assert.deepEqual([...missingIds].sort(), ['a1', 'a2'])
})

test('classifyMobileArticles は10件ずつ送る', async () => {
  const client = stubClient(echoAll)
  const out = await classifyMobileArticles(inputs(23), { client, config })
  assert.equal(client.calls.length, 3)
  assert.deepEqual(client.calls.map((c) => idsOf(c).length), [10, 10, 3])
  assert.equal(out.results.size, 23)
  assert.deepEqual(out.pendingIds, [])
  assert.equal(out.requestCount, 3)
})

test('classifyMobileArticles は欠けた記事だけ1件ずつ再送する', async () => {
  const client = stubClient((params, n) => {
    if (n === 0) return message([item('a1')])
    return echoAll(params)
  })
  const out = await classifyMobileArticles(inputs(2), { client, config })
  assert.equal(client.calls.length, 2)
  assert.deepEqual(idsOf(client.calls[1]), ['a2'])
  assert.ok(out.results.has('a1'))
  assert.ok(out.results.has('a2'))
  assert.equal(out.results.get('a2').id, 'a2')
  assert.deepEqual(out.pendingIds, [])
})

test('classifyMobileArticles は再送も失敗した記事を pending にする', async () => {
  const client = stubClient((params, n) => {
    if (n === 0) return message([item('a1')])
    return message([])
  })
  const out = await classifyMobileArticles(inputs(2), { client, config })
  assert.ok(out.results.has('a1'))
  assert.ok(!out.results.has('a2'))
  assert.deepEqual(out.pendingIds, ['a2'])
})

test('classifyMobileArticles は client が例外を投げた送信分を pending にする', async () => {
  const client = stubClient((params) => {
    if (idsOf(params).includes('a1')) throw new Error('boom')
    return echoAll(params)
  })
  const out = await classifyMobileArticles(inputs(12), { client, config })
  assert.ok(out.pendingIds.includes('a1'))
  assert.ok(!out.results.has('a1'))
  assert.ok(out.results.has('a11'))
  assert.ok(out.results.has('a12'))

  const failing = stubClient(() => {
    throw new Error('boom')
  })
  const all = await classifyMobileArticles(inputs(3), { client: failing, config })
  assert.equal(all.results.size, 0)
  assert.deepEqual([...all.pendingIds].sort(), ['a1', 'a2', 'a3'])
})

test('classifyMobileArticles は呼び出し上限を超えた分を pending にする', async () => {
  const client = stubClient(echoAll)
  const out = await classifyMobileArticles(inputs(15), {
    client,
    config: { ...config, dailyMaxRequests: 1 },
  })
  assert.equal(client.calls.length, 1)
  assert.equal(out.requestCount, 1)
  assert.equal(out.results.size, 10)
  assert.equal(out.pendingIds.length, 5)
  assert.deepEqual([...out.pendingIds].sort(), ['a11', 'a12', 'a13', 'a14', 'a15'])
})

test('classifyMobileArticles は client が null なら呼び出さずに全件 pending', async () => {
  const out = await classifyMobileArticles(inputs(3), { client: null, config })
  assert.equal(out.requestCount, 0)
  assert.equal(out.results.size, 0)
  assert.deepEqual([...out.pendingIds].sort(), ['a1', 'a2', 'a3'])
})

test('createClaudeMessagesClient は API キーがなければ null を返す', () => {
  assert.equal(createClaudeMessagesClient(undefined), null)
  assert.equal(createClaudeMessagesClient(''), null)
})
