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
    '時間：13時45分~14時45分',
    '場所：中央公民館',
  ].join('\n'))], new Date('2026-07-14T00:00:00+09:00'))
  const event = suggestions.find((item) => item.type === 'calendar_event')

  assert.equal(event.value.dateText, '5月15日')
  assert.equal(event.value.date, '2026-05-15')
  assert.equal(event.value.yearAmbiguous, true)
  assert.equal(event.value.inferredYear, 2026)
  assert.equal(event.value.time, '13:45')
  assert.equal(event.value.endTime, '14:45')
  assert.equal(event.value.location, '中央公民館')
  assert.equal(event.title, '茶話会')
  assert.match(event.sourceExcerpt, /時間：13時45分/)
})

test('記載曜日が基準年と違う場合は近い一致年を日付候補にする', () => {
  const suggestions = extractDocumentSuggestions([
    page('開催日：5月15日（木）\n時間：10時00分'),
  ], new Date('2026-07-14T00:00:00+09:00'))
  const event = suggestions.find((item) => item.type === 'calendar_event')

  assert.equal(event.value.date, '2025-05-15')
  assert.equal(event.value.inferredYear, 2025)
  assert.equal(event.value.yearAmbiguous, true)
})

test('期限だけを操作可能な候補として抽出し、単独の情報候補を作らない', () => {
  const suggestions = extractDocumentSuggestions([page([
    '提出期限：2026年7月20日までに提出してください',
    '持ち物：水筒、帽子',
    '参加費：1,500円',
    '連絡先：03-1234-5678 test@example.com',
  ].join('\n'), 2)])

  assert.ok(suggestions.some((item) => item.type === 'task'
    && item.value.date === '2026-07-20'
    && item.pageNumber === 2))
  assert.equal(suggestions.length, 1)
  assert.ok(suggestions.every((item) => item.sourceExcerpt.length > 0))
})

test('用途を判断できない日付は操作候補にしない', () => {
  const suggestions = extractDocumentSuggestions([page('次回は7月20日です')])
  assert.deepEqual(suggestions, [])
})

test('案内文のスラッシュ日付と曜日付き日付を予定候補にする', () => {
  const suggestions = extractDocumentSuggestions([page([
    '地域イベントのお知らせ',
    'みんなで練習して',
    '9/4(金)&9/5(土)の',
    '地域イベントにいこう！',
    '9月2日水',
    '中央公民館ホール',
    '踊りを練習しよう！',
    '10:00〜11:00',
    'ほかの曲も練習します',
  ].join('\n'))], new Date('2026-07-16T00:00:00+09:00'))
  const events = suggestions.filter((item) => item.type === 'calendar_event')

  assert.deepEqual(events.map((item) => item.value.date), [
    '2026-09-04',
    '2026-09-05',
    '2026-09-02',
  ])
  assert.ok(events.every((item) => item.value.yearAmbiguous === true))
  assert.equal(events[0].value.time, null)
  assert.equal(events[1].value.time, null)
  assert.equal(events[2].value.time, '10:00')
  assert.equal(events[2].value.endTime, '11:00')
  assert.equal(events[2].value.location, '中央公民館ホール')
  assert.match(events[2].sourceExcerpt, /10:00〜11:00/)
})

test('存在しない日付と空の解析結果を採用しない', () => {
  assert.deepEqual(extractDocumentSuggestions([page('2026年2月30日')]), [])
  assert.deepEqual(extractDocumentSuggestions([page('')]), [])
})
