const test = require('node:test')
const assert = require('node:assert/strict')

// 未実装でも、各契約の失敗を独立して表示する。
let api, loadError
try { api = require('../lib/news/v2/newsActionApi') } catch (error) { loadError = error }
function mod() {
  if (!api) throw new Error(`newsActionApi が未実装です: ${loadError?.message}`)
  return api
}
const UID = 'fictional-curator'
const TOKEN = 'fictional-id-token'
const ORIGIN = 'https://example.com'
const ARTICLE = { id: 'fictional-article', title: '架空のタイトル', summary: '架空の概要', url: 'https://example.com/article', titleEn: 'Fictional article', tags: ['ai'] }
const BODY = { schemaVersion: 2, topic: 'ai', feedDate: '2026-11-03', revision: 'a'.repeat(64), articleId: ARTICLE.id, action: 'dismiss', operationId: '12345678-1234-1234-1234-123456789abc' }
const result = (body = BODY, status = 'applied') => ({ operationId: body.operationId, articleId: body.articleId, action: body.action, status })
function makeDaily(date = BODY.feedDate, revision = BODY.revision, articles = [ARTICLE]) {
  return {
    schemaVersion: 2, topic: 'ai', feedDate: date, learningCutoffAt: `${date}T00:00:00.000Z`,
    feed: { schemaVersion: 2, topic: 'ai', feedDate: date, generatedAt: `${date}T00:00:00.000Z`, revision, totalCount: articles.length, articles: articles.map(article => ({ ...article, sourceName: '架空の配信元', publishedAt: null })) },
    actionArticles: articles,
  }
}
function setup(overrides = {}) {
  const calls = []
  const deps = {
    curatorUid: UID,
    allowedOrigins: [ORIGIN],
    now() { calls.push(['now']); return new Date('2026-11-03T00:00:00Z') },
    async verifyIdToken(token) { calls.push(['verify', token]); return { uid: UID, newsRole: 'curator' } },
    async loadDaily(date) { calls.push(['daily', date]); return makeDaily(date) },
    store: {
      async findReceipt(...args) { calls.push(['receipt', ...args]); return null },
      async apply(input) { calls.push(['apply', input]); return result({ ...input, articleId: input.article.id }, input.action === 'dismiss' ? 'applied' : 'created') },
    },
    ...overrides,
  }
  return { deps, calls }
}
async function run(ctx, options = {}) {
  const req = { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN }, body: { ...BODY }, ...options }
  const res = {
    headers: {}, statusCode: null, body: undefined,
    set(name, value) { if (typeof name === 'object') { for (const [k, v] of Object.entries(name)) this.headers[k.toLowerCase()] = v } else this.headers[name.toLowerCase()] = value; return this },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    send(body) { this.body = body; return this },
    end() { return this },
  }
  await mod().createNewsActionHandler(ctx.deps)(req, res)
  assert.equal(res.headers['cache-control'], 'private, no-store')
  if (req.method === 'POST' && req.headers.origin === ORIGIN) assert.equal(res.headers['access-control-allow-origin'], ORIGIN)
  return res
}
const kinds = ctx => ctx.calls.map(c => c[0])

