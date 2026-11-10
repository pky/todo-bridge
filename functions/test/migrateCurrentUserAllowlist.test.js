const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })

const db = admin.firestore()
const context = { auth: { uid: 'alice', token: { email: 'alice@example.com' } } }
const { migrateCurrentUserToPersonalSpace } = require('../lib/migrate')

async function call(allowedEmails, check) {
  const originals = { doc: db.doc, collection: db.collection, batch: db.batch }
  const reads = [], writes = []
  db.doc = path => ({
    path,
    get: async () => {
      reads.push(path)
      return {
        exists: path === 'appConfig/authAccess' || path === 'users/alice',
        data: () => path === 'appConfig/authAccess'
          ? { allowedEmails }
          : path === 'users/alice' ? { email: 'alice@example.com' } : undefined,
      }
    },
    set: async (data, options) => { writes.push({ path, data, options }) },
  })
  db.collection = path => ({
    count: () => ({ get: async () => {
      reads.push(path)
      return { data: () => ({ count: 0 }) }
    } }),
    get: async () => { reads.push(path); return { docs: [], size: 0 } },
  })
  db.batch = () => ({
    set: (ref, data, options) => writes.push({ path: ref.path, data, options }),
    commit: async () => {},
  })
  try {
    await check(() => migrateCurrentUserToPersonalSpace.run({}, context), reads, writes)
  } finally {
    Object.assign(db, originals)
  }
}

test('migrateCurrentUserToPersonalSpace: 非空allowlistの許可外メールを保存前に拒否する', async t => {
  await call(['bob@example.com'], async (run, reads, writes) => {
    // 拒否の検証に失敗しても、書き込みがないことを独立して確認する。
    t.after(() => assert.deepEqual(writes, []))
    await assert.rejects(run(), error => error.code === 'permission-denied')
    assert.deepEqual(reads, ['appConfig/authAccess'])
  })
})

for (const allowedEmails of [[' ALICE@Example.com '], []]) {
  test(`migrateCurrentUserToPersonalSpace: allowlist=${JSON.stringify(allowedEmails)}で本人の移行を許可する`, () => {
    return call(allowedEmails, async (run, _reads, writes) => {
      const result = await run()
      assert.equal(result.success, true)
      assert.equal(result.spaceId, 'personal_alice')
      assert.deepEqual(writes.map(write => write.path), [
        'spaces/personal_alice',
        'spaces/personal_alice/members/alice',
        'users/alice/memberships/personal_alice',
      ])
      assert.equal(writes[1].data.uid, 'alice')
    })
  })
}
