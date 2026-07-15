import { httpsCallable } from 'firebase/functions'
import {
  collection,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
  type Unsubscribe,
} from 'firebase/firestore'
import { functions } from '@/services/firebaseFunctions'
import { db } from '@/services/firebase'
import type {
  CreateDocumentUploadInput,
  DocumentSuggestion,
  DocumentTaskLink,
  FamilyDocumentCategory,
  FamilyDocumentSource,
} from '@/types'

export interface SignedDocumentUpload {
  url: string
  method: 'PUT'
  headers: Record<string, string>
  expiresAt: string
}

export interface CreateDocumentUploadResult {
  documentId: string
  upload: SignedDocumentUpload
}

export interface CompleteDocumentUploadResult {
  documentId: string
  status: string
}

export interface CreateDocumentCalendarEventResult {
  success: boolean
  eventId: string
  alreadyRegistered: boolean
}

export interface ReanalyzeDocumentSuggestionsResult {
  success: boolean
  suggestionCount: number
}

export interface DocumentAccessResult {
  url: string
  expiresAt: string
  mimeType: string
  name: string
}

export interface DocumentThumbnailAccessResult {
  url: string
  expiresAt: string
}

export interface DocumentTextPage {
  pageNumber: number
  text: string
  confidence: number | null
  source: 'pdf_text' | 'cloud_vision'
}

export interface DocumentTextResult {
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'
  provider: string | null
  pageCount: number | null
  pendingExternalOcrPageNumbers: number[]
  pages: DocumentTextPage[]
}

export interface DocumentSearchIndexPage {
  pageNumber: number
  text: string
  normalizedText: string
}

export interface DocumentSearchIndexEntry {
  documentId: string
  name: string
  normalizedName: string
  category: FamilyDocumentCategory
  documentDate: string | null
  pages: DocumentSearchIndexPage[]
}

export interface DocumentSearchIndexArtifact {
  schemaVersion: number
  spaceId: string
  version: string
  generatedAt: string
  entries: DocumentSearchIndexEntry[]
}

export interface DocumentSearchIndexAccessResult {
  version: string
  url: string
  expiresAt: string
}

export interface DocumentBulkDownloadEntry {
  documentId: string
  name: string
  archiveName: string
  mimeType: string
  sizeBytes: number
  category: string
  documentDate: string | null
  url: string
}

export interface DocumentBulkDownloadPart {
  partNumber: number
  fileName: string
  totalBytes: number
  entries: DocumentBulkDownloadEntry[]
}

export interface DocumentBulkDownloadManifest {
  totalFiles: number
  totalBytes: number
  parts: DocumentBulkDownloadPart[]
}

export interface UpdateDocumentOcrSettingsResult {
  success: boolean
  enabled: boolean
  policyVersion: number
  monthlyPageLimit: number
  monthlyWarningPages: number
  queuedDocumentCount: number
}

export function subscribeTaskDocumentLinks(
  spaceId: string,
  taskId: string,
  onLinks: (links: DocumentTaskLink[]) => void,
  onError: (error: Error) => void
): Unsubscribe {
  const linksQuery = query(
    collection(db, 'spaces', spaceId, 'documentTaskLinks'),
    where('taskId', '==', taskId)
  )
  return onSnapshot(linksQuery, (snapshot) => {
    onLinks(snapshot.docs.map((snapshot) => snapshot.data() as DocumentTaskLink))
  }, (error) => onError(error))
}

export async function linkDocumentToTaskApi(
  spaceId: string,
  taskId: string,
  documentId: string
): Promise<void> {
  const callable = httpsCallable<
    { spaceId: string; taskId: string; documentId: string },
    { success: boolean; linkId: string; created: boolean }
  >(functions, 'linkDocumentToTask')
  await callable({ spaceId, taskId, documentId })
}

export async function unlinkDocumentFromTaskApi(
  spaceId: string,
  taskId: string,
  documentId: string
): Promise<void> {
  const callable = httpsCallable<
    { spaceId: string; taskId: string; documentId: string },
    { success: boolean }
  >(functions, 'unlinkDocumentFromTask')
  await callable({ spaceId, taskId, documentId })
}

