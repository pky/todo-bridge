const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// 未実装のモジュールでファイル全体が落ちないよう、読み込み失敗は各テスト内で報告する。
let contractModule = null
let loadError = null
try {
  contractModule = require('../lib/news/v2/feedContract')
} catch (error) {
  loadError = error
}
function mod() {
  if (!contractModule) throw new Error(`feedContract が未実装です: ${loadError && loadError.message}`)
  return contractModule
}

const contract = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'aiFeedV2Contract.json'), 'utf8'))
const emptyFeed = contract.validFeeds[0].feed
const threeFeed = contract.validFeeds[1].feed

function article(overrides = {}) {
  return {
    id: 'fictional-article',
    title: 'Fictional article',
    titleJa: '架空の日本語記事',
    summaryJa: '  架空の概要です。 \n',
    source: 'rss',
    sourceName: '架空技術通信',
    url: 'https://example.com/articles/fictional',
    thumbnailUrl: 'https://images.example.com/fictional.png',
    ...overrides,
  }
}

function twentyArticles() {
  return Array.from({ length: 20 }, (_, i) => ({ ...threeFeed.articles[1], id: `fictional-${i}` }))
}

test('公開定数はschemaVersion 2、20記事、非圧縮1MiB', () => {
  const { AI_FEED_V2_SCHEMA_VERSION, AI_FEED_V2_MAX_ARTICLES, AI_FEED_V2_MAX_BYTES } = mod()
  assert.equal(AI_FEED_V2_SCHEMA_VERSION, 2)
  assert.equal(AI_FEED_V2_MAX_ARTICLES, 20)
  assert.equal(AI_FEED_V2_MAX_BYTES, 1048576)
})

for (const vector of contract.canonicalizationVectors) {
  test(`JCS契約: ${vector.name}`, () => {
    const { canonicalizeJson } = mod()
    assert.equal(canonicalizeJson(vector.value), vector.expected)
  })
}

for (const [name, value] of [
  ['非整数', 1.5],
  ['NaN', NaN],
  ['正の無限大', Infinity],
  ['負の無限大', -Infinity],
  ['undefined', undefined],
  ['配列内のundefined', [undefined]],
  ['オブジェクト内のundefined', { missing: undefined }],
  ['入れ子の非整数', { values: [1, 2.5] }],
]) {
  test(`JCSは対象外の値を拒否する: ${name}`, () => {
    const { canonicalizeJson } = mod()
    assert.throws(() => canonicalizeJson(value))
  })
}

for (const scenario of contract.validFeeds) {
  test(`revisionは独立計算した固定値に一致する: ${scenario.name}`, () => {
    const { computeFeedRevision } = mod()
    assert.equal(computeFeedRevision(structuredClone(scenario.feed)), scenario.expectedRevision)
    assert.match(scenario.expectedRevision, /^[0-9a-f]{64}$/)
    assert.equal(scenario.feed.revision, scenario.expectedRevision)
  })
}

for (const [name, change] of [
  ['タイトル', feed => { feed.articles[0].title += 'の改訂' }],
  ['概要', feed => { feed.articles[0].summary += '追記。' }],
  ['記事の順序', feed => { feed.articles.reverse() }],
  ['配信日', feed => { feed.feedDate = '2028-03-01' }],
  ['任意の原文URL', feed => { feed.articles[0].url = 'https://example.com/articles/revised' }],
]) {
  test(`同じ記事IDでも${name}の変更でrevisionが変わる`, () => {
    const { computeFeedRevision } = mod()
    const changed = structuredClone(threeFeed)
    change(changed)
    assert.notEqual(computeFeedRevision(changed), threeFeed.revision)
  })
}

test('generatedAtとrevision自身はrevisionの計算対象に含めない', () => {
  const { computeFeedRevision } = mod()
  const changed = { ...structuredClone(threeFeed), generatedAt: '2028-02-29T00:00:00.000Z', revision: '0'.repeat(64) }
  assert.equal(computeFeedRevision(changed), threeFeed.revision)
  const { generatedAt: _generatedAt, revision: _revision, ...content } = structuredClone(threeFeed)
  assert.equal(computeFeedRevision(content), threeFeed.revision)
})

