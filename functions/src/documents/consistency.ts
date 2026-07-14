import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import {
  buildDocumentCleanupPlan,
  buildDocumentIntegrityUpdates,
  buildReconciledDocumentUsage,
  ConsistencyDocument,
  STALE_UPLOAD_RETENTION_MS,
  shouldApplyReconciledUsage,
} from './consistencyPlan'
import {
  DEFAULT_DOCUMENT_LIMIT_BYTES,
  DEFAULT_DOCUMENT_WARNING_BYTES,
} from './lifecycle'
import { createObjectStorageProvider } from './providers/providerFactory'
import { FamilyDocument } from './types'

const db = admin.firestore()

interface DocumentSnapshotEntry {
  snapshot: admin.firestore.QueryDocumentSnapshot
  document: ConsistencyDocument
}

function toConsistencyDocument(
  snapshot: admin.firestore.QueryDocumentSnapshot
): ConsistencyDocument | null {
  const spaceId = snapshot.ref.parent.parent?.id
  if (!spaceId) return null
  const data = snapshot.data() as FamilyDocument
  const updatedAtMs = data.updatedAt?.toMillis?.()
  if (!Number.isFinite(updatedAtMs)) return null
  return {
    spaceId,
    documentId: snapshot.id,
    status: data.status,
    updatedAtMs,
    originalObjectKey: data.originalObjectKey,
    thumbnailObjectKey: data.thumbnailObjectKey ?? null,
    ocrObjectKey: data.ocrObjectKey ?? null,
    integrityStatus: data.integrityStatus ?? 'unchecked',
  }
}

async function loadDocuments(): Promise<DocumentSnapshotEntry[]> {
  const snapshot = await db.collectionGroup('documents').get()
  return snapshot.docs.flatMap((documentSnapshot): DocumentSnapshotEntry[] => {
    const document = toConsistencyDocument(documentSnapshot)
    return document ? [{ snapshot: documentSnapshot, document }] : []
  })
}

async function deleteStaleDocument(
  entry: DocumentSnapshotEntry,
  cutoffMs: number
): Promise<boolean> {
  return db.runTransaction(async (transaction) => {
    const latestSnapshot = await transaction.get(entry.snapshot.ref)
    if (!latestSnapshot.exists) return false
    const latestDocument = latestSnapshot.data() as FamilyDocument
    const updatedAtMs = latestDocument.updatedAt?.toMillis?.()
    if (latestDocument.status !== 'uploading'
      || !Number.isFinite(updatedAtMs)
      || updatedAtMs > cutoffMs) {
      return false
    }
    transaction.delete(entry.snapshot.ref)
    return true
  })
}

export async function runDocumentConsistency(now: Date = new Date()): Promise<void> {
  const provider = createObjectStorageProvider()
  const [initialEntries, initialObjects] = await Promise.all([
    loadDocuments(),
    provider.listObjects('spaces/'),
  ])
  const initialDocuments = initialEntries.map((entry) => entry.document)
  const entryByKey = new Map(initialEntries.map((entry) => [
    `${entry.document.spaceId}\n${entry.document.documentId}`,
    entry,
  ]))
  const cleanupPlan = buildDocumentCleanupPlan(initialDocuments, initialObjects, now.getTime())
  let staleDocumentCount = 0
  for (const staleDocument of cleanupPlan.staleDocuments) {
    const entry = entryByKey.get(`${staleDocument.spaceId}\n${staleDocument.documentId}`)
    if (!entry) continue
    const deleted = await deleteStaleDocument(
      entry,
      now.getTime() - STALE_UPLOAD_RETENTION_MS
    )
    if (!deleted) continue
    staleDocumentCount += 1
    await provider.deleteObjects(staleDocument.objectKeys)
  }
  await provider.deleteObjects(cleanupPlan.orphanObjectKeys)

  const [latestEntries, latestObjects] = await Promise.all([
    loadDocuments(),
    provider.listObjects('spaces/'),
  ])
  const latestDocuments = latestEntries.map((entry) => entry.document)
  const integrityUpdates = buildDocumentIntegrityUpdates(latestDocuments, latestObjects)
  const latestEntryByKey = new Map(latestEntries.map((entry) => [
    `${entry.document.spaceId}\n${entry.document.documentId}`,
    entry,
  ]))
  const integrityWriter = db.bulkWriter()
  integrityUpdates.forEach((update) => {
    const entry = latestEntryByKey.get(`${update.spaceId}\n${update.documentId}`)
    if (!entry) return
    integrityWriter.update(entry.snapshot.ref, {
      integrityStatus: update.status,
      integrityError: update.status === 'missing_original'
        ? '保存先で原本を確認できませんでした'
        : null,
      integrityCheckedAt: Timestamp.fromDate(now),
      updatedAt: Timestamp.fromDate(now),
    })
  })
  await integrityWriter.close()

  const allSpaceIds = [...new Set(initialDocuments.map((document) => document.spaceId))]
  const usageBySpace = buildReconciledDocumentUsage(
    latestDocuments,
    latestObjects,
    allSpaceIds
  )
  let reconciledSpaceCount = 0
  for (const [spaceId, usage] of Object.entries(usageBySpace)) {
    const usageRef = db.doc(`spaces/${spaceId}/usage/documents`)
    const reconciled = await db.runTransaction(async (transaction) => {
      const usageSnapshot = await transaction.get(usageRef)
      const latestUpdatedAtMs = usageSnapshot.data()?.updatedAt?.toMillis?.()
      if (!shouldApplyReconciledUsage(
        now.getTime(),
        Number.isFinite(latestUpdatedAtMs) ? latestUpdatedAtMs : undefined
      )) {
        return false
      }
      transaction.set(usageRef, {
        ...usage,
        limitBytes: usageSnapshot.data()?.limitBytes ?? DEFAULT_DOCUMENT_LIMIT_BYTES,
        warningBytes: usageSnapshot.data()?.warningBytes ?? DEFAULT_DOCUMENT_WARNING_BYTES,
        updatedAt: Timestamp.fromDate(now),
      }, { merge: true })
      return true
    })
    if (reconciled) reconciledSpaceCount += 1
  }

  console.log('[documentConsistency] completed', {
    staleDocumentCount,
    orphanObjectCount: cleanupPlan.orphanObjectKeys.length,
    integrityUpdateCount: integrityUpdates.length,
    reconciledSpaceCount,
  })
}
