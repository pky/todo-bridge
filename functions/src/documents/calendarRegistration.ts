import { createHash } from 'node:crypto'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import * as functions from 'firebase-functions/v1'
import {
  documentCalendarEventExists,
  insertDocumentCalendarEvent,
  updateDocumentCalendarEvent,
} from '../calendar'
import { DocumentSuggestion, FamilyDocument } from './types'

const db = admin.firestore()
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function parseInput(data: unknown): { spaceId: string; documentId: string; suggestionId: string } {
  if (typeof data !== 'object' || data === null) {
    throw new functions.https.HttpsError('invalid-argument', '予定候補の指定が不正です')
  }
  const input = data as Record<string, unknown>
  const values = [input.spaceId, input.documentId, input.suggestionId]
  if (!values.every((value) => typeof value === 'string' && IDENTIFIER_PATTERN.test(value))) {
    throw new functions.https.HttpsError('invalid-argument', '予定候補の指定が不正です')
  }
  return {
    spaceId: input.spaceId as string,
    documentId: input.documentId as string,
    suggestionId: input.suggestionId as string,
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function registrationVersion(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : 0
}

function editableSuggestionValue(value: Record<string, unknown>): Record<string, unknown> {
  const {
    calendarEventId: _legacyCalendarEventId,
    calendarRegistrationVersion: _legacyCalendarRegistrationVersion,
    ...editableValue
  } = value
  return editableValue
}

export function buildDocumentCalendarEventId(
  spaceId: string,
  documentId: string,
  suggestionId: string,
  version: number
): string {
  const source = version === 0
    ? `${spaceId}/${documentId}/${suggestionId}`
    : `${spaceId}/${documentId}/${suggestionId}/retry-${version}`
  return createHash('sha256').update(source).digest('hex')
}

export const createDocumentCalendarEvent = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }
    const input = parseInput(data)
    const memberRef = db.doc(`spaces/${input.spaceId}/members/${context.auth.uid}`)
    const documentRef = db.doc(`spaces/${input.spaceId}/documents/${input.documentId}`)
    const suggestionRef = documentRef.collection('suggestions').doc(input.suggestionId)
    const settingsRef = db.doc(`spaces/${input.spaceId}/settings/integrations`)
    const [memberSnapshot, documentSnapshot, suggestionSnapshot, settingsSnapshot] = await Promise.all([
      memberRef.get(),
      documentRef.get(),
      suggestionRef.get(),
      settingsRef.get(),
    ])
    if (!memberSnapshot.exists || memberSnapshot.data()?.status !== 'active') {
      throw new functions.https.HttpsError('permission-denied', '家族スペースへのアクセス権がありません')
    }
    if (!documentSnapshot.exists || !suggestionSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', '書類または予定候補が見つかりません')
    }
    const document = documentSnapshot.data() as FamilyDocument
    const suggestion = suggestionSnapshot.data() as DocumentSuggestion
    if (document.status === 'trashed' || suggestion.type !== 'calendar_event') {
      throw new functions.https.HttpsError('failed-precondition', 'Google Calendarへ登録できる予定候補ではありません')
    }
    const storedEventId = optionalString(suggestion.calendarEventId)
    const legacyEventId = optionalString(suggestion.value.calendarEventId)
    const existingEventId = storedEventId ?? legacyEventId
    const date = optionalString(suggestion.value.date)
    const time = optionalString(suggestion.value.time)
    const endTime = optionalString(suggestion.value.endTime)
    if (!date || !DATE_PATTERN.test(date)
      || (time && !TIME_PATTERN.test(time))
      || (endTime && !TIME_PATTERN.test(endTime))) {
      throw new functions.https.HttpsError('failed-precondition', '日付または時刻を確認してください')
    }
    const calendarId = optionalString(settingsSnapshot.data()?.calendarId)
    if (!calendarId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        '設定画面でGoogle Calendarの共有先を設定してください'
      )
    }

    const eventInput = {
      title: suggestion.title.trim(),
      date,
      time,
      endTime,
      location: optionalString(suggestion.value.location),
      description: `書類「${document.name}」から登録\n${suggestion.sourceExcerpt}`,
    }
    let nextRegistrationVersion = existingEventId
      ? registrationVersion(
        suggestion.calendarRegistrationVersion ?? suggestion.value.calendarRegistrationVersion
      )
      : 0
    let eventId: string
    let alreadyRegistered = false
    try {
      if (storedEventId && await updateDocumentCalendarEvent(storedEventId, eventInput, calendarId)) {
        eventId = storedEventId
        alreadyRegistered = true
      } else if (!storedEventId && legacyEventId
        && await documentCalendarEventExists(legacyEventId, calendarId)) {
        eventId = legacyEventId
        alreadyRegistered = true
      } else {
        if (existingEventId) nextRegistrationVersion += 1
        eventId = await insertDocumentCalendarEvent(
          buildDocumentCalendarEventId(
            input.spaceId,
            input.documentId,
            input.suggestionId,
            nextRegistrationVersion
          ),
          eventInput,
          calendarId
        )
      }
    } catch {
      throw new functions.https.HttpsError('internal', 'Google Calendarへの登録に失敗しました')
    }

    const batch = db.batch()
    batch.update(suggestionRef, {
      value: editableSuggestionValue(suggestion.value),
      calendarEventId: eventId,
      calendarRegistrationVersion: nextRegistrationVersion,
      status: 'accepted',
      acceptedBy: context.auth.uid,
      acceptedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    })
    batch.update(documentRef, {
      calendarEventIds: FieldValue.arrayUnion(eventId),
      updatedAt: Timestamp.now(),
    })
    await batch.commit()
    return { success: true, eventId, alreadyRegistered }
  })
