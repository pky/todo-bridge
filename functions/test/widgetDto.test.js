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

test('titleJaがあれば表示タイトルに使う', () => {
  const { toWidgetArticleDto } = mod()
  const result = toWidgetArticleDto(doc({ title: 'Original', titleJa: '日本語タイトル' }))
  assert.equal(result.title, '日本語タイトル')
  assert.equal(result.id, 'a1')
  assert.equal(result.sourceName, '架空のフィード')
})

test('titleJaが空ならtitleを使う', () => {
  const { toWidgetArticleDto } = mod()
  assert.equal(toWidgetArticleDto(doc({ title: 'Original', titleJa: '' })).title, 'Original')
  assert.equal(toWidgetArticleDto(doc({ title: 'Original', titleJa: undefined })).title, 'Original')
})

test('imageUrlはhttpsだけ', () => {
  const { toWidgetArticleDto } = mod()
  assert.equal(toWidgetArticleDto(doc({ thumbnailUrl: 'https://example.com/ok.png' })).imageUrl, 'https://example.com/ok.png')
  for (const thumbnailUrl of ['http://example.com/a.png', 'javascript:alert(1)', 'not a url', null]) {
    const result = toWidgetArticleDto(doc({ thumbnailUrl }))
    assert.equal('imageUrl' in result, false, `thumbnailUrl=${String(thumbnailUrl)}`)
  }
})

test('GitHub記事は画像を返さない', () => {
  const { toWidgetArticleDto } = mod()
  const bySource = toWidgetArticleDto(doc({ source: 'github', thumbnailUrl: 'https://example.com/a.png' }))
  assert.equal('imageUrl' in bySource, false)
  const byHost = toWidgetArticleDto(doc({ thumbnailUrl: 'https://opengraph.githubassets.com/abc123/sample-owner/sample-repo' }))
  assert.equal('imageUrl' in byHost, false)
})

test('summaryは前後の空白を除き、空なら省く', () => {
  const { toWidgetArticleDto } = mod()
  assert.equal(toWidgetArticleDto(doc({ summaryJa: '  架空の概要です \n' })).summary, '架空の概要です')
  for (const summaryJa of ['', '   ', undefined]) {
    const result = toWidgetArticleDto(doc({ summaryJa }))
    assert.equal('summary' in result, false, `summaryJa=${String(summaryJa)}`)
  }
})

test('publishedAtはtoDate()を持つ値ならISO文字列、無ければnull', () => {
  const { toWidgetArticleDto } = mod()
  const date = new Date('2026-03-14T01:02:03.000Z')
  assert.equal(toWidgetArticleDto(doc({ publishedAt: { toDate: () => date } })).publishedAt, '2026-03-14T01:02:03.000Z')
  assert.equal(toWidgetArticleDto(doc({ publishedAt: undefined })).publishedAt, null)
  assert.equal(toWidgetArticleDto(doc({ publishedAt: null })).publishedAt, null)
  assert.equal(toWidgetArticleDto(doc({ publishedAt: 'not a timestamp' })).publishedAt, null)
})

test('revisionは同じ入力で同じ値、記事の並びが違えば別の値、フィード日付が違えば別の値、64桁の16進文字列', () => {
  const { computeRevision } = mod()
  const base = computeRevision('2026-03-15', ['a', 'b', 'c'])
  assert.match(base, /^[0-9a-f]{64}$/)
  assert.equal(computeRevision('2026-03-15', ['a', 'b', 'c']), base)
  assert.notEqual(computeRevision('2026-03-15', ['c', 'b', 'a']), base)
  assert.notEqual(computeRevision('2026-03-14', ['a', 'b', 'c']), base)
})

test('revisionはfeedDateがnullでも空配列でも計算できる', () => {
  const { computeRevision } = mod()
  const empty = computeRevision(null, [])
  assert.match(empty, /^[0-9a-f]{64}$/)
  assert.equal(computeRevision(null, []), empty)
  assert.notEqual(computeRevision('2026-03-15', []), empty)
})

test('buildWidgetNewsResponseはtotalCountが記事数、dtoVersionが1、generatedAtがnowのISO文字列', () => {
  const { buildWidgetNewsResponse, computeRevision } = mod()
  const now = new Date('2026-03-15T09:00:00.000Z')
  const result = {
    feedDate: '2026-03-15',
    isSharedFallback: true,
    articles: [doc({ id: 'a1' }), doc({ id: 'a2', url: 'https://example.com/a2' })],
  }
  const response = buildWidgetNewsResponse('ai', result, now)
  assert.equal(response.dtoVersion, 1)
  assert.equal(response.topic, 'ai')
  assert.equal(response.generatedAt, '2026-03-15T09:00:00.000Z')
  assert.equal(response.feedDate, '2026-03-15')
  assert.equal(response.isSharedFallback, true)
  assert.equal(response.totalCount, 2)
  assert.deepEqual(response.articles.map(article => article.id), ['a1', 'a2'])
  assert.equal(response.revision, computeRevision('2026-03-15', ['a1', 'a2']))
})

test('buildWidgetNewsResponseは記事0件でもfeedDateがnullでも成立する', () => {
  const { buildWidgetNewsResponse, computeRevision } = mod()
  const now = new Date('2026-03-15T09:00:00.000Z')
  const response = buildWidgetNewsResponse('mobile', { feedDate: null, isSharedFallback: false, articles: [] }, now)
  assert.equal(response.dtoVersion, 1)
  assert.equal(response.topic, 'mobile')
  assert.equal(response.feedDate, null)
  assert.equal(response.isSharedFallback, false)
  assert.equal(response.totalCount, 0)
  assert.deepEqual(response.articles, [])
  assert.equal(response.revision, computeRevision(null, []))
  assert.match(response.revision, /^[0-9a-f]{64}$/)
})

