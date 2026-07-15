const test = require('node:test')
const assert = require('node:assert/strict')

const { buildDocumentArchiveParts } = require('../lib/documents/archivePlan')

function source(id, name, sizeBytes) {
  return {
    documentId: id,
    name,
    mimeType: 'application/pdf',
    sizeBytes,
    category: 'other',
    documentDate: null,
  }
}

test('同名書類へ連番を付け、パス区切りを安全な名前へ変換する', () => {
  const [part] = buildDocumentArchiveParts([
    source('1', '学校/案内.pdf', 10),
    source('2', '学校/案内.pdf', 10),
  ], 100)

  assert.deepEqual(part.entries.map((entry) => entry.archiveName), [
    '学校_案内.pdf',
    '学校_案内 (2).pdf',
  ])
})

test('指定容量を超える書類を複数ZIPへ分割する', () => {
  const parts = buildDocumentArchiveParts([
    source('1', 'a.pdf', 60),
    source('2', 'b.pdf', 60),
    source('3', 'c.pdf', 40),
  ], 100)

  assert.deepEqual(parts.map((part) => ({
    number: part.partNumber,
    count: part.entries.length,
    bytes: part.totalBytes,
  })), [
    { number: 1, count: 1, bytes: 60 },
    { number: 2, count: 2, bytes: 100 },
  ])
})
