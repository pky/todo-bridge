const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MAX_TEXT_DOCUMENT_FILE_SIZE_BYTES,
  TEXT_DOCUMENT_MIME_TYPES,
  isTextDocumentMimeType,
  supportsDocumentText,
} = require('../lib/documents/textFormats')

test('txt、md、csvのMIMEをテキスト書類として判定する', () => {
  assert.deepEqual([...TEXT_DOCUMENT_MIME_TYPES].sort(), ['text/csv', 'text/markdown', 'text/plain'])
  assert.equal(isTextDocumentMimeType('text/plain'), true)
  assert.equal(isTextDocumentMimeType('text/markdown'), true)
  assert.equal(isTextDocumentMimeType('text/csv'), true)
  assert.equal(isTextDocumentMimeType('text/html'), false)
  assert.equal(isTextDocumentMimeType('application/pdf'), false)
  assert.equal(isTextDocumentMimeType('image/png'), false)
})

test('文字読み取り対象はPDF、画像、テキスト書類に限る', () => {
  assert.equal(supportsDocumentText('application/pdf'), true)
  assert.equal(supportsDocumentText('image/jpeg'), true)
  assert.equal(supportsDocumentText('text/plain'), true)
  assert.equal(supportsDocumentText('text/csv'), true)
  assert.equal(supportsDocumentText('application/zip'), false)
  assert.equal(supportsDocumentText('text/html'), false)
})

test('テキスト書類の上限サイズは1 MBとする', () => {
  assert.equal(MAX_TEXT_DOCUMENT_FILE_SIZE_BYTES, 1024 * 1024)
})
