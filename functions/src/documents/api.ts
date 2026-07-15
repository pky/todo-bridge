import { randomUUID } from 'node:crypto'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import * as functions from 'firebase-functions/v1'
import { buildOriginalObjectKey, isObjectKeyInDocument } from './objectKeys'
import { decodeDocumentTextArtifact } from './ocr/artifact'
import { analyzeAndStoreDocumentText } from './documentAnalysis'
import { createObjectStorageProvider, isFunctionsEmulator } from './providers/providerFactory'
import {
  DEFAULT_DOCUMENT_LIMIT_BYTES,
  buildDocumentUsageAfterFinalize,
  buildInitialDocumentRecord,
  validateStoredObject,
} from './lifecycle'
import { CreateDocumentUploadInput, FamilyDocument } from './types'
import {
  MAX_DOCUMENT_FILE_SIZE_BYTES,
  validateCreateDocumentUploadInput,
} from './validation'

const db = admin.firestore()
const UPLOAD_URL_EXPIRY_SECONDS = 10 * 60
const DOWNLOAD_URL_EXPIRY_SECONDS = 5 * 60
const R2_SECRETS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]

const documentRuntime = functions.runWith(
  isFunctionsEmulator() ? {} : { secrets: R2_SECRETS }
)

interface ActiveMember {
  uid: string
  isOwner: boolean
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

function parseCreateUploadInput(data: unknown): CreateDocumentUploadInput {
  const validation = validateCreateDocumentUploadInput(data)
  if (!validation.valid) {
    throw new functions.https.HttpsError('invalid-argument', validation.errors.join('\n'))
  }
  return data as CreateDocumentUploadInput
}

function parseDocumentRequest(data: unknown): { spaceId: string; documentId: string } {
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

async function markUploadFailed(documentRef: admin.firestore.DocumentReference): Promise<void> {
  await documentRef.set({
    status: 'failed',
    updatedAt: Timestamp.now(),
  }, { merge: true })
}

export const createDocumentUpload = documentRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const input = parseCreateUploadInput(data)
    const member = await requireActiveMember(context, input.spaceId)
    const usageSnapshot = await db.doc(`spaces/${input.spaceId}/usage/documents`).get()
    const currentUsage = usageSnapshot.data()
    const limitBytes = typeof currentUsage?.limitBytes === 'number'
      ? currentUsage.limitBytes
      : DEFAULT_DOCUMENT_LIMIT_BYTES
    const originalBytes = typeof currentUsage?.originalBytes === 'number'
      ? currentUsage.originalBytes
      : 0
    const derivedBytes = typeof currentUsage?.derivedBytes === 'number'
      ? currentUsage.derivedBytes
      : 0
    if (originalBytes + derivedBytes + input.sizeBytes > limitBytes) {
      throw new functions.https.HttpsError('resource-exhausted', '家族スペースの書類容量上限を超えています')
    }

    const documentRef = db.collection(`spaces/${input.spaceId}/documents`).doc()
    const objectKey = buildOriginalObjectKey(input.spaceId, documentRef.id, randomUUID())
    const now = Timestamp.now()
    const record = buildInitialDocumentRecord(
      documentRef.id,
      input,
      objectKey,
      member.uid,
      now
    )
    const provider = createObjectStorageProvider()
    const upload = await provider.createUploadUrl({
      objectKey,
      contentType: record.mimeType,
      contentLength: record.sizeBytes,
      expiresInSeconds: UPLOAD_URL_EXPIRY_SECONDS,
      ...(record.sha256 ? { metadata: { sha256: record.sha256 } } : {}),
    })

    await documentRef.create(record)
    return {
      documentId: documentRef.id,
      upload: {
        url: upload.url,
        method: upload.method,
        headers: upload.headers,
        expiresAt: upload.expiresAt.toISOString(),
      },
    }
  })

