const test = require('node:test')
const assert = require('node:assert/strict')

// 読み込み失敗は各テスト内で報告し、残りのテストも列挙する。
let api = null
let loadError = null
try {
  api = require('../lib/news/widgetReadLaterUrlApi')
} catch (error) {
  loadError = error
}
function mod() {
  if (!api) throw new Error(`widgetReadLaterUrlApi が未実装です: ${loadError && loadError.code}`)
  assert.equal(typeof api.createWidgetReadLaterUrlHandler, 'function', 'handler が未実装です')
  return api
}

const UID = 'user-fictional-1'
const TOKEN = 'fictional-id-token'
const ENTRY = {
  url: 'https://example.com/shared?source=fictional#section',
  title: '架空の共有タイトル',
  description: '架空の共有説明文',
}

function createDeps({ status = 'created', verifyError, addError } = {}) {
  const calls = { verify: [], add: [] }
  return {
    calls,
    async verifyIdToken(token) {
      calls.verify.push(token)
      if (verifyError) throw verifyError
      return { uid: UID }
    },
    async add(uid, entry) {
      calls.add.push({ uid, entry })
      if (addError) throw addError
      return status
    },
  }
}

function request(body = ENTRY) {
  return { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body }
}

async function run(deps, req) {
  const res = {
    statusCode: null,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this },
    json(body) { this.body = body; return this },
  }
  await mod().createWidgetReadLaterUrlHandler(deps)(req, res)
  // エラー系を含む、すべての応答で確かめる。
  assert.equal(res.headers['cache-control'], 'private, no-store')
  return res
}

function assertResponse(res, statusCode, body) {
  assert.equal(res.statusCode, statusCode)
  assert.deepEqual(res.body, body)
}

for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
  test(`${method} は認証や本文の検証より先に405を返す`, async () => {
    const deps = createDeps()
    const res = await run(deps, { method, headers: {}, body: null })
    assertResponse(res, 405, { error: 'method-not-allowed' })
    assert.deepEqual(deps.calls, { verify: [], add: [] })
  })
}

const invalidAuthorization = [
  ['未指定', undefined], ['Basic', 'Basic fictional'], ['Token', `Token ${TOKEN}`],
  ['Bearerなし', TOKEN], ['空文字', ''], ['トークンなし', 'Bearer'],
  ['空白のみ', 'Bearer '], ['複数トークン', 'Bearer fictional extra'],
  ['末尾空白', `Bearer ${TOKEN} `], ['配列', [`Bearer ${TOKEN}`]],
]
for (const [label, authorization] of invalidAuthorization) {
  test(`Authorizationが${label}なら本文が不正でも401、依存は呼ばない`, async () => {
    const deps = createDeps()
    const req = request(null)
    req.headers = authorization === undefined ? {} : { authorization }
    assertResponse(await run(deps, req), 401, { error: 'unauthenticated' })
    assert.deepEqual(deps.calls, { verify: [], add: [] })
  })
}

test('トークン検証の失敗は本文の検証より先に401、storeは呼ばない', async () => {
  const deps = createDeps({ verifyError: new Error('fictional-revoked') })
  assertResponse(await run(deps, request(null)), 401, { error: 'unauthenticated' })
  assert.deepEqual(deps.calls, { verify: [TOKEN], add: [] })
})

for (const status of ['created', 'already']) {
  test(`整形済みの本文と認証UIDをstoreへ1回渡し、200 ${status}を返す`, async () => {
    const deps = createDeps({ status })
    const req = request({
      url: ` \n${ENTRY.url}\t `,
      title: ` ${ENTRY.title} `,
      description: `\n${ENTRY.description}\t`,
      uid: 'user-fictional-other',
    })
    req.headers.authorization = `bEaReR\t ${TOKEN}`
    assertResponse(await run(deps, req), 200, { status })
    assert.deepEqual(deps.calls, { verify: [TOKEN], add: [{ uid: UID, entry: ENTRY }] })
  })
}

