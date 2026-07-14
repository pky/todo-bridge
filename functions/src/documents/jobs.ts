import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import * as functions from 'firebase-functions/v1'
import { createObjectStorageProvider, isFunctionsEmulator } from './providers/providerFactory'
import { generateDocumentThumbnail, supportsDocumentThumbnail } from './preview'
import { FamilyDocument } from './types'

const db = admin.firestore()
const R2_SECRETS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]
const previewRuntime = functions.runWith(
  isFunctionsEmulator() ? {} : { secrets: R2_SECRETS }
)

function normalizePreviewError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'サムネイル生成に失敗しました'
  return message.slice(0, 200)
}

async function processDocumentThumbnail(
  spaceId: string,
  documentId: string
): Promise<void> {
  const documentRef = db.doc(`spaces/${spaceId}/documents/${documentId}`)
  const initialSnapshot = await documentRef.get()
  if (!initialSnapshot.exists) return
  const initialDocument = initialSnapshot.data() as FamilyDocument
  if (!supportsDocumentThumbnail(initialDocument.mimeType)
    || !['uploaded', 'processing', 'ready'].includes(initialDocument.status)
    || (initialDocument.previewStatus === 'completed' && initialDocument.thumbnailObjectKey)) {
    return
  }

  await documentRef.set({
    previewStatus: 'processing',
    previewError: null,
    updatedAt: Timestamp.now(),
  }, { merge: true })

  try {
    const provider = createObjectStorageProvider()
    const thumbnail = await generateDocumentThumbnail(
      provider,
      spaceId,
      documentId,
      initialDocument
    )
    const usageRef = db.doc(`spaces/${spaceId}/usage/documents`)
    const retained = await db.runTransaction(async (transaction) => {
      const latestSnapshot = await transaction.get(documentRef)
      if (!latestSnapshot.exists) return false
      const latestDocument = latestSnapshot.data() as FamilyDocument
      if (!['uploaded', 'processing', 'ready'].includes(latestDocument.status)) {
        return false
      }
      if (latestDocument.previewStatus === 'completed'
        && latestDocument.thumbnailObjectKey === thumbnail.objectKey) {
        return true
      }

      const previousSize = latestDocument.thumbnailSizeBytes ?? 0
      const sizeDelta = thumbnail.data.length - previousSize
      transaction.update(documentRef, {
        thumbnailObjectKey: thumbnail.objectKey,
        thumbnailSizeBytes: thumbnail.data.length,
        pageCount: thumbnail.pageCount,
        previewStatus: 'completed',
        previewVersion: 1,
        previewError: null,
        updatedAt: Timestamp.now(),
      })
      transaction.set(usageRef, {
        derivedBytes: FieldValue.increment(sizeDelta),
        updatedAt: Timestamp.now(),
      }, { merge: true })
      return true
    })
    if (!retained) await provider.deleteObjects([thumbnail.objectKey])
  } catch (error) {
    await db.runTransaction(async (transaction) => {
      const latestSnapshot = await transaction.get(documentRef)
      if (!latestSnapshot.exists) return
      const latestDocument = latestSnapshot.data() as FamilyDocument
      if (latestDocument.thumbnailObjectKey) return
      transaction.update(documentRef, {
        previewStatus: 'failed',
        previewError: normalizePreviewError(error),
        updatedAt: Timestamp.now(),
      })
    })
    throw error
  }
}

export const generateDocumentThumbnailOnUpload = previewRuntime
  .region('asia-northeast1')
  .firestore.document('spaces/{spaceId}/documents/{documentId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data() as FamilyDocument
    const after = change.after.data() as FamilyDocument
    if (before.status === 'uploaded' || after.status !== 'uploaded') return
    await processDocumentThumbnail(context.params.spaceId, context.params.documentId)
  })

export const retryDocumentThumbnail = previewRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }
    if (typeof data?.spaceId !== 'string' || typeof data?.documentId !== 'string') {
      throw new functions.https.HttpsError('invalid-argument', 'spaceIdとdocumentIdが必要です')
    }
    const memberSnapshot = await db
      .doc(`spaces/${data.spaceId}/members/${context.auth.uid}`)
      .get()
    if (!memberSnapshot.exists || memberSnapshot.data()?.status !== 'active') {
      throw new functions.https.HttpsError('permission-denied', '家族スペースへのアクセス権がありません')
    }

    try {
      await processDocumentThumbnail(data.spaceId, data.documentId)
      return { success: true }
    } catch (error) {
      throw new functions.https.HttpsError('internal', normalizePreviewError(error))
    }
  })
