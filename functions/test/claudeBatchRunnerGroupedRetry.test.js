const test = require('node:test')
const assert = require('node:assert/strict')
const Anthropic = require('@anthropic-ai/sdk')
const { runClaudeBatches } = require('../lib/news/claudeBatchRunner')

const inputs = count => Array.from({ length: count }, (_, index) => ({ id: `article-${index + 1}` }))
const message = ids => ({ ids, usage: { input_tokens: 1, output_tokens: 1 } })

function setup(handler, overrides = {}) {
  const calls = []
  const deps = {
    client: {
      create: async request => {
        calls.push(request.ids)
        return handler(request.ids, calls.length - 1)
      },
    },
    batchSize: 30,
    dailyMaxRequests: 100,
    logPrefix: 'grouped-retry-test',
    buildRequest: batch => ({ ids: batch.map(item => item.id) }),
    parseResponse: (response, expectedIds) => ({
      results: response.ids.filter(id => expectedIds.includes(id)).map(id => ({ id })),
      missingIds: expectedIds.filter(id => !response.ids.includes(id)),
    }),
    ...overrides,
  }
  return { calls, deps }
}

// 送信回数とは別に、すべての入力が結果か保留の片方だけに残ることを確かめる。
function assertPartition(out, articles, calls) {
  const resultIds = [...out.results.keys()]
  assert.equal(new Set(out.pendingIds).size, out.pendingIds.length, 'pendingIds に重複がない')
  assert.deepEqual(resultIds.filter(id => out.pendingIds.includes(id)), [], '結果と保留が重ならない')
  assert.deepEqual([...resultIds, ...out.pendingIds].sort(), articles.map(item => item.id).sort())
  assert.equal(out.requestCount, calls.length, '実際に create を呼んだ回数だけを数える')
}

test('170件の6まとまりから漏れた6件は1回にまとめて再送し7回で完了する', async () => {
  const articles = inputs(170)
  const missing = [2, 32, 62, 92, 122, 152].map(index => `article-${index}`)
  const { calls, deps } = setup((ids, index) => message(index < 6 ? ids.filter(id => !missing.includes(id)) : ids), {
    dailyMaxRequests: 10,
  })
  const out = await runClaudeBatches(articles, deps)
  assertPartition(out, articles, calls)
  assert.equal(out.requestCount, 7)
  assert.deepEqual(calls.slice(6), [missing])
  assert.deepEqual(out.pendingIds, [])
  assert.equal(out.results.size, 170)
})

test('まとめた再送で再び漏れた1件だけを個別に1回再送する', async () => {
  const articles = inputs(6)
  const missing = ['article-2', 'article-4', 'article-6']
  const { calls, deps } = setup((ids, index) => message(
    index === 0 ? ids.filter(id => !missing.includes(id)) : index === 1 ? ids.filter(id => id !== 'article-4') : ids
  ))
  const out = await runClaudeBatches(articles, deps)
  assertPartition(out, articles, calls)
  assert.deepEqual(calls, [articles.map(item => item.id), missing, ['article-4']])
  assert.equal(out.requestCount, 3)
  assert.deepEqual(out.pendingIds, [])
  assert.equal(out.results.size, 6)
})

test('再送対象が1件だけで再び漏れたら追加送信せずpendingにする', async () => {
  const articles = inputs(3)
  const { calls, deps } = setup(ids => message(ids.filter(id => id !== 'article-2')))
  const out = await runClaudeBatches(articles, deps)
  assertPartition(out, articles, calls)
  assert.deepEqual(calls, [articles.map(item => item.id), ['article-2']])
  assert.deepEqual(out.pendingIds, ['article-2'])
  assert.equal(out.results.size, 2)
})

test('1回目で日次上限へ達したら散らばった欠落を再送せずpendingにする', async () => {
  const articles = inputs(65)
  const missing = ['article-2', 'article-32', 'article-62']
  const { calls, deps } = setup(ids => message(ids.filter(id => !missing.includes(id))), { dailyMaxRequests: 3 })
  const out = await runClaudeBatches(articles, deps)
  assertPartition(out, articles, calls)
  assert.equal(calls.length, 3)
  assert.deepEqual(out.pendingIds, missing)
  assert.equal(out.results.size, 62)
})

