const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_DOCUMENT_LIMIT_BYTES,
  DEFAULT_DOCUMENT_WARNING_BYTES,
  buildDocumentUsageAfterFinalize,
  buildInitialDocumentRecord,
  isDocumentUsageCountedStatus,
  validateStoredObject,
} = require('../lib/documents/lifecycle')

const now = { seconds: 1, nanoseconds: 0 }

function createInput(overrides = {}) {
  return {
    spaceId: 'family_1',
    name: ' お知らせ.pdf ',
    source: 'file',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    sha256: 'A'.repeat(64),
    ...overrides,
  }
}

test('アップロード開始用の安全な初期レコードを生成する', () => {
  const record = buildInitialDocumentRecord(
    'document_1',
    createInput(),
    'spaces/family_1/documents/document_1/original/object_1',
    'alice',
    now
  )

  assert.equal(record.name, 'お知らせ.pdf')
  assert.equal(record.status, 'uploading')
  assert.equal(record.category, 'other')
  assert.equal(record.uploadedBy, 'alice')
  assert.equal(record.sha256, 'a'.repeat(64))
  assert.equal(record.ocrStatus, 'pending')
  assert.equal(record.ocrObjectKey, null)
  assert.equal(record.ocrSizeBytes, 0)
  assert.equal(record.ocrError, null)
  assert.equal(record.deletionStatus, 'idle')
  assert.equal(record.deletionError, null)
  assert.equal(record.statusBeforeTrash, null)
  assert.equal(record.integrityStatus, 'unchecked')
  assert.equal(record.integrityError, null)
  assert.equal(record.integrityCheckedAt, null)
})

test('保存確定前の書類を容量集計済みとして扱わない', () => {
  assert.equal(isDocumentUsageCountedStatus('uploading'), false)
  assert.equal(isDocumentUsageCountedStatus('failed'), false)
  assert.equal(isDocumentUsageCountedStatus('uploaded'), true)
  assert.equal(isDocumentUsageCountedStatus('processing'), true)
  assert.equal(isDocumentUsageCountedStatus('ready'), true)
})

test('R2のサイズ、MIME、ハッシュが要求と一致することを検証する', () => {
  const document = {
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    sha256: 'a'.repeat(64),
  }
  assert.deepEqual(validateStoredObject(document, {
    objectKey: 'key',
    sizeBytes: 1024,
    contentType: 'application/pdf',
    etag: null,
    lastModifiedAt: null,
    metadata: { sha256: 'a'.repeat(64) },
  }), [])

  assert.deepEqual(validateStoredObject(document, {
    objectKey: 'key',
    sizeBytes: 2048,
    contentType: 'image/png',
    etag: null,
    lastModifiedAt: null,
    metadata: { sha256: 'b'.repeat(64) },
  }), [
    '保存されたファイルサイズがアップロード要求と一致しません',
    '保存されたMIMEタイプがアップロード要求と一致しません',
    '保存されたSHA-256がアップロード要求と一致しません',
  ])
})

test('初回確定時に既定の容量集計を作る', () => {
  assert.deepEqual(buildDocumentUsageAfterFinalize(undefined, 1024), {
    originalBytes: 1024,
    derivedBytes: 0,
    documentCount: 1,
    processingPageCountThisMonth: 0,
    processingPageMonth: null,
    limitBytes: DEFAULT_DOCUMENT_LIMIT_BYTES,
    warningBytes: DEFAULT_DOCUMENT_WARNING_BYTES,
  })
})

test('容量上限を超える確定を拒否する', () => {
  assert.throws(() => buildDocumentUsageAfterFinalize({
    originalBytes: 900,
    derivedBytes: 0,
    documentCount: 1,
    processingPageCountThisMonth: 0,
    processingPageMonth: null,
    limitBytes: 1000,
    warningBytes: 800,
  }, 101), /容量上限/)
})

test('サムネイルを含む合計容量が上限を超える確定を拒否する', () => {
  assert.throws(() => buildDocumentUsageAfterFinalize({
    originalBytes: 700,
    derivedBytes: 200,
    documentCount: 1,
    processingPageCountThisMonth: 0,
    processingPageMonth: null,
    limitBytes: 1000,
    warningBytes: 800,
  }, 101), /容量上限/)
})
