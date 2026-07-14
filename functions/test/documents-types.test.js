const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MAX_DOCUMENT_FILE_SIZE_BYTES,
  assertFamilyDocumentStatusTransition,
  canTransitionFamilyDocumentStatus,
  validateCreateDocumentUploadInput,
} = require('../lib/documents/validation')

function createValidUploadInput(overrides = {}) {
  return {
    spaceId: 'family-1',
    name: 'お知らせ.pdf',
    source: 'file',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    ...overrides,
  }
}

test('書類状態の正常な遷移と同じ状態への冪等な更新を許可する', () => {
  assert.equal(canTransitionFamilyDocumentStatus('uploading', 'uploaded'), true)
  assert.equal(canTransitionFamilyDocumentStatus('uploaded', 'processing'), true)
  assert.equal(canTransitionFamilyDocumentStatus('processing', 'ready'), true)
  assert.equal(canTransitionFamilyDocumentStatus('ready', 'ready'), true)
  assert.equal(canTransitionFamilyDocumentStatus('ready', 'processing'), true)
  assert.equal(canTransitionFamilyDocumentStatus('ready', 'trashed'), true)
  assert.equal(canTransitionFamilyDocumentStatus('trashed', 'ready'), true)
})

test('処理を飛ばす不正な状態遷移を拒否する', () => {
  assert.equal(canTransitionFamilyDocumentStatus('uploading', 'ready'), false)
  assert.equal(canTransitionFamilyDocumentStatus('trashed', 'processing'), false)
  assert.throws(
    () => assertFamilyDocumentStatusTransition('uploading', 'ready'),
    /uploading から ready/
  )
})

test('有効なアップロード入力を受け付ける', () => {
  const result = validateCreateDocumentUploadInput(createValidUploadInput({
    sizeBytes: MAX_DOCUMENT_FILE_SIZE_BYTES,
  }))

  assert.deepEqual(result, { valid: true, errors: [] })
})

test('空の識別子、過大ファイル、不正なMIMEとハッシュを拒否する', () => {
  const result = validateCreateDocumentUploadInput(createValidUploadInput({
    spaceId: ' ',
    name: ' ',
    source: 'unknown',
    mimeType: 'invalid',
    sizeBytes: MAX_DOCUMENT_FILE_SIZE_BYTES + 1,
    sha256: 'not-a-hash',
  }))

  assert.equal(result.valid, false)
  assert.deepEqual(result.errors, [
    'spaceIdは必須です',
    'ファイル名は必須です',
    '追加元が不正です',
    'MIMEタイプが不正です',
    'ファイルサイズが20 MBの上限を超えています',
    'SHA-256が不正です',
  ])
})

test('0以下または整数ではないファイルサイズを拒否する', () => {
  assert.deepEqual(
    validateCreateDocumentUploadInput(createValidUploadInput({ sizeBytes: 0 })).errors,
    ['ファイルサイズは正の整数で指定してください']
  )
  assert.deepEqual(
    validateCreateDocumentUploadInput(createValidUploadInput({ sizeBytes: 1.5 })).errors,
    ['ファイルサイズは正の整数で指定してください']
  )
})

test('型が保証されていない外部入力でも例外を発生させない', () => {
  assert.deepEqual(validateCreateDocumentUploadInput(null), {
    valid: false,
    errors: ['アップロード入力が不正です'],
  })

  const result = validateCreateDocumentUploadInput({
    spaceId: null,
    name: 123,
    source: null,
    mimeType: [],
    sizeBytes: '1024',
    sha256: 123,
  })

  assert.equal(result.valid, false)
  assert.deepEqual(result.errors, [
    'spaceIdは必須です',
    'ファイル名は必須です',
    '追加元が不正です',
    'MIMEタイプが不正です',
    'ファイルサイズは正の整数で指定してください',
    'SHA-256が不正です',
  ])
})
