const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
const { google } = require('googleapis')
const { HttpsError } = require('firebase-functions/v1/https')

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })

const {
  buildTaskCalendarEventId,
  createTaskCalendarEvent,
} = require('../lib/taskCalendarRegistration')
const {
  buildDocumentCalendarEventId,
  createDocumentCalendarEvent,
} = require('../lib/documents/calendarRegistration')

// FirestoreとCalendarクライアントを置き換え、404から再登録・保存まで外部接続なしで確認する。
function registration(t, kind, version) {
  const calls = { update: [], insert: [], writes: [], commits: 0 }
  const isTask = kind === 'task'
  const targetPath = isTask
    ? 'spaces/space-1/tasks/task-1'
    : 'spaces/space-1/documents/document-1/suggestions/suggestion-1'
  const ownId = (value) => isTask
    ? buildTaskCalendarEventId('space-1', 'task-1', value)
    : buildDocumentCalendarEventId('space-1', 'document-1', 'suggestion-1', value)
  const storedFields = {
    calendarEventId: ownId(version),
    calendarRegistrationVersion: version,
  }
  const snapshots = {
    'spaces/space-1/members/member-1': { status: 'active' },
    'spaces/space-1': { type: 'family' },
    'spaces/space-1/settings/integrations': { calendarId: 'test-calendar' },
    'spaces/space-1/documents/document-1': { status: 'ready', name: 'サンプル書類' },
    [targetPath]: isTask ? {
      name: 'サンプルタスク',
      dueDate: admin.firestore.Timestamp.fromDate(new Date('2026-05-15T00:00:00+09:00')),
      allDay: true,
      editableByMemberIds: ['member-1'],
      ...storedFields,
    } : {
      type: 'calendar_event',
      title: 'サンプル予定',
      value: { date: '2026-05-15' },
      ...storedFields,
    },
  }
  function ref(path) {
    return {
      path,
      get: async () => ({ exists: Object.hasOwn(snapshots, path), data: () => snapshots[path] }),
      update: async (value) => { calls.writes.push({ path, value }) },
      collection: (name) => ({ doc: (id) => ref(`${path}/${name}/${id}`) }),
    }
  }
  const db = admin.firestore()
  t.mock.method(db, 'doc', ref)
  t.mock.method(db, 'batch', () => ({
    update: (reference, value) => calls.writes.push({ path: reference.path, value }),
    commit: async () => { calls.commits += 1 },
  }))
  t.mock.method(google, 'calendar', () => ({
    events: {
      update: async ({ eventId }) => {
        calls.update.push(eventId)
        throw Object.assign(new Error('予定が見つかりません'), { code: 404 })
      },
      insert: async ({ requestBody }) => {
        calls.insert.push(requestBody.id)
        return { data: { id: requestBody.id } }
      },
    },
  }))
  const run = () => (isTask ? createTaskCalendarEvent : createDocumentCalendarEvent).run(
    isTask
      ? { spaceId: 'space-1', taskId: 'task-1' }
      : { spaceId: 'space-1', documentId: 'document-1', suggestionId: 'suggestion-1' },
    { auth: { uid: 'member-1' } }
  )
  return { calls, ownId, targetPath, run }
}

for (const [kind, label] of [['task', 'タスク'], ['document', '書類予定候補']]) {
  test(`${label}の世代100で更新が404なら上限エラーとし、挿入も100超の保存もしない`, async (t) => {
    const { calls, ownId, run } = registration(t, kind, 100)
    // 拒否の有無にかかわらず、副作用も同じアサーションで確認する。
    const error = await run().then(() => null, (reason) => reason)
    assert.deepEqual({
      update: calls.update,
      isHttpsError: error instanceof HttpsError,
      code: error?.code,
      insert: calls.insert,
      excessiveWrites: calls.writes.filter(({ value }) => value.calendarRegistrationVersion > 100),
    }, {
      update: [ownId(100)],
      isHttpsError: true,
      code: 'resource-exhausted',
      insert: [],
      excessiveWrites: [],
    })
  })

  test(`${label}の世代99で更新が404なら世代100のIDで挿入して保存する`, async (t) => {
    const { calls, ownId, targetPath, run } = registration(t, kind, 99)
    const result = await run()
    assert.deepEqual(calls.update, [ownId(99)])
    assert.deepEqual(calls.insert, [ownId(100)])
    assert.deepEqual(result, { success: true, eventId: ownId(100), alreadyRegistered: false })
    const targetWrites = calls.writes.filter(({ path }) => path === targetPath)
    assert.equal(targetWrites.length, 1)
    assert.equal(targetWrites[0].value.calendarEventId, ownId(100))
    assert.equal(targetWrites[0].value.calendarRegistrationVersion, 100)
    assert.equal(calls.writes.some(({ value }) => value.calendarRegistrationVersion > 100), false)
    assert.equal(calls.commits, kind === 'document' ? 1 : 0)
  })
}
