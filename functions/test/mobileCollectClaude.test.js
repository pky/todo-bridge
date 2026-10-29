const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const {
  getAppleNewsId,
  getAppleNewsAlternateUrls,
  preferJapaneseAppleNews,
  planMobileArticleProcessing,
  buildClassificationInput,
  buildClassifiedMobileArticle,
  buildReusedMobileArticle,
} = require('../lib/news/collectArticles')

const JP_URL = 'https://developer.apple.com/jp/news/?id=92th7e5i'
const EN_URL = 'https://developer.apple.com/news/?id=92th7e5i'
const TODAY = '2026-10-28'
const fetchedAt = admin.firestore.Timestamp.fromDate(new Date('2026-10-28T00:00:00Z'))

function makeRaw(overrides = {}) {
  return {
    title: 'Raw title',
    url: EN_URL,
    description: 'Raw description',
    thumbnailUrl: null,
    topic: 'mobile',
    source: 'official',
    sourceName: 'Apple Developer News',
    sourceTier: 'official',
    platform: 'ios',
    isOfficial: true,
    score: null,
    publishedAt: new Date('2026-10-20T10:00:00Z'),
    ...overrides,
  }
}

function makeSummary() {
  return { overview: '概要', target: '対象', deadline: '期限なし', action: '対応不要' }
}

function makeExisting(overrides = {}) {
  return {
    title: 'Old title',
    description: 'Old description',
    content: 'Old content',
    titleJa: '古い日本語タイトル',
    summaryJa: '古い概要',
    tags: [],
    url: EN_URL,
    thumbnailUrl: null,
    topic: 'mobile',
    source: 'official',
    sourceName: 'Apple Developer News',
    sourceTier: 'official',
    platform: 'ios',
    isOfficial: true,
    actionRequired: true,
    actionType: 'security',
    importantLevel: 'urgent',
    requiredByDate: '2026-12-01',
    score: null,
    publishedAt: admin.firestore.Timestamp.fromDate(new Date('2026-10-20T10:00:00Z')),
    fetchedAt: admin.firestore.Timestamp.fromDate(new Date('2026-10-21T00:00:00Z')),
    date: '2026-10-21',
    classificationStatus: 'done',
    inScope: true,
    mobileSummary: makeSummary(),
    ...overrides,
  }
}

function makeResult(overrides = {}) {
  return {
    id: 'doc1',
    category: 'security',
    importantLevel: 'urgent',
    actionRequired: true,
    requiredByDate: '2026-12-01',
    platform: 'ios',
    titleJa: '日本語タイトル',
    summary: { overview: '脆弱性の修正', target: 'iOS 26', deadline: '2026-12-01', action: '更新する' },
    ...overrides,
  }
}

test('getAppleNewsId は日英どちらの URL からも id を取る', () => {
  assert.equal(getAppleNewsId(JP_URL), '92th7e5i')
  assert.equal(getAppleNewsId(EN_URL), '92th7e5i')
  assert.equal(getAppleNewsId('https://example.com/?id=x'), null)
})

test('getAppleNewsAlternateUrls は日英両方の URL を返す', () => {
  const urls = getAppleNewsAlternateUrls(EN_URL)
  assert.equal(urls.length, 2)
  assert.ok(urls.includes(EN_URL))
  assert.ok(urls.includes(JP_URL))
  const other = 'https://example.com/post'
  assert.deepEqual(getAppleNewsAlternateUrls(other), [other])
})

test('preferJapaneseAppleNews は同じ id の日英が両方あれば日本語版だけ残す', () => {
  const enOnlyUrl = 'https://developer.apple.com/news/?id=aaaa1111'
  const result = preferJapaneseAppleNews([
    makeRaw({ url: EN_URL }),
    makeRaw({ url: JP_URL }),
    makeRaw({ url: enOnlyUrl }),
  ])
  assert.equal(result.length, 2)
  const urls = result.map((r) => r.url)
  assert.ok(urls.includes(JP_URL))
  assert.ok(urls.includes(enOnlyUrl))
  assert.ok(!urls.includes(EN_URL))
})

test('planMobileArticleProcessing は done の過去記事と URL が同じなら再利用に回す', () => {
  const raw = makeRaw({ url: EN_URL })
  const source = makeExisting({ url: EN_URL, classificationStatus: 'done' })
  const plan = planMobileArticleProcessing([raw], [source])
  assert.equal(plan.reuse.length, 1)
  assert.equal(plan.fresh.length, 0)
  assert.equal(plan.reuse[0].raw, raw)
  assert.equal(plan.reuse[0].source, source)
})

test('planMobileArticleProcessing は pending の過去記事を再利用しない', () => {
  const raw = makeRaw({ url: EN_URL })
  const source = makeExisting({ url: EN_URL, classificationStatus: 'pending' })
  const plan = planMobileArticleProcessing([raw], [source])
  assert.equal(plan.reuse.length, 0)
  assert.deepEqual(plan.fresh, [raw])
})

