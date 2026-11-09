const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

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
const input = (extra = {}) => ({ uid: UID, operationId: OP1, fingerprint: 'a'.repeat(64), action: 'undismiss', topic: 'ai', feedDate: '2026-11-03', revision: 'b'.repeat(64), article: { ...ARTICLE }, ...extra })
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
      delete(ref) { pending.push({ op: 'delete', path: ref.path }); return tx },
      update(ref, data) { pending.push({ op: 'update', path: ref.path, data }); return tx },
      async commit() {
        const next = new Map(docs)
        for (let i = 0; i < pending.length; i++) {
          const w = pending[i]
          if (failure && failure(w, i)) throw Object.assign(new Error('fictional-write-failed'), { code: 14 })
          if (w.op === 'create' && next.has(w.path)) throw Object.assign(new Error('fictional-already-exists'), { code: 6 })
          if (w.op === 'update' && !next.has(w.path)) throw new Error('fictional-missing-document')
          if (w.op === 'delete') { next.delete(w.path); continue }
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
test('delete対応fakeは削除後readを拒否し、失敗時は削除とreceiptを共に破棄する', async () => {
  const db = fakeDb({ 'fictional/event': { action: 'dismiss' } })
  await assert.rejects(db.runTransaction(async tx => { tx.delete(db.doc('fictional/event')); await tx.get(db.doc('fictional/receipt')) }), /write後/)
  assert.ok(db.docs.has('fictional/event'))
  db.failWhen((write, index) => index === 1)
  await assert.rejects(db.runTransaction(async tx => { tx.delete(db.doc('fictional/event')); tx.create(db.doc('fictional/receipt'), {}) }), /fictional-write-failed/)
  assert.deepEqual([...db.docs.keys()], ['fictional/event']); assert.equal(db.commits.length, 0)
  db.failWhen(null)
  await db.runTransaction(async tx => { tx.delete(db.doc('fictional/event')); tx.create(db.doc('fictional/receipt'), {}) })
  assert.deepEqual([...db.docs.keys()], ['fictional/receipt'])
})
for (const exists of [true, false]) test(`undismissはdismissのみ削除しreceiptを同時保存する: 存在=${exists}`, async () => {
  const ctx = setup(exists ? { [eventPath()]: { action: 'dismiss' } } : {})
  const value = input(); const res = await ctx.store.apply(value)
  assert.deepEqual(res, expected(value, exists ? 'applied' : 'already'))
  assert.ok(!('taskId' in res))
  assert.deepEqual([...ctx.db.docs.keys()], [receiptPath()])
  assert.deepEqual(ctx.db.docs.get(receiptPath()), { fingerprint: value.fingerprint, result: res, createdAt: TS })
  assert.equal(ctx.db.commits.length, 1)
  assert.equal(ctx.db.commits[0].transactional, true)
  assert.deepEqual(ctx.db.commits[0].writes.map(w => [w.op, w.path]), [...(exists ? [['delete', eventPath()]] : []), ['create', receiptPath()]])
  assert.ok(!ctx.db.writes.some(w => w.op !== 'delete' && w.path.includes('/newsActionEvents/')), 'undismissのイベントを作らない')
  assert.ok(!ctx.db.reads.includes(eventPath('undismiss')), 'undismiss用のイベントIDを参照しない')
})
for (const spaced of [false, true]) test(`同じ記事のreadLater・open・タスク・リストと別記事のdismiss・他receiptを保持する: memberships=${spaced}`, async () => {
  const base = spaced ? `spaces/personal_${UID}` : `users/${UID}`
  const otherEvent = `users/${UID}/newsActionEvents/${hash(`${UID}:ai:fictional-other-article:dismiss`).slice(0, 32)}`
  const protectedDocs = {
    [eventPath('readLater')]: { action: 'readLater' }, [eventPath('open')]: { action: 'open' },
    [otherEvent]: { action: 'dismiss', articleId: 'fictional-other-article' },
    [`${base}/tasks/${taskId}`]: { name: '架空のタスク', listId: 'readlater_list' },
    [`${base}/lists/readlater_list`]: { name: 'あとで読む' }, [receiptPath(OP2)]: { fingerprint: 'fictional-other' },
    ...(spaced ? { [`users/${UID}/memberships/fictional-membership`]: { spaceId: `personal_${UID}` } } : {}),
  }
  const ctx = setup({ ...protectedDocs, [eventPath()]: { action: 'dismiss' } })
  await ctx.store.apply(input())
  assert.ok(!ctx.db.docs.has(eventPath()))
  for (const [path, data] of Object.entries(protectedDocs)) assert.deepEqual(ctx.db.docs.get(path), data)
  assert.deepEqual(ctx.db.writes.map(w => w.path), [eventPath(), receiptPath()])
})
test('undismiss後に新しいoperationIdのdismissでイベントが再作成される', async () => {
  const ctx = setup({ [eventPath()]: { action: 'dismiss', title: '取り消し前の架空記事' } })
  await ctx.store.apply(input())
  assert.ok(!ctx.db.docs.has(eventPath()))
  const next = input({ action: 'dismiss', operationId: OP2, fingerprint: 'c'.repeat(64) })
  assert.deepEqual(await ctx.store.apply(next), expected(next, 'applied'))
  assert.equal(ctx.db.docs.get(eventPath()).title, ARTICLE.title)
  assert.equal(ctx.db.docs.get(eventPath()).action, 'dismiss')
})
test('同じundismissの再送は保存結果だけ返し後から作られたdismissを消さない', async () => {
  const value = input(); const saved = expected(value, 'applied')
  const event = { action: 'dismiss', title: '再度興味なしにした架空記事' }
  const ctx = setup({ [receiptPath()]: { fingerprint: value.fingerprint, result: saved, createdAt: TS }, [eventPath()]: event })
  assert.deepEqual(await ctx.store.apply(value), saved)
  assert.deepEqual(ctx.db.docs.get(eventPath()), event)
  assert.deepEqual(ctx.db.writes, []); assert.deepEqual(ctx.db.reads, [receiptPath()])
})
test('同じoperationIdでfingerprintが違うundismissは競合として何も変更しない', async () => {
  const value = input()
  const seed = { [receiptPath()]: { fingerprint: 'c'.repeat(64), result: expected(value, 'applied') }, [eventPath()]: { action: 'dismiss' } }
  const ctx = setup(seed)
  await assert.rejects(ctx.store.apply(value), mod().NewsActionConflictError)
  assert.deepEqual(Object.fromEntries(ctx.db.docs), seed); assert.deepEqual(ctx.db.writes, [])
})