export async function getDocumentSuggestionsApi(
  spaceId: string,
  documentId: string
): Promise<DocumentSuggestion[]> {
  const suggestionsQuery = query(
    collection(db, 'spaces', spaceId, 'documents', documentId, 'suggestions'),
    orderBy('createdAt', 'asc')
  )
  const snapshot = await getDocs(suggestionsQuery)
  return snapshot.docs.map((suggestionSnapshot) => ({
    ...(suggestionSnapshot.data() as Omit<DocumentSuggestion, 'id'>),
    id: suggestionSnapshot.id,
  }))
}

export async function calculateFileSha256(file: File): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null
  return calculateArrayBufferSha256(await file.arrayBuffer())
}

async function calculateArrayBufferSha256(data: ArrayBuffer): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

export async function createDocumentUploadApi(
  input: CreateDocumentUploadInput
): Promise<CreateDocumentUploadResult> {
  const callable = httpsCallable<CreateDocumentUploadInput, CreateDocumentUploadResult>(
    functions,
    'createDocumentUpload'
  )
  return (await callable(input)).data
}

export async function uploadDocumentFile(
  upload: SignedDocumentUpload,
  file: Blob
): Promise<void> {
  const response = await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: file,
  })
  if (!response.ok) {
    throw new Error(`原本のアップロードに失敗しました（${response.status}）`)
  }
}

export async function completeDocumentUploadApi(
  spaceId: string,
  documentId: string
): Promise<CompleteDocumentUploadResult> {
  const callable = httpsCallable<
    { spaceId: string; documentId: string },
    CompleteDocumentUploadResult
  >(functions, 'completeDocumentUpload')
  return (await callable({ spaceId, documentId })).data
}

export async function getDocumentAccessUrlApi(
  spaceId: string,
  documentId: string
): Promise<DocumentAccessResult> {
  const callable = httpsCallable<
    { spaceId: string; documentId: string },
    DocumentAccessResult
  >(functions, 'getDocumentAccessUrl')
  return (await callable({ spaceId, documentId })).data
}

export async function getDocumentDownloadUrlApi(
  spaceId: string,
  documentId: string
): Promise<DocumentAccessResult> {
  const callable = httpsCallable<
    { spaceId: string; documentId: string; download: true },
    DocumentAccessResult
  >(functions, 'getDocumentAccessUrl')
  return (await callable({ spaceId, documentId, download: true })).data
}

export async function getDocumentBulkDownloadManifestApi(
  spaceId: string
): Promise<DocumentBulkDownloadManifest> {
  const callable = httpsCallable<
    { spaceId: string },
    DocumentBulkDownloadManifest
  >(functions, 'getDocumentBulkDownloadManifest')
  return (await callable({ spaceId })).data
}

export async function createDocumentCalendarEventApi(
  spaceId: string,
  documentId: string,
  suggestionId: string
): Promise<CreateDocumentCalendarEventResult> {
  const callable = httpsCallable<
    { spaceId: string; documentId: string; suggestionId: string },
    CreateDocumentCalendarEventResult
  >(functions, 'createDocumentCalendarEvent')
  return (await callable({ spaceId, documentId, suggestionId })).data
}

export async function getDocumentThumbnailAccessUrlApi(
  spaceId: string,
  documentId: string
): Promise<DocumentThumbnailAccessResult> {
  const callable = httpsCallable<
    { spaceId: string; documentId: string },
    DocumentThumbnailAccessResult
  >(functions, 'getDocumentThumbnailAccessUrl')
  return (await callable({ spaceId, documentId })).data
}

export async function getDocumentTextApi(
  spaceId: string,
  documentId: string
): Promise<DocumentTextResult> {
  const callable = httpsCallable<
    { spaceId: string; documentId: string },
    DocumentTextResult
  >(functions, 'getDocumentText')
  return (await callable({ spaceId, documentId })).data
}

export async function reanalyzeDocumentSuggestionsApi(
  spaceId: string,
  documentId: string
): Promise<ReanalyzeDocumentSuggestionsResult> {
  const callable = httpsCallable<
    { spaceId: string; documentId: string },
    ReanalyzeDocumentSuggestionsResult
  >(functions, 'reanalyzeDocumentSuggestions')
  return (await callable({ spaceId, documentId })).data
}

export async function getDocumentSearchIndexApi(
  spaceId: string
): Promise<DocumentSearchIndexAccessResult> {
  const callable = httpsCallable<
    { spaceId: string },
    DocumentSearchIndexAccessResult
  >(functions, 'getDocumentSearchIndex')
  return (await callable({ spaceId })).data
}

