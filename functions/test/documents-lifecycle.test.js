const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_DOCUMENT_LIMIT_BYTES,
  DEFAULT_DOCUMENT_WARNING_BYTES,
  buildDocumentUsageAfterFinalize,
  buildInitialDocumentRecord,
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
    limitBytes: 1000,
    warningBytes: 800,
  }, 101), /容量上限/)
})