test('planMobileArticleProcessing は英語版で判定済みの記事に日本語版が来たら再利用する', () => {
  const raw = makeRaw({ url: JP_URL })
  const source = makeExisting({ url: EN_URL, classificationStatus: 'done' })
  const plan = planMobileArticleProcessing([raw], [source])
  assert.equal(plan.reuse.length, 1)
  assert.equal(plan.fresh.length, 0)
  assert.equal(plan.reuse[0].raw, raw)
  assert.equal(plan.reuse[0].source, source)
})

test('planMobileArticleProcessing はフラグメントが違う版の判定を再利用せず fresh に回す', () => {
  const raw = makeRaw({ url: 'https://example.com/release-notes/#2026-10-28-new-release' })
  const source = makeExisting({
    url: 'https://example.com/release-notes/#2026-10-01-old-release',
    classificationStatus: 'done',
  })
  const plan = planMobileArticleProcessing([raw], [source])
  assert.equal(plan.reuse.length, 0)
  assert.deepEqual(plan.fresh, [raw])
})

test('planMobileArticleProcessing はフラグメントまで同じ URL なら再利用に回す', () => {
  const url = 'https://example.com/release-notes/#2026-10-28-new-release'
  const raw = makeRaw({ url })
  const source = makeExisting({ url, classificationStatus: 'done' })
  const plan = planMobileArticleProcessing([raw], [source])
  assert.equal(plan.reuse.length, 1)
  assert.equal(plan.fresh.length, 0)
  assert.equal(plan.reuse[0].source, source)
})

test('buildReusedMobileArticle は URL とタイトルを新しい記事のものにし、判定と要約をコピーする', () => {
  const raw = makeRaw({ url: JP_URL, title: '日本語版タイトル', description: '日本語版の説明' })
  const source = makeExisting({ url: EN_URL })
  const article = buildReusedMobileArticle(raw, source, TODAY, fetchedAt)
  assert.equal(article.url, JP_URL)
  assert.equal(article.title, '日本語版タイトル')
  assert.equal(article.description, '日本語版の説明')
  assert.deepEqual(article.mobileSummary, source.mobileSummary)
  assert.equal(article.actionType, 'security')
  assert.equal(article.importantLevel, 'urgent')
  assert.equal(article.titleJa, '古い日本語タイトル')
  assert.equal(article.content, 'Old content')
  assert.equal(article.classificationStatus, 'done')
  assert.equal(article.inScope, true)
  assert.equal(article.date, TODAY)
})

test('buildClassificationInput は本文がなければ説明文を使い、5000文字で切る', () => {
  const raw = makeRaw({ description: 'フォールバック説明' })
  const empty = buildClassificationInput('doc1', raw, '')
  assert.equal(empty.id, 'doc1')
  assert.equal(empty.title, raw.title)
  assert.equal(empty.sourceName, raw.sourceName)
  assert.equal(empty.text, 'フォールバック説明')
  assert.equal(empty.publishedDate, '2026-10-20')
  const long = buildClassificationInput('doc2', raw, 'a'.repeat(6000))
  assert.equal(long.text.length, 5000)
  assert.equal(long.text, 'a'.repeat(5000))
})

test('buildClassifiedMobileArticle は判定結果を保存形式に変換する', () => {
  const raw = makeRaw()
  const result = makeResult()
  const article = buildClassifiedMobileArticle(raw, '本文', result, TODAY, fetchedAt)
  assert.equal(article.actionType, 'security')
  assert.equal(article.inScope, true)
  assert.equal(article.classificationStatus, 'done')
  assert.equal(article.summaryJa, result.summary.overview)
  assert.deepEqual(article.mobileSummary, result.summary)
  assert.deepEqual(article.tags, [])
  assert.equal(article.requiredByDate, '2026-12-01')
  assert.equal(article.importantLevel, 'urgent')
  assert.equal(article.actionRequired, true)
  assert.equal(article.titleJa, '日本語タイトル')
  assert.equal(article.content, '本文')
  assert.equal(article.url, raw.url)
  assert.equal(article.date, TODAY)
  assert.equal(article.fetchedAt, fetchedAt)
})

test('buildClassifiedMobileArticle は out_of_scope を inScope false、actionType other にする', () => {
  const result = makeResult({
    category: 'out_of_scope',
    importantLevel: 'reference',
    actionRequired: false,
    requiredByDate: null,
    summary: { overview: '', target: '', deadline: '', action: '' },
  })
  const article = buildClassifiedMobileArticle(makeRaw(), '本文', result, TODAY, fetchedAt)
  assert.equal(article.inScope, false)
  assert.equal(article.actionType, 'other')
  assert.equal(article.classificationStatus, 'done')
})

test('buildClassifiedMobileArticle は requiredByDate が null ならフィールドを持たない', () => {
  const result = makeResult({ requiredByDate: null })
  const article = buildClassifiedMobileArticle(makeRaw(), '本文', result, TODAY, fetchedAt)
  assert.equal('requiredByDate' in article, false)
})

test('buildClassifiedMobileArticle は判定結果がなければ pending で保存する', () => {
  const article = buildClassifiedMobileArticle(makeRaw(), '本文', null, TODAY, fetchedAt)
  assert.equal(article.classificationStatus, 'pending')
  assert.equal('inScope' in article, false)
  assert.equal('mobileSummary' in article, false)
  assert.equal(article.url, EN_URL)
  assert.equal(article.date, TODAY)
})
