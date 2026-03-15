const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const {
  normalizeUrl,
  normalizeTitle,
  deduplicateArticlesByPriority,
  filterMobileArticlesByFreshness,
  getSourceTierRank,
} = require('../lib/news/collectArticles')

test('normalizeUrl は末尾スラッシュを除去する', () => {
  assert.equal(
    normalizeUrl('https://developer.apple.com/jp/news/?id=f5zj08ey'),
    'developer.apple.com/jp/news?id=f5zj08ey'
  )
  assert.equal(
    normalizeUrl('https://developers-jp.googleblog.com/2026/03/example/'),
    'developers-jp.googleblog.com/2026/03/example'
  )
})

test('sourceTier の優先順位は official > official-rss > community-rss', () => {
  assert.equal(getSourceTierRank('official'), 3)
  assert.equal(getSourceTierRank('official-rss'), 2)
  assert.equal(getSourceTierRank('community-rss'), 1)
})

test('normalizeTitle は空白と記号差を吸収する', () => {
  assert.equal(
    normalizeTitle('App Reviewガイドラインの更新版を公開'),
    normalizeTitle('App Review ガイドラインの更新版を公開')
  )
})

test('同一URLなら official を優先して残す', () => {
  const result = deduplicateArticlesByPriority([
    {
      title: 'RSS item',
      url: 'https://developer.apple.com/jp/news/?id=f5zj08ey',
      description: '',
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'rss',
      sourceName: 'Apple Developer News RSS',
      sourceTier: 'official-rss',
      platform: 'ios',
      isOfficial: true,
      actionRequired: true,
      actionType: 'other',
      score: null,
      publishedAt: new Date(),
    },
    {
      title: 'HTML item',
      url: 'https://developer.apple.com/jp/news/?id=f5zj08ey',
      description: '',
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'official',
      sourceName: 'Apple Developer News',
      sourceTier: 'official',
      platform: 'ios',
      isOfficial: true,
      actionRequired: true,
      actionType: 'other',
      score: null,
      publishedAt: new Date(),
    },
  ])

  assert.equal(result.length, 1)
  assert.equal(result[0].sourceName, 'Apple Developer News')
  assert.equal(result[0].sourceTier, 'official')
})

test('別URLなら両方残す', () => {
  const result = deduplicateArticlesByPriority([
    {
      title: 'A',
      url: 'https://developer.apple.com/jp/news/?id=aaaa1111',
      description: '',
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'official',
      sourceName: 'Apple Developer News',
      sourceTier: 'official',
      platform: 'ios',
      isOfficial: true,
      actionRequired: false,
      actionType: 'other',
      score: null,
      publishedAt: new Date(),
    },
    {
      title: 'B',
      url: 'https://android-developers-jp.googleblog.com/2026/03/example.html',
      description: '',
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'official',
      sourceName: 'Android Developers Japan Blog',
      sourceTier: 'official',
      platform: 'android',
      isOfficial: true,
      actionRequired: false,
      actionType: 'other',
      score: null,
      publishedAt: new Date(),
    },
  ])

  assert.equal(result.length, 2)
})

test('URLが違っても同日同題なら優先ソースだけ残す', () => {
  const publishedAt = new Date('2026-03-14T00:00:00.000Z')
  const result = deduplicateArticlesByPriority([
    {
      title: '最新のベータ版リリースへの対応準備',
      url: 'https://developer.apple.com/jp/news/?id=xgkk9w83',
      description: '',
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'rss',
      sourceName: 'Apple Developer News RSS',
      sourceTier: 'official-rss',
      platform: 'ios',
      isOfficial: true,
      actionRequired: false,
      actionType: 'beta',
      score: null,
      publishedAt,
    },
    {
      title: '最新のベータ版リリースへの対応準備',
      url: 'https://developer.apple.com/news/?id=xgkk9w83',
      description: '',
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'official',
      sourceName: 'Apple Developer News',
      sourceTier: 'official',
      platform: 'ios',
      isOfficial: true,
      actionRequired: false,
      actionType: 'beta',
      score: null,
      publishedAt,
    },
  ])

  assert.equal(result.length, 1)
  assert.equal(result[0].sourceTier, 'official')
  assert.equal(result[0].sourceName, 'Apple Developer News')
})

test('mobile 記事は公式14日・コミュニティ30日で鮮度フィルタする', () => {
  const now = new Date('2026-03-15T00:00:00.000Z')
  const result = filterMobileArticlesByFreshness([
    {
      title: 'fresh official',
      url: 'https://developer.apple.com/news/?id=fresh-official',
      description: '',
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'official',
      sourceName: 'Apple Developer News',
      sourceTier: 'official',
      platform: 'ios',
      isOfficial: true,
      actionRequired: false,
      actionType: 'other',
      score: null,
      publishedAt: new Date('2026-03-10T00:00:00.000Z'),
    },
    {
      title: 'old official',
      url: 'https://developer.apple.com/news/?id=old-official',
      description: '',
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'official',
      sourceName: 'Apple Developer News',
      sourceTier: 'official',
      platform: 'ios',
      isOfficial: true,
      actionRequired: false,
      actionType: 'other',
      score: null,
      publishedAt: new Date('2026-02-20T00:00:00.000Z'),
    },
    {
      title: 'fresh community',
      url: 'https://menthas.com/ios/fresh-community',
      description: '',
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'rss',
      sourceName: 'menthas iOS',
      sourceTier: 'community-rss',
      platform: 'ios',
      isOfficial: false,
      actionRequired: false,
      actionType: 'other',
      score: null,
      publishedAt: new Date('2026-02-20T00:00:00.000Z'),
    },
    {
      title: 'old community',
      url: 'https://menthas.com/ios/old-community',
      description: '',
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'rss',
      sourceName: 'menthas iOS',
      sourceTier: 'community-rss',
      platform: 'ios',
      isOfficial: false,
      actionRequired: false,
      actionType: 'other',
      score: null,
      publishedAt: new Date('2026-02-01T00:00:00.000Z'),
    },
  ], now)

  assert.equal(result.length, 2)
  assert.equal(result.some((article) => article.title === 'fresh official'), true)
  assert.equal(result.some((article) => article.title === 'fresh community'), true)
  assert.equal(result.some((article) => article.title === 'old official'), false)
  assert.equal(result.some((article) => article.title === 'old community'), false)
})
