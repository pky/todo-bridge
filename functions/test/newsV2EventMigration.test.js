const test = require('node:test')
const assert = require('node:assert/strict')
const { Timestamp } = require('firebase-admin/firestore')
const { newsActionEventId } = require('../lib/news/v2/newsActionStore')

const UID = 'fiction-curator'
const NOW_MS = Date.parse('2026-11-04T00:00:00.000Z')
const DAY_MS = 86400000

function migration() {
  return require('../lib/news/v2/newsEventMigration')
}

function interaction(id, data = {}) {
  return {
    id: `ai_${id}`,
    data: {
      topic: 'ai', articleId: id, title: '架空の表示タイトル',
      titleEn: 'Fictional agents release', summaryJa: '架空の概要',
      tags: ['agents'], url: `https://example.invalid/${id}`, ...data,
    },
  }
}

function plan(interactions) {
  return migration().planNewsActionEventMigration({ uid: UID, interactions, nowMs: NOW_MS })
}

function millis(value) {
  assert.ok(value instanceof Date || value instanceof Timestamp, 'receivedAt は Date または Timestamp を保持する')
  return value instanceof Date ? value.getTime() : value.toMillis()
}

test('readLaterAtを正のイベントに変換し、通常操作と同じIDと元記事情報を使う', () => {
  const at = Timestamp.fromMillis(NOW_MS - DAY_MS)
  const [event] = plan([interaction('saved-article', { readLaterAt: at })])
  assert.equal(event.eventId, newsActionEventId(UID, 'ai', 'saved-article', 'readLater'))
  assert.equal(event.data.topic, 'ai')
  assert.equal(event.data.articleId, 'saved-article')
  assert.equal(event.data.action, 'readLater')
  assert.equal(millis(event.data.receivedAt), at.toMillis())
  assert.equal(event.data.title, 'Fictional agents release')
  assert.equal(event.data.summary, '架空の概要')
  assert.deepEqual(event.data.tags, ['agents'])
  assert.equal(event.data.url, 'https://example.invalid/saved-article')
  assert.equal(event.data.source, 'migration')
})

test('titleEnが無いときはtitleを移行する', () => {
  const [event] = plan([interaction('display-title', { titleEn: undefined, readLaterAt: new Date(NOW_MS) })])
  assert.equal(event.data.title, '架空の表示タイトル')
})

test('明示的なdismissはdismissedAtを保持し、readLaterとは別の安定IDにする', () => {
  const at = new Date(NOW_MS - 2 * DAY_MS)
  const [event] = plan([interaction('dismissed-article', { dismissed: true, dismissedAt: at })])
  assert.equal(event.data.action, 'dismiss')
  assert.equal(millis(event.data.receivedAt), at.getTime())
  assert.equal(event.eventId, newsActionEventId(UID, 'ai', 'dismissed-article', 'dismiss'))
  assert.notEqual(event.eventId, newsActionEventId(UID, 'ai', 'dismissed-article', 'readLater'))
})

test('readLaterAtに伴う自動dismissedを負のイベントに変換しない', () => {
  const events = plan([interaction('automatic-dismiss', {
    readLaterAt: new Date(NOW_MS - DAY_MS), dismissed: true, dismissedAt: new Date(NOW_MS),
  })])
  assert.deepEqual(events.map(event => event.data.action), ['readLater'])
})

test('古いreadLaterAtに伴う新しいdismissedAtも負のイベントに変換しない', () => {
  assert.deepEqual(plan([interaction('old-readlater', {
    readLaterAt: new Date(NOW_MS - 91 * DAY_MS), dismissed: true, dismissedAt: new Date(NOW_MS),
  })]), [])
})

for (const action of ['readLater', 'dismiss']) {
  test(`${action}の90日窓は各操作時刻を使い、両端を含み範囲外を除く`, () => {
    const atOffsets = { oldest: -90 * DAY_MS, now: 0, expired: -90 * DAY_MS - 1, future: 1 }
    const events = plan(Object.entries(atOffsets).map(([id, offset]) => interaction(id, {
      ...(action === 'readLater'
        ? { readLaterAt: new Date(NOW_MS + offset) }
        : { dismissed: true, dismissedAt: Timestamp.fromMillis(NOW_MS + offset) }),
      updatedAt: new Date(NOW_MS), clickedAt: new Date(NOW_MS),
    })))
    assert.deepEqual(events.map(event => event.data.articleId).sort(), ['now', 'oldest'])
    for (const event of events) assert.equal(millis(event.data.receivedAt), NOW_MS + atOffsets[event.data.articleId])
  })
}

test('クリックと表示回数だけの履歴は移行しない', () => {
  assert.deepEqual(plan([interaction('click-only', { clickedAt: new Date(NOW_MS), shownCount: 30 })]), [])
})

test('dismissedがtrueでない履歴や操作時刻のない履歴は移行しない', () => {
  assert.deepEqual(plan([
    interaction('not-dismissed', { dismissed: false, dismissedAt: new Date(NOW_MS) }),
    interaction('missing-time', { dismissed: true }),
  ]), [])
})

