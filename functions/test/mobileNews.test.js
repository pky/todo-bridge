const test = require('node:test')
const assert = require('node:assert/strict')

const {
  detectActionRequired,
  detectActionType,
  detectImportantLevel,
  extractRequiredByDate,
  classifyMobileArticle,
} = require('../lib/news/mobileClassifier')
const { MOBILE_SOURCES } = require('../lib/news/fetchers/mobileSources')

test('SDK要件記事を要対応として判定する', () => {
  const result = classifyMobileArticle({
    title: 'Target SDK requirement changes for Google Play',
    description: 'You must update your app to meet the new target SDK requirement before the deadline.',
  })

  assert.equal(result.actionRequired, true)
  assert.equal(result.actionType, 'sdk_requirement')
})

test('ポリシー記事を policy として判定する', () => {
  assert.equal(
    detectActionType(
      'Google Play policy updates',
      'Review the latest policy and guideline changes.'
    ),
    'policy'
  )
})

test('一般的なリリース記事は other または release として判定する', () => {
  const result = classifyMobileArticle({
    title: 'Android 16 beta is now available',
    description: 'The latest beta release is available for testing.',
  })

  assert.equal(result.actionRequired, false)
  assert.equal(result.actionType, 'beta')
})

test('mobile source 設定に主要公式ソースが含まれる', () => {
  const names = MOBILE_SOURCES.map((source) => source.name)

  assert.ok(names.includes('Apple Developer News'))
  assert.ok(names.includes('Apple Developer News RSS'))
  assert.ok(names.includes('Apple Developer LinkedIn'))
  assert.ok(names.includes('Google Developers Japan'))
  assert.ok(names.includes('Android Developers Japan Blog'))
  assert.ok(names.includes('menthas'))
  assert.ok(names.includes('menthas iOS'))
  assert.ok(names.includes('Android Weekly'))
  assert.ok(names.includes('Swift with Majid'))
})

test('mobile source 設定にコミュニティRSSが複数含まれる', () => {
  const communitySources = MOBILE_SOURCES.filter((source) => source.sourceTier === 'community-rss')
  const urls = communitySources.map((source) => source.url)

  assert.ok(urls.includes('http://taisy0.com/feed'))
  assert.ok(urls.includes('http://menthas.com/android/rss'))
  assert.ok(urls.includes('https://menthas.com/ios/rss'))
  assert.ok(urls.includes('https://androidweekly.net/rss.xml'))
  assert.ok(urls.includes('https://swiftwithmajid.com/feed.xml'))
})

test('major source は mobile topic と platform を持つ', () => {
  for (const source of MOBILE_SOURCES) {
    assert.equal(source.topic, 'mobile')
    assert.ok(['ios', 'android', 'cross'].includes(source.platform))
    assert.ok(['html', 'rss', 'atom'].includes(source.kind))
  }
})

test('要対応キーワードの日本語判定が働く', () => {
  assert.equal(
    detectActionRequired(
      'App Store審査要件の更新',
      '対応期限までに新しい要件への移行が必要です。'
    ),
    true
  )
})

test('Hello Developer のような案内記事は要対応にしない', () => {
  const result = classifyMobileArticle({
    title: 'Hello Developer 2026年3月',
    description: '今月のApple Developer関連ニュースをまとめて紹介します。',
  })

  assert.equal(result.actionRequired, false)
})

test('ベータ記事は beta でも必ずしも要対応にしない', () => {
  const result = classifyMobileArticle({
    title: 'Android 16 beta is now available',
    description: 'Check out the latest beta release notes and features.',
  })

  assert.equal(result.actionType, 'beta')
  assert.equal(result.actionRequired, false)
})

test('ガイドライン更新は review の policy として判定する', () => {
  const result = classifyMobileArticle({
    title: 'App Reviewガイドラインの更新版を公開',
    description: 'App Reviewガイドラインが更新されました。',
  })

  assert.equal(result.actionType, 'policy')
  assert.equal(result.actionRequired, false)
  assert.equal(result.importantLevel, 'review')
})

test('期限付き要件から requiredByDate を抽出する', () => {
  const result = classifyMobileArticle({
    title: 'Target SDK requirement changes',
    description: 'You must update before 2026-05-31 to remain compliant.',
  })

  assert.equal(result.requiredByDate, '2026-05-31')
  assert.equal(result.importantLevel, 'urgent')
})

test('公式ポリシー変更は review として扱う', () => {
  assert.equal(
    detectImportantLevel(
      'Google Play policy updates',
      'Review the latest policy and guideline changes.'
    ),
    'review'
  )
})

test('日付抽出は日本語日付にも対応する', () => {
  assert.equal(
    extractRequiredByDate(
      'App Store審査要件の更新',
      '2026年6月15日までに対応が必要です。'
    ),
    '2026-06-15'
  )
})

test('公開日だけの日付は requiredByDate にしない', () => {
  assert.equal(
    extractRequiredByDate(
      'Android 16 beta is now available',
      'Published on 2026-05-31 with the latest beta release notes.'
    ),
    undefined
  )
})