test('公開入口2箇所から newsAction を export する', () => {
  for (const path of ['../lib', '../lib/news']) {
    const fn = require(path).newsAction
    assert.equal(typeof fn, 'function')
    assert.deepEqual(fn.__endpoint.region, ['asia-northeast1'])
    assert.equal(fn.__endpoint.platform, 'gcfv1')
    assert.ok(fn.__endpoint.httpsTrigger)
  }
})
for (const origin of [ORIGIN, 'https://untrusted.example.com', undefined]) {
  test(`OPTIONS は origin を検証し依存処理を呼ばない: ${origin}`, async () => {
    const ctx = setup()
    const res = await run(ctx, { method: 'OPTIONS', headers: { origin } })
    assert.equal(res.statusCode, origin === ORIGIN ? 204 : 403)
    assert.deepEqual(ctx.calls, [])
    if (origin === ORIGIN) {
      assert.equal(res.headers['access-control-allow-origin'], ORIGIN)
      assert.equal(res.headers['access-control-allow-methods'], 'POST')
      const headers = String(res.headers['access-control-allow-headers']).toLowerCase().split(',').map(s => s.trim())
      assert.deepEqual(headers.sort(), ['authorization', 'content-type'])
    } else assert.equal(res.headers['access-control-allow-origin'], undefined)
  })
}
for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) test(`${method} は405、依存処理なし`, async () => {
  const ctx = setup(); assert.equal((await run(ctx, { method })).statusCode, 405); assert.deepEqual(ctx.calls, [])
})
for (const authorization of [undefined, '', 'Basic fictional', 'Bearer', 'Bearer one two', ['Bearer fictional']]) test(`不正Bearerは401: ${JSON.stringify(authorization)}`, async () => {
  const ctx = setup(); assert.equal((await run(ctx, { headers: { authorization } })).statusCode, 401); assert.deepEqual(ctx.calls, [])
})
test('検証失敗は401、以降を呼ばない', async () => {
  const ctx = setup({ async verifyIdToken() { throw new Error('fictional-expired') } })
  assert.equal((await run(ctx)).statusCode, 401); assert.deepEqual(ctx.calls, [])
})
for (const [label, override] of [
  ['未設定UID', { curatorUid: undefined }], ['空UID', { curatorUid: '' }],
  ...[undefined, 'viewer', true, ['curator'], 'CURATOR'].map(newsRole => [`role=${JSON.stringify(newsRole)}`, { async verifyIdToken() { return { uid: UID, newsRole } } }]),
  ['別UID', { async verifyIdToken() { return { uid: 'fictional-other', newsRole: 'curator' } } }],
]) test(`認可拒否は403、body検証・Storage・storeに進まない: ${label}`, async () => {
  const ctx = setup(override)
  assert.equal((await run(ctx, { body: null })).statusCode, 403)
  assert.ok(kinds(ctx).every(k => k === 'verify'))
})
const invalid = [null, [], 'body', 1, ...Object.keys(BODY).map(key => { const b = { ...BODY }; delete b[key]; return b })]
for (const [key, values] of Object.entries({
  schemaVersion: [1, '2', null], topic: ['mobile', '', null],
  feedDate: ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-1-03', '2026-11-03T00:00:00Z', 20261103],
  revision: ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null],
  articleId: ['', 'a'.repeat(201), 'a/b', null, 1], action: ['delete', '', null],
  operationId: ['', '12345678123412341234123456789abc', 'xxxxxxxx-1234-1234-1234-123456789abc', '12345678-1234-1234-1234-123456789ab', null],
})) for (const value of values) invalid.push({ ...BODY, [key]: value })
for (const key of ['uid', 'title', 'summary', 'listId', 'url', 'task', 'extra']) invalid.push({ ...BODY, [key]: 'fictional' })
invalid.forEach((body, i) => test(`不正body ${i + 1} は400、receipt参照より前に拒否`, async () => {
  const ctx = setup(); assert.equal((await run(ctx, { body })).statusCode, 400); assert.deepEqual(kinds(ctx), ['verify'])
}))
test('認証、receipt、期限、daily、apply の順でサーバー原本の記事を渡す', async () => {
  const ctx = setup(); const res = await run(ctx)
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, result())
  assert.deepEqual(kinds(ctx), ['verify', 'receipt', 'now', 'daily', 'apply'])
  assert.deepEqual(ctx.calls[1], ['receipt', UID, BODY.operationId])
  assert.deepEqual(ctx.calls.at(-1)[1], { uid: UID, operationId: BODY.operationId, fingerprint: mod().newsActionFingerprint(BODY), action: BODY.action, topic: 'ai', feedDate: BODY.feedDate, revision: BODY.revision, article: ARTICLE })
})
test('200字の記事ID、大文字UUID、閏日の実在日は受理する', async () => {
  const body = { ...BODY, articleId: 'a'.repeat(200), operationId: BODY.operationId.toUpperCase(), feedDate: '2024-02-29' }
  const ctx = setup({ now: () => new Date('2024-03-01T00:00:00Z'), async loadDaily() { return makeDaily(body.feedDate, body.revision, [{ ...ARTICLE, id: body.articleId }]) } })
  assert.equal((await run(ctx, { body })).statusCode, 200)
})
for (const same of [true, false]) test(`期限切れでもreceiptを先に調べる: 指紋一致=${same}`, async () => {
  const body = { ...BODY, feedDate: '2020-01-01' }; const saved = { ...result(body), marker: 'fictional-saved-result' }
  const ctx = setup({ store: { async findReceipt() { return { fingerprint: same ? mod().newsActionFingerprint(body) : 'different', result: saved } }, async apply() { assert.fail('apply禁止') } } })
  const res = await run(ctx, { body }); assert.equal(res.statusCode, same ? 200 : 409)
  if (same) assert.deepEqual(res.body, saved)
  assert.deepEqual(kinds(ctx), ['verify'])
})
for (const [now, date, status] of [
  ['2026-11-02T14:59:59.999Z', '2026-10-03', 200],
  ['2026-11-02T15:00:00.000Z', '2026-10-03', 410],
  ['2026-11-02T15:00:00.000Z', '2026-10-04', 200],
]) test(`JST日付境界 ${now} / ${date} → ${status}`, async () => {
  const ctx = setup({ now: () => new Date(now) }); assert.equal((await run(ctx, { body: { ...BODY, feedDate: date } })).statusCode, status)
  if (status === 410) assert.deepEqual(kinds(ctx), ['verify', 'receipt'])
})
for (const daily of [null, makeDaily(BODY.feedDate, 'b'.repeat(64)), makeDaily(BODY.feedDate, BODY.revision, [])]) test(`原本・revision・記事が不一致なら404: ${JSON.stringify(daily)}`, async () => {
  const ctx = setup({ async loadDaily() { return daily } }); assert.equal((await run(ctx)).statusCode, 404); assert.ok(!kinds(ctx).includes('apply'))
})
for (const status of ['created', 'already']) test(`readLaterの確定結果 ${status} とtaskIdをそのまま返す`, async () => {
  const body = { ...BODY, action: 'readLater' }; const expected = { ...result(body, status), taskId: 'readlater_fictional' }
  const ctx = setup({ store: { async findReceipt() { return null }, async apply() { return expected } } })
  const res = await run(ctx, { body }); assert.equal(res.statusCode, 200); assert.deepEqual(res.body, expected)
})
for (const stage of ['verifyIdToken', 'findReceipt', 'loadDaily', 'apply']) test(`${stage} 例外は安全な401/500で返す`, async () => {
  const ctx = setup(); const sensitive = [UID, TOKEN, ARTICLE.title, ARTICLE.summary, ARTICLE.url]
  const fail = async () => { throw new Error(sensitive.join(' ')) }
  if (stage === 'findReceipt' || stage === 'apply') ctx.deps.store[stage] = fail
  else ctx.deps[stage] = fail
  const logs = []; const originals = new Map()
  for (const name of ['log', 'warn', 'error', 'info', 'debug']) { originals.set(name, console[name]); console[name] = (...args) => logs.push(args) }
  let res
  try { res = await run(ctx) } finally { for (const [name, original] of originals) console[name] = original }
  assert.equal(res.statusCode, stage === 'verifyIdToken' ? 401 : 500)
  const output = JSON.stringify(res.body) + logs.flat().map(v => v instanceof Error ? v.stack : JSON.stringify(v)).join(' ')
  for (const value of sensitive) assert.ok(!output.includes(value), '応答・ログに機密データを含めない')
})
test('fingerprint は64hexでoperationId・キー順に依存せず可変の意味フィールドに依存する', () => {
  const fingerprint = mod().newsActionFingerprint
  const expected = fingerprint(BODY)
  assert.match(expected, /^[0-9a-f]{64}$/)
  assert.equal(fingerprint({ ...BODY, operationId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }), expected)
  assert.equal(fingerprint(Object.fromEntries(Object.entries(BODY).reverse())), expected)
  for (const [key, value] of Object.entries({ feedDate: '2026-11-02', revision: 'b'.repeat(64), articleId: 'other', action: 'readLater' })) assert.notEqual(fingerprint({ ...BODY, [key]: value }), expected)
})

