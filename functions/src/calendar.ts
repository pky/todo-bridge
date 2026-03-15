import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { OAuth2Client } from 'google-auth-library'
import { google } from 'googleapis'
import { buildScopedCollectionPath } from './sharedTypes'

const db = admin.firestore()

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

export function buildCalendarSettingsDocPath(userId: string, spaceId?: string, useLegacyPath: boolean = false): string {
  if (spaceId && !useLegacyPath) {
    return `spaces/${spaceId}/settings/integrations`
  }
  return `users/${userId}`
}

export function buildCalendarTaskDocPath(userId: string, taskId: string, spaceId?: string, useLegacyPath: boolean = false): string {
  return `${buildScopedCollectionPath(userId, 'tasks', { spaceId, useLegacyPath })}/${taskId}`
}

// Firestoreのappconfig/googleCalendarからAPIキー設定を取得
async function getApiConfig(): Promise<{ clientId: string; clientSecret: string }> {
  const configSnap = await db.doc('appConfig/googleCalendar').get()
  if (!configSnap.exists) {
    throw new Error('Google Calendar APIキーが設定されていません。アプリの設定画面から入力してください。')
  }
  const data = configSnap.data()!
  return {
    clientId: data.clientId || '',
    clientSecret: data.clientSecret || '',
  }
}

async function getOAuthClient(refreshToken?: string): Promise<OAuth2Client> {
  const { clientId, clientSecret } = await getApiConfig()
  const client = new OAuth2Client(clientId, clientSecret, 'postmessage')
  if (refreshToken) {
    client.setCredentials({ refresh_token: refreshToken })
  }
  return client
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

// authorization code → refresh_token に交換して Firestore に保存
export const connectGoogleCalendar = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const { code, spaceId, useLegacyPath = false } = data as { code?: string; spaceId?: string; useLegacyPath?: boolean }
    if (!code) {
      throw new functions.https.HttpsError('invalid-argument', 'authorization codeが必要です')
    }

    const oauth2Client = await getOAuthClient()
    const { tokens } = await oauth2Client.getToken(code)

    if (!tokens.refresh_token) {
      throw new functions.https.HttpsError(
        'internal',
        'refresh_tokenの取得に失敗しました。再度連携を試みてください。'
      )
    }

    // メールアドレスを取得
    oauth2Client.setCredentials(tokens)
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client })
    const userInfo = await oauth2Api.userinfo.get()
    const email = userInfo.data.email || ''

    await db.doc(buildCalendarSettingsDocPath(context.auth.uid, spaceId, useLegacyPath)).set({
      calendarRefreshToken: tokens.refresh_token,
      calendarEmail: email,
      calendarId: 'primary',
    }, { merge: true })

    return { email }
  })

// 連携解除: Firestore から refresh_token を削除
export const disconnectGoogleCalendar = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const { spaceId, useLegacyPath = false } = data as { spaceId?: string; useLegacyPath?: boolean }

    await db.doc(buildCalendarSettingsDocPath(context.auth.uid, spaceId, useLegacyPath)).set({
      calendarRefreshToken: null,
      calendarEmail: null,
    }, { merge: true })
  })

// カレンダーイベントを作成し、eventIdをFirestoreのタスクドキュメントに保存
export async function createCalendarEvent(
  userId: string,
  taskId: string,
  task: CalendarTask,
  refreshToken: string,
  calendarId: string,
  spaceId?: string,
  useLegacyPath: boolean = false
): Promise<void> {
  if (!task.dueDate) return

  const oauth2Client = await getOAuthClient(refreshToken)
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

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
  refreshToken: string,
  calendarId: string
): Promise<void> {
  if (!task.dueDate) return

  const oauth2Client = await getOAuthClient(refreshToken)
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

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
  refreshToken: string,
  calendarId: string,
  spaceId?: string,
  useLegacyPath: boolean = false
): Promise<void> {
  const oauth2Client = await getOAuthClient(refreshToken)
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

  try {
    await calendar.events.delete({ calendarId, eventId })
  } catch (err: unknown) {
    // イベントが既に存在しない場合は無視（410 Gone）
    const error = err as { code?: number }
    if (error.code !== 410 && error.code !== 404) throw err
  }

  await db.doc(buildCalendarTaskDocPath(userId, taskId, spaceId, useLegacyPath)).update({ calendarEventId: null })
}
