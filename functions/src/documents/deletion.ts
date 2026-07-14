import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import * as functions from 'firebase-functions/v1'
import { createObjectStorageProvider, isFunctionsEmulator } from './providers/providerFactory'
import { FamilyDocument, FamilyDocumentStatus } from './types'
import { isDocumentUsageCountedStatus } from './lifecycle'
import { buildDocumentUsageAfterPermanentDelete } from './usage'
import { buildDocumentDeletionObjectKeys } from './deletionPlan'

const db = admin.firestore()
const R2_SECRETS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]
const deletionRuntime = functions.runWith(
  isFunctionsEmulator() ? {} : { secrets: R2_SECRETS }
)
const RESTORABLE_STATUSES: FamilyDocumentStatus[] = [
  'uploading',
  'uploaded',
  'processing',
  'ready',
  'failed',
]

interface DocumentRequest {
  spaceId: string
  documentId: string
}

interface ActiveMember {
  uid: string
  isOwner: boolean
}

function parseDocumentRequest(data: unknown): DocumentRequest {
  if (typeof data !== 'object' || data === null) {
    throw new functions.https.HttpsError('invalid-argument', '書類の指定が不正です')
  }
  const candidate = data as Record<string, unknown>
  if (typeof candidate.spaceId !== 'string' || !candidate.spaceId.trim()
    || typeof candidate.documentId !== 'string' || !candidate.documentId.trim()) {
    throw new functions.https.HttpsError('invalid-argument', 'spaceIdとdocumentIdが必要です')
  }
  return {
    spaceId: candidate.spaceId.trim(),
    documentId: candidate.documentId.trim(),
  }
}

async function requireActiveMember(
  context: functions.https.CallableContext,
  spaceId: string
): Promise<ActiveMember> {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
  }
  const [memberSnapshot, spaceSnapshot] = await Promise.all([
    db.doc(`spaces/${spaceId}/members/${context.auth.uid}`).get(),
    db.doc(`spaces/${spaceId}`).get(),
  ])
  if (!memberSnapshot.exists || memberSnapshot.data()?.status !== 'active') {
    throw new functions.https.HttpsError('permission-denied', '家族スペースへのアクセス権がありません')
  }
  return {
    uid: context.auth.uid,
    isOwner: spaceSnapshot.data()?.ownerUid === context.auth.uid,
  }
}

function normalizeDeletionError(error: unknown): string {
  const message = error instanceof Error ? error.message : '書類の完全削除に失敗しました'
  return message.slice(0, 200)
}

async function deleteDocumentLinks(spaceId: string, documentId: string): Promise<void> {
  const linksSnapshot = await db
    .collection(`spaces/${spaceId}/documentTaskLinks`)
    .where('documentId', '==', documentId)
    .get()
  if (linksSnapshot.empty) return
  const writer = db.bulkWriter()
  linksSnapshot.docs.forEach((snapshot) => writer.delete(snapshot.ref))
  await writer.close()
}

export const trashDocument = deletionRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const { spaceId, documentId } = parseDocumentRequest(data)
    const member = await requireActiveMember(context, spaceId)
    const documentRef = db.doc(`spaces/${spaceId}/documents/${documentId}`)
    const activityRef = db.collection(`spaces/${spaceId}/documentActivity`).doc()
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(documentRef)
      if (!snapshot.exists) {
        throw new functions.https.HttpsError('not-found', '書類が見つかりません')
      }
      const document = snapshot.data() as FamilyDocument
      if (document.status === 'trashed') return
      if (!RESTORABLE_STATUSES.includes(document.status)) {
        throw new functions.https.HttpsError('failed-precondition', '保存完了後の書類だけをごみ箱へ移動できます')
      }
      const now = Timestamp.now()
      transaction.update(documentRef, {
        status: 'trashed',
        statusBeforeTrash: document.status,
        trashedAt: now,
        trashedBy: member.uid,
        deletionStatus: 'idle',
        deletionError: null,
        updatedAt: now,
      })
      transaction.create(activityRef, {
        type: 'trashed',
        documentId,
        performedBy: member.uid,
        createdAt: now,
      })
    })
    return { success: true }
  })

export const restoreDocument = deletionRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const { spaceId, documentId } = parseDocumentRequest(data)
    const member = await requireActiveMember(context, spaceId)
    const documentRef = db.doc(`spaces/${spaceId}/documents/${documentId}`)
    const activityRef = db.collection(`spaces/${spaceId}/documentActivity`).doc()
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(documentRef)
      if (!snapshot.exists) {
        throw new functions.https.HttpsError('not-found', '書類が見つかりません')
      }
      const document = snapshot.data() as FamilyDocument
      if (document.status !== 'trashed') return
      if (document.deletionStatus === 'processing') {
        throw new functions.https.HttpsError('failed-precondition', '完全削除の処理中です')
      }
      const restoredStatus = document.statusBeforeTrash
        && RESTORABLE_STATUSES.includes(document.statusBeforeTrash)
        ? document.statusBeforeTrash
        : 'uploaded'
      const now = Timestamp.now()
      transaction.update(documentRef, {
        status: restoredStatus,
        statusBeforeTrash: null,
        trashedAt: null,
        trashedBy: null,
        deletionStatus: 'idle',
        deletionError: null,
        updatedAt: now,
      })
      transaction.create(activityRef, {
        type: 'restored',
        documentId,
        performedBy: member.uid,
        createdAt: now,
      })
    })
    return { success: true }
  })

