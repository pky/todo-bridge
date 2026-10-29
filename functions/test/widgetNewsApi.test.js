const test = require('node:test')
const assert = require('node:assert/strict')

// 未実装のモジュールでファイル全体が落ちないよう、読み込み失敗は各テスト内の失敗として報告する。
let api = null
let loadError = null
try {
  api = require('../lib/news/widgetNewsApi')
} catch (error) {
  loadError = error
}
function mod() {
  if (!api) throw new Error(`widgetNewsApi が未実装です: ${loadError && loadError.message}`)
  return api
}

const TOKEN = 'fictional-token-abc123'
const UID = 'fictional-uid-777'
const NOW = new Date('2026-01-05T03:04:05.000Z')

function createReq({ method = 'GET', authorization, query = { topic: 'ai' } } = {}) {
  const headers = {}
  if (authorization !== undefined) headers.authorization = authorization
  return { method, headers, query }
}

function createRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: undefined,
    status(code) { res.statusCode = code; return res },
    set(name, value) { res.headers[String(name).toLowerCase()] = value; return res },
    json(body) { res.body = body; return res },
  }
  return res
}

function emptyInput(topic = 'ai') {
  return { topic, personalDate: null, personalDocs: [], sharedDate: null, sharedDocs: [], interactions: [] }
}

function createDeps(overrides = {}) {
  const calls = { verify: [], load: [] }
  const deps = {
    calls,
    async verifyIdToken(token) { calls.verify.push(token); return { uid: UID } },
    async loadInputs(uid, topic) { calls.load.push({ uid, topic }); return emptyInput(topic) },
    now: () => NOW,
    ...overrides,
  }
  return deps
}

async function run(deps, req) {
  const handler = mod().createWidgetNewsHandler(deps)
  const res = createRes()
  await handler(req, res)
  return res
}

test('GETでAuthorizationが無ければ401で、loadInputsを呼ばない', async () => {
  const deps = createDeps()
  const res = await run(deps, createReq({}))
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.body, { error: 'unauthenticated' })
  assert.equal(deps.calls.load.length, 0)
  assert.equal(deps.calls.verify.length, 0)
})

test('Bearer以外のAuthorizationは401', async () => {
  for (const authorization of ['Basic abc123', `Token ${TOKEN}`, TOKEN, 'Bearer']) {
    const deps = createDeps()
    const res = await run(deps, createReq({ authorization }))
    assert.equal(res.statusCode, 401, authorization)
    assert.deepEqual(res.body, { error: 'unauthenticated' })
    assert.equal(deps.calls.load.length, 0)
  }
})

test('空トークンは401で、verifyIdTokenもloadInputsも呼ばない', async () => {
  for (const authorization of ['Bearer ', 'Bearer    ', '']) {
    const deps = createDeps()
    const res = await run(deps, createReq({ authorization }))
    assert.equal(res.statusCode, 401, JSON.stringify(authorization))
    assert.deepEqual(res.body, { error: 'unauthenticated' })
    assert.equal(deps.calls.verify.length, 0)
    assert.equal(deps.calls.load.length, 0)
  }
})

test('verifyIdTokenが拒否した場合は500ではなく401', async () => {
  const deps = createDeps({ async verifyIdToken() { throw new Error('token revoked') } })
  const res = await run(deps, createReq({ authorization: `Bearer ${TOKEN}` }))
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.body, { error: 'unauthenticated' })
  assert.equal(deps.calls.load.length, 0)
})

test('BearerトークンはそのままverifyIdTokenに渡される', async () => {
  const deps = createDeps()
  await run(deps, createReq({ authorization: `Bearer ${TOKEN}` }))
  assert.deepEqual(deps.calls.verify, [TOKEN])
})

test('POSTなど GET 以外は405で、認証もloadInputsも行わない', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const deps = createDeps()
    const res = await run(deps, createReq({ method, authorization: `Bearer ${TOKEN}` }))
    assert.equal(res.statusCode, 405, method)
    assert.deepEqual(res.body, { error: 'method-not-allowed' })
    assert.equal(deps.calls.verify.length, 0)
    assert.equal(deps.calls.load.length, 0)
  }
})

test('topicが無い、AI、ai,mobile、複数指定は400', async () => {
  const patterns = [
    {},
    { topic: undefined },
    { topic: '' },
    { topic: 'AI' },
    { topic: 'Mobile' },
    { topic: 'ai,mobile' },
    { topic: ' ai' },
    { topic: 'other' },
    { topic: ['ai', 'mobile'] },
    { topic: ['ai'] },
  ]
  for (const query of patterns) {
    const deps = createDeps()
    const res = await run(deps, createReq({ authorization: `Bearer ${TOKEN}`, query }))
    assert.equal(res.statusCode, 400, JSON.stringify(query))
    assert.deepEqual(res.body, { error: 'invalid-argument' })
    assert.equal(deps.calls.load.length, 0)
  }
})

