import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import * as functions from 'firebase-functions/v1'
import { analyzeAndStoreDocumentText } from './documentAnalysis'
import {
  GeneratedDocumentTextArtifact,
  generatePdfTextArtifact,
  writeDocumentTextArtifact,
} from './ocr/artifact'
import { extractDocumentText } from './ocr/pipeline'
import { DOCUMENT_OCR_POLICY_VERSION } from './ocrPolicy'
import {
  buildOcrReservationId,
  buildOcrUsageReservation,
  getOcrUsageMonth,
} from './ocrUsagePlan'
import { CloudVisionOcrProvider } from './providers/cloudVisionOcr'
import { createObjectStorageProvider, isFunctionsEmulator } from './providers/providerFactory'
import { DocumentOcrProvider } from './providers/types'
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

function normalizeOcrError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'PDF文字抽出に失敗しました'
  return message.slice(0, 200)
}

async function isExternalOcrEnabled(spaceId: string): Promise<boolean> {
  if (isFunctionsEmulator()) return false
  const snapshot = await db.doc(`spaces/${spaceId}/settings/documentIntegrations`).get()
  return snapshot.data()?.ocrEnabled === true
    && snapshot.data()?.ocrPolicyVersion === DOCUMENT_OCR_POLICY_VERSION
}

async function reserveOcrPages(
  spaceId: string,
  documentId: string,
  analysisVersion: number,
  pageCount: number,
  now: Date = new Date()
): Promise<void> {
  const month = getOcrUsageMonth(now)
  const reservationId = buildOcrReservationId(month, documentId, analysisVersion)
  const reservationRef = db.doc(`spaces/${spaceId}/ocrUsage/${reservationId}`)
  const usageRef = db.doc(`spaces/${spaceId}/usage/documents`)
  await db.runTransaction(async (transaction) => {
    const [reservationSnapshot, usageSnapshot] = await Promise.all([
      transaction.get(reservationRef),
      transaction.get(usageRef),
    ])
    if (reservationSnapshot.exists) return
    const reservation = buildOcrUsageReservation(usageSnapshot.data(), pageCount, month)
    const timestamp = Timestamp.fromDate(now)
    transaction.set(usageRef, {
      processingPageCountThisMonth: reservation.processingPageCountThisMonth,
      processingPageMonth: reservation.processingPageMonth,
      updatedAt: timestamp,
    }, { merge: true })
    transaction.create(reservationRef, {
      documentId,
      analysisVersion,
      pageCount,
      month,
      createdAt: timestamp,
    })
  })
}

function createConsentAwareOcrProvider(spaceId: string): DocumentOcrProvider {
  const provider = new CloudVisionOcrProvider()
  return {
    extractPage: async (input) => {
      if (!await isExternalOcrEnabled(spaceId)) {
        throw new Error('外部OCRが無効になったため処理を停止しました')
      }
      return provider.extractPage(input)
    },
  }
}

