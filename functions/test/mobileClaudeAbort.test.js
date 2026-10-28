const test = require('node:test')
const assert = require('node:assert/strict')

const { classifyMobileArticles } = require('../lib/news/mobileClaudeClassifier')

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
const echoAll = (params) => message(idsOf(params).map((id) => item(id)))

test('締め切りがあれば各呼び出しに中断用の signal を渡す', async () => {
  const calls = []
  const client = {
    create: async (params, options) => {
      calls.push({
        options,
        isSignal: Boolean(options && options.signal instanceof AbortSignal),
        abortedAtCall: Boolean(options && options.signal && options.signal.aborted),
      })
      return echoAll(params)
    },
  }
  const out = await classifyMobileArticles(inputs(3), { client, config, deadlineAt: Date.now() + 60000 })
  assert.equal(out.results.size, 3)
  assert.ok(calls.length >= 1)
  for (const c of calls) {
    assert.notEqual(c.options, undefined, 'options が渡されていない')
    assert.equal(c.isSignal, true, 'options.signal が AbortSignal ではない')
    assert.equal(c.abortedAtCall, false, '呼び出し時点で signal が中断済み')
  }
})

test('締め切りがなければ signal を渡さない', async () => {
  const calls = []
  const client = {
    create: async (params, options) => {
      calls.push(options)
      return echoAll(params)
    },
  }
  const out = await classifyMobileArticles(inputs(3), { client, config })
  assert.equal(out.results.size, 3)
  assert.ok(calls.length >= 1)
  for (const options of calls) {
    assert.ok(!(options && options.signal), 'signal が渡されている')
  }
})

test('進行中の呼び出しは締め切りで打ち切られ pending になる', { timeout: 5000 }, async () => {
  let callCount = 0
  const client = {
    create: (params, options) => {
      callCount++
      return new Promise((_resolve, reject) => {
        const signal = options && options.signal
        if (!signal) return // signal が無ければ解決も拒否もしない
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  }
  const list = inputs(3)
  const start = Date.now()
  const out = await classifyMobileArticles(list, { client, config, deadlineAt: Date.now() + 100 })
  const elapsed = Date.now() - start
  assert.ok(elapsed < 2000, `elapsed=${elapsed}ms`)
  assert.equal(out.results.size, 0)
  assert.deepEqual([...out.pendingIds].sort(), list.map((i) => i.id).sort())
  assert.equal(callCount, 1)
})
