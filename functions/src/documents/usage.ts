import { DEFAULT_DOCUMENT_LIMIT_BYTES, DEFAULT_DOCUMENT_WARNING_BYTES } from './lifecycle'
import { DocumentUsageSnapshot } from './lifecycle'

export interface DeletedDocumentSizes {
  originalSizeBytes: number
  derivedSizeBytes: number
}

export function buildDocumentUsageAfterPermanentDelete(
  current: Partial<DocumentUsageSnapshot> | undefined,
  deleted: DeletedDocumentSizes
): DocumentUsageSnapshot {
  return {
    originalBytes: Math.max(0, (current?.originalBytes ?? 0) - deleted.originalSizeBytes),
    derivedBytes: Math.max(0, (current?.derivedBytes ?? 0) - deleted.derivedSizeBytes),
    documentCount: Math.max(0, (current?.documentCount ?? 0) - 1),
    processingPageCountThisMonth: current?.processingPageCountThisMonth ?? 0,
    processingPageMonth: current?.processingPageMonth ?? null,
    limitBytes: current?.limitBytes ?? DEFAULT_DOCUMENT_LIMIT_BYTES,
    warningBytes: current?.warningBytes ?? DEFAULT_DOCUMENT_WARNING_BYTES,
  }
}
