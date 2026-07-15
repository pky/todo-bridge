import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { GoogleAuth } from 'google-auth-library'
import { google } from 'googleapis'
import { buildScopedCollectionPath } from './sharedTypes'

const db = admin.firestore()
const calendarAuth = new GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/calendar.calendars.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ],
})

interface CalendarTask {
  name?: string
  dueDate?: admin.firestore.Timestamp | null
  startDate?: admin.firestore.Timestamp | null
  notes?: string[]
  url?: string | null
  allDay?: boolean
  addToCalendar?: boolean
  calendarEventId?: string | null
}

export interface DocumentCalendarEventInput {
  title: string
  date: string
  time: string | null
  endTime: string | null
  location: string | null
  description: string
}

const SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function validateGoogleCalendarConfig(data: unknown): { calendarId: string } {
  if (typeof data !== 'object' || data === null) {
    throw new functions.https.HttpsError('invalid-argument', 'Google Calendar設定が不正です')
  }
  const input = data as Record<string, unknown>
  const calendarId = typeof input.calendarId === 'string' ? input.calendarId.trim() : ''
  if (!calendarId || calendarId === 'primary' || calendarId.length > 1024) {
    throw new functions.https.HttpsError('invalid-argument', 'カレンダーIDを確認してください')
  }
  return { calendarId }
}

function parseCalendarScope(data: unknown): { spaceId?: string; useLegacyPath: boolean } {
  if (typeof data !== 'object' || data === null) {
    throw new functions.https.HttpsError('invalid-argument', '家族スペースの指定が不正です')
  }
  const input = data as Record<string, unknown>
  const useLegacyPath = input.useLegacyPath === true
  const spaceId = typeof input.spaceId === 'string' ? input.spaceId : undefined
  if ((!useLegacyPath && (!spaceId || !SCOPE_ID_PATTERN.test(spaceId)))
    || (spaceId && !SCOPE_ID_PATTERN.test(spaceId))) {
    throw new functions.https.HttpsError('invalid-argument', '家族スペースの指定が不正です')
  }
  return { spaceId, useLegacyPath }
}

export function buildCalendarSettingsDocPath(userId: string, spaceId?: string, useLegacyPath: boolean = false): string {
  if (spaceId && !useLegacyPath) {
    return `spaces/${spaceId}/settings/integrations`
  }
  return `users/${userId}`
}

export function buildCalendarTaskDocPath(userId: string, taskId: string, spaceId?: string, useLegacyPath: boolean = false): string {
  return `${buildScopedCollectionPath(userId, 'tasks', { spaceId, useLegacyPath })}/${taskId}`
}

function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: calendarAuth })
}

async function getCalendarServiceAccountEmail(): Promise<string> {
  const credentials = await calendarAuth.getCredentials()
  if (!credentials.client_email) {
    throw new Error('Firebase Functionsのサービスアカウントを確認できませんでした')
  }
  return credentials.client_email
}

async function assertCanManageCalendar(
  userId: string,
  spaceId?: string,
  useLegacyPath: boolean = false
): Promise<void> {
  if (!spaceId || useLegacyPath) return
  const [spaceSnapshot, memberSnapshot] = await Promise.all([
    db.doc(`spaces/${spaceId}`).get(),
    db.doc(`spaces/${spaceId}/members/${userId}`).get(),
  ])
  if (!spaceSnapshot.exists
    || spaceSnapshot.data()?.ownerUid !== userId
    || memberSnapshot.data()?.status !== 'active') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Google Calendar連携は家族スペースのownerだけが変更できます'
    )
  }
}

