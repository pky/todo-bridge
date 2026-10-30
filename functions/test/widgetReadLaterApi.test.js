const test = require('node:test')
const assert = require('node:assert/strict')

// 未実装のモジュールでファイル全体が落ちないよう、読み込み失敗は各テスト内の失敗として報告する。
let api = null
let loadError = null
try {
  api = require('../lib/news/widgetReadLaterApi')
} catch (error) {
  loadError = error
}
function mod() {
  if (!api) throw new Error(`widgetReadLaterApi が未実装です: ${loadError && loadError.message}`)
  return api
}

const TOKEN = 'fictional-token-abc123'
const UID = 'user-fictional-1'
const ARTICLE = {
  id: 'article-1',
  title: '架空の記事',
  summary: '架空の概要です',
  url: 'https://example.com/fictional-article',
}

function createReq({ method = 'POST', authorization, body = { topic: 'ai', articleId: 'article-1' } } = {}) {
  const headers = {}
  if (authorization !== undefined) headers.authorization = authorization
  return { method, headers, body }
}

function createRes() {
  const setCalls = []
  const res = {
    statusCode: null,
    headers: {},
    body: undefined,
    setCalls,
    status(code) { res.statusCode = code; return res },
    set(name, value) { setCalls.push([name, value]); res.headers[String(name).toLowerCase()] = value; return res },
    json(body) { res.body = body; return res },
  }
  return res
}

function createDeps(overrides = {}) {
  const calls = { verify: [], find: [], isAdded: [], add: [] }
  const deps = {
    calls,
    async verifyIdToken(token) { calls.verify.push(token); return { uid: UID } },
    async findArticle(uid, topic, articleId) { calls.find.push({ uid, topic, articleId }); return { ...ARTICLE } },
    async isAdded(uid, topic, articleId) { calls.isAdded.push({ uid, topic, articleId }); return false },
    async add(uid, topic, article) { calls.add.push({ uid, topic, article }); return 'created' },
    ...overrides,
  }
  return deps
}

async function run(deps, req) {
  const handler = mod().createWidgetReadLaterHandler(deps)
  const res = createRes()
  await handler(req, res)
  return res
}

function authed(extra = {}) {
  return createReq({ authorization: `Bearer ${TOKEN}`, ...extra })
}

async function withSilencedConsole(fn) {
  const original = console.error
  const logged = []
  console.error = (...args) => { logged.push(args) }
  try {
    await fn()
  } finally {
    console.error = original
  }
  return logged.map(args => args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a) ?? String(a))).join(' ')).join('\n')
}

function assertNoStore(res) {
  assert.ok(
    res.setCalls.some(([name, value]) => name === 'Cache-Control' && value === 'private, no-store'),
    `res.set('Cache-Control', 'private, no-store') が呼ばれていない: ${JSON.stringify(res.setCalls)}`,
  )
}

test('POST以外は405で、deps を呼ばない', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const deps = createDeps()
    const res = await run(deps, authed({ method }))
    assert.equal(res.statusCode, 405, method)
    assert.deepEqual(res.body, { error: 'method-not-allowed' })
    assert.equal(deps.calls.find.length, 0)
    assert.equal(deps.calls.add.length, 0)
  }
})

test('Cache-Control: 200（created）に private, no-store を付ける', async () => {
  const res = await run(createDeps(), authed())
  assert.equal(res.statusCode, 200)
  assertNoStore(res)
})

test('Cache-Control: 200（already）に private, no-store を付ける', async () => {
  const res = await run(createDeps({ async isAdded() { return true } }), authed())
  assert.equal(res.statusCode, 200)
  assertNoStore(res)
})

test('Cache-Control: 400 に private, no-store を付ける', async () => {
  const res = await run(createDeps(), authed({ body: { topic: 'other', articleId: 'article-1' } }))
  assert.equal(res.statusCode, 400)
  assertNoStore(res)
})

