// 要対応記事（セキュリティ・期限付きなど）の集約ドキュメント topics/mobile/meta/actionItems を
// 収集のたびに更新する処理の検証。消えるのは公開から180日たったときだけで、
// 中身が変わらない日は書き込まない。
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const { normalizeUrl } = require('../lib/news/collectArticles')

// 対象モジュールが未作成の間も、各テストが個別に「関数が無い」理由で落ちるようにする
let actionItems = {}
try {
  actionItems = require('../lib/news/mobileActionItems')
} catch (err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') throw err
}

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 31, 3, 0, 0)
const TODAY = '2026-10-31'

function article(overrides = {}) {
  return {
    title: 'Security update',
    titleJa: 'セキュリティ更新',
    description: '',
    summaryJa: '要約',
    url: 'https://example.com/security-1',
    thumbnailUrl: null,
    topic: 'mobile',
    source: 'rss',
    sourceName: 'Example Security',
    platform: 'ios',
    isOfficial: true,
    actionRequired: false,
    actionType: 'other',
    importantLevel: 'urgent',
    inScope: true,
    classificationStatus: 'done',
    score: null,
    publishedAt: admin.firestore.Timestamp.fromMillis(NOW - 3 * DAY_MS),
    fetchedAt: admin.firestore.Timestamp.fromMillis(NOW),
    date: TODAY,
    ...overrides,
  }
}

function expectedKey(url) {
  return crypto.createHash('sha256').update(normalizeUrl(url)).digest('hex').slice(0, 20)
}

function storedItem(url, overrides = {}) {
  return {
    key: expectedKey(url),
    url,
    titleJa: '既存の要対応',
    title: 'Existing item',
    summaryJa: '既存の要約',
    platform: 'ios',
    sourceName: 'Example Security',
    isOfficial: true,
    importantLevel: 'urgent',
    actionRequired: false,
    actionType: 'other',
    publishedAt: NOW - 10 * DAY_MS,
    firstSeenDate: '2026-10-21',
    ...overrides,
  }
}

function fakeStore(initial) {
  const calls = { load: 0, save: [] }
  return {
    calls,
    async load() {
      calls.load += 1
      return initial
    },
    async save(items) {
      calls.save.push(items)
    },
  }
}

test('MOBILE_ACTION_ITEM_MAX_AGE_DAYS は 180', () => {
  assert.equal(actionItems.MOBILE_ACTION_ITEM_MAX_AGE_DAYS, 180)
})

test('isMobileActionItemArticle: urgent / actionRequired / actionType security のどれかで対象になる', () => {
  const { isMobileActionItemArticle } = actionItems
  assert.equal(isMobileActionItemArticle(article({ importantLevel: 'urgent' })), true)
  assert.equal(
    isMobileActionItemArticle(article({ importantLevel: 'reference', actionRequired: true, actionType: 'other' })),
    true
  )
  assert.equal(
    isMobileActionItemArticle(article({ importantLevel: 'reference', actionRequired: false, actionType: 'security' })),
    true
  )
})

test('isMobileActionItemArticle: どの条件も満たさない記事は対象外', () => {
  const { isMobileActionItemArticle } = actionItems
  assert.equal(
    isMobileActionItemArticle(article({ importantLevel: 'review', actionRequired: false, actionType: 'release' })),
    false
  )
})

test('isMobileActionItemArticle: inScope が true でない記事は対象外', () => {
  const { isMobileActionItemArticle } = actionItems
  assert.equal(isMobileActionItemArticle(article({ inScope: false })), false)
  assert.equal(isMobileActionItemArticle(article({ inScope: undefined })), false)
})

test('isMobileActionItemArticle: classificationStatus が done でない記事は対象外', () => {
  const { isMobileActionItemArticle } = actionItems
  assert.equal(isMobileActionItemArticle(article({ classificationStatus: 'pending' })), false)
  assert.equal(isMobileActionItemArticle(article({ classificationStatus: undefined })), false)
})

test('getMobileActionItemKey は Apple ニュース ID の apple:<id> を sha256 した先頭20桁の16進', () => {
  const url = 'https://developer.apple.com/news/?id=abc123'
  const key = actionItems.getMobileActionItemKey(url)
  assert.match(key, /^[0-9a-f]{20}$/)
  assert.equal(key, crypto.createHash('sha256').update('apple:abc123').digest('hex').slice(0, 20))
})

test('getMobileActionItemKey は Apple Developer News の日英で同じ ID なら同じキー、別 ID なら別キー', () => {
  const { getMobileActionItemKey } = actionItems
  const english = 'https://developer.apple.com/news/?id=abc123'
  const japanese = 'https://developer.apple.com/jp/news/?id=abc123'
  assert.equal(getMobileActionItemKey(japanese), getMobileActionItemKey(english))
  assert.notEqual(getMobileActionItemKey(english), getMobileActionItemKey('https://developer.apple.com/news/?id=def456'))
})

