const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { addReadLaterTask } = require('../lib/news/widgetReadLaterStore')

let store, loadError
try { store = require('../lib/news/v2/newsActionStore') } catch (error) { loadError = error }
function mod() {
  if (!store) throw new Error(`newsActionStore が未実装です: ${loadError?.message}`)
  return store
}
const UID = 'fictional-curator'
const OP1 = '12345678-1234-1234-1234-123456789abc'
const OP2 = '22345678-1234-1234-1234-123456789abc'
const ARTICLE = { id: 'fictional-article', title: '架空の記事', summary: '架空の概要', url: 'https://example.com/article', titleEn: 'Fictional article', tags: ['ai'] }
const TS = { __fictionalServerTimestamp: true }
const hash = text => createHash('sha256').update(text).digest('hex')
const taskId = `readlater_${hash(`ai:${ARTICLE.id}`).slice(0, 32)}`
const receiptPath = (op = OP1, uid = UID) => `users/${uid}/newsActionReceipts/${op}`
const eventPath = (action = 'dismiss', uid = UID) => `users/${uid}/newsActionEvents/${hash(`${uid}:ai:${ARTICLE.id}:${action}`).slice(0, 32)}`
const input = (extra = {}) => ({ uid: UID, operationId: OP1, fingerprint: 'a'.repeat(64), action: 'dismiss', topic: 'ai', feedDate: '2026-11-03', revision: 'b'.repeat(64), article: { ...ARTICLE }, ...extra })
const expected = (value, status) => ({ operationId: value.operationId, articleId: value.article.id, action: value.action, status, ...(value.action === 'readLater' ? { taskId } : {}) })

// transactionは直列化し、全readがwriteより前であることと、commitの原子性を再現する。
// データをその場で更新しないため、後続createの衝突・注入失敗でも途中結果は残らない。
function fakeDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([p, data]) => [p, structuredClone(data)]))
  const writes = [], commits = [], reads = []
  let queue = Promise.resolve()
  let failure = null
  const snapshot = path => ({ id: path.split('/').at(-1), ref: db.doc(path), exists: docs.has(path), data: () => docs.get(path) })
  function query(path, filters = [], order = null, count = Infinity) {
    return {
      path,
      where(field, op, value) { assert.equal(op, '=='); return query(path, [...filters, [field, value]], order, count) },
      orderBy(field, direction) { return query(path, filters, [field, direction], count) },
      limit(n) { return query(path, filters, order, n) },
      doc(id) { return db.doc(`${path}/${id}`) },
      async get() {
        reads.push(path)
        let items = [...docs.keys()].filter(p => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/')).map(snapshot)
        items = items.filter(item => filters.every(([key, value]) => item.data()[key] === value))
        if (order) items.sort((a, b) => (Number(a.data()[order[0]]) - Number(b.data()[order[0]])) * (order[1] === 'desc' ? -1 : 1))
        items = items.slice(0, count)
        return { empty: !items.length, size: items.length, docs: items }
      },
    }
  }
  function writer(transactional) {
    const pending = []
    const tx = {
      async get(ref) {
        assert.equal(pending.length, 0, 'Firestore transactionはwrite後にreadできない')
        return ref.get()
      },
      async getAll(...refs) { return Promise.all(refs.map(ref => tx.get(ref))) },
      create(ref, data) { pending.push({ op: 'create', path: ref.path, data }); return tx },
      set(ref, data, options) { pending.push({ op: 'set', path: ref.path, data, options }); return tx },
      update(ref, data) { pending.push({ op: 'update', path: ref.path, data }); return tx },
      async commit() {
        const next = new Map(docs)
        for (let i = 0; i < pending.length; i++) {
          const w = pending[i]
          if (failure && failure(w, i)) throw Object.assign(new Error('fictional-write-failed'), { code: 14 })
          if (w.op === 'create' && next.has(w.path)) throw Object.assign(new Error('fictional-already-exists'), { code: 6 })
          if (w.op === 'update' && !next.has(w.path)) throw new Error('fictional-missing-document')
          next.set(w.path, structuredClone(w.options?.merge || w.op === 'update' ? { ...next.get(w.path), ...w.data } : w.data))
        }
        docs.clear(); for (const [path, data] of next) docs.set(path, data)
        writes.push(...structuredClone(pending)); commits.push({ transactional, writes: structuredClone(pending) })
      },
    }
    return tx
  }
  const db = {
    docs, writes, commits, reads,
    failWhen(fn) { failure = fn },
    doc(path) { return { path, id: path.split('/').at(-1), async get() { reads.push(path); return snapshot(path) }, collection(name) { return query(`${path}/${name}`) } } },
    collection(path) { return query(path) },
    batch() { return writer(false) },
    runTransaction(fn) {
      const next = queue.then(async () => { const tx = writer(true); const result = await fn(tx); await tx.commit(); return result })
      queue = next.catch(() => {})
      return next
    },
  }
  return db
}
function setup(seed) {
  const db = fakeDb(seed)
  const deps = { db, serverTimestamp: () => TS }
  return { db, deps, store: mod().createNewsActionStore(deps) }
}
function noInteractions(db) { assert.ok(!db.writes.some(w => w.path.includes('/newsInteractions/')), 'v2操作で旧dismiss状態を書かない') }
function assertAtomic(db) { assert.ok(db.commits.every(c => c.transactional), '操作の書込は同一transaction内に限定する') }

