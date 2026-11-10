const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const db = admin.firestore()
const { validateCurrentUserAccess, updateFamilySpaceName } = require('../lib/spaces')

// 実DBには接続せず、callableの読み書きを記録し、終了時に元へ戻す。
async function withDatabase(seed, check) {
  const originals = { doc: db.doc, collection: db.collection, batch: db.batch }
  const documents = new Map(Object.entries(seed))
  const writes = []
  const snapshot = path => ({
    id: path.split('/').at(-1), ref: { path }, exists: documents.has(path),
    data: () => documents.get(path),
  })
  db.doc = path => ({ path, get: async () => snapshot(path) })
  db.collection = path => {
    const query = filters => ({
      where: (field, operator, value) => {
        assert.equal(operator, '==')
        return query([...filters, [field, value]])
      },
      get: async () => ({ docs: [...documents.keys()]
        .filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
        .filter(key => filters.every(([field, value]) => documents.get(key)[field] === value))
        .map(snapshot) }),
    })
    return query([])
  }
  db.batch = () => {
    const pending = []
    return {
      set: (ref, data, options) => {
        const write = { path: ref.path, data, options }
        writes.push(write)
        pending.push(write)
      },
      commit: async () => {
        for (const { path, data, options } of pending) {
          documents.set(path, options?.merge ? { ...documents.get(path), ...data } : data)
        }
      },
    }
  }
  try { await check({ writes, documents }) } finally { Object.assign(db, originals) }
}

test('ログインで家族へ新規参加すると共有リスト・タスク・タグだけACLを拡張する', async () => {
  const seed = {
    'appConfig/authAccess': { allowedEmails: ['carol@example.com'] },
    'spaces/family': { type: 'family', ownerUid: 'alice', name: '架空の家族', memberCount: 2 },
  }
  for (const collection of ['lists', 'tasks', 'tags']) {
    seed[`spaces/family/${collection}/private`] = {
      visibleToMemberIds: ['alice'], editableByMemberIds: ['alice'],
    }
    seed[`spaces/family/${collection}/shared`] = {
      visibleToMemberIds: ['alice', 'bob'], editableByMemberIds: ['alice', 'bob'],
    }
  }
  await withDatabase(seed, async ({ writes, documents }) => {
    const result = await validateCurrentUserAccess.run({}, {
      auth: { uid: 'carol', token: { email: 'carol@example.com' } },
    })
    assert.equal(result.success, true)
    assert.deepEqual(result.joinedFamilySpaceIds, ['family'])
    const memberWrites = writes.filter(write => write.path === 'spaces/family/members/carol')
    assert.equal(memberWrites.length, 1)
    assert.equal(memberWrites[0].data.uid, 'carol')
    assert.equal(memberWrites[0].data.role, 'member')
    assert.equal(memberWrites[0].data.status, 'active')
    const resourceWrites = writes.filter(write => /^spaces\/family\/(lists|tasks|tags)\//.test(write.path))
    assert.deepEqual(resourceWrites.map(write => write.path).sort(),
      ['lists', 'tasks', 'tags'].map(collection => `spaces/family/${collection}/shared`).sort())
    for (const collection of ['lists', 'tasks', 'tags']) {
      const privatePath = `spaces/family/${collection}/private`
      const sharedPath = `spaces/family/${collection}/shared`
      assert.deepEqual(documents.get(privatePath), seed[privatePath])
      const expected = {
        visibleToMemberIds: ['alice', 'bob', 'carol'],
        editableByMemberIds: ['alice', 'bob', 'carol'],
      }
      assert.deepEqual(documents.get(sharedPath), expected)
      assert.deepEqual(resourceWrites.find(write => write.path === sharedPath), {
        path: sharedPath, data: expected, options: { merge: true },
      })
    }
  })
})

const ownerSeed = {
  'spaces/family': { type: 'family', ownerUid: 'bob', name: '架空の家族' },
  'spaces/family/members/alice': { uid: 'alice', role: 'owner', status: 'active' },
  'spaces/family/members/bob': { uid: 'bob', role: 'owner', status: 'active' },
}

test('家族のownerUidと異なるactive ownerは名前変更を書込前に拒否する', async t => {
  await withDatabase(ownerSeed, async ({ writes }) => {
    // 拒否の検証に失敗しても、書込ゼロを独立して確かめる。
    t.after(() => assert.deepEqual(writes, []))
    await assert.rejects(updateFamilySpaceName.run({ spaceId: 'family', name: '変更後の家族' }, {
      auth: { uid: 'alice', token: { email: 'alice@example.com' } },
    }), error => error.code === 'permission-denied')
  })
})

test('家族のownerUidと一致するactive ownerは名前とメンバー表示名を保存できる', async () => {
  await withDatabase(ownerSeed, async ({ writes, documents }) => {
    const result = await updateFamilySpaceName.run({ spaceId: 'family', name: '変更後の家族' }, {
      auth: { uid: 'bob', token: { email: 'bob@example.com' } },
    })
    assert.deepEqual(result, { success: true, spaceId: 'family', name: '変更後の家族' })
    assert.deepEqual(writes.map(write => write.path).sort(), [
      'spaces/family', 'users/alice/memberships/family', 'users/bob/memberships/family',
    ])
    assert.equal(documents.get('spaces/family').name, '変更後の家族')
    assert.equal(documents.get('spaces/family').ownerUid, 'bob')
    for (const uid of ['alice', 'bob']) {
      assert.deepEqual(documents.get(`users/${uid}/memberships/family`), { displayName: '変更後の家族' })
    }
    assert.ok(writes.every(write => write.options?.merge === true))
  })
})