test('Cache-Control: 401 に private, no-store を付ける（Authorization無し／検証失敗）', async () => {
  const noAuth = await run(createDeps(), createReq({}))
  assert.equal(noAuth.statusCode, 401)
  assertNoStore(noAuth)
  const rejected = await run(createDeps({ async verifyIdToken() { throw new Error('token revoked') } }), authed())
  assert.equal(rejected.statusCode, 401)
  assertNoStore(rejected)
})

test('Cache-Control: 404 に private, no-store を付ける', async () => {
  const res = await run(createDeps({ async findArticle() { return null } }), authed())
  assert.equal(res.statusCode, 404)
  assertNoStore(res)
})

test('Cache-Control: 405 に private, no-store を付ける', async () => {
  const res = await run(createDeps(), authed({ method: 'GET' }))
  assert.equal(res.statusCode, 405)
  assertNoStore(res)
})

test('Cache-Control: 500 に private, no-store を付ける', async () => {
  await withSilencedConsole(async () => {
    const res = await run(createDeps({ async add() { throw new Error('boom') } }), authed())
    assert.equal(res.statusCode, 500)
    assertNoStore(res)
  })
})

test('Authorizationが無い、Bearer形式でない、空トークンは401で、depsを呼ばない', async () => {
  const patterns = [undefined, 'Basic abc123', `Token ${TOKEN}`, TOKEN, 'Bearer', 'Bearer ', '']
  for (const authorization of patterns) {
    const deps = createDeps()
    const res = await run(deps, createReq({ authorization }))
    assert.equal(res.statusCode, 401, String(JSON.stringify(authorization)))
    assert.deepEqual(res.body, { error: 'unauthenticated' })
    assert.equal(deps.calls.isAdded.length, 0)
    assert.equal(deps.calls.find.length, 0)
    assert.equal(deps.calls.add.length, 0)
  }
})

test('トークン検証が失敗したら500ではなく401', async () => {
  const deps = createDeps({ async verifyIdToken() { throw new Error('token revoked') } })
  const res = await run(deps, authed())
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.body, { error: 'unauthenticated' })
  assert.equal(deps.calls.add.length, 0)
})

test('本文が不正でも未認証なら400ではなく401', async () => {
  const res = await run(createDeps(), createReq({ body: { topic: 'AI', articleId: '' } }))
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.body, { error: 'unauthenticated' })
})

test('topicがaiとmobile以外（未指定、大文字、配列）は400', async () => {
  const bodies = [
    { articleId: 'article-1' },
    { topic: undefined, articleId: 'article-1' },
    { topic: '', articleId: 'article-1' },
    { topic: 'AI', articleId: 'article-1' },
    { topic: 'Mobile', articleId: 'article-1' },
    { topic: ['ai'], articleId: 'article-1' },
    { topic: ['ai', 'mobile'], articleId: 'article-1' },
    { topic: 'other', articleId: 'article-1' },
  ]
  for (const body of bodies) {
    const deps = createDeps()
    const res = await run(deps, authed({ body }))
    assert.equal(res.statusCode, 400, JSON.stringify(body))
    assert.deepEqual(res.body, { error: 'invalid-argument' })
    assert.equal(deps.calls.find.length, 0)
    assert.equal(deps.calls.add.length, 0)
  }
})

test('articleIdが空、文字列でない、201文字以上、スラッシュ入りは400', async () => {
  const ids = ['', undefined, null, 123, ['article-1'], { a: 1 }, 'a'.repeat(201), 'a'.repeat(300), 'a/b', '/', 'x/']
  for (const articleId of ids) {
    const deps = createDeps()
    const res = await run(deps, authed({ body: { topic: 'ai', articleId } }))
    assert.equal(res.statusCode, 400, String(JSON.stringify(articleId)))
    assert.deepEqual(res.body, { error: 'invalid-argument' })
    assert.equal(deps.calls.isAdded.length, 0)
    assert.equal(deps.calls.find.length, 0)
    assert.equal(deps.calls.add.length, 0)
  }
})

test('articleIdが200文字ちょうどは受理される（境界）', async () => {
  const deps = createDeps()
  const res = await run(deps, authed({ body: { topic: 'ai', articleId: 'a'.repeat(200) } }))
  assert.equal(res.statusCode, 200)
  assert.equal(deps.calls.find[0].articleId, 'a'.repeat(200))
})

