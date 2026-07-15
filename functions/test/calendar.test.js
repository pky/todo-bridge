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
  validateGoogleCalendarAutomationConfig,
} = require('../lib/calendar')
const {
  buildDocumentCalendarEventId,
} = require('../lib/documents/calendarRegistration')
const {
  buildTaskCalendarEventInput,
  buildTaskCalendarEventId,
  isFamilyCalendarSpace,
} = require('../lib/taskCalendarRegistration')
const {
  buildDocumentTaskLinkId,
} = require('../lib/documents/taskLinks')
const {
  evaluateCalendarAutomationCandidate,
} = require('../lib/documents/calendarAutomation')

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

test('書類予定の自動登録設定を検証する', () => {
  assert.deepEqual(validateGoogleCalendarAutomationConfig({
    enabled: true,
    categories: ['school_childcare', 'school_childcare', 'other'],
    minConfidence: 0.9,
  }), {
    enabled: true,
    categories: ['school_childcare'],
    minConfidence: 0.9,
  })
  assert.throws(() => validateGoogleCalendarAutomationConfig({
    enabled: true,
    categories: [],
    minConfidence: 0.9,
  }))
})

test('明確で信頼度の高い将来予定だけを自動登録対象にする', () => {
  const settings = {
    enabled: true,
    categories: ['school_childcare'],
    minConfidence: 0.9,
  }
  const document = {
    status: 'ready',
    ocrStatus: 'completed',
    category: 'school_childcare',
    classificationConfidence: 0.9,
  }
  const suggestion = {
    type: 'calendar_event',
    status: 'pending',
    title: '茶話会',
    value: {
      date: '2026-07-20',
      yearAmbiguous: false,
      time: '13:45',
      endTime: '14:45',
    },
    confidence: 0.9,
  }

  assert.deepEqual(
    evaluateCalendarAutomationCandidate(settings, document, suggestion, new Date('2026-07-15T00:00:00+09:00')),
    { eligible: true, reason: 'eligible' }
  )
  assert.equal(evaluateCalendarAutomationCandidate(
    settings,
    document,
    { ...suggestion, value: { ...suggestion.value, yearAmbiguous: true } },
    new Date('2026-07-15T00:00:00+09:00')
  ).reason, 'ambiguous_year')
  assert.equal(evaluateCalendarAutomationCandidate(
    settings,
    document,
    { ...suggestion, value: { ...suggestion.value, date: '2026-07-14' } },
    new Date('2026-07-15T00:00:00+09:00')
  ).reason, 'past')
  assert.equal(evaluateCalendarAutomationCandidate(
    settings,
    document,
    { ...suggestion, value: { ...suggestion.value, endTime: '12:00' } },
    new Date('2026-07-15T00:00:00+09:00')
  ).reason, 'invalid_time')
  assert.equal(evaluateCalendarAutomationCandidate(
    settings,
    { ...document, classificationConfidence: 0.8 },
    suggestion,
    new Date('2026-07-15T00:00:00+09:00')
  ).reason, 'confidence')
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

test('タスクのCalendar予定IDも再登録回数ごとに決定的に生成する', () => {
  const originalId = buildTaskCalendarEventId('space-1', 'task-1', 0)
  const retryId = buildTaskCalendarEventId('space-1', 'task-1', 1)

  assert.equal(originalId.length, 64)
  assert.notEqual(retryId, originalId)
  assert.equal(buildTaskCalendarEventId('space-1', 'task-1', 1), retryId)
})

test('家族スペースのタスクだけを家族Calendar登録対象にする', () => {
  assert.equal(isFamilyCalendarSpace({ type: 'family' }), true)
  assert.equal(isFamilyCalendarSpace({ type: 'personal' }), false)
  assert.equal(isFamilyCalendarSpace(undefined), false)
})

test('タスクの開始・終了日時を日本時間のCalendar予定へ変換する', () => {
  const startDate = admin.firestore.Timestamp.fromDate(new Date('2026-07-20T13:45:00+09:00'))
  const dueDate = admin.firestore.Timestamp.fromDate(new Date('2026-07-20T14:45:00+09:00'))

  assert.deepEqual(buildTaskCalendarEventInput({
    name: '茶話会',
    startDate,
    dueDate,
    allDay: false,
    notes: ['書類から作成'],
  }), {
    title: '茶話会',
    date: '2026-07-20',
    time: '13:45',
    endTime: '14:45',
    location: null,
    description: 'Todoから登録\n書類から作成',
  })
})

test('同じタスクと書類から同じリンクIDを生成する', () => {
  const linkId = buildDocumentTaskLinkId('task-1', 'document-1')

  assert.equal(linkId.length, 64)
  assert.equal(buildDocumentTaskLinkId('task-1', 'document-1'), linkId)
  assert.notEqual(buildDocumentTaskLinkId('task-1', 'document-2'), linkId)
})
