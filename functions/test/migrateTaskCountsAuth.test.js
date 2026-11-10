const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const db = admin.firestore()
const context = { auth: { uid: 'alice', token: { email: 'alice@example.com' } } }
const { migrateTaskCounts } = require('../lib/migrate')
async function call(data, auth, member, check) {
  const originals = { doc: db.doc, collection: db.collection }
  const reads = [], writes = []
  db.doc = path => ({ get: async () => { reads.push(path); return { exists: member !== null, data: () => ({ status: member }) } } })
  db.collection = path => {
    const query = {
      where: () => query,
      get: async () => { reads.push(path); return { size: 1, docs: path.endsWith('/lists') ? [{ id: 'list', data: () => ({}) }] : [{ data: () => ({ completed: false, deleted: false, parentId: null }) }] } },
      doc: id => ({ update: async data => writes.push({ path: `${path}/${id}`, data }) }),
    }
    return query
  }
  try { await check(() => migrateTaskCounts.run(data, auth), reads, writes) } finally { Object.assign(db, originals) }
}
for (const [label, data, auth, member, code] of [
  ['未認証', { userId: 'alice' }, {}, 'active', 'unauthenticated'],
  ['他人のuserId', { userId: 'bob' }, context, 'active', 'permission-denied'],
  ['非メンバー', { userId: 'alice', spaceId: 'family' }, context, null, 'permission-denied'],
  ['inactiveメンバー', { userId: 'alice', spaceId: 'family' }, context, 'inactive', 'permission-denied'],
]) test(`migrateTaskCounts: ${label}を拒否する`, () => call(data, auth, member, async (run, reads, writes) => {
  await assert.rejects(run(), error => error.code === code)
  assert.deepEqual(reads, data.spaceId ? ['spaces/family/members/alice'] : [])
  assert.deepEqual(writes, [])
}))
for (const data of [{ userId: 'alice', spaceId: 'family' }, { spaceId: 'family' }, { userId: 'alice', spaceId: 'family', useLegacyPath: true }, {}]) {
  test(`migrateTaskCounts: 本人の${JSON.stringify(data)}を処理する`, () => call(data, context, 'active', async (run, reads, writes) => {
    assert.equal((await run()).success, true)
    const root = data.spaceId && !data.useLegacyPath ? 'spaces/family' : 'users/alice'
    assert.deepEqual(reads, [...(root.startsWith('spaces/') ? [`${root}/members/alice`] : []), `${root}/lists`, `${root}/tasks`])
    assert.deepEqual(writes, [{ path: `${root}/lists/list`, data: { incompleteTaskCount: 1 } }])
  }))
}
