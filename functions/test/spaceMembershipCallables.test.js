const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const db = admin.firestore()
const context = { auth: { uid: 'alice', token: { email: 'alice@example.com' } } }
const { getSmartListTasks } = require('../lib/smartLists')
const { searchTasks, getTasksByFilter } = require('../lib/searchApi')
async function call(callable, spaceId, member, auth, check, useLegacyPath = false) {
  const originals = { doc: db.doc, collection: db.collection }
  const reads = []
  db.doc = path => ({ get: async () => { reads.push(path); return { exists: member !== null, data: () => ({ status: member }) } } })
  db.collection = path => {
    const query = { where: () => query, get: async () => { reads.push(path); return { docs: [{ id: 'task', data: () => ({ name: '架空タスク', completed: false, priority: 4, tags: [], visibleToMemberIds: ['alice'] }) }] } } }
    return query
  }
  try { await check(() => callable.run({ spaceId, useLegacyPath, smartListType: 'noDate', query: '架空' }, auth), reads) } finally { Object.assign(db, originals) }
}
for (const [name, callable] of Object.entries({ getSmartListTasks, searchTasks, getTasksByFilter })) {
  for (const [spaceId, member] of [['personal_bob', null], ['family', null], ['family', 'inactive']]) {
    test(`${name}: ${spaceId}/${member ?? '非メンバー'}をタスク取得前に拒否する`, () => call(callable, spaceId, member, context, async (run, reads) => {
      await assert.rejects(run(), error => error.code === 'permission-denied')
      assert.deepEqual(reads, [`spaces/${spaceId}/members/alice`])
    }))
  }
  test(`${name}: 未認証をアクセス前に拒否する`, () => call(callable, 'family', 'active', {}, async (run, reads) => {
    await assert.rejects(run(), error => error.code === 'unauthenticated')
    assert.deepEqual(reads, [])
  }))
  for (const spaceId of ['personal_alice', 'family']) {
    test(`${name}: activeメンバーの${spaceId}だけを取得する`, () => call(callable, spaceId, 'active', context, async (run, reads) => {
      assert.equal((await run()).totalCount, 1)
      assert.deepEqual(reads, [`spaces/${spaceId}/members/alice`, `spaces/${spaceId}/tasks`])
    }))
  }
  test(`${name}: legacy経路はaliceのタスクだけを取得する`, () => call(callable, 'personal_bob', null, context, async (run, reads) => {
    assert.equal((await run()).totalCount, 1)
    assert.deepEqual(reads, ['users/alice/tasks'])
  }, true))
}