test('getMobileActionItemKey は同じページの別フラグメントを別キーにし、正規化 URL とフラグメントをハッシュする', () => {
  const { getMobileActionItemKey } = actionItems
  const base = 'https://example.com/release-notes/'
  const oldFragment = '#2026-10-01-old-release'
  const newFragment = '#2026-10-28-new-release'
  assert.notEqual(getMobileActionItemKey(`${base}${oldFragment}`), getMobileActionItemKey(`${base}${newFragment}`))
  assert.equal(
    getMobileActionItemKey(`${base}${newFragment}`),
    crypto.createHash('sha256').update(`${normalizeUrl(base)}${newFragment}`).digest('hex').slice(0, 20)
  )
})

test('getMobileActionItemKey はフラグメントも Apple ニュース ID も無ければ正規化 URL をハッシュする', () => {
  const url = 'https://example.com/security-1?utm_source=x'
  assert.equal(actionItems.getMobileActionItemKey(url), expectedKey(url))
})

test('getMobileActionItemKey は追跡パラメーター違いを同じキーにする', () => {
  const { getMobileActionItemKey } = actionItems
  const base = 'https://example.com/security-1'
  assert.equal(
    getMobileActionItemKey(`${base}?utm_source=x&utm_medium=y`),
    getMobileActionItemKey(base)
  )
  assert.equal(getMobileActionItemKey(`${base}/?fbclid=z`), getMobileActionItemKey(base))
  const fragment = '#2026-10-28-new-release'
  assert.equal(
    getMobileActionItemKey(`https://example.com/release-notes/?utm_source=x${fragment}`),
    getMobileActionItemKey(`https://example.com/release-notes/${fragment}`)
  )
  assert.equal(
    getMobileActionItemKey('https://developer.apple.com/jp/news/?id=abc123&utm_source=x'),
    getMobileActionItemKey('https://developer.apple.com/jp/news/?id=abc123')
  )
})

test('buildMobileActionItem は表示用項目、ms の publishedAt、firstSeenDate、key を持つ', () => {
  const published = NOW - 5 * DAY_MS
  const item = actionItems.buildMobileActionItem(
    article({
      url: 'https://example.com/sec?utm_source=x',
      requiredByDate: '2026-11-30',
      actionRequired: true,
      actionType: 'security',
      publishedAt: admin.firestore.Timestamp.fromMillis(published),
      content: '本文は持たない',
    }),
    TODAY
  )
  assert.equal(item.key, expectedKey('https://example.com/sec'))
  assert.equal(item.publishedAt, published)
  assert.equal(typeof item.publishedAt, 'number')
  assert.equal(item.firstSeenDate, TODAY)
  assert.equal(item.titleJa, 'セキュリティ更新')
  assert.equal(item.title, 'Security update')
  assert.equal(item.summaryJa, '要約')
  assert.equal(item.platform, 'ios')
  assert.equal(item.sourceName, 'Example Security')
  assert.equal(item.isOfficial, true)
  assert.equal(item.importantLevel, 'urgent')
  assert.equal(item.actionRequired, true)
  assert.equal(item.actionType, 'security')
  assert.equal(item.requiredByDate, '2026-11-30')
  assert.equal('content' in item, false)
})

test('mergeMobileActionItems: 集約に無い要対応記事を firstSeenDate=today で追加し changed=true', () => {
  const url = 'https://example.com/security-new'
  const result = actionItems.mergeMobileActionItems({}, [article({ url })], NOW, TODAY)
  assert.equal(result.changed, true)
  const key = expectedKey(url)
  assert.deepEqual(Object.keys(result.items), [key])
  assert.equal(result.items[key].firstSeenDate, TODAY)
  assert.equal(result.items[key].key, key)
  assert.equal(result.items[key].url, url)
})

test('mergeMobileActionItems: 要対応でない記事は追加しない', () => {
  const result = actionItems.mergeMobileActionItems(
    {},
    [
      article({ url: 'https://example.com/info', importantLevel: 'reference', actionRequired: false, actionType: 'release' }),
      article({ url: 'https://example.com/out', inScope: false }),
    ],
    NOW,
    TODAY
  )
  assert.equal(result.changed, false)
  assert.deepEqual(result.items, {})
})

test('mergeMobileActionItems: 同じページの別フラグメントのリリースノートを両方追加する', () => {
  const urls = [
    'https://example.com/release-notes/#2026-10-01-old-release',
    'https://example.com/release-notes/#2026-10-28-new-release',
  ]
  const result = actionItems.mergeMobileActionItems({}, urls.map(url => article({ url })), NOW, TODAY)
  const expectedKeys = urls.map(url => crypto.createHash('sha256')
    .update(`${normalizeUrl(url)}${new URL(url).hash}`).digest('hex').slice(0, 20))
  assert.equal(result.changed, true)
  assert.deepEqual(Object.keys(result.items).sort(), expectedKeys.sort())
  for (const url of urls) {
    const key = actionItems.getMobileActionItemKey(url)
    assert.equal(result.items[key].url, url)
    assert.equal(result.items[key].firstSeenDate, TODAY)
    assert.equal(result.items[key].key, key)
  }
})