export const completeDocumentUpload = documentRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const { spaceId, documentId } = parseDocumentRequest(data)
    const member = await requireActiveMember(context, spaceId)
    const documentRef = db.doc(`spaces/${spaceId}/documents/${documentId}`)
    const documentSnapshot = await documentRef.get()
    if (!documentSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', '書類が見つかりません')
    }
    const document = documentSnapshot.data() as FamilyDocument
    if (document.uploadedBy !== member.uid && !member.isOwner) {
      throw new functions.https.HttpsError('permission-denied', 'アップロードを完了する権限がありません')
    }
    if (['uploaded', 'processing', 'ready'].includes(document.status)) {
      return { documentId, status: document.status }
    }
    if (!['uploading', 'failed'].includes(document.status)
      || !isObjectKeyInDocument(document.originalObjectKey, spaceId, documentId)) {
      throw new functions.https.HttpsError('failed-precondition', '書類の状態がアップロード完了処理に適していません')
    }

    const provider = createObjectStorageProvider()
    const storedObject = await provider.stat(document.originalObjectKey)
    if (!storedObject) {
      await markUploadFailed(documentRef)
      throw new functions.https.HttpsError('failed-precondition', 'アップロード済みファイルを確認できません')
    }
    if (storedObject.sizeBytes > MAX_DOCUMENT_FILE_SIZE_BYTES) {
      await markUploadFailed(documentRef)
      throw new functions.https.HttpsError('invalid-argument', 'ファイルサイズが20 MBの上限を超えています')
    }
    const storedObjectErrors = validateStoredObject(document, storedObject)
    if (storedObjectErrors.length > 0) {
      await markUploadFailed(documentRef)
      throw new functions.https.HttpsError('failed-precondition', storedObjectErrors.join('\n'))
    }

    const usageRef = db.doc(`spaces/${spaceId}/usage/documents`)
    const activityRef = db.collection(`spaces/${spaceId}/documentActivity`).doc()
    try {
      const status = await db.runTransaction(async (transaction) => {
        const [latestDocumentSnapshot, usageSnapshot] = await Promise.all([
          transaction.get(documentRef),
          transaction.get(usageRef),
        ])
        if (!latestDocumentSnapshot.exists) {
          throw new functions.https.HttpsError('not-found', '書類が見つかりません')
        }
        const latestDocument = latestDocumentSnapshot.data() as FamilyDocument
        if (['uploaded', 'processing', 'ready'].includes(latestDocument.status)) {
          return latestDocument.status
        }
        if (!['uploading', 'failed'].includes(latestDocument.status)) {
          throw new functions.https.HttpsError('failed-precondition', '書類の状態が変更されています')
        }

        const nextUsage = buildDocumentUsageAfterFinalize(
          usageSnapshot.data(),
          storedObject.sizeBytes
        )
        const now = Timestamp.now()
        transaction.update(documentRef, {
          status: 'uploaded',
          sizeBytes: storedObject.sizeBytes,
          mimeType: storedObject.contentType,
          sha256: storedObject.metadata.sha256 ?? latestDocument.sha256,
          updatedAt: now,
        })
        transaction.set(usageRef, { ...nextUsage, updatedAt: now })
        transaction.create(activityRef, {
          type: 'upload_completed',
          documentId,
          performedBy: member.uid,
          createdAt: now,
        })
        return 'uploaded'
      })
      return { documentId, status }
    } catch (error) {
      if (error instanceof Error && error.message.includes('容量上限')) {
        throw new functions.https.HttpsError('resource-exhausted', error.message)
      }
      throw error
    }
  })

export const getDocumentAccessUrl = documentRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const { spaceId, documentId } = parseDocumentRequest(data)
    await requireActiveMember(context, spaceId)
    const documentSnapshot = await db.doc(`spaces/${spaceId}/documents/${documentId}`).get()
    if (!documentSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', '書類が見つかりません')
    }
    const document = documentSnapshot.data() as FamilyDocument
    if (!['uploaded', 'processing', 'ready', 'trashed'].includes(document.status)
      || !isObjectKeyInDocument(document.originalObjectKey, spaceId, documentId)) {
      throw new functions.https.HttpsError('failed-precondition', '原本を閲覧できる状態ではありません')
    }

    const provider = createObjectStorageProvider()
    const access = await provider.createDownloadUrl({
      objectKey: document.originalObjectKey,
      expiresInSeconds: DOWNLOAD_URL_EXPIRY_SECONDS,
    })
    return {
      url: access.url,
      expiresAt: access.expiresAt.toISOString(),
      mimeType: document.mimeType,
      name: document.name,
    }
  })

