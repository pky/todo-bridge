const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const db = admin.firestore()
const context = { auth: { uid: 'alice', token: { email: 'alice@example.com' } } }
const { createFamilySpace, ensureCurrentUserSpaceAccess } = require('../lib/spaces')
async function call(callable, allowedEmails, check) {
  const originals = { doc: db.doc, collection: db.collection, batch: db.batch }
  const reads = [], writes = []
  db.doc = path => ({ path, get: async () => { reads.push(path); return { exists: false, data: () => path === 'appConfig/authAccess' ? { allowedEmails } : undefined } } })
  db.collection = path => ({ doc: () => ({ id: 'family', path: `${path}/family` }) })
  db.batch = () => ({ set: (ref, data) => writes.push({ path: ref.path, data }), commit: async () => {} })
  try { await check(() => callable.run({ name: '家族' }, context), reads, writes) } finally { Object.assign(db, originals) }
}
for (const [name, callable] of Object.entries({ createFamilySpace, ensureCurrentUserSpaceAccess })) {
  test(`${name}: 非空allowlistの許可外メールを保存前に拒否する`, () => call(callable, ['bob@example.com'], async (run, reads, writes) => {
    await assert.rejects(run(), error => error.code === 'permission-denied')
    assert.deepEqual(reads, ['appConfig/authAccess'])
    assert.deepEqual(writes, [])
  }))
  for (const allowedEmails of [[' ALICE@Example.com '], []]) {
    test(`${name}: allowlist=${JSON.stringify(allowedEmails)}で本人を許可する`, () => call(callable, allowedEmails, async (run, reads, writes) => {
      assert.equal((await run()).success, true)
      assert.equal(reads[0], 'appConfig/authAccess')
      const spaceId = name === 'createFamilySpace' ? 'family' : 'personal_alice'
      assert.deepEqual(writes.map(write => write.path), [`spaces/${spaceId}`, `spaces/${spaceId}/members/alice`, `users/alice/memberships/${spaceId}`])
      assert.equal(writes[1].data.uid, 'alice')
    }))
  }
}