async function retainDocumentTextArtifact(
  documentRef: admin.firestore.DocumentReference,
  usageRef: admin.firestore.DocumentReference,
  initialDocument: FamilyDocument,
  generated: GeneratedDocumentTextArtifact,
  ocrStatus: 'completed' | 'skipped',
  ocrError: string | null = null
): Promise<void> {
  const retained = await db.runTransaction(async (transaction) => {
    const latestSnapshot = await transaction.get(documentRef)
    if (!latestSnapshot.exists) return false
    const latestDocument = latestSnapshot.data() as FamilyDocument
    if (!['uploaded', 'processing', 'ready'].includes(latestDocument.status)
      || latestDocument.analysisVersion !== initialDocument.analysisVersion) {
      return false
    }
    const previousSize = latestDocument.ocrSizeBytes ?? 0
    transaction.update(documentRef, {
      ocrStatus,
      ocrObjectKey: generated.objectKey,
      ocrSizeBytes: generated.data.length,
      ocrError,
      pageCount: generated.artifact.pageCount,
      updatedAt: Timestamp.now(),
    })
    transaction.set(usageRef, {
      derivedBytes: FieldValue.increment(generated.data.length - previousSize),
      updatedAt: Timestamp.now(),
    }, { merge: true })
    return true
  })
  if (!retained) return
  try {
    await analyzeAndStoreDocumentText(documentRef, initialDocument, generated.artifact)
  } catch (error) {
    console.error('[documentAnalysis] failed', {
      documentId: initialDocument.id,
      analysisVersion: initialDocument.analysisVersion,
      error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    })
  }
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

async function processDocumentText(
  spaceId: string,
  documentId: string
): Promise<void> {
  const documentRef = db.doc(`spaces/${spaceId}/documents/${documentId}`)
  const initialDocument = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(documentRef)
    if (!snapshot.exists) return null
    const document = snapshot.data() as FamilyDocument
    if (!['uploaded', 'processing', 'ready'].includes(document.status)
      || document.ocrStatus !== 'pending') {
      return null
    }
    transaction.update(documentRef, {
      ocrStatus: 'processing',
      ocrError: null,
      updatedAt: Timestamp.now(),
    })
    return document
  })
  if (!initialDocument) return

  if (initialDocument.mimeType !== 'application/pdf'
    && !initialDocument.mimeType.startsWith('image/')) {
    await documentRef.set({
      ocrStatus: 'skipped',
      ocrError: null,
      updatedAt: Timestamp.now(),
    }, { merge: true })
    return
  }

  let localArtifact: GeneratedDocumentTextArtifact | null = null
  try {
    const provider = createObjectStorageProvider()
    const usageRef = db.doc(`spaces/${spaceId}/usage/documents`)
    if (initialDocument.mimeType === 'application/pdf') {
      localArtifact = await generatePdfTextArtifact(
        provider,
        spaceId,
        documentId,
        initialDocument
      )
    }

    const requiredExternalPages = localArtifact
      ? localArtifact.artifact.pendingExternalOcrPageNumbers.length
      : 1
    if (requiredExternalPages === 0) {
      await retainDocumentTextArtifact(
        documentRef,
        usageRef,
        initialDocument,
        localArtifact!,
        'completed'
      )
      return
    }
    if (!await isExternalOcrEnabled(spaceId)) {
      if (localArtifact) {
        await retainDocumentTextArtifact(
          documentRef,
          usageRef,
          initialDocument,
          localArtifact,
          'skipped'
        )
      } else {
        await documentRef.set({
          ocrStatus: 'skipped',
          ocrError: null,
          updatedAt: Timestamp.now(),
        }, { merge: true })
      }
      return
    }

    await reserveOcrPages(
      spaceId,
      documentId,
      initialDocument.analysisVersion,
      requiredExternalPages
    )
    const original = await provider.readObject(initialDocument.originalObjectKey)
    if (!original) throw new Error('文字読み取り用の原本が見つかりません')
    const result = await extractDocumentText(
      original,
      initialDocument.mimeType,
      createConsentAwareOcrProvider(spaceId)
    )
    const generated = await writeDocumentTextArtifact(
      provider,
      spaceId,
      documentId,
      initialDocument.analysisVersion,
      original,
      result
    )
    await retainDocumentTextArtifact(
      documentRef,
      usageRef,
      initialDocument,
      generated,
      'completed'
    )
  } catch (error) {
    const normalizedError = normalizeOcrError(error)
    const limitReached = normalizedError.includes('1,000ページ上限')
    if (limitReached && localArtifact) {
      await retainDocumentTextArtifact(
        documentRef,
        db.doc(`spaces/${spaceId}/usage/documents`),
        initialDocument,
        localArtifact,
        'skipped',
        normalizedError
      )
      return
    }
    await db.runTransaction(async (transaction) => {
      const latestSnapshot = await transaction.get(documentRef)
      if (!latestSnapshot.exists) return
      const latestDocument = latestSnapshot.data() as FamilyDocument
      if (latestDocument.ocrStatus !== 'processing') return
      transaction.update(documentRef, {
        ocrStatus: limitReached ? 'skipped' : 'failed',
        ocrError: normalizedError,
        updatedAt: Timestamp.now(),
      })
    })
    if (!limitReached) throw error
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

export const extractDocumentTextOnUpload = previewRuntime
  .region('asia-northeast1')
  .firestore.document('spaces/{spaceId}/documents/{documentId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data() as FamilyDocument
    const after = change.after.data() as FamilyDocument
    const becameUploaded = before.status !== 'uploaded' && after.status === 'uploaded'
    const queuedAgain = before.ocrStatus !== 'pending' && after.ocrStatus === 'pending'
    if (!becameUploaded && !queuedAgain) return
    await processDocumentText(context.params.spaceId, context.params.documentId)
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

export const retryDocumentText = previewRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }
    if (typeof data?.spaceId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(data.spaceId)
      || typeof data?.documentId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(data.documentId)) {
      throw new functions.https.HttpsError('invalid-argument', 'spaceIdとdocumentIdが不正です')
    }
    const memberSnapshot = await db
      .doc(`spaces/${data.spaceId}/members/${context.auth.uid}`)
      .get()
    if (!memberSnapshot.exists || memberSnapshot.data()?.status !== 'active') {
      throw new functions.https.HttpsError('permission-denied', '家族スペースへのアクセス権がありません')
    }

    const documentRef = db.doc(`spaces/${data.spaceId}/documents/${data.documentId}`)
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(documentRef)
      if (!snapshot.exists) {
        throw new functions.https.HttpsError('not-found', '書類が見つかりません')
      }
      const document = snapshot.data() as FamilyDocument
      if (document.status === 'trashed') {
        throw new functions.https.HttpsError('failed-precondition', 'ごみ箱内の書類は再読み取りできません')
      }
      if (!['uploaded', 'processing', 'ready'].includes(document.status)
        || (document.mimeType !== 'application/pdf' && !document.mimeType.startsWith('image/'))) {
        throw new functions.https.HttpsError('failed-precondition', '文字読み取り対象の書類ではありません')
      }
      if (document.ocrStatus === 'processing') {
        throw new functions.https.HttpsError('already-exists', '文字読み取りはすでに処理中です')
      }
      transaction.update(documentRef, {
        ocrStatus: 'pending',
        ocrError: null,
        updatedAt: Timestamp.now(),
      })
    })

    try {
      await processDocumentText(data.spaceId, data.documentId)
      const result = await documentRef.get()
      return {
        success: true,
        status: (result.data() as FamilyDocument | undefined)?.ocrStatus ?? 'failed',
      }
    } catch (error) {
      throw new functions.https.HttpsError('internal', normalizeOcrError(error))
    }
  })
