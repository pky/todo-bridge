// 期待する純粋API: isStoredDocumentCalendarEventId(storedId: string, spaceId: string, documentId: string, suggestionId: string, currentVersion: number): boolean。
// 同じ予定候補の0〜現在世代の決定的IDだけを許可し、現在世代が100を超えたらすべて拒否する。
const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const calendar = require('../lib/calendar')
const {
  buildDocumentCalendarEventId,
  isStoredDocumentCalendarEventId,
  createDocumentCalendarEvent,
} = require('../lib/documents/calendarRegistration')

const ownId = (version) => buildDocumentCalendarEventId('space-1', 'document-1', 'suggestion-1', version)

for (const version of [0, 1, 2, 3, 100]) {
  test(`書類予定候補の自分の決定的IDを採用する: 世代${version}`, () => {
    assert.equal(isStoredDocumentCalendarEventId(ownId(version), 'space-1', 'document-1', 'suggestion-1', version === 100 ? 100 : 3), true)
  })
}

for (const [name, id] of [
  ['任意の保存ID', 'unrelated-event'],
  ['別スペース', buildDocumentCalendarEventId('space-2', 'document-1', 'suggestion-1', 0)],
  ['別書類', buildDocumentCalendarEventId('space-1', 'document-2', 'suggestion-1', 0)],
  ['別候補', buildDocumentCalendarEventId('space-1', 'document-1', 'suggestion-2', 0)],
  ['未来世代', ownId(4)],
]) {
  test(`書類予定候補の所有ID以外を拒否する: ${name}`, () => {
    assert.equal(isStoredDocumentCalendarEventId(id, 'space-1', 'document-1', 'suggestion-1', 3), false)
  })
}

for (const currentVersion of [101, 1_000_000]) {
  test(`書類予定候補の上限100を超える現在世代${currentVersion}では自分のIDも拒否する`, () => {
    assert.equal(isStoredDocumentCalendarEventId(ownId(0), 'space-1', 'document-1', 'suggestion-1', currentVersion), false)
  })
}

// FirestoreとCalendarの境界を置き換え、外部接続せずcallableの採用・挿入・保存まで検証する。
async function register(t, suggestion) {
  const calls = { update: [], exists: [], insert: [], writes: [], commits: 0 }
  const db = admin.firestore()
  const snapshots = {
    'spaces/space-1/members/member-1': { status: 'active' },
    'spaces/space-1/documents/document-1': { status: 'ready', name: 'サンプル書類' },
    'spaces/space-1/documents/document-1/suggestions/suggestion-1': suggestion,
    'spaces/space-1/settings/integrations': { calendarId: 'test-calendar' },
  }
  function ref(path) {
    return {
      path,
      get: async () => ({ exists: Object.hasOwn(snapshots, path), data: () => snapshots[path] }),
      collection: (name) => ({ doc: (id) => ref(`${path}/${name}/${id}`) }),
    }
  }
  t.mock.method(db, 'doc', ref)
  t.mock.method(db, 'batch', () => ({
    update: (reference, value) => calls.writes.push({ path: reference.path, value }),
    commit: async () => { calls.commits += 1 },
  }))
  t.mock.method(calendar, 'updateDocumentCalendarEvent', async (id) => {
    calls.update.push(id)
    return true
  })
  t.mock.method(calendar, 'documentCalendarEventExists', async (id) => {
    calls.exists.push(id)
    return true
  })
  t.mock.method(calendar, 'insertDocumentCalendarEvent', async (id) => {
    calls.insert.push(id)
    return id
  })
  const result = await createDocumentCalendarEvent.run(
    { spaceId: 'space-1', documentId: 'document-1', suggestionId: 'suggestion-1' },
    { auth: { uid: 'member-1' } }
  )
  return { calls, result }
}

function suggestion(fields = {}, valueFields = {}) {
  return {
    type: 'calendar_event', title: 'サンプル予定',
    ...fields,
    value: { date: '2026-05-15', ...valueFields },
  }
}

for (const legacy of [false, true]) {
  test(`無関係な${legacy ? '旧形式' : '保存済み'}IDをCalendarへ渡さず自分の決定的IDで挿入する`, async (t) => {
    const fields = { calendarEventId: 'unrelated-event', calendarRegistrationVersion: 0 }
    const { calls, result } = await register(t, legacy ? suggestion({}, fields) : suggestion(fields))
    assert.deepEqual(calls.update, [])
    assert.deepEqual(calls.exists, [])
    assert.equal(calls.insert.length, 1)
    const expectedId = ownId(result.calendarRegistrationVersion ?? calls.writes[0].value.calendarRegistrationVersion)
    assert.deepEqual(calls.insert, [expectedId])
    assert.equal(result.eventId, expectedId)
    assert.equal(result.alreadyRegistered, false)
    assert.equal(calls.writes[0].value.calendarEventId, expectedId)
    assert.equal(calls.commits, 1)
  })
}

test('自分の保存済み決定的IDでは更新して同じIDを保存する', async (t) => {
  const id = ownId(2)
  const { calls, result } = await register(t, suggestion({ calendarEventId: id, calendarRegistrationVersion: 3 }))
  assert.deepEqual(calls.update, [id])
  assert.deepEqual(calls.exists, [])
  assert.deepEqual(calls.insert, [])
  assert.equal(result.eventId, id)
  assert.equal(result.alreadyRegistered, true)
  assert.equal(calls.writes[0].value.calendarEventId, id)
  assert.equal(calls.commits, 1)
})
