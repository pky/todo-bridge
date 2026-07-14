const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildOcrReservationId,
  buildOcrUsageReservation,
  getOcrUsageMonth,
} = require('../lib/documents/ocrUsagePlan')

test('日本時間の月境界でOCR利用月を計算する', () => {
  assert.equal(getOcrUsageMonth(new Date('2026-07-31T14:59:59Z')), '2026-07')
  assert.equal(getOcrUsageMonth(new Date('2026-07-31T15:00:00Z')), '2026-08')
})

test('同じ月のOCRページ数を加算する', () => {
  assert.deepEqual(buildOcrUsageReservation({
    processingPageCountThisMonth: 790,
    processingPageMonth: '2026-07',
  }, 10, '2026-07'), {
    processingPageCountThisMonth: 800,
    processingPageMonth: '2026-07',
    warningReached: true,
  })
})

test('月が変わったらOCRページ数を0から数える', () => {
  assert.deepEqual(buildOcrUsageReservation({
    processingPageCountThisMonth: 999,
    processingPageMonth: '2026-06',
  }, 2, '2026-07'), {
    processingPageCountThisMonth: 2,
    processingPageMonth: '2026-07',
    warningReached: false,
  })
})

test('月1,000ページを超える予約を拒否する', () => {
  assert.throws(() => buildOcrUsageReservation({
    processingPageCountThisMonth: 999,
    processingPageMonth: '2026-07',
  }, 2, '2026-07'), /1,000ページ上限/)
})

test('月・書類・解析versionから同じ予約IDを生成する', () => {
  assert.equal(
    buildOcrReservationId('2026-07', 'document_1', 2),
    '202607_document_1_v2'
  )
})
