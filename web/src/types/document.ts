import type { Timestamp } from 'firebase/firestore'

export type FamilyDocumentStatus =
  | 'uploading'
  | 'uploaded'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'trashed'

export type FamilyDocumentCategory =
  | 'school_childcare'
  | 'medical'
  | 'insurance_tax'
  | 'home_warranty'
  | 'billing_receipt'
  | 'contact'
  | 'other'

export type FamilyDocumentSource = 'camera' | 'photo' | 'file' | 'drive_import'

export type FamilyDocumentOcrStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped'

export type FamilyDocumentPreviewStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped'

export type FamilyDocumentDeletionStatus = 'idle' | 'processing' | 'failed'
export type FamilyDocumentIntegrityStatus = 'unchecked' | 'ok' | 'missing_original'

export interface FamilyDocument {
  id: string
  spaceId: string
  name: string
  category: FamilyDocumentCategory
  status: FamilyDocumentStatus
  source: FamilyDocumentSource
  mimeType: string
  sizeBytes: number
  pageCount: number | null
  originalObjectKey: string
  thumbnailObjectKey: string | null
  thumbnailSizeBytes: number
  previewStatus: FamilyDocumentPreviewStatus
  previewVersion: number
  previewError: string | null
  sha256: string | null
  uploadedBy: string
  documentDate: Timestamp | null
  ocrStatus: FamilyDocumentOcrStatus
  ocrObjectKey: string | null
  ocrSizeBytes: number
  ocrError: string | null
  analysisVersion: number
  searchIndexVersion: number | null
  calendarEventIds: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
  trashedAt: Timestamp | null
  trashedBy: string | null
  statusBeforeTrash: Exclude<FamilyDocumentStatus, 'trashed'> | null
  deletionStatus: FamilyDocumentDeletionStatus
  deletionError: string | null
  integrityStatus: FamilyDocumentIntegrityStatus
  integrityError: string | null
  integrityCheckedAt: Timestamp | null
}

export type DocumentSuggestionType =
  | 'task'
  | 'calendar_event'
  | 'contact'
  | 'amount'
  | 'field'

export type DocumentSuggestionStatus = 'pending' | 'accepted' | 'dismissed'

export interface DocumentSuggestion {
  id: string
  type: DocumentSuggestionType
  status: DocumentSuggestionStatus
  title: string
  value: Record<string, unknown>
  pageNumber: number | null
  sourceExcerpt: string
  confidence: number | null
  generatedByVersion: number
  acceptedBy: string | null
  acceptedAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type DocumentTaskRelation = 'source' | 'attachment' | 'reference'

export interface DocumentTaskLink {
  id: string
  spaceId: string
  documentId: string
  taskId: string
  relation: DocumentTaskRelation
  pageNumber: number | null
  suggestionId: string | null
  sourceExcerpt: string | null
  createdBy: string
  createdAt: Timestamp
}

export interface DocumentUsage {
  originalBytes: number
  derivedBytes: number
  documentCount: number
  processingPageCountThisMonth: number
  limitBytes: number
  warningBytes: number
  updatedAt: Timestamp
}

export interface CreateDocumentUploadInput {
  spaceId: string
  name: string
  source: FamilyDocumentSource
  mimeType: string
  sizeBytes: number
  sha256?: string
}
