const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  parseAppleSecurityReleases,
  parseAndroidSecurityBulletins,
} = require('../lib/news/fetchers/mobileOfficialFetcher')
const { extractMainContent } = require('../lib/news/scraper')
const { MOBILE_SOURCES } = require('../lib/news/fetchers/mobileSources')

const readFixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const appleHtml = readFixture('apple-security-releases.html')
const androidHtml = readFixture('android-asb-overview.html')
const androidBulletinHtml = readFixture('android-asb-2026-10.html')

const APPLE_URL = 'https://support.apple.com/en-us/100100'

test('Apple のセキュリティ一覧から iOS と iPadOS と Xcode の行だけを取る', () => {
  const articles = parseAppleSecurityReleases(appleHtml, APPLE_URL)
  assert.ok(articles.length > 0)
  assert.ok(articles.every((a) => /^(iOS|iPadOS|Xcode)/.test(a.title)))
  assert.ok(articles.every((a) => a.url.startsWith('https://')))
  assert.ok(articles.every((a) => a.platform === 'ios' && a.topic === 'mobile' && a.isOfficial === true))
  const first = articles[0]
  assert.equal(first.title, 'iOS 27.2 and iPadOS 27.2')
  assert.equal(first.url, 'https://support.apple.com/en-us/149230')
  assert.equal(first.publishedAt.toISOString().slice(0, 10), '2026-10-26')
})

test('Apple のセキュリティ一覧でリンクのない行は飛ばす', () => {
  // fixture の先頭データ行から a 要素を外した実マークアップ
  const html =
    '<table><tbody><tr><td class="gb-table-cell tablecell-align-left" colspan="1" rowspan="1"><p class="gb-paragraph">iOS 27.2 and iPadOS 27.2</p></td>' +
    '<td class="gb-table-cell tablecell-align-left" colspan="1" rowspan="1"><p class="gb-paragraph">iPhone 11 and later</p></td>' +
    '<td class="gb-table-cell tablecell-align-left" colspan="1" rowspan="1"><p class="gb-paragraph">26 Oct 2026</p></td></tr></tbody></table>'
  assert.deepEqual(parseAppleSecurityReleases(html, APPLE_URL), [])
})

test('Android Security Bulletin の一覧から月次の公開情報を取る', () => {
  const articles = parseAndroidSecurityBulletins(
    androidHtml,
    'https://source.android.com/docs/security/bulletin/asb-overview'
  )
  assert.ok(articles.length > 1)
  const first = articles[0]
  assert.equal(first.url, 'https://source.android.com/docs/security/bulletin/2026/2026-10-01')
  assert.equal(first.publishedAt.toISOString().slice(0, 10), '2026-10-05')
  assert.ok(first.title.includes('October 2026'))
  assert.ok(articles.every((a) => a.platform === 'android' && a.isOfficial === true))
  assert.ok(articles.every((a) => a.url.startsWith('https://')))
})

test('Android Security Bulletin の一覧に表がなければ空配列を返す', () => {
  assert.deepEqual(
    parseAndroidSecurityBulletins('<html><body><p>none</p></body></html>', 'https://source.android.com/docs/security/bulletin/asb-overview'),
    []
  )
})

test('mobile source は公式の7本だけで構成される', () => {
  assert.deepEqual(MOBILE_SOURCES.map((s) => s.name).sort(), [
    'Android Developers Blog', 'Android Security Bulletin', 'App Store Connect Release Notes',
    'Apple Developer News EN', 'Apple Developer News JP', 'Apple Security Releases', 'Play Console Announcements',
  ])
  assert.ok(MOBILE_SOURCES.every((s) => s.isOfficial === true && s.sourceTier !== 'community-rss'))
})

test('Android Security Bulletin の個別ページから本文の冒頭を取る', () => {
  const content = extractMainContent(androidBulletinHtml)
  assert.ok(content.length >= 500)
  const head = content.slice(0, 1500)
  assert.ok(/Published\s+October 5, 2026/.test(head))
  assert.ok(head.includes('2026-10-01'))
  assert.ok(head.includes('This Android Security Bulletin contains details of security vulnerabilities'))
  assert.ok(!content.slice(0, 300).includes('Skip to main content'))
})
