const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const {
  buildDocumentEventResource,
  buildCalendarSettingsDocPath,
  buildCalendarTaskDocPath,
  validateGoogleCalendarConfig,
} = require('../lib/calendar')
const {
  buildDocumentCalendarEventId,
} = require('../lib/documents/calendarRegistration')

test('書類予定候補を日時・終了時刻・場所つきイベントへ変換する', () => {
  assert.deepEqual(buildDocumentEventResource('event-id', {
    title: '茶話会',
    date: '2026-05-15',
    time: '13:45',
    endTime: '14:45',
    location: '中央公民館',
    description: '書類から登録',
  }), {
    id: 'event-id',
    summary: '茶話会',
    description: '書類から登録',
    location: '中央公民館',
    start: { dateTime: '2026-05-15T13:45:00', timeZone: 'Asia/Tokyo' },
    end: { dateTime: '2026-05-15T14:45:00', timeZone: 'Asia/Tokyo' },
  })
})

test('時刻なしの書類予定候補を1日の終日イベントへ変換する', () => {
  const event = buildDocumentEventResource('event-id', {
    title: '休園日',
    date: '2026-05-15',
    time: null,
    endTime: null,
    location: null,
    description: '書類から登録',
  })

  assert.deepEqual(event.start, { date: '2026-05-15' })
  assert.deepEqual(event.end, { date: '2026-05-16' })
})

test('legacy calendar settings は users 配下に保存する', () => {
  assert.equal(buildCalendarSettingsDocPath('user-1'), 'users/user-1')
})

test('space calendar settings は spaces settings 配下に保存する', () => {
  assert.equal(
    buildCalendarSettingsDocPath('user-1', 'family-1', false),
    'spaces/family-1/settings/integrations'
  )
})

test('Google Calendarの共有先設定を検証する', () => {
  assert.deepEqual(validateGoogleCalendarConfig({
    calendarId: 'family@group.calendar.google.com',
  }), {
    calendarId: 'family@group.calendar.google.com',
  })
  assert.throws(() => validateGoogleCalendarConfig({ calendarId: '' }))
  assert.throws(() => validateGoogleCalendarConfig({ calendarId: 'primary' }))
})

test('space calendar task path は spaces tasks 配下を返す', () => {
  assert.equal(
    buildCalendarTaskDocPath('user-1', 'task-1', 'family-1', false),
    'spaces/family-1/tasks/task-1'
  )
})

test('削除後の再登録では元の予定と異なる決定的なIDを生成する', () => {
  const originalId = buildDocumentCalendarEventId('space-1', 'document-1', 'suggestion-1', 0)
  const retryId = buildDocumentCalendarEventId('space-1', 'document-1', 'suggestion-1', 1)

  assert.equal(originalId.length, 64)
  assert.notEqual(retryId, originalId)
  assert.equal(
    buildDocumentCalendarEventId('space-1', 'document-1', 'suggestion-1', 1),
    retryId
  )
})