export async function downloadDocumentSearchIndex(
  url: string
): Promise<DocumentSearchIndexArtifact> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error('書類検索データを取得できませんでした')
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('このブラウザは書類検索データの展開に対応していません')
  }
  const decompressed = response.body?.pipeThrough(new DecompressionStream('gzip'))
  if (!decompressed) throw new Error('書類検索データを読み込めませんでした')
  const parsed = JSON.parse(await new Response(decompressed).text()) as unknown
  if (!isDocumentSearchIndexArtifact(parsed)) {
    throw new Error('書類検索データの形式が不正です')
  }
  return parsed
}

function isDocumentSearchIndexArtifact(value: unknown): value is DocumentSearchIndexArtifact {
  if (typeof value !== 'object' || value === null) return false
  const artifact = value as Partial<DocumentSearchIndexArtifact>
  return artifact.schemaVersion === 1
    && typeof artifact.spaceId === 'string'
    && typeof artifact.version === 'string'
    && typeof artifact.generatedAt === 'string'
    && Array.isArray(artifact.entries)
    && artifact.entries.every(isDocumentSearchIndexEntry)
}

function isDocumentSearchIndexEntry(value: unknown): value is DocumentSearchIndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<DocumentSearchIndexEntry>
  return typeof entry.documentId === 'string'
    && typeof entry.name === 'string'
    && typeof entry.normalizedName === 'string'
    && typeof entry.category === 'string'
    && Array.isArray(entry.pages)
    && entry.pages.every((value) => {
      if (typeof value !== 'object' || value === null) return false
      const page = value as Partial<DocumentSearchIndexPage>
      return Number.isSafeInteger(page.pageNumber)
        && typeof page.text === 'string'
        && typeof page.normalizedText === 'string'
    })
}

export async function retryDocumentThumbnailApi(
  spaceId: string,
  documentId: string
): Promise<void> {
  const callable = httpsCallable<
    { spaceId: string; documentId: string },
    { success: boolean }
  >(functions, 'retryDocumentThumbnail')
  await callable({ spaceId, documentId })
}

export async function retryDocumentTextApi(
  spaceId: string,
  documentId: string
): Promise<void> {
  const callable = httpsCallable<
    { spaceId: string; documentId: string },
    { success: boolean; status: string }
  >(functions, 'retryDocumentText')
  await callable({ spaceId, documentId })
}

export async function updateDocumentOcrSettingsApi(
  spaceId: string,
  enabled: boolean,
  acceptedPolicyVersion?: number
): Promise<UpdateDocumentOcrSettingsResult> {
  const callable = httpsCallable<
    { spaceId: string; enabled: boolean; acceptedPolicyVersion?: number },
    UpdateDocumentOcrSettingsResult
  >(functions, 'updateDocumentOcrSettings')
  return (await callable({ spaceId, enabled, acceptedPolicyVersion })).data
}

async function callDocumentMutation(
  functionName: 'trashDocument' | 'restoreDocument' | 'permanentlyDeleteDocument',
  spaceId: string,
  documentId: string
): Promise<void> {
  const callable = httpsCallable<
    { spaceId: string; documentId: string },
    { success: boolean }
  >(functions, functionName)
  await callable({ spaceId, documentId })
}

export async function trashDocumentApi(spaceId: string, documentId: string): Promise<void> {
  await callDocumentMutation('trashDocument', spaceId, documentId)
}

export async function restoreDocumentApi(spaceId: string, documentId: string): Promise<void> {
  await callDocumentMutation('restoreDocument', spaceId, documentId)
}

export async function permanentlyDeleteDocumentApi(
  spaceId: string,
  documentId: string
): Promise<void> {
  await callDocumentMutation('permanentlyDeleteDocument', spaceId, documentId)
}

export async function uploadDocument(
  spaceId: string,
  file: File,
  source: FamilyDocumentSource
): Promise<string> {
  const mimeType = file.type || 'application/octet-stream'
  const fileData = await file.arrayBuffer()
  const sha256 = await calculateArrayBufferSha256(fileData)
  const created = await createDocumentUploadApi({
    spaceId,
    name: file.name || '名称未設定',
    source,
    mimeType,
    sizeBytes: file.size,
    ...(sha256 ? { sha256 } : {}),
  })
  await uploadDocumentFile(created.upload, new Blob([fileData], { type: mimeType }))
  await completeDocumentUploadApi(spaceId, created.documentId)
  return created.documentId
}
