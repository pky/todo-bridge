import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import {
  DOCUMENT_CALENDAR_AUTO_CATEGORIES,
  DocumentCalendarAutoCategory,
  GoogleCalendarAutomationConfig,
  insertDocumentCalendarEvent,
} from '../calendar'
import { buildDocumentCalendarEventId } from './calendarRegistration'
import { DocumentSuggestion, FamilyDocument } from './types'

const db = admin.firestore()
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

type AutomationDecisionReason =
  | 'eligible'
  | 'disabled'
  | 'category'
  | 'document_state'
  | 'suggestion_state'
  | 'ambiguous_year'
  | 'invalid_date'
  | 'past'
  | 'confidence'
  | 'invalid_time'

export interface CalendarAutomationDecision {
  eligible: boolean
  reason: AutomationDecisionReason
}

export interface CalendarAutomationDocument {
  status: FamilyDocument['status']
  ocrStatus: FamilyDocument['ocrStatus']
  category: FamilyDocument['category']
  classificationConfidence: number | null
}

export interface CalendarAutomationSuggestion {
  type: DocumentSuggestion['type']
  status: DocumentSuggestion['status']
  title: string
  value: Record<string, unknown>
  confidence: number | null
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function todayInJst(now: Date): string {
  const date = new Date(now.getTime() + JST_OFFSET_MS)
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

export function evaluateCalendarAutomationCandidate(
  settings: GoogleCalendarAutomationConfig,
  document: CalendarAutomationDocument,
  suggestion: CalendarAutomationSuggestion,
  now: Date = new Date()
): CalendarAutomationDecision {
  if (!settings.enabled) return { eligible: false, reason: 'disabled' }
  if (!settings.categories.includes(document.category as DocumentCalendarAutoCategory)) {
    return { eligible: false, reason: 'category' }
  }
  if (!['uploaded', 'processing', 'ready'].includes(document.status)
    || document.ocrStatus !== 'completed') {
    return { eligible: false, reason: 'document_state' }
  }
  if (suggestion.type !== 'calendar_event'
    || suggestion.status !== 'pending'
    || !suggestion.title.trim()) {
    return { eligible: false, reason: 'suggestion_state' }
  }
  if (suggestion.value.yearAmbiguous !== false) {
    return { eligible: false, reason: 'ambiguous_year' }
  }
  const date = optionalString(suggestion.value.date)
  if (!date || !isValidDate(date)) {
    return { eligible: false, reason: 'invalid_date' }
  }
  if (date < todayInJst(now)) return { eligible: false, reason: 'past' }
  if (suggestion.confidence === null
    || document.classificationConfidence === null
    || suggestion.confidence < settings.minConfidence
    || document.classificationConfidence < settings.minConfidence) {
    return { eligible: false, reason: 'confidence' }
  }
  const time = optionalString(suggestion.value.time)
  const endTime = optionalString(suggestion.value.endTime)
  if ((time && !TIME_PATTERN.test(time))
    || (endTime && (!TIME_PATTERN.test(endTime) || !time || endTime <= time))) {
    return { eligible: false, reason: 'invalid_time' }
  }
  return { eligible: true, reason: 'eligible' }
}

function duplicateKey(suggestion: CalendarAutomationSuggestion): string {
  return [
    optionalString(suggestion.value.date) ?? '',
    optionalString(suggestion.value.time) ?? '',
    optionalString(suggestion.value.endTime) ?? '',
  ].join('\n')
}

function normalizeSettings(data: FirebaseFirestore.DocumentData | undefined): (
  GoogleCalendarAutomationConfig & { calendarId: string | null }
) {
  const categories = Array.isArray(data?.calendarAutoRegistrationCategories)
    ? data.calendarAutoRegistrationCategories.filter((value: unknown): value is DocumentCalendarAutoCategory => (
      typeof value === 'string'
        && DOCUMENT_CALENDAR_AUTO_CATEGORIES.includes(value as DocumentCalendarAutoCategory)
    ))
    : []
  const minConfidence = typeof data?.calendarAutoRegistrationMinConfidence === 'number'
    ? data.calendarAutoRegistrationMinConfidence
    : 0.9
  return {
    enabled: data?.calendarAutoRegistrationEnabled === true,
    categories,
    minConfidence,
    calendarId: optionalString(data?.calendarId),
  }
}

export async function autoRegisterDocumentCalendarSuggestions(
  documentRef: FirebaseFirestore.DocumentReference,
  document: FamilyDocument,
  suggestions: Array<CalendarAutomationSuggestion & { id: string; sourceExcerpt: string }>
): Promise<{ registered: number; skipped: number; failed: number }> {
  if (document.spaceId.startsWith('personal_')) {
    return { registered: 0, skipped: suggestions.length, failed: 0 }
  }
  const [spaceSnapshot, settingsSnapshot] = await Promise.all([
    db.doc(`spaces/${document.spaceId}`).get(),
    db.doc(`spaces/${document.spaceId}/settings/integrations`).get(),
  ])
  const settings = normalizeSettings(settingsSnapshot.data())
  if (spaceSnapshot.data()?.type !== 'family' || !settings.enabled || !settings.calendarId) {
    return { registered: 0, skipped: suggestions.length, failed: 0 }
  }

  const decisions = suggestions.map((suggestion) => ({
    suggestion,
    decision: evaluateCalendarAutomationCandidate(settings, document, suggestion),
  }))
  const eligibleCounts = new Map<string, number>()
  decisions.forEach(({ suggestion, decision }) => {
    if (!decision.eligible) return
    const key = duplicateKey(suggestion)
    eligibleCounts.set(key, (eligibleCounts.get(key) ?? 0) + 1)
  })

  let registered = 0
  let skipped = 0
  let failed = 0
  for (const { suggestion, decision } of decisions) {
    if (!decision.eligible || eligibleCounts.get(duplicateKey(suggestion)) !== 1) {
      skipped += 1
      continue
    }
    const suggestionRef = documentRef.collection('suggestions').doc(suggestion.id)
    const latestSuggestionSnapshot = await suggestionRef.get()
    if (!latestSuggestionSnapshot.exists
      || latestSuggestionSnapshot.data()?.status !== 'pending'
      || latestSuggestionSnapshot.data()?.calendarEventId) {
      skipped += 1
      continue
    }
    const date = optionalString(suggestion.value.date)!
    const eventInput = {
      title: suggestion.title.trim(),
      date,
      time: optionalString(suggestion.value.time),
      endTime: optionalString(suggestion.value.endTime),
      location: optionalString(suggestion.value.location),
      description: `書類「${document.name}」から自動登録`,
    }
    const eventId = buildDocumentCalendarEventId(
      document.spaceId,
      document.id,
      suggestion.id,
      0
    )
    try {
      const registeredEventId = await insertDocumentCalendarEvent(
        eventId,
        eventInput,
        settings.calendarId
      )
      const now = Timestamp.now()
      const batch = db.batch()
      batch.update(suggestionRef, {
        calendarEventId: registeredEventId,
        calendarRegistrationVersion: 0,
        calendarRegistrationMode: 'automatic',
        calendarRegistrationValues: eventInput,
        calendarAutomationStatus: 'completed',
        status: 'accepted',
        acceptedBy: document.uploadedBy,
        acceptedAt: now,
        updatedAt: now,
      })
      batch.update(documentRef, {
        calendarEventIds: FieldValue.arrayUnion(registeredEventId),
        updatedAt: now,
      })
      batch.create(db.collection(`spaces/${document.spaceId}/documentActivity`).doc(), {
        type: 'calendar_auto_registered',
        documentId: document.id,
        performedBy: document.uploadedBy,
        createdAt: now,
      })
      await batch.commit()
      registered += 1
    } catch {
      await suggestionRef.set({
        calendarAutomationStatus: 'failed',
        updatedAt: Timestamp.now(),
      }, { merge: true })
      failed += 1
    }
  }
  return { registered, skipped, failed }
}
