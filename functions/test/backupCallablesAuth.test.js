const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const db = admin.firestore()
const context = { auth: { uid: 'alice', token: { email: 'alice@example.com' } } }
const storage = admin.storage()
const callables = require('../lib/scheduledBackup')

// DBとStorageの入口をすべて差し替え、復元の削除・保存先も記録する。
async function withStubs(run) {
  const originals = { collection: db.collection, doc: db.doc, batch: db.batch }
  const originalBucket = storage.bucket
  const accesses = []
  const writes = []
  db.doc = path => { accesses.push(path); return { path } }
  db.collection = path => {
    accesses.push(path)
    return {
      get: async () => ({ docs: [{ id: 'old', ref: { path: `${path}/old` }, data: () => ({ name: '架空データ' }) }] }),
      doc: id => ({ set: async data => writes.push({ path: `${path}/${id}`, data }) }),
    }
  }
  db.batch = () => ({ delete: ref => writes.push({ path: ref.path, deleted: true }), commit: async () => {} })
  storage.bucket = () => {
    accesses.push('storage')
    return {
      getFiles: async ({ prefix }) => { accesses.push(prefix); return [[]] },
      file: path => {
        accesses.push(path)
        return {
          exists: async () => [true],
          save: async body => writes.push({ path, data: JSON.parse(body) }),
          download: async () => [Buffer.from(JSON.stringify({ lists: [{ id: 'list', name: '架空リスト' }], tasks: [{ id: 'task', name: '架空タスク' }], tags: [{ id: 'tag', name: '架空タグ' }] }))],
        }
      },
    }
  }
  try { await run({ accesses, writes }) } finally { Object.assign(db, originals); storage.bucket = originalBucket }
}

for (const name of ['manualBackup', 'listBackups', 'restoreFromBackup']) {
  for (const [label, auth, userId, code] of [
    ['未認証', {}, 'alice', 'unauthenticated'],
    ['他人のuserId', context, 'bob', 'permission-denied'],
  ]) {
    test(`${name}: ${label}をデータアクセス前に拒否する`, () => withStubs(async ({ accesses, writes }) => {
      await assert.rejects(callables[name].run({ userId, date: '2026-01-01' }, auth), error => error.code === code)
      assert.deepEqual(accesses, [])
      assert.deepEqual(writes, [])
    }))
  }
  for (const userId of [undefined, 'alice']) {
    test(`${name}: userId=${userId ?? '省略'}はaliceだけを対象にする`, () => withStubs(async ({ accesses, writes }) => {
      const result = await callables[name].run({ ...(userId ? { userId } : {}), date: '2026-01-01' }, context)
      if (name === 'listBackups') assert.deepEqual(result, { backups: [] })
      else assert.equal(result.success, true)
      assert.ok(accesses.some(path => path.startsWith('backups/alice/')))
      assert.ok(accesses.every(path => path === 'storage' || path.startsWith('users/alice/') || path.startsWith('backups/alice/')))
      assert.ok(writes.every(write => write.path.startsWith('users/alice/') || write.path.startsWith('backups/alice/')))
      if (name === 'manualBackup') assert.equal(writes[0].data.userId, 'alice')
      if (name === 'restoreFromBackup') {
        assert.deepEqual(result.restored, { lists: 1, tasks: 1, tags: 1 })
        assert.equal(writes.filter(write => write.deleted).length, 3)
        assert.deepEqual(writes.filter(write => !write.deleted).map(write => write.path).sort(), ['users/alice/lists/list', 'users/alice/tags/tag', 'users/alice/tasks/task'])
      }
    }))
  }
}
