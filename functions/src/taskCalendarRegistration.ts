import { createHash } from 'node:crypto'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import * as functions from 'firebase-functions/v1'
import {
  insertDocumentCalendarEvent,
  updateDocumentCalendarEvent,
} from './calendar'

const db = admin.firestore()
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

export interface CalendarTask {
  name?: string
  dueDate?: admin.firestore.Timestamp | null
  startDate?: admin.firestore.Timestamp | null
  notes?: string[]
  allDay?: boolean
  calendarEventId?: string | null
  calendarRegistrationVersion?: number
  editableByMemberIds?: string[]
}

function parseInput(data: unknown): { spaceId: string; taskId: string } {
  if (typeof data !== 'object' || data === null) {
    throw new functions.https.HttpsError('invalid-argument', 'タスクの指定が不正です')
  }
  const input = data as Record<string, unknown>
  if (typeof input.spaceId !== 'string' || !IDENTIFIER_PATTERN.test(input.spaceId)
    || typeof input.taskId !== 'string' || !IDENTIFIER_PATTERN.test(input.taskId)) {
    throw new functions.https.HttpsError('invalid-argument', 'タスクの指定が不正です')
  }
  return { spaceId: input.spaceId, taskId: input.taskId }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function registrationVersion(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : 0
}

function dateParts(timestamp: admin.firestore.Timestamp): { date: string; time: string } {
  const date = new Date(timestamp.toMillis() + JST_OFFSET_MS)
  return {
    date: [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ].join('-'),
    time: `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`,
  }
}

export function buildTaskCalendarEventInput(task: CalendarTask) {
  if (!task.name?.trim() || !task.dueDate) {
    throw new Error('タスク名と日付が必要です')
  }
  const start = dateParts(task.startDate ?? task.dueDate)
  const end = dateParts(task.dueDate)
  return {
    title: task.name.trim(),
    date: start.date,
    time: task.allDay ? null : start.time,
    endTime: task.allDay ? null : end.time,
    location: null,
    description: task.notes?.length
      ? `Todoから登録\n${task.notes.join('\n')}`
      : 'Todoから登録',
  }
}

export function buildTaskCalendarEventId(
  spaceId: string,
  taskId: string,
  version: number
): string {
  return createHash('sha256')
    .update(version === 0 ? `${spaceId}/${taskId}` : `${spaceId}/${taskId}/retry-${version}`)
    .digest('hex')
}

export function isFamilyCalendarSpace(space: { type?: unknown } | undefined): boolean {
  return space?.type === 'family'
}

export const createTaskCalendarEvent = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }
    const input = parseInput(data)
    const memberRef = db.doc(`spaces/${input.spaceId}/members/${context.auth.uid}`)
    const spaceRef = db.doc(`spaces/${input.spaceId}`)
    const taskRef = db.doc(`spaces/${input.spaceId}/tasks/${input.taskId}`)
    const settingsRef = db.doc(`spaces/${input.spaceId}/settings/integrations`)
    const [memberSnapshot, spaceSnapshot, taskSnapshot, settingsSnapshot] = await Promise.all([
      memberRef.get(),
      spaceRef.get(),
      taskRef.get(),
      settingsRef.get(),
    ])
    if (!memberSnapshot.exists || memberSnapshot.data()?.status !== 'active') {
      throw new functions.https.HttpsError('permission-denied', '家族スペースへのアクセス権がありません')
    }
    if (!taskSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', 'タスクが見つかりません')
    }
    const task = taskSnapshot.data() as CalendarTask
    if (!isFamilyCalendarSpace(spaceSnapshot.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        '個人タスクは家族のGoogle Calendarへ登録できません'
      )
    }
    if (!task.editableByMemberIds?.includes(context.auth.uid)) {
      throw new functions.https.HttpsError('permission-denied', 'タスクを変更する権限がありません')
    }
    if (!task.name?.trim() || !task.dueDate) {
      throw new functions.https.HttpsError('failed-precondition', 'タスク名と日付を確認してください')
    }
    const calendarId = optionalString(settingsSnapshot.data()?.calendarId)
    if (!calendarId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        '設定画面でGoogle Calendarの共有先を設定してください'
      )
    }

    const eventInput = buildTaskCalendarEventInput(task)
    const storedEventId = optionalString(task.calendarEventId)
    let nextVersion = registrationVersion(task.calendarRegistrationVersion)
    let eventId: string
    let alreadyRegistered = false
    try {
      if (storedEventId && await updateDocumentCalendarEvent(storedEventId, eventInput, calendarId)) {
        eventId = storedEventId
        alreadyRegistered = true
      } else {
        if (storedEventId) nextVersion += 1
        eventId = await insertDocumentCalendarEvent(
          buildTaskCalendarEventId(input.spaceId, input.taskId, nextVersion),
          eventInput,
          calendarId
        )
      }
    } catch {
      throw new functions.https.HttpsError('internal', 'Google Calendarへの登録に失敗しました')
    }

    await taskRef.update({
      addToCalendar: true,
      calendarEventId: eventId,
      calendarRegistrationVersion: nextVersion,
      dateModified: Timestamp.now(),
    })
    return { success: true, eventId, alreadyRegistered }
  })
