import { Timestamp } from 'firebase-admin/firestore'
import {
  CreateDocumentUploadInput,
  FamilyDocument,
} from './types'
import { StoredObject } from './providers/types'

export const DEFAULT_DOCUMENT_LIMIT_BYTES = 5 * 1024 * 1024 * 1024
export const DEFAULT_DOCUMENT_WARNING_BYTES = 4 * 1024 * 1024 * 1024

type FirestoreTimestamp = Timestamp

export function buildInitialDocumentRecord(
  documentId: string,
  input: CreateDocumentUploadInput,
  objectKey: string,
  uploadedBy: string,
  now: FirestoreTimestamp
): FamilyDocument {
  return {
    id: documentId,
    spaceId: input.spaceId,
    name: input.name.trim(),
    category: 'other',
    status: 'uploading',
    source: input.source,
    mimeType: input.mimeType.trim(),
    sizeBytes: input.sizeBytes,
    pageCount: null,
    originalObjectKey: objectKey,
    thumbnailObjectKey: null,
    thumbnailSizeBytes: 0,
    previewStatus: input.mimeType.startsWith('image/') || input.mimeType === 'application/pdf'
      ? 'pending'
      : 'skipped',
    previewVersion: 1,
    previewError: null,
    sha256: input.sha256?.toLowerCase() ?? null,
    uploadedBy,
    documentDate: null,
    ocrStatus: 'pending',
    analysisVersion: 1,
    searchIndexVersion: null,
    calendarEventIds: [],
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashedBy: null,
  }
}

export function validateStoredObject(
  document: Pick<FamilyDocument, 'sizeBytes' | 'mimeType' | 'sha256'>,
  storedObject: StoredObject
): string[] {
  const errors: string[] = []
  if (storedObject.sizeBytes !== document.sizeBytes) {
    errors.push('保存されたファイルサイズがアップロード要求と一致しません')
  }
  if (storedObject.contentType !== document.mimeType) {
    errors.push('保存されたMIMEタイプがアップロード要求と一致しません')
  }
  if (document.sha256 && storedObject.metadata.sha256 !== document.sha256) {
    errors.push('保存されたSHA-256がアップロード要求と一致しません')
  }
  return errors
}

export interface DocumentUsageSnapshot {
  originalBytes: number
  derivedBytes: number
  documentCount: number
  processingPageCountThisMonth: number
  limitBytes: number
  warningBytes: number
}

export function buildDocumentUsageAfterFinalize(
  current: Partial<DocumentUsageSnapshot> | undefined,
  addedBytes: number
): DocumentUsageSnapshot {
  const originalBytes = current?.originalBytes ?? 0
  const limitBytes = current?.limitBytes ?? DEFAULT_DOCUMENT_LIMIT_BYTES
  if (originalBytes + addedBytes > limitBytes) {
    throw new Error('家族スペースの書類容量上限を超えています')
  }

  return {
    originalBytes: originalBytes + addedBytes,
    derivedBytes: current?.derivedBytes ?? 0,
    documentCount: (current?.documentCount ?? 0) + 1,
    processingPageCountThisMonth: current?.processingPageCountThisMonth ?? 0,
    limitBytes,
    warningBytes: current?.warningBytes ?? DEFAULT_DOCUMENT_WARNING_BYTES,
  }
}
