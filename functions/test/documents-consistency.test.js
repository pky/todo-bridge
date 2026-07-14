const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ORPHAN_OBJECT_RETENTION_MS,
  STALE_UPLOAD_RETENTION_MS,
  buildDocumentCleanupPlan,
  buildDocumentIntegrityUpdates,
  buildReconciledDocumentUsage,
  parseDocumentObjectKey,
  shouldApplyReconciledUsage,
} = require('../lib/documents/consistencyPlan')

const nowMs = Date.UTC(2026, 6, 14, 0, 0, 0)

function createDocument(overrides = {}) {
  return {
    spaceId: 'family_1',
    documentId: 'document_1',
    status: 'ready',
    updatedAtMs: nowMs,
    originalObjectKey: 'spaces/family_1/documents/document_1/original/object_1',
    thumbnailObjectKey: 'spaces/family_1/documents/document_1/thumbnail/v1.webp',
    ocrObjectKey: 'spaces/family_1/documents/document_1/analysis/v1/ocr.json.gz',
    integrityStatus: 'unchecked',
    ...overrides,
  }
}

function createObject(objectKey, overrides = {}) {
  return {
    objectKey,
    sizeBytes: 100,
    lastModifiedAt: new Date(nowMs),
    ...overrides,
  }
}

test('書類オブジェクトキーからspaceと用途を判定する', () => {
  assert.deepEqual(
    parseDocumentObjectKey('spaces/family_1/documents/document_1/original/object_1'),
    { spaceId: 'family_1', documentId: 'document_1', kind: 'original' }
  )
  assert.deepEqual(
    parseDocumentObjectKey('spaces/family_1/documents/document_1/thumbnail/v1.webp'),
    { spaceId: 'family_1', documentId: 'document_1', kind: 'derived' }
  )
  assert.deepEqual(
    parseDocumentObjectKey('spaces/family_1/documents/document_1/analysis/v1/ocr.json.gz'),
    { spaceId: 'family_1', documentId: 'document_1', kind: 'derived' }
  )
  assert.equal(parseDocumentObjectKey('unrelated/object'), null)
})

test('24時間を過ぎた中断アップロードとそのオブジェクトを削除候補にする', () => {
  const document = createDocument({
    status: 'uploading',
    updatedAtMs: nowMs - STALE_UPLOAD_RETENTION_MS,
  })
  const plan = buildDocumentCleanupPlan(
    [document],
    [createObject(document.originalObjectKey)],
    nowMs
  )

  assert.deepEqual(plan.staleDocuments, [{
    spaceId: 'family_1',
    documentId: 'document_1',
    objectKeys: [document.originalObjectKey],
  }])
  assert.deepEqual(plan.orphanObjectKeys, [])
})

test('保持期間前または参照中のオブジェクトを孤立削除しない', () => {
  const document = createDocument()
  const recentOrphanKey = 'spaces/family_1/documents/orphan_1/original/object_1'
  const plan = buildDocumentCleanupPlan([document], [
    createObject(document.originalObjectKey, {
      lastModifiedAt: new Date(nowMs - ORPHAN_OBJECT_RETENTION_MS - 1),
    }),
    createObject(recentOrphanKey, {
      lastModifiedAt: new Date(nowMs - ORPHAN_OBJECT_RETENTION_MS + 1),
    }),
  ], nowMs)

  assert.deepEqual(plan.orphanObjectKeys, [])
})

test('保持期間を過ぎた孤立オブジェクトだけを削除候補にする', () => {
  const orphanKey = 'spaces/family_1/documents/orphan_1/original/object_1'
  const plan = buildDocumentCleanupPlan([], [
    createObject(orphanKey, {
      lastModifiedAt: new Date(nowMs - ORPHAN_OBJECT_RETENTION_MS),
    }),
  ], nowMs)

  assert.deepEqual(plan.orphanObjectKeys, [orphanKey])
})

test('原本欠損と復旧を整合性更新として検出する', () => {
  const missing = createDocument({ integrityStatus: 'ok' })
  const recovered = createDocument({
    documentId: 'document_2',
    originalObjectKey: 'spaces/family_1/documents/document_2/original/object_2',
    thumbnailObjectKey: null,
    ocrObjectKey: null,
    integrityStatus: 'missing_original',
  })
  const updates = buildDocumentIntegrityUpdates(
    [missing, recovered],
    [createObject(recovered.originalObjectKey)]
  )

  assert.deepEqual(updates, [
    { spaceId: 'family_1', documentId: 'document_1', status: 'missing_original' },
    { spaceId: 'family_1', documentId: 'document_2', status: 'ok' },
  ])
})

test('R2実オブジェクトから原本と生成物の容量を再集計する', () => {
  const document = createDocument()
  const usage = buildReconciledDocumentUsage([document], [
    createObject(document.originalObjectKey, { sizeBytes: 1000 }),
    createObject(document.thumbnailObjectKey, { sizeBytes: 100 }),
    createObject(document.ocrObjectKey, { sizeBytes: 50 }),
    createObject('spaces/family_1/documents/orphan_1/original/object_2', { sizeBytes: 500 }),
  ])

  assert.deepEqual(usage, {
    family_1: {
      originalBytes: 1500,
      derivedBytes: 150,
      documentCount: 1,
    },
  })
})

test('整合性チェック開始後に更新された容量集計を上書きしない', () => {
  assert.equal(shouldApplyReconciledUsage(nowMs, undefined), true)
  assert.equal(shouldApplyReconciledUsage(nowMs, nowMs - 1), true)
  assert.equal(shouldApplyReconciledUsage(nowMs, nowMs), false)
  assert.equal(shouldApplyReconciledUsage(nowMs, nowMs + 1), false)
})