const longUrl = length => 'https://example.com/'.padEnd(length, 'a')
const invalidBodies = [
  ['本文なし', undefined], ['本文null', null], ['本文文字列', 'fictional'],
  ['本文数値', 123], ['本文配列', []], ['urlなし', {}], ['url数値', { url: 123 }],
  ['url null', { url: null }], ['url配列', { url: [ENTRY.url] }],
  ['url空文字', { url: '' }], ['url空白', { url: ' \n\t ' }],
  ['2049文字', { url: longUrl(2049) }],
  ['http', { url: 'http://example.com/shared' }],
  ['javascript', { url: 'javascript:void(0)' }],
  ['ftp', { url: 'ftp://example.com/shared' }],
  ['解釈不能', { url: 'fictional-not-a-url' }], ['ホストなし', { url: 'https://' }],
  ['ユーザー名とパスワード', { url: 'https://user:pass@example.com/shared' }],
  ['ユーザー名のみ', { url: 'https://user@example.com/shared' }],
  ['パスワードのみ', { url: 'https://:pass@example.com/shared' }],
]
for (const field of ['title', 'description']) {
  for (const value of [123, null, [], {}, false]) {
    invalidBodies.push([`${field}が${JSON.stringify(value)}`, { url: ENTRY.url, [field]: value }])
  }
}
for (const [label, body] of invalidBodies) {
  test(`${label}は400でstoreを呼ばない`, async () => {
    const deps = createDeps()
    // undefinedも既定の本文に置き換えず、そのまま渡す。
    const req = request()
    req.body = body
    assertResponse(await run(deps, req), 400, { error: 'invalid-argument' })
    assert.deepEqual(deps.calls, { verify: [TOKEN], add: [] })
  })
}

test('urlの長さは空白除去後に判定し、2048文字は受理する', async () => {
  const url = longUrl(2048)
  const deps = createDeps()
  assertResponse(await run(deps, request({ url: ` \n${url}\t ` })), 200, { status: 'created' })
  assert.deepEqual(deps.calls.add, [{ uid: UID, entry: { url } }])
})

test('urlのクエリ・フラグメント・表記を空白除去以外は変えない', async () => {
  const url = 'https://EXAMPLE.com:443/a%2fb?x=1&x=2#MixedCase'
  const deps = createDeps()
  assertResponse(await run(deps, request({ url: ` ${url} ` })), 200, { status: 'created' })
  assert.deepEqual(deps.calls.add, [{ uid: UID, entry: { url } }])
})

for (const [label, optional] of [
  ['未指定', {}], ['空文字', { title: '', description: '' }],
  ['空白のみ', { title: ' \t ', description: '\n　 ' }],
]) {
  test(`titleとdescriptionが${label}ならentryからキーごと省略する`, async () => {
    const deps = createDeps()
    assertResponse(await run(deps, request({ url: ENTRY.url, ...optional })), 200, { status: 'created' })
    const entry = deps.calls.add[0].entry
    assert.deepEqual(entry, { url: ENTRY.url })
    assert.equal(Object.hasOwn(entry, 'title'), false)
    assert.equal(Object.hasOwn(entry, 'description'), false)
  })
}

for (const [field, limit] of [['title', 300], ['description', 1000]]) {
  for (const character of ['a', '😀']) {
    for (const excess of [0, 1]) {
      test(`${field}は${character}の${limit + excess}文字をコードポイント単位で${limit}文字まで渡す`, async () => {
        const deps = createDeps()
        const value = character.repeat(limit + excess)
        assertResponse(await run(deps, request({ url: ENTRY.url, [field]: ` ${value} ` })), 200, { status: 'created' })
        assert.deepEqual(deps.calls.add, [{ uid: UID, entry: { url: ENTRY.url, [field]: character.repeat(limit) } }])
      })
    }
  }
}

test('storeが例外を投げたら500で、応答・ログに入力やUIDやトークンを出さない', async t => {
  const logged = []
  for (const level of ['error', 'warn', 'info', 'log', 'debug']) {
    t.mock.method(console, level, (...args) => { logged.push(args) })
  }
  const addError = new Error([UID, TOKEN, ...Object.values(ENTRY)].join(' '))
  const deps = createDeps({ addError })
  const res = await run(deps, request())
  assertResponse(res, 500, { error: 'internal' })
  assert.equal(deps.calls.add.length, 1)
  assert.ok(logged.length > 0, '失敗を固定文言で記録していない')
  const surfaced = JSON.stringify({ body: res.body, logged }, (_key, value) => value instanceof Error ? value.message : value)
  for (const secret of [UID, TOKEN, ...Object.values(ENTRY)]) {
    assert.equal(surfaced.includes(secret), false, '応答かログに入力が含まれている')
  }
})

test('成功時も入力をログへ出さず、URLへfetchしない', async t => {
  const logged = []
  for (const level of ['error', 'warn', 'info', 'log', 'debug']) {
    t.mock.method(console, level, (...args) => { logged.push(args) })
  }
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('URL取得は禁止') })
  for (const status of ['created', 'already']) {
    assertResponse(await run(createDeps({ status }), request()), 200, { status })
  }
  assert.equal(fetch.mock.callCount(), 0)
  for (const secret of [UID, TOKEN, ...Object.values(ENTRY)]) {
    assert.equal(JSON.stringify(logged).includes(secret), false)
  }
})