test('topic不正でも認証が先で、未認証なら400ではなく401', async () => {
  const deps = createDeps()
  const res = await run(deps, createReq({ query: { topic: 'AI' } }))
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.body, { error: 'unauthenticated' })
})

test('クエリにuidを付けてもloadInputsはトークンのUIDで呼ばれる', async () => {
  const deps = createDeps()
  const res = await run(deps, createReq({
    authorization: `Bearer ${TOKEN}`,
    query: { topic: 'mobile', uid: 'other-uid-999' },
  }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(deps.calls.load, [{ uid: UID, topic: 'mobile' }])
})

test('成功時は200、Cache-Controlがprivate, no-store、本文がWidgetNewsResponse', async () => {
  const deps = createDeps({
    async loadInputs(uid, topic) {
      return {
        ...emptyInput(topic),
        personalDate: '2026-01-05',
        personalDocs: [
          { id: 'a1', title: 'Fictional A', titleJa: '架空A', summaryJa: '架空の概要A', source: 'rss', sourceName: 'Fictional Feed', url: 'https://example.com/a1', displayScore: 5 },
          { id: 'a2', title: 'Fictional B', titleJa: '架空B', summaryJa: '架空の概要B', source: 'rss', sourceName: 'Fictional Feed', url: 'https://example.com/a2', displayScore: 9 },
        ],
      }
    },
  })
  const res = await run(deps, createReq({ authorization: `Bearer ${TOKEN}` }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'private, no-store')
  assert.equal(res.body.dtoVersion, 1)
  assert.equal(res.body.topic, 'ai')
  assert.equal(res.body.generatedAt, NOW.toISOString())
  assert.equal(res.body.feedDate, '2026-01-05')
  assert.equal(res.body.isSharedFallback, false)
  assert.match(res.body.revision, /^[0-9a-f]{64}$/)
  assert.equal(res.body.totalCount, 2)
  assert.deepEqual(res.body.articles.map(a => a.id), ['a2', 'a1'])
  assert.equal(res.body.articles[0].title, '架空B')
})

test('記事が0件でも200と空配列で、revisionは同じ入力なら同じ値', async () => {
  const first = await run(createDeps(), createReq({ authorization: `Bearer ${TOKEN}` }))
  const second = await run(createDeps(), createReq({ authorization: `Bearer ${TOKEN}` }))
  for (const res of [first, second]) {
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'private, no-store')
    assert.deepEqual(res.body.articles, [])
    assert.equal(res.body.totalCount, 0)
    assert.equal(res.body.feedDate, null)
    assert.match(res.body.revision, /^[0-9a-f]{64}$/)
  }
  assert.equal(first.body.revision, second.body.revision)
})

test('loadInputsが例外なら500で本文は {error:internal}', async () => {
  const original = console.error
  console.error = () => {}
  try {
    const deps = createDeps({ async loadInputs() { throw new Error('boom') } })
    const res = await run(deps, createReq({ authorization: `Bearer ${TOKEN}` }))
    assert.equal(res.statusCode, 500)
    assert.deepEqual(res.body, { error: 'internal' })
  } finally {
    console.error = original
  }
})

test('500時の console.error 出力にトークン文字列もUIDも含まない', async () => {
  const original = console.error
  const logged = []
  console.error = (...args) => { logged.push(args) }
  try {
    const deps = createDeps({ async loadInputs() { throw new Error('boom') } })
    const res = await run(deps, createReq({ authorization: `Bearer ${TOKEN}` }))
    assert.equal(res.statusCode, 500)
  } finally {
    console.error = original
  }
  const text = logged.map(args => args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a) ?? String(a))).join(' ')).join('\n')
  assert.ok(!text.includes(TOKEN), 'ログにトークンが含まれている')
  assert.ok(!text.includes(UID), 'ログにUIDが含まれている')
})

test('200のレスポンスでもトークン検証前の失敗でも、res.jsonは1回だけ呼ばれる', async () => {
  let calls = 0
  const handler = mod().createWidgetNewsHandler(createDeps())
  const res = createRes()
  const json = res.json
  res.json = body => { calls += 1; return json(body) }
  await handler(createReq({ authorization: `Bearer ${TOKEN}` }), res)
  assert.equal(calls, 1)
})
