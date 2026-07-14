const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

admin.initializeApp({ projectId: 'demo-rertm' })

const { runDocumentConsistency } = require('../lib/documents/consistency')
const {
  LocalObjectStorageProvider,
  writeLocalObject,
} = require('../lib/documents/providers/localProvider')

const db = admin.firestore()

function createDocument(spaceId, documentId, objectKey, status, updatedAt) {
  return {
    id: documentId,
    spaceId,
    status,
    originalObjectKey: objectKey,
    thumbnailObjectKey: null,
    updatedAt,
    integrityStatus: 'unchecked',
  }
}

test('整合性ジョブが中断upload、孤立object、欠損原本、容量を修復する', async () => {
  const uniqueId = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const spaceId = `consistency_${uniqueId}`
  const staleDocumentId = 'stale_document'
  const activeDocumentId = 'active_document'
  const missingDocumentId = 'missing_document'
  const staleObjectKey = `spaces/${spaceId}/documents/${staleDocumentId}/original/object_1`
  const activeObjectKey = `spaces/${spaceId}/documents/${activeDocumentId}/original/object_2`
  const missingObjectKey = `spaces/${spaceId}/documents/${missingDocumentId}/original/object_3`
  const orphanObjectKey = `spaces/${spaceId}/documents/orphan_document/original/object_4`
  const writtenAt = new Date()
  const jobNow = new Date(writtenAt.getTime() + 8 * 24 * 60 * 60 * 1000)
  const documents = db.collection(`spaces/${spaceId}/documents`)
  await Promise.all([
    documents.doc(staleDocumentId).set(createDocument(
      spaceId,
      staleDocumentId,
      staleObjectKey,
      'uploading',
      admin.firestore.Timestamp.fromDate(writtenAt)
    )),
    documents.doc(activeDocumentId).set(createDocument(
      spaceId,
      activeDocumentId,
      activeObjectKey,
      'ready',
      admin.firestore.Timestamp.fromDate(writtenAt)
    )),
    documents.doc(missingDocumentId).set(createDocument(
      spaceId,
      missingDocumentId,
      missingObjectKey,
      'ready',
      admin.firestore.Timestamp.fromDate(writtenAt)
    )),
    writeLocalObject(staleObjectKey, 'application/pdf', {}, Buffer.from('stale')),
    writeLocalObject(activeObjectKey, 'application/pdf', {}, Buffer.from('active')),
    writeLocalObject(orphanObjectKey, 'application/pdf', {}, Buffer.from('orphan')),
  ])

  await runDocumentConsistency(jobNow)

  const provider = new LocalObjectStorageProvider()
  assert.equal((await documents.doc(staleDocumentId).get()).exists, false)
  assert.equal(await provider.stat(staleObjectKey), null)
  assert.equal(await provider.stat(orphanObjectKey), null)
  assert.equal((await documents.doc(activeDocumentId).get()).data().integrityStatus, 'ok')
  assert.equal(
    (await documents.doc(missingDocumentId).get()).data().integrityStatus,
    'missing_original'
  )
  const usage = (await db.doc(`spaces/${spaceId}/usage/documents`).get()).data()
  assert.equal(usage.originalBytes, Buffer.byteLength('active'))
  assert.equal(usage.derivedBytes, 0)
  assert.equal(usage.documentCount, 1)
})