export const getDocumentThumbnailAccessUrl = documentRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const { spaceId, documentId } = parseDocumentRequest(data)
    await requireActiveMember(context, spaceId)
    const documentSnapshot = await db.doc(`spaces/${spaceId}/documents/${documentId}`).get()
    if (!documentSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', '書類が見つかりません')
    }
    const document = documentSnapshot.data() as FamilyDocument
    if (document.previewStatus !== 'completed'
      || !document.thumbnailObjectKey
      || !isObjectKeyInDocument(document.thumbnailObjectKey, spaceId, documentId)) {
      throw new functions.https.HttpsError('failed-precondition', 'サムネイルを閲覧できる状態ではありません')
    }

    const access = await createObjectStorageProvider().createDownloadUrl({
      objectKey: document.thumbnailObjectKey,
      expiresInSeconds: DOWNLOAD_URL_EXPIRY_SECONDS,
    })
    return {
      url: access.url,
      expiresAt: access.expiresAt.toISOString(),
    }
  })

export const getDocumentText = documentRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const { spaceId, documentId } = parseDocumentRequest(data)
    await requireActiveMember(context, spaceId)
    const documentSnapshot = await db.doc(`spaces/${spaceId}/documents/${documentId}`).get()
    if (!documentSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', '書類が見つかりません')
    }
    const document = documentSnapshot.data() as FamilyDocument
    if (!document.ocrObjectKey) {
      return {
        status: document.ocrStatus,
        provider: null,
        pageCount: document.pageCount,
        pendingExternalOcrPageNumbers: [],
        pages: [],
      }
    }
    if (!isObjectKeyInDocument(document.ocrObjectKey, spaceId, documentId)) {
      throw new functions.https.HttpsError('failed-precondition', 'OCR成果物の保存先が不正です')
    }
    const stored = await createObjectStorageProvider().readObject(document.ocrObjectKey)
    if (!stored) {
      throw new functions.https.HttpsError('failed-precondition', 'OCR成果物が見つかりません')
    }
    try {
      const artifact = await decodeDocumentTextArtifact(stored)
      if (artifact.analysisVersion !== document.analysisVersion) {
        throw new Error('解析versionが一致しません')
      }
      return {
        status: document.ocrStatus,
        provider: artifact.provider,
        pageCount: artifact.pageCount,
        pendingExternalOcrPageNumbers: artifact.pendingExternalOcrPageNumbers,
        pages: artifact.pages,
      }
    } catch {
      throw new functions.https.HttpsError('failed-precondition', 'OCR成果物を読み込めませんでした')
    }
  })

export const reanalyzeDocumentSuggestions = documentRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const { spaceId, documentId } = parseDocumentRequest(data)
    await requireActiveMember(context, spaceId)
    const documentRef = db.doc(`spaces/${spaceId}/documents/${documentId}`)
    const documentSnapshot = await documentRef.get()
    if (!documentSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', '書類が見つかりません')
    }
    const document = documentSnapshot.data() as FamilyDocument
    if (document.status === 'trashed') {
      throw new functions.https.HttpsError('failed-precondition', 'ごみ箱内の書類は候補を再抽出できません')
    }
    if (!document.ocrObjectKey
      || !isObjectKeyInDocument(document.ocrObjectKey, spaceId, documentId)) {
      throw new functions.https.HttpsError('failed-precondition', '再利用できるOCR成果物がありません')
    }
    const stored = await createObjectStorageProvider().readObject(document.ocrObjectKey)
    if (!stored) {
      throw new functions.https.HttpsError('failed-precondition', 'OCR成果物が見つかりません')
    }
    try {
      const artifact = await decodeDocumentTextArtifact(stored)
      if (artifact.analysisVersion !== document.analysisVersion) {
        throw new Error('解析versionが一致しません')
      }
      const suggestionCount = await analyzeAndStoreDocumentText(documentRef, document, artifact)
      return { success: true, suggestionCount }
    } catch {
      throw new functions.https.HttpsError('failed-precondition', '保存済みOCRから候補を再抽出できませんでした')
    }
  })
