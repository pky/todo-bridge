// デモEmulatorだけで実SDKの集計・差分更新・競合を検証する。
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const admin = require('firebase-admin')

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? ''
if (!/^(localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/.test(emulatorHost) || projectId !== 'demo-rertm') {
  throw new Error('demo-rertmのループバックFirestore Emulator指定が必要です')
}
admin.initializeApp({ projectId })
const db = admin.firestore()
const { refreshSmartListCounts, updateSpaceSmartListCounts, updateSmartListCounts } = require('../lib/smartLists')
const uid = `verification-${randomUUID()}`
const spaceId = `verification-${randomUUID()}`
const taskData = { name: '検証用の架空タスク', completed: false, priority: 4, tags: [] }
const context = { auth: { uid } }
const root = db.doc(`spaces/${spaceId}`)
const request = { spaceId, preferCached: true }
const timestampString = time => new Date(time.seconds * 1000).toISOString()
  .replace('.000Z', `.${String(time.nanoseconds).padStart(9, '0')}Z`)
const absent = { exists: false }

async function main() {
  await root.set({})
  await root.collection('members').doc(uid).set({ status: 'active' })
  const task = root.collection('tasks').doc('first')
  await task.set(taskData)
  const created = await task.get()
  assert.equal((await refreshSmartListCounts.run(request, context)).noDate, 1)
  const initial = (await root.get()).data()
  assert.ok(initial.smartListCountsSnapshotAt instanceof admin.firestore.Timestamp)

  // 既に全再集計に含まれた作成の遅延配信を抑制する。
  await updateSpaceSmartListCounts.run({ before: absent, after: created }, { params: { spaceId } })
  assert.equal((await root.get()).data().smartListCounts.noDate, 1)
  await refreshSmartListCounts.run(request, context)
  assert.ok((await root.get()).data().smartListCountsRecalculatedAt.isEqual(initial.smartListCountsRecalculatedAt))

  // snapshot以降の更新をネストしたcountへ反映する。
  await task.update({ completed: true })
  const completed = await task.get()
  await updateSpaceSmartListCounts.run({ before: created, after: completed }, { params: { spaceId } })
  assert.equal((await root.get()).data().smartListCounts.noDate, 0)
  const second = root.collection('tasks').doc('second')
  await second.set(taskData)
  const secondCreated = await second.get()
  await updateSpaceSmartListCounts.run({ before: absent, after: secondCreated }, { params: { spaceId } })
  assert.equal((await root.get()).data().smartListCounts.noDate, 1)
  const deleted = await second.delete()
  await updateSpaceSmartListCounts.run({ before: secondCreated, after: absent }, {
    params: { spaceId }, timestamp: timestampString(deleted.writeTime),
  })
  assert.equal((await root.get()).data().smartListCounts.noDate, 0)

  // 削除を含んだ全再集計の後で、その削除イベントが遅延到着しても減算しない。
  await second.set(taskData)
  const thirdCreated = await second.get()
  const thirdDeleted = await second.delete()
  await refreshSmartListCounts.run({ spaceId }, context)
  await updateSpaceSmartListCounts.run({ before: thirdCreated, after: absent }, {
    params: { spaceId }, timestamp: timestampString(thirdDeleted.writeTime),
  })
  assert.equal((await root.get()).data().smartListCounts.noDate, 0)
  // 更新の遅延到着も同じsnapshot基準で除外する。
  await updateSpaceSmartListCounts.run({ before: created, after: completed }, { params: { spaceId } })
  assert.equal((await root.get()).data().smartListCounts.noDate, 0)

  // lastUpdatedが今日でも、前日の全再集計マーカーなら修復する。
  await root.update({
    'smartListCounts.noDate': 999,
    'smartListCounts.lastUpdated': admin.firestore.Timestamp.now(),
    smartListCountsRecalculatedAt: admin.firestore.Timestamp.fromMillis(Date.now() - 86400000),
  })
  const concurrent = await Promise.all(Array.from({ length: 3 }, () => refreshSmartListCounts.run(request, context)))
  concurrent.forEach(result => assert.equal(result.noDate, 0))
  assert.equal((await root.get()).data().smartListCounts.noDate, 0)

  // 当日正常countでも明示修復では再集計する。
  await root.update({ 'smartListCounts.noDate': 999 })
  assert.equal((await refreshSmartListCounts.run({ spaceId }, context)).noDate, 0)

  // legacyも同じsnapshot契約で更新する。
  const user = db.doc(`users/${uid}`)
  await user.set({})
  const legacyTask = user.collection('tasks').doc('first')
  await legacyTask.set(taskData)
  const legacyBefore = await legacyTask.get()
  assert.equal((await refreshSmartListCounts.run({ useLegacyPath: true, preferCached: true }, context)).noDate, 1)
  await updateSmartListCounts.run({ before: absent, after: legacyBefore }, { params: { userId: uid } })
  assert.equal((await user.get()).data().smartListCounts.noDate, 1)
  await legacyTask.update({ completed: true })
  await updateSmartListCounts.run({ before: legacyBefore, after: await legacyTask.get() }, { params: { userId: uid } })
  assert.equal((await user.get()).data().smartListCounts.noDate, 0)
  console.log('スマートリスト実SDK検証成功（保存済み再利用・差分・遅延イベント・同時初期化・legacy）')
}
main().then(() => db.terminate()).catch(async error => {
  console.error(error)
  process.exitCode = 1
  await db.terminate()
})
