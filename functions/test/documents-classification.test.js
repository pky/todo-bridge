const test = require('node:test')
const assert = require('node:assert/strict')
const {
  classifyDocumentByRules,
} = require('../lib/documents/classification/ruleBasedClassifier')
const {
  extractDocumentSuggestions,
} = require('../lib/documents/extraction/ruleBasedExtractor')

function page(text, pageNumber = 1) {
  return { pageNumber, text, confidence: null, source: 'pdf_text' }
}

test('学校、医療、請求書をルールで分類する', () => {
  assert.equal(classifyDocumentByRules('学校のお知らせ.pdf', [page('保護者のみなさまへ')]).category, 'school_childcare')
  assert.equal(classifyDocumentByRules('お知らせ.jpeg', [page('園行事のご案内')]).category, 'school_childcare')
  assert.equal(classifyDocumentByRules('健康診断.pdf', [page('病院 診療内容')]).category, 'medical')
  assert.equal(classifyDocumentByRules('請求書.pdf', [page('合計金額 1,000円')]).category, 'billing_receipt')
})

test('園行事の日付と次行の時刻を予定候補にまとめる', () => {
  const suggestions = extractDocumentSuggestions([page([
    '〈茶話会〉',
    '日にち：5月15日（金）',
    '時間：13時45分〜14時45分',
    '場所：中央公民館',
  ].join('\n'))])
  const event = suggestions.find((item) => item.type === 'calendar_event')

  assert.equal(event.value.dateText, '5月15日')
  assert.equal(event.value.yearAmbiguous, true)
  assert.equal(event.value.time, '13:45')
  assert.match(event.sourceExcerpt, /時間：13時45分/)
})

test('期限、予定、持ち物、金額、連絡先を根拠ページつきで抽出する', () => {
  const suggestions = extractDocumentSuggestions([page([
    '提出期限：2026年7月20日までに提出してください',
    '持ち物：水筒、帽子',
    '参加費：1,500円',
    '連絡先：03-1234-5678 test@example.com',
  ].join('\n'), 2)])

  assert.ok(suggestions.some((item) => item.type === 'task'
    && item.value.date === '2026-07-20'
    && item.pageNumber === 2))
  assert.ok(suggestions.some((item) => item.type === 'field'
    && item.value.fieldType === 'items'))
  assert.ok(suggestions.some((item) => item.type === 'amount'
    && item.value.amount === 1500))
  assert.ok(suggestions.some((item) => item.type === 'contact'
    && item.value.kind === 'phone'))
  assert.ok(suggestions.some((item) => item.type === 'contact'
    && item.value.kind === 'email'))
  assert.ok(suggestions.every((item) => item.sourceExcerpt.length > 0))
})

test('年と役割が不明な日付を曖昧なfield候補にする', () => {
  const suggestions = extractDocumentSuggestions([page('次回は7月20日です')])
  const date = suggestions.find((item) => item.value.fieldType === 'date')

  assert.equal(date.type, 'field')
  assert.equal(date.value.date, null)
  assert.equal(date.value.yearAmbiguous, true)
  assert.equal(date.value.roleAmbiguous, true)
  assert.ok(date.confidence < 0.6)
})

test('存在しない日付と空の解析結果を採用しない', () => {
  assert.deepEqual(extractDocumentSuggestions([page('2026年2月30日')]), [])
  assert.deepEqual(extractDocumentSuggestions([page('')]), [])
})
