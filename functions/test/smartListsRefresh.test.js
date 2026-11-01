const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const db = admin.firestore()
const { refreshSmartListCounts, canReuseSmartListCounts } = require('../lib/smartLists')
const stamp = date => admin.firestore.Timestamp.fromDate(date)
const values = { today: 2, tomorrow: 1, overdue: 0, thisWeek: 3, noDate: 4 }
const saved = (date = new Date()) => ({ smartListCounts: { ...values, lastUpdated: stamp(date) }, smartListCountsRecalculatedAt: stamp(date) })

// 実DBへ接続せず、公開callableが要求するクエリと保存を記録する。
async function call({ document = saved(), request = {}, member = true, authenticated = true, retry = false } = {}) {
  const originals = { doc: db.doc, collection: db.collection, runTransaction: db.runTransaction }
  const reads = [], writes = []
  let scans = 0
  db.doc = path => ({ path, get: async () => ({ exists: member, data: () => ({ status: member ? 'active' : 'inactive' }) }) })
  db.collection = path => ({ where(field, operator, value) {
    assert.deepEqual([field, operator, value], ['completed', '==', false])
    return { path, query: true }
  } })
  const transaction = {
    async get(ref) {
      reads.push(ref.path)
      if (!ref.query) return { data: () => document }
      scans++
      return { docs: [{ data: () => ({ name: '架空タスク', completed: false, priority: 4, tags: [] }) }] }
    },
    set(ref, data) { writes.push({ path: ref.path, data }); document = { ...document, ...data } },
  }
  db.runTransaction = async callback => {
    const result = await callback(transaction)
    // 他の再集計が先に成功した場合の再試行を模擬する。
    return retry ? callback(transaction) : result
  }
  try {
    const result = await refreshSmartListCounts.run(request, authenticated ? { auth: { uid: 'user-fictional' } } : {})
    return { result, scans, reads, writes }
  } finally {
    Object.assign(db, originals)
  }
}

test('通常復帰は当日の完全なcountを使いタスクを読まない', async () => {
  const { result, scans, writes } = await call({ request: { preferCached: true } })
  assert.deepEqual(result, values)
  assert.equal(scans, 0)
  assert.equal(writes.length, 0)
})

test('未作成・旧形式・不正countは全件取得で復旧する', async () => {
  for (const document of [undefined, {}, { smartListCounts: values }, { ...saved(), smartListCounts: { ...values, today: -1 } }, { ...saved(), smartListCounts: { ...values, noDate: undefined } }]) {
    const { result, scans } = await call({ document: document ?? {}, request: { preferCached: true } })
    assert.equal(scans, 1)
    assert.deepEqual(result, { today: 0, tomorrow: 0, overdue: 0, thisWeek: 0, noDate: 1 })
  }
})

test('lastUpdatedだけ当日でも前日countは再利用しない', async () => {
  const now = new Date('2026-03-10T15:00:00Z')
  const document = saved(new Date('2026-03-10T14:59:59Z'))
  document.smartListCounts.lastUpdated = stamp(now)
  assert.equal(canReuseSmartListCounts(document, now), false)
  assert.equal(canReuseSmartListCounts(saved(now), now), true)
  assert.equal(canReuseSmartListCounts(saved(new Date(now.getTime() + 1)), now), false)
})

test('明示更新は正常countも全件再集計して欠損を修復する', async () => {
  assert.equal((await call()).scans, 1)
})

test('spaceとlegacyで読み書きするスコープを分離する', async () => {
  for (const legacy of [false, true]) {
    const { reads, writes } = await call({ document: {}, request: { spaceId: 'space-fictional', useLegacyPath: legacy, preferCached: true } })
    const path = legacy ? 'users/user-fictional' : 'spaces/space-fictional'
    assert.deepEqual(reads, [path, `${path}/tasks`])
    assert.equal(writes[0].path, path)
  }
})

test('未認証・非メンバーは保存済みcountも取得できない', async () => {
  await assert.rejects(call({ authenticated: false }), error => error.code === 'unauthenticated')
  await assert.rejects(call({ member: false, request: { spaceId: 'space-fictional', preferCached: true } }), error => error.code === 'permission-denied')
  await assert.rejects(call({ request: { spaceId: 'invalid/path' } }), error => error.code === 'invalid-argument')
})

test('別端末の初期化完了後のtransaction再試行は再scanしない', async () => {
  const { scans, writes } = await call({ document: {}, request: { preferCached: true }, retry: true })
  assert.equal(scans, 1)
  assert.equal(writes.length, 1)
})

test('差分triggerは再集計snapshotに含まれる遅延変更を無視し、新しい変更だけnested countへ加算する', async () => {
  const { updateSpaceSmartListCounts, parseSmartListEventTime } = require('../lib/smartLists')
  const snapshotAt = new admin.firestore.Timestamp(1770000000, 500000000)
  const originals = { doc: db.doc, runTransaction: db.runTransaction }
  const writes = []
  db.doc = path => ({ path })
  db.runTransaction = callback => callback({
    get: async () => ({ data: () => ({ smartListCountsSnapshotAt: snapshotAt }) }),
    set: (ref, data) => writes.push({ path: ref.path, data }),
  })
  const task = { name: '架空タスク', completed: false, priority: 4, tags: [] }
  try {
    for (const nanos of [499999999, 500000000, 500000001]) {
      await updateSpaceSmartListCounts.run({
        before: { exists: false },
        after: { exists: true, data: () => task, updateTime: new admin.firestore.Timestamp(snapshotAt.seconds, nanos) },
      }, { params: { spaceId: 'space-fictional' } })
    }
    assert.equal(writes.length, 1)
    assert.equal(writes[0].path, 'spaces/space-fictional')
    assert.ok(writes[0].data.smartListCounts.noDate)
    assert.equal(Object.keys(writes[0].data).some(key => key.includes('.')), false)
    const date = parseSmartListEventTime('2026-03-10T15:00:00.123456789Z')
    assert.equal(date.nanoseconds, 123456789)
  } finally {
    Object.assign(db, originals)
  }
})

test('削除triggerはcommit時刻で遅延削除を除き、snapshot以後の削除だけ減算する', async () => {
  const { updateSmartListCounts, parseSmartListEventTime } = require('../lib/smartLists')
  const originals = { doc: db.doc, runTransaction: db.runTransaction }
  const writes = []
  db.doc = path => ({ path })
  db.runTransaction = callback => callback({
    get: async () => ({ data: () => ({ smartListCountsSnapshotAt: parseSmartListEventTime('2026-03-10T15:00:00.500000000Z') }) }),
    set: (ref, data) => writes.push({ path: ref.path, data }),
  })
  try {
    for (const timestamp of ['2026-03-10T15:00:00.499999999Z', '2026-03-10T15:00:00.500000001Z']) {
      await updateSmartListCounts.run({
        before: { exists: true, data: () => ({ name: '架空タスク', completed: false, priority: 4, tags: [] }) },
        after: { exists: false },
      }, { params: { userId: 'user-fictional' }, timestamp })
    }
    assert.equal(writes.length, 1)
    assert.equal(writes[0].path, 'users/user-fictional')
    assert.ok(writes[0].data.smartListCounts.noDate.isEqual(admin.firestore.FieldValue.increment(-1)))
  } finally {
    Object.assign(db, originals)
  }
})
