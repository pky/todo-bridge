const test = require('node:test')
const assert = require('node:assert/strict')

const { buildDocumentDeletionObjectKeys } = require('../lib/documents/deletionPlan')
const { buildDocumentUsageAfterPermanentDelete } = require('../lib/documents/usage')

test('完全削除対象に原本とversion固定サムネイルを含める', () => {
  const keys = buildDocumentDeletionObjectKeys('family_1', 'document_1', {
    originalObjectKey: 'spaces/family_1/documents/document_1/original/object_1',
    thumbnailObjectKey: null,
    previewVersion: 1,
    mimeType: 'application/pdf',
    ocrObjectKey: null,
    analysisVersion: 1,
  })

  assert.deepEqual(keys, [
    'spaces/family_1/documents/document_1/original/object_1',
    'spaces/family_1/documents/document_1/thumbnail/v1.webp',
    'spaces/family_1/documents/document_1/analysis/v1/ocr.json.gz',
  ])
})

test('別書類のオブジェクトキーを完全削除対象にしない', () => {
  assert.throws(() => buildDocumentDeletionObjectKeys('family_1', 'document_1', {
    originalObjectKey: 'spaces/family_1/documents/document_2/original/object_1',
    thumbnailObjectKey: null,
    previewVersion: 1,
    mimeType: 'application/pdf',
    ocrObjectKey: null,
    analysisVersion: 1,
  }), /原本のオブジェクトキー/)
})

test('完全削除後の容量と件数を減算する', () => {
  const usage = buildDocumentUsageAfterPermanentDelete({
    originalBytes: 3000,
    derivedBytes: 300,
    documentCount: 2,
    processingPageCountThisMonth: 10,
    limitBytes: 5000,
    warningBytes: 4000,
  }, {
    originalSizeBytes: 1000,
    derivedSizeBytes: 100,
  })

  assert.deepEqual(usage, {
    originalBytes: 2000,
    derivedBytes: 200,
    documentCount: 1,
    processingPageCountThisMonth: 10,
    limitBytes: 5000,
    warningBytes: 4000,
  })
})

test('不整合な容量集計でも負数にしない', () => {
  const usage = buildDocumentUsageAfterPermanentDelete({
    originalBytes: 10,
    derivedBytes: 5,
    documentCount: 0,
  }, {
    originalSizeBytes: 100,
    derivedSizeBytes: 50,
  })

  assert.equal(usage.originalBytes, 0)
  assert.equal(usage.derivedBytes, 0)
  assert.equal(usage.documentCount, 0)
})
