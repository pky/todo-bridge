const test = require('node:test')
const assert = require('node:assert/strict')
const { runClaudeBatches } = require('../lib/news/claudeBatchRunner')
const { triageAiArticles, getAiTriageConfig } = require('../lib/news/aiClaudeTriage')
const { summarizeAiArticles, getAiSummaryConfig } = require('../lib/news/aiClaudeSummary')

const inputs = [{ id: 'a' }, { id: 'b' }]
const message = { usage: { input_tokens: 1, output_tokens: 1 } }

function deps(overrides = {}) {
  return {
    client: { create: async () => message }, batchSize: 1, dailyMaxRequests: 10,
    logPrefix: 'reservation-test', buildRequest: batch => ({ ids: batch.map(item => item.id) }),
    parseResponse: (_message, ids) => ({ results: ids.map(id => ({ id })), missingIds: [] }),
    ...overrides,
  }
}

test('予約を各create直前に行い拒否分はpendingにして送信数へ含めない', async () => {
  const events = []
  let reservations = 0
  const out = await runClaudeBatches(inputs, deps({
    reserveRequest: async () => { events.push('reserve'); return ++reservations === 1 },
    client: { create: async () => { events.push('create'); return message } },
  }))
  assert.deepEqual(events, ['reserve', 'create', 'reserve'])
  assert.equal(out.requestCount, 1)
  assert.deepEqual([...out.results.keys()], ['a'])
  assert.deepEqual(out.pendingIds, ['b'])
})

test('予約例外はAPIを呼ばず全件pendingにして機密エラーを出力しない', async t => {
  const logged = []
  for (const method of ['log', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => logged.push(args.map(String).join(' ')))
  }
  let calls = 0
  const out = await runClaudeBatches(inputs, deps({
    reserveRequest: async () => { throw new Error('機密を模した予約エラー') },
    client: { create: async () => { calls++; return message } },
  }))
  assert.equal(calls, 0)
  assert.equal(out.requestCount, 0)
  assert.deepEqual(out.pendingIds, ['a', 'b'])
  assert.equal(logged.join('\n').includes('機密を模した予約エラー'), false)
})

test('欠落記事の個別再送も予約し上限到達なら再送せずpendingに残す', async () => {
  let calls = 0
  let reservations = 0
  const out = await runClaudeBatches(inputs, deps({
    batchSize: 2,
    reserveRequest: async () => ++reservations === 1,
    client: { create: async () => { calls++; return message } },
    parseResponse: () => ({ results: [{ id: 'a' }], missingIds: ['b'] }),
  }))
  assert.equal(reservations, 2)
  assert.equal(calls, 1)
  assert.equal(out.requestCount, 1)
  assert.deepEqual(out.pendingIds, ['b'])
})

test('予約待ちの間に締め切りが過ぎたらAPIを呼ばない', async () => {
  let clock = 0
  let calls = 0
  const out = await runClaudeBatches([{ id: 'a' }], deps({
    deadlineAt: 100, now: () => clock,
    reserveRequest: async () => { clock = 100; return true },
    client: { create: async () => { calls++; return message } },
  }))
  assert.equal(calls, 0)
  assert.equal(out.requestCount, 0)
  assert.deepEqual(out.pendingIds, ['a'])
})

test('予約callback未指定なら既存どおり全件を送る', async () => {
  const out = await runClaudeBatches(inputs, deps())
  assert.equal(out.requestCount, 2)
  assert.equal(out.results.size, 2)
  assert.deepEqual(out.pendingIds, [])
})

test('未解決の予約も締め切りで待機を終えAPIを呼ばずpendingを返す', { timeout: 2000 }, async () => {
  const startedAt = Date.now()
  let calls = 0
  // 締め切り用タイマーがイベントループを維持しない環境でも待機する。
  const keepAlive = setTimeout(() => {}, 1500)
  let timeout
  try {
    const completed = runClaudeBatches([{ id: 'a' }], deps({
      deadlineAt: startedAt + 50,
      reserveRequest: () => new Promise(() => {}),
      client: { create: async () => { calls++; return message } },
    }))
    const out = await Promise.race([
      completed,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('予約待機が締め切り後も終了しない')), 1000)
      }),
    ])
    assert.ok(Date.now() - startedAt < 1000)
    assert.equal(calls, 0)
    assert.equal(out.requestCount, 0)
    assert.deepEqual(out.pendingIds, ['a'])
  } finally {
    clearTimeout(timeout)
    clearTimeout(keepAlive)
  }
})

for (const [name, run, config] of [
  ['triageAiArticles', triageAiArticles, getAiTriageConfig({})],
  ['summarizeAiArticles', summarizeAiArticles, getAiSummaryConfig({})],
]) {
  test(`${name} は予約callbackをrunnerへ渡す`, async () => {
    let reservations = 0
    let calls = 0
    const out = await run([{ id: 'a', title: 'Fictional article', sourceName: 'Example', domain: 'example.com', description: 'Example', text: 'Example' }], {
      config, reserveRequest: async () => { reservations++; return false },
      client: { create: async () => { calls++; return message } },
    })
    assert.equal(reservations, 1)
    assert.equal(calls, 0)
    assert.equal(out.requestCount, 0)
    assert.deepEqual(out.pendingIds, ['a'])
  })
}