// fake自体の失敗をAPI未実装と混同しないための検証。
test('transaction fakeはwrite後readを拒否し、途中失敗時も全書込を破棄する', async () => {
  const db = fakeDb()
  await assert.rejects(db.runTransaction(async tx => { tx.create(db.doc('fictional/a'), { a: 1 }); await tx.get(db.doc('fictional/b')) }), /write後/)
  assert.equal(db.docs.size, 0)
  db.failWhen((w, i) => i === 1)
  await assert.rejects(db.runTransaction(async tx => { tx.create(db.doc('fictional/a'), { a: 1 }); tx.create(db.doc('fictional/b'), { b: 2 }) }), /fictional-write-failed/)
  assert.equal(db.docs.size, 0); assert.equal(db.writes.length, 0)
})
test('eventIdはUID・topic・記事・actionのSHA-256先頭32hex', () => {
  const id = mod().newsActionEventId
  assert.equal(id(UID, 'ai', ARTICLE.id, 'dismiss'), hash(`${UID}:ai:${ARTICLE.id}:dismiss`).slice(0, 32))
  const original = id(UID, 'ai', ARTICLE.id, 'dismiss')
  for (const args of [['fictional-other', 'ai', ARTICLE.id, 'dismiss'], [UID, 'mobile', ARTICLE.id, 'dismiss'], [UID, 'ai', 'other', 'dismiss'], [UID, 'ai', ARTICLE.id, 'readLater']]) assert.notEqual(id(...args), original)
})
test('findReceiptは指定UID・operationIdの保存データを返し、無ければnull', async () => {
  const saved = { fingerprint: 'a'.repeat(64), result: expected(input(), 'applied'), createdAt: TS }
  const ctx = setup({ [receiptPath()]: saved })
  assert.deepEqual(await ctx.store.findReceipt(UID, OP1), saved)
  assert.equal(await ctx.store.findReceipt(UID, OP2), null)
  assert.equal(await ctx.store.findReceipt('fictional-other', OP1), null)
  assert.equal(ctx.db.writes.length, 0)
})
test('dismissはeventとreceiptのみを1transactionでcreateする', async () => {
  const ctx = setup(); const value = input(); const res = await ctx.store.apply(value)
  assert.deepEqual(res, expected(value, 'applied'))
  assert.deepEqual([...ctx.db.docs.keys()].sort(), [eventPath(), receiptPath()].sort())
  assert.deepEqual(ctx.db.docs.get(eventPath()), { topic: 'ai', articleId: ARTICLE.id, action: 'dismiss', receivedAt: TS, feedDate: value.feedDate, revision: value.revision, title: ARTICLE.title, summary: ARTICLE.summary, url: ARTICLE.url, titleEn: ARTICLE.titleEn, tags: ARTICLE.tags })
  assert.deepEqual(ctx.db.docs.get(receiptPath()), { fingerprint: value.fingerprint, result: res, createdAt: TS })
  assert.ok(ctx.db.writes.every(w => w.op === 'create'))
  assert.equal(ctx.db.commits.length, 1); assertAtomic(ctx.db); noInteractions(ctx.db)
})
test('同じ記事の別operationIdはeventを上書きせず受付時刻も保持する', async () => {
  const ctx = setup(); await ctx.store.apply(input())
  const event = structuredClone(ctx.db.docs.get(eventPath())); const before = ctx.db.writes.length
  ctx.deps.serverTimestamp = () => ({ __fictionalLaterTimestamp: true })
  await ctx.store.apply(input({ operationId: OP2, feedDate: '2026-11-04', article: { ...ARTICLE, title: '変更後の架空タイトル' } }))
  assert.deepEqual(ctx.db.docs.get(eventPath()), event)
  assert.deepEqual(ctx.db.writes.slice(before).map(w => w.path), [receiptPath(OP2)])
  assert.equal(ctx.db.docs.size, 3); noInteractions(ctx.db)
})
for (const spaced of [false, true]) test(`readLaterはv1と完全に同じリスト・タスクを作る: memberships=${spaced}`, async () => {
  const base = spaced ? `spaces/personal_${UID}` : `users/${UID}`
  const seed = { ...(spaced ? { [`users/${UID}/memberships/fictional-membership`]: { spaceId: `personal_${UID}` } } : {}), [`${base}/lists/fictional-other-list`]: { name: '架空のリスト', position: 7 } }
  const legacyDb = fakeDb(seed)
  await addReadLaterTask({ db: legacyDb, serverTimestamp: () => TS }, UID, 'ai', ARTICLE)
  const ctx = setup(seed); const value = input({ action: 'readLater' })
  assert.deepEqual(await ctx.store.apply(value), expected(value, 'created'))
  assert.deepEqual(ctx.db.docs.get(`${base}/tasks/${taskId}`), legacyDb.docs.get(`${base}/tasks/${taskId}`))
  assert.deepEqual(ctx.db.docs.get(`${base}/lists/readlater_list`), legacyDb.docs.get(`${base}/lists/readlater_list`))
  assert.equal(ctx.db.docs.get(`${base}/lists/readlater_list`).position, 8)
  assert.equal(ctx.db.commits.length, 1); assertAtomic(ctx.db); noInteractions(ctx.db)
  assert.ok(ctx.db.writes.every(w => w.path.startsWith(`users/${UID}/`) || w.path.startsWith(`${base}/`)))
})
test('名前で既存あとで読むリストを再利用し、新規リストを作らない', async () => {
  const base = `users/${UID}`
  const ctx = setup({ [`${base}/lists/fictional-existing`]: { name: 'あとで読む', position: 5 } })
  await ctx.store.apply(input({ action: 'readLater' }))
  assert.equal(ctx.db.docs.get(`${base}/tasks/${taskId}`).listId, 'fictional-existing')
  assert.ok(!ctx.db.writes.some(w => w.path.includes('/lists/')))
})
test('空リストでは固定ID・position 1、URL省略時はv1同様タスクURLがnull', async () => {
  const ctx = setup(); const article = { id: ARTICLE.id, title: ARTICLE.title, summary: ARTICLE.summary }
  await ctx.store.apply(input({ action: 'readLater', article }))
  assert.equal(ctx.db.docs.get(`users/${UID}/lists/readlater_list`).position, 1)
  assert.equal(ctx.db.docs.get(`users/${UID}/tasks/${taskId}`).url, null)
  const event = ctx.db.docs.get(eventPath('readLater'))
  for (const key of ['url', 'titleEn', 'tags']) assert.ok(!(key in event))
  for (const data of ctx.db.docs.values()) for (const value of Object.values(data)) assert.notEqual(value, undefined)
})
test('別operationIdで同じreadLaterはalreadyで同じtaskId、タスクとeventを変更しない', async () => {
  const ctx = setup(); const first = input({ action: 'readLater' })
  assert.deepEqual(await ctx.store.apply(first), expected(first, 'created'))
  const oldTask = structuredClone(ctx.db.docs.get(`users/${UID}/tasks/${taskId}`))
  const oldEvent = structuredClone(ctx.db.docs.get(eventPath('readLater')))
  const count = ctx.db.writes.length; const second = input({ action: 'readLater', operationId: OP2 })
  assert.deepEqual(await ctx.store.apply(second), expected(second, 'already'))
  assert.deepEqual(ctx.db.docs.get(`users/${UID}/tasks/${taskId}`), oldTask)
  assert.deepEqual(ctx.db.docs.get(eventPath('readLater')), oldEvent)
  assert.deepEqual(ctx.db.writes.slice(count).map(w => w.path), [receiptPath(OP2)])
  noInteractions(ctx.db)
})
for (const spaced of [false, true]) test(`v1 addReadLaterTaskの既存タスクをalreadyとして保持: memberships=${spaced}`, async () => {
  const seed = spaced ? { [`users/${UID}/memberships/fictional-membership`]: {} } : {}
  const ctx = setup(seed)
  await addReadLaterTask(ctx.deps, UID, 'ai', ARTICLE)
  const base = spaced ? `spaces/personal_${UID}` : `users/${UID}`
  const original = structuredClone(ctx.db.docs.get(`${base}/tasks/${taskId}`)); const count = ctx.db.writes.length
  const value = input({ action: 'readLater', article: { ...ARTICLE, title: '更新された架空記事' } })
  assert.deepEqual(await ctx.store.apply(value), expected(value, 'already'))
  assert.deepEqual(ctx.db.docs.get(`${base}/tasks/${taskId}`), original)
  const added = ctx.db.writes.slice(count)
  assert.deepEqual(added.map(w => w.path).sort(), [eventPath('readLater'), receiptPath()].sort())
  assert.ok(!added.some(w => w.path.includes('/newsInteractions/')))
})
test('dismissとreadLaterは独立イベントになり、旧interactionを変更しない', async () => {
  const path = `users/${UID}/newsInteractions/ai_${ARTICLE.id}`
  const legacy = { dismissed: false, fictional: 'preserved' }
  const ctx = setup({ [path]: legacy })
  await ctx.store.apply(input())
  await ctx.store.apply(input({ action: 'readLater', operationId: OP2 }))
  assert.ok(ctx.db.docs.has(eventPath('dismiss'))); assert.ok(ctx.db.docs.has(eventPath('readLater')))
  assert.deepEqual(ctx.db.docs.get(path), legacy); noInteractions(ctx.db)
})
for (const action of ['dismiss', 'readLater']) test(`同一operationIdの同時再送は確定結果を返し、書込1回分: ${action}`, async () => {
  const ctx = setup(); const value = input({ action })
  const [a, b] = await Promise.all([ctx.store.apply(value), ctx.store.apply(value)])
  assert.deepEqual(a, expected(value, action === 'dismiss' ? 'applied' : 'created'))
  assert.deepEqual(b, a)
  assert.equal(ctx.db.commits.filter(c => c.writes.length > 0).length, 1)
  assert.equal(ctx.db.writes.filter(w => w.path === receiptPath()).length, 1)
  noInteractions(ctx.db); assertAtomic(ctx.db)
})
test('既存receiptがあれば原本記事やタスクを読み直さず保存結果を返す', async () => {
  const saved = { fingerprint: 'a'.repeat(64), result: expected(input({ action: 'readLater' }), 'created'), createdAt: TS }
  const ctx = setup({ [receiptPath()]: saved })
  assert.deepEqual(await ctx.store.apply(input({ action: 'readLater' })), saved.result)
  assert.equal(ctx.db.writes.length, 0)
  assert.ok(ctx.db.reads.every(p => p === receiptPath()))
})
for (const fragment of ['/newsActionEvents/', '/lists/', '/tasks/', '/newsActionReceipts/']) test(`transactionの${fragment}書込失敗ではタスク・リスト・event・receiptを全てロールバック`, async () => {
  const ctx = setup(); ctx.db.failWhen(w => w.path.includes(fragment))
  await assert.rejects(ctx.store.apply(input({ action: 'readLater' })))
  assert.equal(ctx.db.docs.size, 0); assert.equal(ctx.db.writes.length, 0)
})
test('同時初回の別記事readLaterでも固定リスト1件、タスク2件を作れる', async () => {
  const ctx = setup()
  const second = input({ operationId: OP2, action: 'readLater', article: { ...ARTICLE, id: 'fictional-second-article' } })
  const results = await Promise.all([ctx.store.apply(input({ action: 'readLater' })), ctx.store.apply(second)])
  assert.deepEqual(results.map(r => r.status), ['created', 'created'])
  assert.equal([...ctx.db.docs.keys()].filter(p => p.includes('/lists/')).length, 1)
  assert.equal([...ctx.db.docs.keys()].filter(p => p.includes('/tasks/')).length, 2)
  noInteractions(ctx.db); assertAtomic(ctx.db)
})
test('transaction fakeはv1のbatchとクエリも再現し、既存タスクを検出できる', async () => {
  const db = fakeDb()
  const deps = { db, serverTimestamp: () => TS }
  assert.equal(await addReadLaterTask(deps, UID, 'ai', ARTICLE), 'created')
  assert.ok(db.docs.has(`users/${UID}/tasks/${taskId}`))
  assert.equal(await addReadLaterTask(deps, UID, 'ai', ARTICLE), 'already')
  assert.equal(db.writes.filter(w => w.path === `users/${UID}/tasks/${taskId}`).length, 1)
})
