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
const BODY = { schemaVersion: 2, topic: 'ai', feedDate: '2026-11-03', revision: 'a'.repeat(64), articleId: ARTICLE.id, action: 'undismiss', operationId: '12345678-1234-1234-1234-123456789abc' }
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
      async apply(input) { calls.push(['apply', input]); return result({ ...input, articleId: input.article.id }, 'applied') },
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

test('undismissを受け付け原本の記事とactionをstoreへ渡して200を返す', async () => {
  const ctx = setup(); const res = await run(ctx)
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, result())
  assert.deepEqual(kinds(ctx), ['verify', 'receipt', 'now', 'daily', 'apply'])
  assert.deepEqual(ctx.calls.at(-1)[1], { uid: UID, operationId: BODY.operationId, fingerprint: mod().newsActionFingerprint(BODY), action: 'undismiss', topic: 'ai', feedDate: BODY.feedDate, revision: BODY.revision, article: ARTICLE })
  assert.ok(!('taskId' in res.body))
})
for (const action of ['undo', 'UNDISMISS']) test(`未知のactionは400で保存しない: ${action}`, async () => {
  const ctx = setup()
  assert.equal((await run(ctx, { body: { ...BODY, action } })).statusCode, 400)
  assert.deepEqual(kinds(ctx), ['verify'])
})
for (const same of [true, false]) test(`undismissのreceiptを期限・原本より先に検証する: 指紋一致=${same}`, async () => {
  const body = { ...BODY, feedDate: '2020-01-01' }; const saved = result(body, 'already')
  const ctx = setup({ store: {
    async findReceipt(uid, operationId) { ctx.calls.push(['receipt', uid, operationId]); return { fingerprint: same ? mod().newsActionFingerprint(body) : 'different', result: saved } },
    async apply() { assert.fail('再適用しない') },
  } })
  const res = await run(ctx, { body })
  assert.equal(res.statusCode, same ? 200 : 409)
  if (same) assert.deepEqual(res.body, saved)
  assert.deepEqual(kinds(ctx), ['verify', 'receipt'])
})
for (const [label, daily] of [['原本なし', null], ['revision不一致', makeDaily(BODY.feedDate, 'b'.repeat(64))], ['記事なし', makeDaily(BODY.feedDate, BODY.revision, [])]]) test(`undismissも原本照合で404: ${label}`, async () => {
  const ctx = setup({ async loadDaily(date) { ctx.calls.push(['daily', date]); return daily } })
  assert.equal((await run(ctx)).statusCode, 404)
  assert.deepEqual(kinds(ctx), ['verify', 'receipt', 'now', 'daily'])
})
for (const [now, feedDate, status] of [
  ['2026-11-02T14:59:59.999Z', '2026-10-03', 200],
  ['2026-11-02T15:00:00.000Z', '2026-10-03', 410],
  ['2026-11-02T15:00:00.000Z', '2026-10-04', 200],
]) test(`undismissの30日期限はJST基準: ${now} / ${feedDate}`, async () => {
  const ctx = setup({ now: () => new Date(now) })
  assert.equal((await run(ctx, { body: { ...BODY, feedDate } })).statusCode, status)
  if (status === 410) assert.deepEqual(kinds(ctx), ['verify', 'receipt'])
})