test('欠落がbatchSizeを超えたら元の順序のままbatchSizeごとに再送する', async () => {
  const articles = inputs(8)
  const { calls, deps } = setup((ids, index) => message(index < 3 ? [] : ids), { batchSize: 3 })
  const out = await runClaudeBatches(articles, deps)
  assertPartition(out, articles, calls)
  assert.deepEqual(calls.map(ids => ids.length), [3, 3, 2, 3, 3, 2])
  assert.deepEqual(calls.slice(3), calls.slice(0, 3))
  assert.deepEqual(out.pendingIds, [])
  assert.equal(out.results.size, 8)
})

test('1回目の5xxで未処理になったまとまりを1件ずつ再送する', async () => {
  const articles = inputs(5)
  const APIError = Anthropic.APIError || Anthropic.default.APIError
  const { calls, deps } = setup((ids, index) => {
    if (index === 0) {
      throw APIError.generate(503, { error: { type: 'api_error', message: '架空の一時障害' } }, '架空の一時障害', new Headers())
    }
    return message(ids)
  }, { batchSize: 3 })
  const out = await runClaudeBatches(articles, deps)
  assertPartition(out, articles, calls)
  assert.deepEqual(calls, [articles.slice(0, 3).map(item => item.id), articles.slice(3).map(item => item.id), ['article-1'], ['article-2'], ['article-3']])
  assert.equal(out.requestCount, 5)
  assert.deepEqual(out.pendingIds, [])
  assert.equal(out.results.size, 5)
})

test('まとめた再送で上限に達したら個別再送せず残りをpendingにする', async () => {
  const articles = inputs(3)
  const { calls, deps } = setup((ids, index) => message(index === 0 ? [] : ids.filter(id => id !== 'article-2')), {
    dailyMaxRequests: 2,
  })
  const out = await runClaudeBatches(articles, deps)
  assertPartition(out, articles, calls)
  assert.deepEqual(calls, [articles.map(item => item.id), articles.map(item => item.id)])
  assert.deepEqual(out.pendingIds, ['article-2'])
})

test('まとめた再送の予約が拒否されたらcreateを増やさず全欠落をpendingにする', async () => {
  const articles = inputs(3)
  let reservations = 0
  const { calls, deps } = setup(() => message([]), { reserveRequest: async () => ++reservations === 1 })
  const out = await runClaudeBatches(articles, deps)
  assertPartition(out, articles, calls)
  assert.equal(calls.length, 1)
  assert.deepEqual(out.pendingIds, articles.map(item => item.id))
  assert.equal(reservations, 2, 'まとめた再送の予約は1回だけ行う')
})

test('1回目の完了時に締め切りを迎えたら欠落を再送しない', async () => {
  const articles = inputs(3)
  let clock = 0
  const { calls, deps } = setup(() => { clock = 100; return message([]) }, { deadlineAt: 100, now: () => clock })
  const out = await runClaudeBatches(articles, deps)
  assertPartition(out, articles, calls)
  assert.equal(calls.length, 1)
  assert.deepEqual(out.pendingIds, articles.map(item => item.id))
})

test('まとめた再送の完了時に締め切りを迎えたら個別再送しない', async () => {
  const articles = inputs(3)
  let clock = 0
  const { calls, deps } = setup((ids, index) => {
    if (index === 0) return message([])
    clock = 100
    return message(ids.filter(id => id !== 'article-2'))
  }, { deadlineAt: 100, now: () => clock })
  const out = await runClaudeBatches(articles, deps)
  assertPartition(out, articles, calls)
  assert.deepEqual(calls, [articles.map(item => item.id), articles.map(item => item.id)])
  assert.deepEqual(out.pendingIds, ['article-2'])
})
