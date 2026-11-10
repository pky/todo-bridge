// 想定署名: appendMemberToVisibility(data, userId, { sharedOnly: true })。
// 第3引数省略時は既存契約を維持し、共有限定時は本人以外の異なるUIDが2つ以上ある資源だけを拡張する。
const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const db = admin.firestore()
const context = { auth: { uid: 'alice', token: { email: 'alice@example.com' } } }
const { appendMemberToVisibility, updateFamilySpaceName } = require('../lib/spaces')
for (const visible of [['alice'], ['alice', 'alice'], ['alice', 'carol'], []]) {
  test(`共有限定ACL: ${JSON.stringify(visible)}を拡張しない`, () => {
    const data = { visibleToMemberIds: [...visible], editableByMemberIds: ['alice'] }
    const before = structuredClone(data)
    assert.equal(appendMemberToVisibility(data, 'carol', { sharedOnly: true }), null)
    assert.deepEqual(data, before)
  })
}
test('共有限定ACL: aliceとbobに共有した資源へcarolを追加する', () => {
  const data = { visibleToMemberIds: ['alice', 'bob'], editableByMemberIds: ['alice', 'bob'] }
  assert.deepEqual(appendMemberToVisibility(data, 'carol', { sharedOnly: true }), {
    visibleToMemberIds: ['alice', 'bob', 'carol'], editableByMemberIds: ['alice', 'bob', 'carol'],
  })
  assert.deepEqual(data.visibleToMemberIds, ['alice', 'bob'])
})
test('updateFamilySpaceName: inactiveのownerを名前保存前に拒否する', async () => {
  const originals = { doc: db.doc, collection: db.collection, batch: db.batch }
  const reads = [], writes = []
  db.doc = path => ({ path, get: async () => { reads.push(path); return { exists: true, data: () => ({ role: 'owner', status: 'inactive' }) } } })
  db.collection = path => ({ where: () => ({ get: async () => { reads.push(path); return { docs: [] } } }) })
  db.batch = () => ({ set: (ref, data) => writes.push({ path: ref.path, data }), commit: async () => {} })
  try {
    await assert.rejects(updateFamilySpaceName.run({ spaceId: 'family', name: '新しい家族' }, context), error => error.code === 'permission-denied')
    assert.deepEqual(reads, ['spaces/family/members/alice'])
    assert.deepEqual(writes, [])
  } finally { Object.assign(db, originals) }
})