test('urlはhttpsの有効なURL文字列ならそのまま入る', () => {
  const { toWidgetArticleDto } = mod()
  const result = toWidgetArticleDto(doc({ url: 'https://example.com/articles/a1?ref=widget#top' }))
  assert.equal(result.url, 'https://example.com/articles/a1?ref=widget#top')
})

test('urlが無い、文字列でない、解釈できない、https以外のときはurlキーを返さず他の項目は従来どおり', () => {
  const { toWidgetArticleDto } = mod()
  const date = new Date('2026-03-14T01:02:03.000Z')
  const invalidUrls = [
    ['未指定', undefined],
    ['null', null],
    ['空文字', ''],
    ['数値', 123],
    ['相対パス', '/path'],
    ['http', 'http://example.com/a'],
    ['javascript', 'javascript:alert(1)'],
    ['不正な文字列', 'not a url'],
  ]
  for (const [label, url] of invalidUrls) {
    const result = toWidgetArticleDto(doc({ url, publishedAt: { toDate: () => date } }))
    assert.equal('url' in result, false, `url=${label}`)
    assert.equal(result.id, 'a1', `url=${label}`)
    assert.equal(result.title, '架空の記事', `url=${label}`)
    assert.equal(result.sourceName, '架空のフィード', `url=${label}`)
    assert.equal(result.publishedAt, '2026-03-14T01:02:03.000Z', `url=${label}`)
  }
})

test('GitHub記事でも有効なhttps URLならurlを返す（画像とは違い除外しない）', () => {
  const { toWidgetArticleDto } = mod()
  const result = toWidgetArticleDto(doc({ source: 'github', url: 'https://example.com/sample-owner/sample-repo' }))
  assert.equal(result.url, 'https://example.com/sample-owner/sample-repo')
  assert.equal('imageUrl' in result, false)
})

test('url追加後もdtoVersionは1、revisionは記事IDだけで決まり、既存フィールドは変わらない', () => {
  const { buildWidgetNewsResponse, computeRevision, toWidgetArticleDto, WIDGET_DTO_VERSION } = mod()
  assert.equal(WIDGET_DTO_VERSION, 1)
  const now = new Date('2026-03-15T09:00:00.000Z')
  const withUrl = [doc({ id: 'a1', url: 'https://example.com/a1' }), doc({ id: 'a2', url: 'https://example.com/a2' })]
  const withoutUrl = [doc({ id: 'a1', url: undefined }), doc({ id: 'a2', url: 'http://example.com/a2' })]
  const a = buildWidgetNewsResponse('ai', { feedDate: '2026-03-15', isSharedFallback: false, articles: withUrl }, now)
  const b = buildWidgetNewsResponse('ai', { feedDate: '2026-03-15', isSharedFallback: false, articles: withoutUrl }, now)
  assert.equal(a.dtoVersion, 1)
  assert.equal(a.revision, computeRevision('2026-03-15', ['a1', 'a2']))
  assert.equal(a.revision, b.revision)
  assert.equal(a.totalCount, 2)
  const { url, ...rest } = toWidgetArticleDto(doc())
  assert.equal(url, 'https://example.com/a1')
  assert.deepEqual(rest, {
    id: 'a1',
    title: '架空の記事',
    sourceName: '架空のフィード',
    publishedAt: null,
    summary: '架空の概要です',
    imageUrl: 'https://example.com/a1.png',
  })
})

test('urlに前後の空白・制御文字、途中の改行、不正な形式が含まれるときはurlキーを返さず他の項目は従来どおり', () => {
  const { toWidgetArticleDto } = mod()
  const malformedUrls = [
    ['先頭の空白', ' https://example.com/a'],
    ['末尾の空白', 'https://example.com/a '],
    ['先頭のTAB', '\thttps://example.com/a'],
    ['末尾の改行', 'https://example.com/a\n'],
    ['先頭のNUL', '\u0000https://example.com/a'],
    ['先頭のU+0001', '\u0001https://example.com/a'],
    ['スキーム途中の改行', 'ht\ntps://example.com/a'],
    ['ホスト途中の改行', 'https://exa\nmple.com/a'],
    ['スラッシュの欠落', 'https:example.com/a'],
    ['バックスラッシュ形式', 'https:\\\\example.com/a'],
    ['URL中の空白', 'https://example.com/a b'],
  ]
  for (const [label, url] of malformedUrls) {
    const result = toWidgetArticleDto(doc({ url }))
    assert.equal('url' in result, false, `url=${label}`)
    assert.equal(result.id, 'a1', `url=${label}`)
    assert.equal(result.title, '架空の記事', `url=${label}`)
    assert.equal(result.sourceName, '架空のフィード', `url=${label}`)
  }
})

test('大文字スキームのHTTPS URLは制御文字や空白が無ければそのままurlに入る', () => {
  const { toWidgetArticleDto } = mod()
  assert.equal(toWidgetArticleDto(doc({ url: 'HTTPS://example.com/a' })).url, 'HTTPS://example.com/a')
})

test('非ASCII文字を含むhttps URLは過剰に除外せずそのままurlに入る', () => {
  const { toWidgetArticleDto } = mod()
  const url = 'https://example.com/記事?q=日本語'
  assert.equal(toWidgetArticleDto(doc({ url })).url, url)
})