test('isAddedがtrueならfindArticleもaddも呼ばず 200 already', async () => {
  const deps = createDeps({
    async isAdded(uid, topic, articleId) { deps.calls.isAdded.push({ uid, topic, articleId }); return true },
  })
  const res = await run(deps, authed())
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { status: 'already' })
  assert.deepEqual(deps.calls.isAdded, [{ uid: UID, topic: 'ai', articleId: 'article-1' }])
  assert.equal(deps.calls.find.length, 0)
  assert.equal(deps.calls.add.length, 0)
})

test('isAddedがfalseでfindArticleがnullなら404 not-found で、addを呼ばない', async () => {
  const deps = createDeps({
    async findArticle(uid, topic, articleId) { deps.calls.find.push({ uid, topic, articleId }); return null },
  })
  const res = await run(deps, authed())
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.body, { error: 'not-found' })
  assert.equal(deps.calls.find.length, 1)
  assert.equal(deps.calls.add.length, 0)
})

test('addがcreatedなら 200 created。addはトークンのuid、topic、サーバーが見つけた記事で1回だけ呼ばれる', async () => {
  const found = { id: 'article-1', title: 'サーバー側の題', summary: 'サーバー側の概要', url: 'https://example.com/server' }
  const deps = createDeps({
    async findArticle(uid, topic, articleId) { deps.calls.find.push({ uid, topic, articleId }); return found },
  })
  const res = await run(deps, authed({ body: { topic: 'mobile', articleId: 'article-1' } }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { status: 'created' })
  assert.deepEqual(deps.calls.verify, [TOKEN])
  assert.deepEqual(deps.calls.find, [{ uid: UID, topic: 'mobile', articleId: 'article-1' }])
  assert.equal(deps.calls.add.length, 1)
  assert.equal(deps.calls.add[0].uid, UID)
  assert.equal(deps.calls.add[0].topic, 'mobile')
  assert.deepEqual(deps.calls.add[0].article, found)
})

test('本文にtitleやurlやuidを付けても、addに渡る記事はサーバーが見つけたもの', async () => {
  const found = { id: 'article-1', title: 'サーバー側の題', summary: 'サーバー側の概要', url: 'https://example.com/server' }
  const deps = createDeps({
    async findArticle(uid, topic, articleId) { deps.calls.find.push({ uid, topic, articleId }); return found },
  })
  const res = await run(deps, authed({
    body: {
      topic: 'ai',
      articleId: 'article-1',
      title: 'クライアントが送った題',
      summary: 'クライアントが送った概要',
      url: 'https://example.com/client',
      uid: 'other-user-2',
    },
  }))
  assert.equal(res.statusCode, 200)
  assert.equal(deps.calls.add.length, 1)
  assert.equal(deps.calls.add[0].uid, UID)
  assert.deepEqual(deps.calls.add[0].article, found)
  assert.equal(deps.calls.find[0].uid, UID)
})

test('addがalreadyを返すと 200 already', async () => {
  const deps = createDeps({ async add() { return 'already' } })
  const res = await run(deps, authed())
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { status: 'already' })
})

test('depsのどれかが例外なら 500 internal で、応答にもログにもuid・トークン・記事内容を含まない', async () => {
  const failures = {
    isAdded: { async isAdded() { throw new Error('boom') } },
    findArticle: { async findArticle() { throw new Error('boom') } },
    add: { async add() { throw new Error('boom') } },
  }
  for (const [name, override] of Object.entries(failures)) {
    let res
    const text = await withSilencedConsole(async () => {
      res = await run(createDeps(override), authed())
    })
    assert.equal(res.statusCode, 500, name)
    assert.deepEqual(res.body, { error: 'internal' }, name)
    const responseText = JSON.stringify(res.body)
    for (const secret of [UID, TOKEN, ARTICLE.title, ARTICLE.summary, ARTICLE.url]) {
      assert.ok(!responseText.includes(secret), `${name}: 応答に含まれている`)
      assert.ok(!text.includes(secret), `${name}: ログに含まれている`)
    }
  }
})
