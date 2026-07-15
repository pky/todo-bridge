import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { DocumentTextArtifact } from './ocr/artifact'
import { classifyDocumentByRules } from './classification/ruleBasedClassifier'
import { extractDocumentSuggestions } from './extraction/ruleBasedExtractor'
import { FamilyDocument } from './types'

export async function analyzeAndStoreDocumentText(
  documentRef: admin.firestore.DocumentReference,
  document: FamilyDocument,
  artifact: DocumentTextArtifact
): Promise<number> {
  if (artifact.analysisVersion !== document.analysisVersion) return 0
  const currentSnapshot = await documentRef.get()
  if (!currentSnapshot.exists) return 0
  const current = currentSnapshot.data() as FamilyDocument
  if (current.analysisVersion !== document.analysisVersion
    || !['uploaded', 'processing', 'ready'].includes(current.status)) return 0
  const classification = classifyDocumentByRules(document.name, artifact.pages)
  const suggestions = extractDocumentSuggestions(artifact.pages, document.createdAt.toDate())
  const suggestionsRef = documentRef.collection('suggestions')
  const existingSnapshot = await suggestionsRef.get()
  const existingById = new Map(existingSnapshot.docs.map((snapshot) => [snapshot.id, snapshot]))
  const generatedIds = new Set(suggestions.map((suggestion) => suggestion.id))
  const now = Timestamp.now()
  const writer = admin.firestore().bulkWriter()

  suggestions.forEach((suggestion) => {
    const existing = existingById.get(suggestion.id)
    if (existing && ['accepted', 'dismissed'].includes(existing.data().status)) return
    writer.set(suggestionsRef.doc(suggestion.id), {
      ...suggestion,
      status: 'pending',
      generatedByVersion: document.analysisVersion,
      acceptedBy: null,
      acceptedAt: null,
      createdAt: existing?.data().createdAt ?? now,
      updatedAt: now,
    })
  })
  existingSnapshot.docs.forEach((snapshot) => {
    if (snapshot.data().status === 'pending' && !generatedIds.has(snapshot.id)) {
      writer.delete(snapshot.ref)
    }
  })
  await writer.close()

  await admin.firestore().runTransaction(async (transaction) => {
    const latestSnapshot = await transaction.get(documentRef)
    if (!latestSnapshot.exists) return
    const latest = latestSnapshot.data() as FamilyDocument
    if (latest.analysisVersion !== document.analysisVersion || latest.status === 'trashed') return
    const update: Record<string, unknown> = {
      classificationVersion: document.analysisVersion,
      classificationConfidence: classification.confidence,
      updatedAt: Timestamp.now(),
    }
    if (latest.classificationVersion == null && latest.category === 'other') {
      update.category = classification.category
    }
    transaction.update(documentRef, update)
  })
  return suggestions.length
}
