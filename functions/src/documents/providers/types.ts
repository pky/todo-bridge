import { FamilyDocumentCategory } from '../types'

export interface CreateUploadUrlInput {
  objectKey: string
  contentType: string
  contentLength: number
  expiresInSeconds: number
  metadata?: Record<string, string>
}

export interface SignedUpload {
  url: string
  method: 'PUT'
  headers: Record<string, string>
  expiresAt: Date
}

export interface CreateDownloadUrlInput {
  objectKey: string
  expiresInSeconds: number
  downloadFileName?: string
}

export interface SignedDownload {
  url: string
  expiresAt: Date
}

export interface StoredObject {
  objectKey: string
  sizeBytes: number
  contentType: string | null
  etag: string | null
  lastModifiedAt: Date | null
  metadata: Record<string, string>
}

export interface WriteObjectInput {
  objectKey: string
  contentType: string
  data: Buffer
  metadata?: Record<string, string>
}

export interface ObjectStorageProvider {
  createUploadUrl(input: CreateUploadUrlInput): Promise<SignedUpload>
  createDownloadUrl(input: CreateDownloadUrlInput): Promise<SignedDownload>
  stat(objectKey: string): Promise<StoredObject | null>
  readObject(objectKey: string): Promise<Buffer | null>
  writeObject(input: WriteObjectInput): Promise<void>
  deleteObjects(objectKeys: string[]): Promise<void>
}

export interface OcrInput {
  objectKey: string
  mimeType: string
  analysisVersion: number
  pageCount: number | null
}

export interface OcrPageResult {
  pageNumber: number
  text: string
  confidence: number | null
}

export interface OcrResult {
  pages: OcrPageResult[]
  provider: string
}

export interface DocumentOcrProvider {
  extract(input: OcrInput): Promise<OcrResult>
}

export interface ClassificationInput {
  documentId: string
  documentName: string
  pages: OcrPageResult[]
  analysisVersion: number
}

export interface ClassificationResult {
  category: FamilyDocumentCategory
  confidence: number | null
}

export interface DocumentClassifier {
  classify(input: ClassificationInput): Promise<ClassificationResult>
}

export interface BackupInput {
  spaceId: string
  documentId: string
  objectKey: string
  fileName: string
  mimeType: string
  sha256: string | null
}

export interface BackupResult {
  providerFileId: string
  displayName: string
  exportedAt: Date
}

export interface DocumentBackupProvider {
  export(input: BackupInput): Promise<BackupResult>
}
