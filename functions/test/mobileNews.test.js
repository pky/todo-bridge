const test = require('node:test')
const assert = require('node:assert/strict')

const { MOBILE_SOURCES } = require('../lib/news/fetchers/mobileSources')

test('mobile source 設定に主要公式ソースが含まれる', () => {
  const names = MOBILE_SOURCES.map((source) => source.name)

  assert.ok(names.includes('Apple Developer News JP'))
  assert.ok(names.includes('Apple Developer News EN'))
  assert.ok(names.includes('App Store Connect Release Notes'))
  assert.ok(names.includes('Android Developers Blog'))
  assert.ok(names.includes('Play Console Announcements'))
  assert.ok(names.includes('Apple Security Releases'))
  assert.ok(names.includes('Android Security Bulletin'))
})

test('major source は mobile topic と platform を持つ', () => {
  for (const source of MOBILE_SOURCES) {
    assert.equal(source.topic, 'mobile')
    assert.ok(['ios', 'android', 'cross'].includes(source.platform))
    assert.ok(['html', 'rss', 'atom'].includes(source.kind))
  }
})

test('mobile source は公式ソースだけでコミュニティRSSを含まない', () => {
  assert.equal(MOBILE_SOURCES.length, 7)
  assert.ok(MOBILE_SOURCES.every((source) => source.isOfficial === true))
  assert.ok(MOBILE_SOURCES.every((source) => source.sourceTier !== 'community-rss'))
})
