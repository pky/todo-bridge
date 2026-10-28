const test = require('node:test')
const assert = require('node:assert/strict')

const { runClaudeBatches } = require('../lib/news/claudeBatchRunner')

const message = (ids) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ ids }) }],
  usage: { input_tokens: 100, output_tokens: 50 },
})

const inputs = (n) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}` }))

const buildRequest = (batch) => ({
  model: 'claude-opus-5-5',
  max_tokens: 1000,
  messages: [{ role: 'user', content: JSON.stringify({ ids: batch.map((b) => b.id) }) }],
})

const idsOf = (params) => JSON.parse(params.messages[0].content).ids

const parseResponse = (msg, expectedIds) => {
  const block = msg.content.find((b) => b.type === 'text')
  const ids = JSON.parse(block.text).ids
  const results = ids.filter((id) => expectedIds.includes(id)).map((id) => ({ id }))
  const missingIds = expectedIds.filter((id) => !ids.includes(id))
  return { results, missingIds }
}

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

const baseDeps = (client, overrides = {}) => ({
  client,
  batchSize: 30,
  dailyMaxRequests: 100,
  logPrefix: 'testPrefix',
  buildRequest,
  parseResponse,
  ...overrides,
})

test('batchSize ごとに分けて送る', async () => {
  const client = stubClient((params) => message(idsOf(params)))
  const out = await runClaudeBatches(inputs(65), baseDeps(client))
  assert.equal(client.calls.length, 3)
  assert.deepEqual(client.calls.map((c) => idsOf(c).length), [30, 30, 5])
  assert.equal(out.results.size, 65)
  assert.deepEqual(out.pendingIds, [])
})

test('logPrefix を使って usage を出す', async () => {
  const client = stubClient((params) => message(idsOf(params)))
  const logged = []
  const original = console.log
  console.log = (...args) => { logged.push(args.map(String).join(' ')) }
  try {
    await runClaudeBatches(inputs(3), baseDeps(client))
  } finally {
    console.log = original
  }
  assert.ok(logged.some((line) => line.includes('testPrefix')), `logged: ${JSON.stringify(logged)}`)
})

test('parseResponse が返した欠落 id だけを個別に再送する', async () => {
  const client = stubClient((params, index) => {
    const ids = idsOf(params)
    return message(index === 0 ? ids.filter((id) => id !== 'a2') : ids)
  })
  const out = await runClaudeBatches(inputs(3), baseDeps(client))
  assert.equal(client.calls.length, 2)
  assert.deepEqual(idsOf(client.calls[1]), ['a2'])
  assert.ok(out.results.has('a2'))
  assert.equal(out.results.size, 3)
  assert.deepEqual(out.pendingIds, [])
})
