import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import * as functions from 'firebase-functions/v1'
import {
  DOCUMENT_OCR_MONTHLY_PAGE_LIMIT,
  DOCUMENT_OCR_MONTHLY_WARNING_PAGES,
  DOCUMENT_OCR_POLICY_VERSION,
} from './ocrPolicy'

const db = admin.firestore()

interface UpdateDocumentOcrSettingsInput {
  spaceId?: unknown
  enabled?: unknown
  acceptedPolicyVersion?: unknown
}

function parseInput(data: UpdateDocumentOcrSettingsInput): {
  spaceId: string
  enabled: boolean
} {
  if (typeof data?.spaceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.spaceId)) {
    throw new functions.https.HttpsError('invalid-argument', 'spaceIdが不正です')
  }
  if (typeof data.enabled !== 'boolean') {
    throw new functions.https.HttpsError('invalid-argument', 'enabledが必要です')
  }
  if (data.enabled && data.acceptedPolicyVersion !== DOCUMENT_OCR_POLICY_VERSION) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      '最新の文字読み取り方針への同意が必要です'
    )
  }
  return { spaceId: data.spaceId, enabled: data.enabled }
}

async function requireSpaceOwner(uid: string, spaceId: string): Promise<void> {
  const [spaceSnapshot, memberSnapshot] = await Promise.all([
    db.doc(`spaces/${spaceId}`).get(),
    db.doc(`spaces/${spaceId}/members/${uid}`).get(),
  ])
  if (!spaceSnapshot.exists || !memberSnapshot.exists
    || memberSnapshot.data()?.status !== 'active'
    || spaceSnapshot.data()?.ownerUid !== uid) {
    throw new functions.https.HttpsError(
      'permission-denied',
      '文字読み取り設定は家族スペースの所有者だけが変更できます'
    )
  }
}

async function queueSkippedDocuments(spaceId: string): Promise<number> {
  const snapshot = await db.collection(`spaces/${spaceId}/documents`)
    .where('ocrStatus', '==', 'skipped')
    .limit(400)
    .get()
  if (snapshot.empty) return 0
  const batch = db.batch()
  const now = Timestamp.now()
  snapshot.docs.forEach((documentSnapshot) => {
    batch.update(documentSnapshot.ref, {
      ocrStatus: 'pending',
      ocrError: null,
      updatedAt: now,
    })
  })
  await batch.commit()
  return snapshot.size
}

export const updateDocumentOcrSettings = functions
  .region('asia-northeast1')
  .https.onCall(async (data: UpdateDocumentOcrSettingsInput, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }
    const input = parseInput(data)
    await requireSpaceOwner(context.auth.uid, input.spaceId)

    const now = Timestamp.now()
    await db.doc(`spaces/${input.spaceId}/settings/documentIntegrations`).set({
      ocrEnabled: input.enabled,
      ocrProvider: 'cloud_vision_eu',
      ocrPolicyVersion: DOCUMENT_OCR_POLICY_VERSION,
      ocrMonthlyPageLimit: DOCUMENT_OCR_MONTHLY_PAGE_LIMIT,
      ocrMonthlyWarningPages: DOCUMENT_OCR_MONTHLY_WARNING_PAGES,
      ...(input.enabled ? {
        ocrConsentedAt: now,
        ocrConsentedBy: context.auth.uid,
      } : {}),
      updatedAt: now,
    }, { merge: true })

    const queuedDocumentCount = input.enabled
      ? await queueSkippedDocuments(input.spaceId)
      : 0
    return {
      success: true,
      enabled: input.enabled,
      policyVersion: DOCUMENT_OCR_POLICY_VERSION,
      monthlyPageLimit: DOCUMENT_OCR_MONTHLY_PAGE_LIMIT,
      monthlyWarningPages: DOCUMENT_OCR_MONTHLY_WARNING_PAGES,
      queuedDocumentCount,
    }
  })