test('オブジェクトのキー挿入順はrevisionに影響しない', () => {
  const { computeFeedRevision } = mod()
  const changed = structuredClone(threeFeed)
  changed.articles = changed.articles.map(item => Object.fromEntries(Object.entries(item).reverse()))
  assert.equal(computeFeedRevision(changed), threeFeed.revision)
})

test('DTOはtitleJaを優先し、空または未指定なら原題を使う', () => {
  const { toAiFeedV2Article } = mod()
  assert.equal(toAiFeedV2Article(article()).title, '架空の日本語記事')
  for (const titleJa of ['', undefined]) {
    assert.equal(toAiFeedV2Article(article({ titleJa })).title, 'Fictional article')
  }
})

test('DTOのsummaryはsummaryJaを使って前後空白を除く', () => {
  const { toAiFeedV2Article } = mod()
  assert.equal(toAiFeedV2Article(article({ summary: '採用しない概要' })).summary, '架空の概要です。')
})

test('DTOはsummaryJaが空または未指定なら記事全体をnullにする', () => {
  const { toAiFeedV2Article } = mod()
  for (const summaryJa of ['', '  \n\t', undefined, null]) {
    assert.equal(toAiFeedV2Article(article({ summaryJa, summary: '代替に使わない概要' })), null)
  }
})

test('DTOは有効なHTTPS原文URLを保持する', () => {
  const { toAiFeedV2Article } = mod()
  for (const url of ['https://example.com/articles/a?ref=feed#summary', 'HTTPS://example.com/a', 'https://example.com/記事']) {
    assert.equal(toAiFeedV2Article(article({ url })).url, url)
  }
})

for (const [name, url] of [
  ['HTTP', 'http://example.com/a'],
  ['未指定', undefined],
  ['空文字', ''],
  ['null', null],
  ['数値', 42],
  ['相対URL', '/articles/a'],
  ['不正なURL', 'https://'],
  ['スラッシュ欠落', 'https:example.com/a'],
  ['先頭の空白', ' https://example.com/a'],
  ['末尾の改行', 'https://example.com/a\n'],
  ['ホスト途中の改行', 'https://exa\nmple.com/a'],
  ['パス内の制御文字', 'https://example.com/a\u0090b'],
]) {
  test(`DTOは不正な原文URLをキーごと省略する: ${name}`, () => {
    const { toAiFeedV2Article } = mod()
    const result = toAiFeedV2Article(article({ url }))
    assert.equal('url' in result, false)
    assert.equal(result.id, 'fictional-article')
    assert.equal(result.summary, '架空の概要です。')
  })
}

test('DTOはHTTPS画像を保持し、それ以外の画像は省略する', () => {
  const { toAiFeedV2Article } = mod()
  assert.equal(toAiFeedV2Article(article()).imageUrl, 'https://images.example.com/fictional.png')
  for (const thumbnailUrl of ['http://example.com/a.png', 'https://', '/a.png', null, undefined]) {
    assert.equal('imageUrl' in toAiFeedV2Article(article({ thumbnailUrl })), false)
  }
})

test('DTOはGitHub由来の記事とGitHubのOGPホストの画像を省略する', () => {
  const { toAiFeedV2Article } = mod()
  const githubArticle = toAiFeedV2Article(article({ source: 'github' }))
  assert.equal('imageUrl' in githubArticle, false)
  assert.equal(githubArticle.url, 'https://example.com/articles/fictional')
  // 除外対象ホストそのものを確認し、実在する記事やリポジトリのパスは使わない。
  const blockedImage = toAiFeedV2Article(article({ thumbnailUrl: 'https://opengraph.githubassets.com/fictional-image' }))
  assert.equal('imageUrl' in blockedImage, false)
})

test('DTOはFirestore TimestampをISO文字列へ変換する', () => {
  const { toAiFeedV2Article } = mod()
  const timestamp = { toDate: () => new Date('2028-02-28T12:34:56.000Z') }
  const result = toAiFeedV2Article(article({ publishedAt: timestamp }))
  assert.equal(result.publishedAt, '2028-02-28T12:34:56.000Z')
  assert.equal(typeof result.publishedAt, 'string')
})