function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  return [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, '0'),
    String(next.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function defaultEndDateTime(date: string, time: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const end = new Date(Date.UTC(year, month - 1, day, hour + 1, minute))
  return `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}T${String(end.getUTCHours()).padStart(2, '0')}:${String(end.getUTCMinutes()).padStart(2, '0')}:00`
}

export function buildDocumentEventResource(eventId: string, input: DocumentCalendarEventInput) {
  if (!input.time) {
    return {
      id: eventId,
      summary: input.title,
      description: input.description,
      ...(input.location ? { location: input.location } : {}),
      start: { date: input.date },
      end: { date: nextDate(input.date) },
    }
  }
  const startDateTime = `${input.date}T${input.time}:00`
  let endDateTime = input.endTime
    ? `${input.date}T${input.endTime}:00`
    : defaultEndDateTime(input.date, input.time)
  if (input.endTime && input.endTime <= input.time) {
    endDateTime = `${nextDate(input.date)}T${input.endTime}:00`
  }
  return {
    id: eventId,
    summary: input.title,
    description: input.description,
    ...(input.location ? { location: input.location } : {}),
    start: { dateTime: startDateTime, timeZone: 'Asia/Tokyo' },
    end: { dateTime: endDateTime, timeZone: 'Asia/Tokyo' },
  }
}

export async function insertDocumentCalendarEvent(
  eventId: string,
  input: DocumentCalendarEventInput,
  calendarId: string
): Promise<string> {
  const calendar = getCalendarClient()
  try {
    const response = await calendar.events.insert({
      calendarId,
      requestBody: buildDocumentEventResource(eventId, input),
    })
    return response.data.id ?? eventId
  } catch (error) {
    const candidate = error as { code?: number }
    if (candidate.code === 409) return eventId
    throw error
  }
}

export async function updateDocumentCalendarEvent(
  eventId: string,
  input: DocumentCalendarEventInput,
  calendarId: string
): Promise<boolean> {
  try {
    const { id: _id, ...requestBody } = buildDocumentEventResource(eventId, input)
    await getCalendarClient().events.update({
      calendarId,
      eventId,
      requestBody,
    })
    return true
  } catch (error) {
    const candidate = error as { code?: number }
    if (candidate.code === 404 || candidate.code === 410) return false
    throw error
  }
}

export async function documentCalendarEventExists(
  eventId: string,
  calendarId: string
): Promise<boolean> {
  try {
    await getCalendarClient().events.get({ calendarId, eventId })
    return true
  } catch (error) {
    const candidate = error as { code?: number }
    if (candidate.code === 404 || candidate.code === 410) return false
    throw error
  }
}

// タスクからカレンダーイベントのリソースを生成
function buildEventResource(task: CalendarTask) {
  const parts: string[] = []
  if (task.notes && task.notes.length > 0) {
    parts.push(task.notes.join('\n'))
  }
  if (task.url) {
    parts.push(task.url)
  }

  const buildTime = (timestamp: admin.firestore.Timestamp, allDay: boolean) => {
    const date = timestamp.toDate()
    if (allDay) {
      const yyyy = date.getFullYear()
      const mm = String(date.getMonth() + 1).padStart(2, '0')
      const dd = String(date.getDate()).padStart(2, '0')
      return { date: `${yyyy}-${mm}-${dd}` }
    }
    return {
      dateTime: date.toISOString(),
      timeZone: 'Asia/Tokyo',
    }
  }

  const dueDate = task.dueDate!
  const startDate = task.startDate ?? dueDate
  const allDay = task.allDay ?? false

  return {
    summary: task.name || '',
    ...(parts.length > 0 ? { description: parts.join('\n') } : {}),
    start: buildTime(startDate, allDay),
    end: buildTime(dueDate, allDay),
  }
}

// Google Calendarへ共有するFirebase Functionsのサービスアカウントを返す
export const getGoogleCalendarServiceConfig = functions
  .region('asia-northeast1')
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }
    try {
      return { serviceAccountEmail: await getCalendarServiceAccountEmail() }
    } catch {
      throw new functions.https.HttpsError('internal', 'サービスアカウントを確認できませんでした')
    }
  })

export const saveGoogleCalendarConfig = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }
    const { spaceId, useLegacyPath } = parseCalendarScope(data)
    await assertCanManageCalendar(context.auth.uid, spaceId, useLegacyPath)
    const { calendarId } = validateGoogleCalendarConfig(data)
    let calendarName: string
    try {
      const response = await getCalendarClient().calendars.get({ calendarId })
      calendarName = response.data.summary?.trim() || calendarId
    } catch {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'カレンダーを確認できません。サービスアカウントへの共有とカレンダーIDを確認してください'
      )
    }
    await db.doc(buildCalendarSettingsDocPath(context.auth.uid, spaceId, useLegacyPath)).set({
      calendarId,
      calendarName,
      calendarEmail: admin.firestore.FieldValue.delete(),
      calendarRefreshToken: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true })
    return { success: true, calendarId, calendarName }
  })

export const clearGoogleCalendarConfig = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }
    const { spaceId, useLegacyPath } = parseCalendarScope(data)
    await assertCanManageCalendar(context.auth.uid, spaceId, useLegacyPath)
    await db.doc(buildCalendarSettingsDocPath(context.auth.uid, spaceId, useLegacyPath)).set({
      calendarId: admin.firestore.FieldValue.delete(),
      calendarName: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true })
  })

// カレンダーイベントを作成し、eventIdをFirestoreのタスクドキュメントに保存
export async function createCalendarEvent(
  userId: string,
  taskId: string,
  task: CalendarTask,
  calendarId: string,
  spaceId?: string,
  useLegacyPath: boolean = false
): Promise<void> {
  if (!task.dueDate) return

  const calendar = getCalendarClient()

  const response = await calendar.events.insert({
    calendarId,
    requestBody: buildEventResource(task),
  })

  const eventId = response.data.id
  if (eventId) {
    await db.doc(buildCalendarTaskDocPath(userId, taskId, spaceId, useLegacyPath)).update({ calendarEventId: eventId })
  }
}

// カレンダーイベントを更新
export async function updateCalendarEvent(
  task: CalendarTask,
  eventId: string,
  calendarId: string
): Promise<void> {
  if (!task.dueDate) return

  const calendar = getCalendarClient()

  await calendar.events.update({
    calendarId,
    eventId,
    requestBody: buildEventResource(task),
  })
}

// カレンダーイベントを削除し、calendarEventIdをnullに更新
export async function deleteCalendarEvent(
  userId: string,
  taskId: string,
  eventId: string,
  calendarId: string,
  spaceId?: string,
  useLegacyPath: boolean = false
): Promise<void> {
  const calendar = getCalendarClient()

  try {
    await calendar.events.delete({ calendarId, eventId })
  } catch (err: unknown) {
    // イベントが既に存在しない場合は無視（410 Gone）
    const error = err as { code?: number }
    if (error.code !== 410 && error.code !== 404) throw err
  }

  await db.doc(buildCalendarTaskDocPath(userId, taskId, spaceId, useLegacyPath)).update({ calendarEventId: null })
}
