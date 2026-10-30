const test = require('node:test')
const assert = require('node:assert/strict')

// 未実装のモジュールでファイル全体が落ちないよう、読み込み失敗は各テスト内の失敗として報告する。
let dto = null
let loadError = null
try {
  dto = require('../lib/news/widgetDto')
} catch (error) {
  loadError = error
}
function mod() {
  if (!dto) throw new Error(`widgetDto が未実装です: ${loadError && loadError.message}`)
  return dto
}

const REASON = 'モデル評価を開発時の比較に取り入れられる'

function doc(overrides = {}) {
  return {
    id: 'a1',
    title: 'Fictional article',
    titleJa: '架空の記事',
    summaryJa: '架空の概要です',
    source: 'rss',
    sourceName: '架空のフィード',
    url: 'https://example.com/a1',
    thumbnailUrl: 'https://example.com/a1.png',
    ...overrides,
  }
}

const now = new Date('2026-03-15T09:00:00.000Z')

test('topicがaiでreadReasonが文字列なら、前後の空白を除いてreadReasonを返す', () => {
  const { toWidgetArticleDto } = mod()
  assert.equal(toWidgetArticleDto(doc({ readReason: REASON }), 'ai').readReason, REASON)
  assert.equal(toWidgetArticleDto(doc({ readReason: `  ${REASON} \n` }), 'ai').readReason, REASON)
})

test('topicがmobileならreadReasonがあってもreadReasonキーを返さない', () => {
  const { toWidgetArticleDto } = mod()
  const result = toWidgetArticleDto(doc({ readReason: REASON }), 'mobile')
  assert.equal('readReason' in result, false)
})

test('topicを渡さないときはreadReasonがあってもreadReasonキーを返さない', () => {
  const { toWidgetArticleDto } = mod()
  const result = toWidgetArticleDto(doc({ readReason: REASON }))
  assert.equal('readReason' in result, false)
})

test('topicがaiでもreadReasonが未指定・null・空文字・空白だけ・文字列でないときはキーを返さない', () => {
  const { toWidgetArticleDto } = mod()
  const invalid = [
    ['未指定', undefined],
    ['null', null],
    ['空文字', ''],
    ['空白だけ', '   '],
    ['改行とタブだけ', ' \n\t '],
    ['数値', 123],
    ['オブジェクト', { text: REASON }],
  ]
  for (const [label, readReason] of invalid) {
    const result = toWidgetArticleDto(doc({ readReason }), 'ai')
    assert.equal('readReason' in result, false, `readReason=${label}`)
    assert.equal(result.id, 'a1', `readReason=${label}`)
    assert.equal(result.title, '架空の記事', `readReason=${label}`)
  }
})

test('readReasonキー自体が無いdocでも、topicがaiでキーを返さない', () => {
  const { toWidgetArticleDto } = mod()
  const source = doc()
  assert.equal('readReason' in source, false)
  assert.equal('readReason' in toWidgetArticleDto(source, 'ai'), false)
})

test('日本語と途中の改行を含むreadReasonは、前後の空白だけ除いてそのまま入る', () => {
  const { toWidgetArticleDto } = mod()
  const multiline = '評価指標を比較に使える。\n導入手順も短い。'
  assert.equal(toWidgetArticleDto(doc({ readReason: `\n  ${multiline}\n\n` }), 'ai').readReason, multiline)
  assert.equal(toWidgetArticleDto(doc({ readReason: multiline }), 'ai').readReason, multiline)
})

test('readReasonを足しても他の項目は変わらない', () => {
  const { toWidgetArticleDto } = mod()
  const { readReason, ...rest } = toWidgetArticleDto(doc({ readReason: REASON }), 'ai')
  assert.equal(readReason, REASON)
  assert.deepEqual(rest, toWidgetArticleDto(doc()))
})

test('readReasonが無い従来のdocでは、結果が従来と同じ形になる', () => {
  const { toWidgetArticleDto } = mod()
  const expected = {
    id: 'a1',
    title: '架空の記事',
    sourceName: '架空のフィード',
    publishedAt: null,
    summary: '架空の概要です',
    url: 'https://example.com/a1',
    imageUrl: 'https://example.com/a1.png',
  }
  assert.deepEqual(toWidgetArticleDto(doc()), expected)
  assert.deepEqual(toWidgetArticleDto(doc(), 'ai'), expected)
  assert.deepEqual(toWidgetArticleDto(doc(), 'mobile'), expected)
})

test('buildWidgetNewsResponseのaiでは、readReasonを持つ記事だけに入る', () => {
  const { buildWidgetNewsResponse } = mod()
  const articles = [
    doc({ id: 'a1', readReason: `  ${REASON}  ` }),
    doc({ id: 'a2', url: 'https://example.com/a2' }),
    doc({ id: 'a3', url: 'https://example.com/a3', readReason: '   ' }),
  ]
  const response = buildWidgetNewsResponse('ai', { feedDate: '2026-03-15', isSharedFallback: false, articles }, now)
  assert.equal(response.articles[0].readReason, REASON)
  assert.equal('readReason' in response.articles[1], false)
  assert.equal('readReason' in response.articles[2], false)
})

test('buildWidgetNewsResponseのmobileでは、docにreadReasonがあっても入らない', () => {
  const { buildWidgetNewsResponse } = mod()
  const articles = [
    doc({ id: 'a1', readReason: REASON }),
    doc({ id: 'a2', url: 'https://example.com/a2', readReason: REASON }),
  ]
  const response = buildWidgetNewsResponse('mobile', { feedDate: '2026-03-15', isSharedFallback: false, articles }, now)
  for (const article of response.articles) {
    assert.equal('readReason' in article, false, `id=${article.id}`)
  }
})

test('readReason追加後もdtoVersionは1、revisionは記事IDだけで決まり、totalCountは記事数', () => {
  const { buildWidgetNewsResponse, computeRevision, WIDGET_DTO_VERSION } = mod()
  assert.equal(WIDGET_DTO_VERSION, 1)
  const withReason = [
    doc({ id: 'a1', readReason: REASON }),
    doc({ id: 'a2', url: 'https://example.com/a2', readReason: REASON }),
  ]
  const withoutReason = [doc({ id: 'a1' }), doc({ id: 'a2', url: 'https://example.com/a2' })]
  const a = buildWidgetNewsResponse('ai', { feedDate: '2026-03-15', isSharedFallback: false, articles: withReason }, now)
  const b = buildWidgetNewsResponse('ai', { feedDate: '2026-03-15', isSharedFallback: false, articles: withoutReason }, now)
  assert.equal(a.dtoVersion, 1)
  assert.equal(a.revision, computeRevision('2026-03-15', ['a1', 'a2']))
  assert.equal(a.revision, b.revision)
  assert.equal(a.totalCount, 2)
  assert.equal(b.totalCount, 2)
  assert.equal(a.articles[0].readReason, REASON)
})
