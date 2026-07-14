import { FamilyDocumentStatus } from './types'
import { ListedObject } from './providers/types'

export const STALE_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000
export const ORPHAN_OBJECT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface ConsistencyDocument {
  spaceId: string
  documentId: string
  status: FamilyDocumentStatus
  updatedAtMs: number
  originalObjectKey: string
  thumbnailObjectKey: string | null
  ocrObjectKey: string | null
  integrityStatus?: 'unchecked' | 'ok' | 'missing_original'
}

export interface ParsedDocumentObjectKey {
  spaceId: string
  documentId: string
  kind: 'original' | 'derived'
}

export interface StaleDocumentCleanup {
  spaceId: string
  documentId: string
  objectKeys: string[]
}

export interface DocumentCleanupPlan {
  staleDocuments: StaleDocumentCleanup[]
  orphanObjectKeys: string[]
}

export interface DocumentIntegrityUpdate {
  spaceId: string
  documentId: string
  status: 'ok' | 'missing_original'
}

export interface ReconciledDocumentUsage {
  originalBytes: number
  derivedBytes: number
  documentCount: number
}

export function shouldApplyReconciledUsage(
  reconciliationStartedAtMs: number,
  currentUsageUpdatedAtMs: number | undefined
): boolean {
  return currentUsageUpdatedAtMs === undefined
    || currentUsageUpdatedAtMs < reconciliationStartedAtMs
}

export function parseDocumentObjectKey(objectKey: string): ParsedDocumentObjectKey | null {
  const match = objectKey.match(
    /^spaces\/([^/]+)\/documents\/([^/]+)\/(original\/[^/]+|thumbnail\/v\d+\.webp|analysis\/v\d+\/ocr\.json\.gz)$/
  )
  if (!match) return null
  return {
    spaceId: match[1],
    documentId: match[2],
    kind: match[3].startsWith('original/') ? 'original' : 'derived',
  }
}

function getDocumentKey(spaceId: string, documentId: string): string {
  return `${spaceId}\n${documentId}`
}

export function buildDocumentCleanupPlan(
  documents: ConsistencyDocument[],
  objects: ListedObject[],
  nowMs: number
): DocumentCleanupPlan {
  const objectsByDocument = new Map<string, string[]>()
  objects.forEach((object) => {
    const parsed = parseDocumentObjectKey(object.objectKey)
    if (!parsed) return
    const key = getDocumentKey(parsed.spaceId, parsed.documentId)
    objectsByDocument.set(key, [...(objectsByDocument.get(key) ?? []), object.objectKey])
  })

  const staleDocuments = documents
    .filter((document) => document.status === 'uploading'
      && document.updatedAtMs <= nowMs - STALE_UPLOAD_RETENTION_MS)
    .map((document) => ({
      spaceId: document.spaceId,
      documentId: document.documentId,
      objectKeys: objectsByDocument.get(
        getDocumentKey(document.spaceId, document.documentId)
      ) ?? [],
    }))

  const expectedObjectKeys = new Set<string>()
  documents.forEach((document) => {
    expectedObjectKeys.add(document.originalObjectKey)
    if (document.thumbnailObjectKey) expectedObjectKeys.add(document.thumbnailObjectKey)
    if (document.ocrObjectKey) expectedObjectKeys.add(document.ocrObjectKey)
  })
  const staleObjectKeys = new Set(staleDocuments.flatMap((document) => document.objectKeys))
  const orphanObjectKeys = objects
    .filter((object) => {
      if (!parseDocumentObjectKey(object.objectKey)
        || expectedObjectKeys.has(object.objectKey)
        || staleObjectKeys.has(object.objectKey)
        || !object.lastModifiedAt) {
        return false
      }
      return object.lastModifiedAt.getTime() <= nowMs - ORPHAN_OBJECT_RETENTION_MS
    })
    .map((object) => object.objectKey)

  return { staleDocuments, orphanObjectKeys }
}

export function buildDocumentIntegrityUpdates(
  documents: ConsistencyDocument[],
  objects: ListedObject[]
): DocumentIntegrityUpdate[] {
  const objectKeys = new Set(objects.map((object) => object.objectKey))
  return documents
    .filter((document) => document.status !== 'uploading')
    .flatMap((document): DocumentIntegrityUpdate[] => {
      const status = objectKeys.has(document.originalObjectKey) ? 'ok' : 'missing_original'
      if (document.integrityStatus === status) return []
      return [{
        spaceId: document.spaceId,
        documentId: document.documentId,
        status,
      }]
    })
}

export function buildReconciledDocumentUsage(
  documents: ConsistencyDocument[],
  objects: ListedObject[],
  additionalSpaceIds: string[] = []
): Record<string, ReconciledDocumentUsage> {
  const usageBySpace: Record<string, ReconciledDocumentUsage> = {}
  const ensureUsage = (spaceId: string): ReconciledDocumentUsage => {
    usageBySpace[spaceId] ??= { originalBytes: 0, derivedBytes: 0, documentCount: 0 }
    return usageBySpace[spaceId]
  }
  additionalSpaceIds.forEach(ensureUsage)
  documents.forEach((document) => ensureUsage(document.spaceId))
  objects.forEach((object) => {
    const parsed = parseDocumentObjectKey(object.objectKey)
    if (!parsed) return
    const usage = ensureUsage(parsed.spaceId)
    if (parsed.kind === 'original') usage.originalBytes += object.sizeBytes
    else usage.derivedBytes += object.sizeBytes
  })

  const objectKeys = new Set(objects.map((object) => object.objectKey))
  documents.forEach((document) => {
    if (document.status !== 'uploading' && objectKeys.has(document.originalObjectKey)) {
      ensureUsage(document.spaceId).documentCount += 1
    }
  })
  return usageBySpace
}
