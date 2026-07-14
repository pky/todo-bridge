import { createHash } from 'node:crypto'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { buildOcrResultObjectKey, isObjectKeyInDocument } from '../objectKeys'
import { ObjectStorageProvider, OcrPageResult, OcrResult } from '../providers/types'
import { FamilyDocument } from '../types'
import { extractPdfText } from './pdfText'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export const OCR_ARTIFACT_SCHEMA_VERSION = 1
export const OCR_ARTIFACT_MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024

export interface DocumentTextArtifact {
  schemaVersion: number
  analysisVersion: number
  originalSha256: string
  provider: string
  pageCount: number
  pendingExternalOcrPageNumbers: number[]
  pages: OcrPageResult[]
}

export async function writeDocumentTextArtifact(
  provider: ObjectStorageProvider,
  spaceId: string,
  documentId: string,
  analysisVersion: number,
  original: Buffer,
  result: OcrResult & { pageCount: number }
): Promise<GeneratedDocumentTextArtifact> {
  const originalSha256 = calculateSha256(original)
  const objectKey = buildOcrResultObjectKey(spaceId, documentId, analysisVersion)
  const artifact: DocumentTextArtifact = {
    schemaVersion: OCR_ARTIFACT_SCHEMA_VERSION,
    analysisVersion,
    originalSha256,
    provider: result.provider,
    pageCount: result.pageCount,
    pendingExternalOcrPageNumbers: [],
    pages: result.pages,
  }
  const data = await gzipAsync(Buffer.from(JSON.stringify(artifact)), { level: 9 })
  await provider.writeObject({
    objectKey,
    contentType: 'application/gzip',
    data,
    metadata: {
      schemaversion: String(OCR_ARTIFACT_SCHEMA_VERSION),
      analysisversion: String(analysisVersion),
      originalsha256: originalSha256,
      pagecount: String(result.pageCount),
      externalocrcompleted: 'true',
    },
  })
  return { objectKey, data, artifact, reused: false }
}

export interface GeneratedDocumentTextArtifact {
  objectKey: string
  data: Buffer
  artifact: DocumentTextArtifact
  reused: boolean
}

function isOcrPageResult(value: unknown): value is OcrPageResult {
  if (typeof value !== 'object' || value === null) return false
  const page = value as Partial<OcrPageResult>
  return Number.isSafeInteger(page.pageNumber)
    && (page.pageNumber ?? 0) > 0
    && typeof page.text === 'string'
    && (page.confidence === null
      || (typeof page.confidence === 'number' && Number.isFinite(page.confidence)))
    && (page.source === 'pdf_text' || page.source === 'cloud_vision')
}

export async function decodeDocumentTextArtifact(data: Buffer): Promise<DocumentTextArtifact> {
  if (data.length > OCR_ARTIFACT_MAX_UNCOMPRESSED_BYTES) {
    throw new Error('OCR成果物のサイズが上限を超えています')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse((await gunzipAsync(data, {
      maxOutputLength: OCR_ARTIFACT_MAX_UNCOMPRESSED_BYTES,
    })).toString('utf8'))
  } catch {
    throw new Error('OCR成果物を読み込めませんでした')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('OCR成果物の形式が不正です')
  }
  const artifact = parsed as Partial<DocumentTextArtifact>
  if (artifact.schemaVersion !== OCR_ARTIFACT_SCHEMA_VERSION
    || !Number.isSafeInteger(artifact.analysisVersion)
    || (artifact.analysisVersion ?? 0) <= 0
    || typeof artifact.originalSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(artifact.originalSha256)
    || typeof artifact.provider !== 'string'
    || !Number.isSafeInteger(artifact.pageCount)
    || (artifact.pageCount ?? 0) <= 0
    || !Array.isArray(artifact.pendingExternalOcrPageNumbers)
    || !artifact.pendingExternalOcrPageNumbers.every((pageNumber) => (
      Number.isSafeInteger(pageNumber) && pageNumber > 0
    ))
    || !Array.isArray(artifact.pages)
    || !artifact.pages.every(isOcrPageResult)) {
    throw new Error('OCR成果物の形式が不正です')
  }
  return artifact as DocumentTextArtifact
}

function calculateSha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

async function readStoredArtifact(
  provider: ObjectStorageProvider,
  objectKey: string,
  originalSha256: string,
  analysisVersion: number
): Promise<GeneratedDocumentTextArtifact | null> {
  const stored = await provider.stat(objectKey)
  if (stored?.metadata.originalsha256 !== originalSha256
    || stored.metadata.analysisversion !== String(analysisVersion)) {
    return null
  }
  const data = await provider.readObject(objectKey)
  if (!data) return null
  try {
    const artifact = await decodeDocumentTextArtifact(data)
    if (artifact.schemaVersion !== OCR_ARTIFACT_SCHEMA_VERSION
      || artifact.analysisVersion !== analysisVersion
      || artifact.originalSha256 !== originalSha256
      || !Array.isArray(artifact.pages)) {
      return null
    }
    return { objectKey, data, artifact, reused: true }
  } catch {
    return null
  }
}

export async function generatePdfTextArtifact(
  provider: ObjectStorageProvider,
  spaceId: string,
  documentId: string,
  document: Pick<FamilyDocument, 'mimeType' | 'originalObjectKey' | 'analysisVersion'>
): Promise<GeneratedDocumentTextArtifact> {
  if (document.mimeType !== 'application/pdf') {
    throw new Error('PDF文字抽出対象の書類ではありません')
  }
  if (!isObjectKeyInDocument(document.originalObjectKey, spaceId, documentId)) {
    throw new Error('原本のオブジェクトキーが書類と一致しません')
  }
  const original = await provider.readObject(document.originalObjectKey)
  if (!original) throw new Error('文字抽出用の原本が見つかりません')

  const originalSha256 = calculateSha256(original)
  const objectKey = buildOcrResultObjectKey(
    spaceId,
    documentId,
    document.analysisVersion
  )
  const existing = await readStoredArtifact(
    provider,
    objectKey,
    originalSha256,
    document.analysisVersion
  )
  if (existing) return existing

  const extracted = await extractPdfText(original)
  const artifact: DocumentTextArtifact = {
    schemaVersion: OCR_ARTIFACT_SCHEMA_VERSION,
    analysisVersion: document.analysisVersion,
    originalSha256,
    provider: 'pdf_text',
    pageCount: extracted.pageCount,
    pendingExternalOcrPageNumbers: extracted.pages
      .filter((page) => page.requiresOcr)
      .map((page) => page.pageNumber),
    pages: extracted.pages.map((page) => ({
      pageNumber: page.pageNumber,
      text: page.text,
      confidence: page.confidence,
      source: page.source,
    })),
  }
  const data = await gzipAsync(Buffer.from(JSON.stringify(artifact)), { level: 9 })
  await provider.writeObject({
    objectKey,
    contentType: 'application/gzip',
    data,
    metadata: {
      schemaversion: String(OCR_ARTIFACT_SCHEMA_VERSION),
      analysisversion: String(document.analysisVersion),
      originalsha256: originalSha256,
      pagecount: String(extracted.pageCount),
    },
  })
  return { objectKey, data, artifact, reused: false }
}
