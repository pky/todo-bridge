import * as admin from 'firebase-admin'

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
  sha256: string | null
  uploadedBy: string
  documentDate: admin.firestore.Timestamp | null
  ocrStatus: FamilyDocumentOcrStatus
  analysisVersion: number
  searchIndexVersion: number | null
  calendarEventIds: string[]
  createdAt: admin.firestore.Timestamp
  updatedAt: admin.firestore.Timestamp
  trashedAt: admin.firestore.Timestamp | null
  trashedBy: string | null
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
  acceptedAt: admin.firestore.Timestamp | null
  createdAt: admin.firestore.Timestamp
  updatedAt: admin.firestore.Timestamp
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
  createdAt: admin.firestore.Timestamp
}

export interface DocumentUsage {
  originalBytes: number
  derivedBytes: number
  documentCount: number
  processingPageCountThisMonth: number
  limitBytes: number
  warningBytes: number
  updatedAt: admin.firestore.Timestamp
}

export interface CreateDocumentUploadInput {
  spaceId: string
  name: string
  source: FamilyDocumentSource
  mimeType: string
  sizeBytes: number
  sha256?: string
}