test('未認証かつ不正bodyでもbody検証より先に401を返す', async () => {
  const ctx = setup()
  assert.equal((await run(ctx, { headers: {}, body: null })).statusCode, 401)
  assert.deepEqual(ctx.calls, [])
})
test('不許可originのPOSTには許可originヘッダーを付けない', async () => {
  const ctx = setup()
  const res = await run(ctx, { headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://untrusted.example.com' } })
  assert.equal(res.headers['access-control-allow-origin'], undefined)
})
test('成功時もログにUID・トークン・原本タイトル・概要・URLを出さない', async () => {
  const ctx = setup(); const logs = []; const originals = new Map()
  for (const name of ['log', 'warn', 'error', 'info', 'debug']) { originals.set(name, console[name]); console[name] = (...args) => logs.push(args) }
  let res
  try { res = await run(ctx) } finally { for (const [name, original] of originals) console[name] = original }
  assert.equal(res.statusCode, 200)
  const output = JSON.stringify(res.body) + logs.flat().map(v => v instanceof Error ? v.stack : JSON.stringify(v)).join(' ')
  for (const value of [UID, TOKEN, ARTICLE.title, ARTICLE.summary, ARTICLE.url]) assert.ok(!output.includes(value), '応答・ログに機密データを含めない')
})

test('openを受け付け記事照合済みのevent保存へ渡しタスク結果を返さない', async () => {
  const ctx = setup({ store: { async findReceipt() { return null }, async apply(input) { ctx.calls.push(['apply', input]); return result({ ...BODY, action: 'open' }) } } })
  const response = await run(ctx, { body: { ...BODY, action: 'open' } })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, result({ ...BODY, action: 'open' }))
  assert.equal(ctx.calls.find(call => call[0] === 'apply')[1].action, 'open')
  assert.ok(!('taskId' in response.body))
})
test('未知のactionは400で保存を呼ばない', async () => {
  const ctx = setup()
  assert.equal((await run(ctx, { body: { ...BODY, action: 'fiction-unknown' } })).statusCode, 400)
  assert.ok(!kinds(ctx).includes('apply'))
})
test('同じoperationIdでもdismissとopenは別指紋として409にする', async () => {
  let fingerprint
  const first = setup({ store: { async findReceipt() { return null }, async apply(input) { fingerprint = input.fingerprint; return result() } } })
  assert.equal((await run(first)).statusCode, 200)
  const second = setup({ store: { async findReceipt() { return { fingerprint, result: result() } }, async apply() { assert.fail('保存は呼ばない') } } })
  assert.equal((await run(second, { body: { ...BODY, action: 'open' } })).statusCode, 409)
})