test('AIの履歴とtopic無しの旧履歴を扱い、明示的なmobile履歴は除く', () => {
  const records = [
    interaction('ai-record', { readLaterAt: new Date(NOW_MS) }),
    interaction('prefixed-legacy', { topic: undefined, readLaterAt: new Date(NOW_MS) }),
    { id: 'bare-legacy', data: { readLaterAt: new Date(NOW_MS), title: '架空の旧記事' } },
    { id: 'mobile_record', data: { topic: 'mobile', articleId: 'mobile-record', readLaterAt: new Date(NOW_MS) } },
  ]
  const events = plan(records)
  assert.deepEqual(events.map(event => event.data.articleId).sort(), ['ai-record', 'bare-legacy', 'prefixed-legacy'])
  const legacy = events.find(event => event.data.articleId === 'bare-legacy')
  assert.equal(legacy.eventId, newsActionEventId(UID, 'ai', 'bare-legacy', 'readLater'))
})

// create以外の書き込みは提供せず、既存の文書へのcreateは実SDKと同じコード6で拒否する。
function fakeDb(initial = []) {
  const documents = new Map(initial)
  const writes = []
  const snapshot = ref => ({ exists: documents.has(ref.path), data: () => documents.get(ref.path) })
  const create = async (ref, data) => {
    writes.push({ path: ref.path, data })
    if (documents.has(ref.path)) {
      const error = new Error('文書は既に存在します')
      error.code = 6
      throw error
    }
    assert.match(ref.path, /^users\/fiction-curator\/newsActionEvents\/[^/]+$/)
    documents.set(ref.path, data)
  }
  const doc = path => ({ path, get: async () => snapshot({ path }), create: data => create({ path }, data) })
  const db = {
    doc,
    collection: path => ({ doc: id => doc(`${path}/${id}`) }),
    batch() {
      const pending = []
      return {
        create(ref, data) { pending.push([ref, data]); return this },
        async commit() { for (const [ref, data] of pending) await create(ref, data) },
      }
    },
    async runTransaction(callback) {
      const pending = []
      const result = await callback({
        get: async ref => snapshot(ref),
        create(ref, data) { pending.push([ref, data]); return this },
      })
      for (const [ref, data] of pending) await create(ref, data)
      return result
    },
  }
  return { db, documents, writes }
}

function plannedEvent(id) {
  return {
    eventId: newsActionEventId(UID, 'ai', id, 'readLater'),
    data: { topic: 'ai', articleId: id, action: 'readLater', receivedAt: new Date(NOW_MS - DAY_MS), title: '架空の記事', source: 'migration' },
  }
}

test('dryRunは計画件数を返し、既存イベントを含め一切書き込まない', async () => {
  const events = [plannedEvent('already'), plannedEvent('new')]
  const path = `users/${UID}/newsActionEvents/${events[0].eventId}`
  const original = { ...events[0].data, title: '既存の架空記事' }
  const fake = fakeDb([[path, original]])
  const result = await migration().applyNewsActionEventMigration({ db: fake.db, uid: UID, plan: events, dryRun: true })
  assert.equal(result.planned, 2)
  assert.equal(result.created, 0)
  assert.deepEqual(fake.writes, [])
  assert.deepEqual([...fake.documents], [[path, original]])
})

test('既存イベントの時刻と記事情報を上書きせず、新規イベントだけcreateする', async () => {
  const events = [plannedEvent('already'), plannedEvent('new')]
  const existingPath = `users/${UID}/newsActionEvents/${events[0].eventId}`
  const original = { ...events[0].data, title: '先に保存した架空記事', receivedAt: new Date(NOW_MS - 2 * DAY_MS) }
  const fake = fakeDb([[existingPath, original]])
  const result = await migration().applyNewsActionEventMigration({ db: fake.db, uid: UID, plan: events, dryRun: false })
  assert.deepEqual(result, { planned: 2, created: 1, skippedExisting: 1 })
  assert.deepEqual(fake.documents.get(existingPath), original)
  assert.deepEqual(fake.documents.get(`users/${UID}/newsActionEvents/${events[1].eventId}`), events[1].data)
  assert.equal(fake.documents.size, 2)
})

test('同じ計画の再実行はcreatedが0となり、保存件数と元の時刻を維持する', async () => {
  const events = [plannedEvent('first'), plannedEvent('second')]
  const fake = fakeDb()
  const apply = () => migration().applyNewsActionEventMigration({ db: fake.db, uid: UID, plan: events, dryRun: false })
  assert.deepEqual(await apply(), { planned: 2, created: 2, skippedExisting: 0 })
  const firstSaved = [...fake.documents]
  assert.deepEqual(await apply(), { planned: 2, created: 0, skippedExisting: 2 })
  assert.deepEqual([...fake.documents], firstSaved)
})