test('DTOは掲載時刻がなければ必須キーをnullで返す', () => {
  const { toAiFeedV2Article } = mod()
  for (const publishedAt of [undefined, null]) {
    const result = toAiFeedV2Article(article({ publishedAt }))
    assert.equal(Object.hasOwn(result, 'publishedAt'), true)
    assert.equal(result.publishedAt, null)
  }
})

test('DTOは値のある任意項目だけを返し、内部情報を出さない', () => {
  const { toAiFeedV2Article } = mod()
  const result = toAiFeedV2Article(article({
    readReason: '架空の利用例を確認できる',
    publisherDomain: 'example.com',
    tags: ['推論', '検証'],
    uid: 'fictional-user',
    score: 80,
    displayScore: 100,
    preferenceScore: 90,
    interactions: { dismissed: true },
    taskId: 'fictional-task',
    createdAt: { toDate: () => new Date('2028-02-28T00:00:00.000Z') },
  }))
  assert.deepEqual(result, {
    id: 'fictional-article',
    title: '架空の日本語記事',
    sourceName: '架空技術通信',
    publishedAt: null,
    summary: '架空の概要です。',
    url: 'https://example.com/articles/fictional',
    imageUrl: 'https://images.example.com/fictional.png',
    readReason: '架空の利用例を確認できる',
    publisherDomain: 'example.com',
    tags: ['推論', '検証'],
  })
  const minimal = toAiFeedV2Article(article({ url: '', thumbnailUrl: '', readReason: '', publisherDomain: '', tags: [] }))
  assert.deepEqual(Object.keys(minimal).sort(), ['id', 'publishedAt', 'sourceName', 'summary', 'title'])
})

for (const scenario of contract.validFeeds) {
  test(`buildは固定fixtureのtotalCountとrevisionを埋める: ${scenario.name}`, () => {
    const { buildAiFeedV2 } = mod()
    const { feedDate, generatedAt, articles } = structuredClone(scenario.feed)
    assert.deepEqual(buildAiFeedV2({ feedDate, generatedAt, articles }), scenario.feed)
  })
}

test('buildとvalidateは上限ちょうど20件を受理する', () => {
  const { buildAiFeedV2, validateAiFeedV2 } = mod()
  const articles = twentyArticles()
  const built = buildAiFeedV2({ feedDate: emptyFeed.feedDate, generatedAt: emptyFeed.generatedAt, articles })
  assert.equal(built.totalCount, 20)
  assert.deepEqual(built.articles, articles)
  assert.match(built.revision, /^[0-9a-f]{64}$/)
  assert.deepEqual(validateAiFeedV2(built), { ok: true, feed: built })
})

test('buildは上限超過の21件を切り捨てずthrowする', () => {
  const { buildAiFeedV2 } = mod()
  const articles = [...twentyArticles(), { ...threeFeed.articles[1], id: 'fictional-21' }]
  assert.throws(() => buildAiFeedV2({ feedDate: emptyFeed.feedDate, generatedAt: emptyFeed.generatedAt, articles }))
})

for (const scenario of contract.validFeeds) {
  test(`validateは有効な共有fixtureを受理する: ${scenario.name}`, () => {
    const { validateAiFeedV2 } = mod()
    assert.deepEqual(validateAiFeedV2(structuredClone(scenario.feed)), { ok: true, feed: scenario.feed })
  })
}

for (const scenario of contract.invalidFeeds) {
  test(`validateは不正な共有fixtureを拒否する: ${scenario.reason}`, () => {
    const { validateAiFeedV2 } = mod()
    const result = validateAiFeedV2(structuredClone(scenario.feed))
    assert.equal(result.ok, false)
    assert.equal(typeof result.reason, 'string')
    assert.ok(result.reason.length > 0)
  })
}

for (const [name, value] of [['null', null], ['配列', []], ['文字列', 'feed'], ['未指定', undefined]]) {
  test(`validateはfeedオブジェクト以外を拒否する: ${name}`, () => {
    const { validateAiFeedV2 } = mod()
    const result = validateAiFeedV2(value)
    assert.equal(result.ok, false)
    assert.equal(typeof result.reason, 'string')
    assert.ok(result.reason.length > 0)
  })
}
