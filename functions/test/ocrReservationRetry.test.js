// 期待する純粋API: documents/ocrUsagePlan の buildOcrReservationId(month: string, documentId: string, analysisVersion: number, retryCount?: number): string。
// retryCount省略時の既存形式を保持し、明示された再試行回数を予約の識別に含める。
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildOcrReservationId } = require('../lib/documents/ocrUsagePlan')

test('同じ書類・月・解析versionでも再試行回数ごとにOCR予約キーが変わる', () => {
  const keys = [0, 1, 2].map(retryCount =>
    buildOcrReservationId('2026-07', 'document_1', 2, retryCount)
  )
  assert.equal(new Set(keys).size, 3)
})

test('同じ再試行回数のOCR予約キーは決定的に再利用できる', () => {
  assert.equal(
    buildOcrReservationId('2026-07', 'document_1', 2, 1),
    buildOcrReservationId('2026-07', 'document_1', 2, 1)
  )
})

test('再試行回数を省略した従来呼び出しのOCR予約キーは互換性を維持する', () => {
  assert.equal(buildOcrReservationId('2026-07', 'document_1', 2), '202607_document_1_v2')
})
