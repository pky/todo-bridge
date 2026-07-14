import { createHash } from 'node:crypto'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { buildDocumentSearchIndexObjectKey, isObjectKeyInDocument } from './objectKeys'
import { decodeDocumentTextArtifact } from './ocr/artifact'
import { ObjectStorageProvider } from './providers/types'
import { FamilyDocument } from './types'

const gzipAsync = promisify(gzip)
export const DOCUMENT_SEARCH_INDEX_SCHEMA_VERSION = 1
const SEARCH_INDEX_MAX_BYTES = 20 * 1024 * 1024

export interface DocumentSearchIndexPage {
  pageNumber: number
  text: string
  normalizedText: string
}

export interface DocumentSearchIndexEntry {
  documentId: string
  name: string
  normalizedName: string
  category: FamilyDocument['category']
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

export function normalizeDocumentSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/g, ' ').trim()
}

function getDocumentDate(document: FamilyDocument): string | null {
  return document.documentDate?.toDate().toISOString() ?? null
}

function getSearchableDocuments(documents: FamilyDocument[]): FamilyDocument[] {
  return documents
    .filter((document) => document.status !== 'trashed')
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function getDocumentSearchIndexVersion(documents: FamilyDocument[]): string {
  const searchableDocuments = getSearchableDocuments(documents)
  const source = searchableDocuments.map((document) => ({
    id: document.id,
    name: document.name,
    category: document.category,
    status: document.status,
    documentDate: getDocumentDate(document),
    analysisVersion: document.analysisVersion,
    ocrObjectKey: document.ocrObjectKey,
  }))
  return createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 24)
}

export async function buildDocumentSearchIndex(
  provider: ObjectStorageProvider,
  spaceId: string,
  documents: FamilyDocument[],
  generatedAt: Date = new Date()
): Promise<{ artifact: DocumentSearchIndexArtifact; objectKey: string; data: Buffer }> {
  const searchableDocuments = getSearchableDocuments(documents)
  const version = getDocumentSearchIndexVersion(searchableDocuments)
  const entries = await Promise.all(searchableDocuments.map(async (document) => {
    const pages: DocumentSearchIndexPage[] = []
    if (document.ocrObjectKey
      && isObjectKeyInDocument(document.ocrObjectKey, spaceId, document.id)) {
      const stored = await provider.readObject(document.ocrObjectKey)
      if (stored) {
        try {
          const textArtifact = await decodeDocumentTextArtifact(stored)
          if (textArtifact.analysisVersion === document.analysisVersion) {
            textArtifact.pages.forEach((page) => {
              pages.push({
                pageNumber: page.pageNumber,
                text: page.text,
                normalizedText: normalizeDocumentSearchText(page.text),
              })
            })
          }
        } catch {
          // 壊れたOCR成果物は検索対象から外し、他の書類の検索を継続する
        }
      }
    }
    return {
      documentId: document.id,
      name: document.name,
      normalizedName: normalizeDocumentSearchText(document.name),
      category: document.category,
      documentDate: getDocumentDate(document),
      pages,
    }
  }))
  const artifact: DocumentSearchIndexArtifact = {
    schemaVersion: DOCUMENT_SEARCH_INDEX_SCHEMA_VERSION,
    spaceId,
    version,
    generatedAt: generatedAt.toISOString(),
    entries,
  }
  const source = Buffer.from(JSON.stringify(artifact))
  if (source.length > SEARCH_INDEX_MAX_BYTES) {
    throw new Error('書類検索インデックスのサイズが上限を超えています')
  }
  const data = await gzipAsync(source, { level: 9 })
  return {
    artifact,
    objectKey: buildDocumentSearchIndexObjectKey(spaceId, version),
    data,
  }
}