test('mergeMobileActionItems: 既にあるキーは上書きせず firstSeenDate を保ち、変化なしなら changed=false', () => {
  const url = 'https://example.com/security-1'
  const existing = storedItem(url)
  const current = { [existing.key]: existing }
  const result = actionItems.mergeMobileActionItems(
    current,
    [article({ url, titleJa: '内容が変わった再収集', importantLevel: 'urgent' })],
    NOW,
    TODAY
  )
  assert.equal(result.changed, false)
  assert.deepEqual(result.items, { [existing.key]: existing })
  assert.equal(result.items[existing.key].firstSeenDate, '2026-10-21')
  assert.equal(result.items[existing.key].titleJa, '既存の要対応')
})

test('mergeMobileActionItems: 追跡パラメーター違いの URL は既存と同じキーとして扱い追加しない', () => {
  const url = 'https://example.com/security-1'
  const existing = storedItem(url)
  const result = actionItems.mergeMobileActionItems(
    { [existing.key]: existing },
    [article({ url: `${url}?utm_source=newsletter&utm_campaign=c` })],
    NOW,
    TODAY
  )
  assert.equal(result.changed, false)
  assert.deepEqual(Object.keys(result.items), [existing.key])
})

test('mergeMobileActionItems: 公開から180日を超えた項目を外し changed=true、179日の項目は残す', () => {
  const oldItem = storedItem('https://example.com/old', { publishedAt: NOW - 181 * DAY_MS })
  const keepItem = storedItem('https://example.com/keep', { publishedAt: NOW - 179 * DAY_MS })
  const result = actionItems.mergeMobileActionItems(
    { [oldItem.key]: oldItem, [keepItem.key]: keepItem },
    [],
    NOW,
    TODAY
  )
  assert.equal(result.changed, true)
  assert.deepEqual(Object.keys(result.items), [keepItem.key])
})

test('mergeMobileActionItems: 公開から180日を超えた要対応記事は追加しない', () => {
  const result = actionItems.mergeMobileActionItems(
    {},
    [article({ url: 'https://example.com/too-old', publishedAt: admin.firestore.Timestamp.fromMillis(NOW - 181 * DAY_MS) })],
    NOW,
    TODAY
  )
  assert.equal(result.changed, false)
  assert.deepEqual(result.items, {})
})

test('mergeMobileActionItems: 公開から15日以上たち当日の収集に無い項目も180日以内なら残る', () => {
  const carried = storedItem('https://example.com/carried', { publishedAt: NOW - 20 * DAY_MS })
  const result = actionItems.mergeMobileActionItems({ [carried.key]: carried }, [], NOW, TODAY)
  assert.equal(result.changed, false)
  assert.deepEqual(result.items, { [carried.key]: carried })
})

test('syncMobileActionItems: 中身が変わらない日は load 1回、save 0回', async () => {
  const url = 'https://example.com/security-1'
  const existing = storedItem(url)
  const store = fakeStore({ [existing.key]: existing })
  const result = await actionItems.syncMobileActionItems(store, [article({ url })], NOW, TODAY)
  assert.equal(store.calls.load, 1)
  assert.equal(store.calls.save.length, 0)
  assert.equal(result.changed, false)
})

test('syncMobileActionItems: 追加があれば load 1回、save 1回で結果の items を保存する', async () => {
  const existing = storedItem('https://example.com/security-1')
  const store = fakeStore({ [existing.key]: existing })
  const newUrl = 'https://example.com/security-2'
  const result = await actionItems.syncMobileActionItems(store, [article({ url: newUrl })], NOW, TODAY)
  assert.equal(store.calls.load, 1)
  assert.equal(store.calls.save.length, 1)
  assert.equal(result.changed, true)
  const saved = store.calls.save[0]
  assert.deepEqual(Object.keys(saved).sort(), [existing.key, expectedKey(newUrl)].sort())
  assert.equal(saved[expectedKey(newUrl)].firstSeenDate, TODAY)
})

test('syncMobileActionItems: 180日超の削除だけでも save 1回', async () => {
  const oldItem = storedItem('https://example.com/old', { publishedAt: NOW - 181 * DAY_MS })
  const store = fakeStore({ [oldItem.key]: oldItem })
  const result = await actionItems.syncMobileActionItems(store, [], NOW, TODAY)
  assert.equal(store.calls.load, 1)
  assert.equal(store.calls.save.length, 1)
  assert.deepEqual(store.calls.save[0], {})
  assert.equal(result.changed, true)
})

test('syncMobileActionItems: load が null なら空として扱い、要対応記事が無ければ save しない', async () => {
  const store = fakeStore(null)
  const result = await actionItems.syncMobileActionItems(store, [], NOW, TODAY)
  assert.equal(store.calls.load, 1)
  assert.equal(store.calls.save.length, 0)
  assert.equal(result.changed, false)
})

test('syncMobileActionItems: load が null でも要対応記事があれば追加して save 1回', async () => {
  const store = fakeStore(null)
  const url = 'https://example.com/security-1'
  const result = await actionItems.syncMobileActionItems(store, [article({ url })], NOW, TODAY)
  assert.equal(store.calls.load, 1)
  assert.equal(store.calls.save.length, 1)
  assert.deepEqual(Object.keys(store.calls.save[0]), [expectedKey(url)])
  assert.equal(result.changed, true)
})