export const permanentlyDeleteDocument = deletionRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const { spaceId, documentId } = parseDocumentRequest(data)
    const member = await requireActiveMember(context, spaceId)
    if (!member.isOwner) {
      throw new functions.https.HttpsError('permission-denied', '完全削除は家族スペースの所有者だけが実行できます')
    }
    const documentRef = db.doc(`spaces/${spaceId}/documents/${documentId}`)
    const document = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(documentRef)
      if (!snapshot.exists) return null
      const latestDocument = snapshot.data() as FamilyDocument
      if (latestDocument.status !== 'trashed') {
        throw new functions.https.HttpsError('failed-precondition', 'ごみ箱内の書類だけを完全削除できます')
      }
      if (latestDocument.deletionStatus === 'processing') {
        throw new functions.https.HttpsError('failed-precondition', '完全削除の処理中です')
      }
      transaction.update(documentRef, {
        deletionStatus: 'processing',
        deletionError: null,
        updatedAt: Timestamp.now(),
      })
      return latestDocument
    })
    if (!document) return { success: true, alreadyDeleted: true }

    try {
      const shouldAdjustUsage = isDocumentUsageCountedStatus(document.statusBeforeTrash)
      const provider = createObjectStorageProvider()
      await provider.deleteObjects(buildDocumentDeletionObjectKeys(
        spaceId,
        documentId,
        document
      ))
      await Promise.all([
        db.recursiveDelete(documentRef.collection('suggestions')),
        deleteDocumentLinks(spaceId, documentId),
      ])

      const usageRef = db.doc(`spaces/${spaceId}/usage/documents`)
      const searchSettingsRef = db.doc(`spaces/${spaceId}/settings/documentSearch`)
      const searchSettingsSnapshot = shouldAdjustUsage
        ? await searchSettingsRef.get()
        : null
      const searchIndexObjectKey = typeof searchSettingsSnapshot?.data()?.objectKey === 'string'
        && searchSettingsSnapshot.data()!.objectKey.startsWith(`spaces/${spaceId}/search/`)
        ? searchSettingsSnapshot.data()!.objectKey as string
        : null
      if (searchIndexObjectKey) await provider.deleteObjects([searchIndexObjectKey])
      const activityRef = db.collection(`spaces/${spaceId}/documentActivity`).doc()
      await db.runTransaction(async (transaction) => {
        const [latestSnapshot, usageSnapshot, latestSearchSettingsSnapshot] = await Promise.all([
          transaction.get(documentRef),
          transaction.get(usageRef),
          transaction.get(searchSettingsRef),
        ])
        if (!latestSnapshot.exists) return
        const latestDocument = latestSnapshot.data() as FamilyDocument
        if (latestDocument.status !== 'trashed') {
          throw new functions.https.HttpsError('failed-precondition', '書類がごみ箱から復元されています')
        }
        const now = Timestamp.now()
        const searchIndexSizeBytes = searchIndexObjectKey
          && latestSearchSettingsSnapshot.data()?.objectKey === searchIndexObjectKey
          && typeof latestSearchSettingsSnapshot.data()?.sizeBytes === 'number'
          ? latestSearchSettingsSnapshot.data()!.sizeBytes
          : 0
        const nextUsage = shouldAdjustUsage
          ? buildDocumentUsageAfterPermanentDelete(
            usageSnapshot.data(),
            {
              originalSizeBytes: latestDocument.sizeBytes,
              derivedSizeBytes: (latestDocument.thumbnailSizeBytes ?? 0)
                + (latestDocument.ocrSizeBytes ?? 0)
                + searchIndexSizeBytes,
            }
          )
          : null
        transaction.delete(documentRef)
        if (searchIndexSizeBytes > 0) transaction.delete(searchSettingsRef)
        if (nextUsage) transaction.set(usageRef, { ...nextUsage, updatedAt: now })
        transaction.create(activityRef, {
          type: 'permanently_deleted',
          documentId,
          performedBy: member.uid,
          createdAt: now,
        })
      })
      return { success: true, alreadyDeleted: false }
    } catch (error) {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(documentRef)
        if (!snapshot.exists) return
        const latestDocument = snapshot.data() as FamilyDocument
        if (latestDocument.deletionStatus !== 'processing') return
        transaction.update(documentRef, {
          deletionStatus: 'failed',
          deletionError: normalizeDeletionError(error),
          updatedAt: Timestamp.now(),
        })
      })
      throw new functions.https.HttpsError('internal', normalizeDeletionError(error))
    }
  })
