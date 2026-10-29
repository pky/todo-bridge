const test = require('node:test')
const assert = require('node:assert/strict')

// 未実装のモジュールでファイル全体が落ちないよう、読み込み失敗は各テスト内の失敗として報告する。
let loader = null
let loadError = null
try {
  loader = require('../lib/news/widgetNewsLoader')
} catch (error) {
  loadError = error
}
function mod() {
  if (!loader) throw new Error(`widgetNewsLoader が未実装です: ${loadError && loadError.message}`)
  return loader
}

const UID = 'user-fictional-1'

// collections: パス -> [{ id, data }]。呼び出しは calls に記録する。
function createDb(collections) {
  const calls = []
  const snapshot = items => ({
    empty: items.length === 0,
    docs: items.map(item => ({ id: item.id, data: () => item.data })),
  })
  const db = {
    calls,
    collection(path) {
      const items = collections[path] || []
      return {
        orderBy(field, direction) {
          return {
            limit(count) {
              return {
                async get() {
                  calls.push({ path, kind: 'latest', field, direction, count })
                  const sorted = [...items].sort((a, b) => String(b.data[field]).localeCompare(String(a.data[field])))
                  return snapshot(sorted.slice(0, count))
                },
              }
            },
          }
        },
        where(field, op, value) {
          return {
            async get() {
              calls.push({ path, kind: 'where', field, op, value })
              return snapshot(items.filter(item => op === '==' && item.data[field] === value))
            },
          }
        },
        async get() {
          calls.push({ path, kind: 'all' })
          return snapshot(items)
        },
      }
    },
  }
  return db
}

const personalPath = topic => `users/${UID}/newsFeed/${topic}/articles`
const sharedPath = topic => `topics/${topic}/articles`
const interactionsPath = `users/${UID}/newsInteractions`

test('個別フィード・共有・記録を所定のパスから読む', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [personalPath('ai')]: [{ id: 'p1', data: { date: '2026-01-02', title: 'P1' } }],
    [sharedPath('ai')]: [{ id: 's1', data: { date: '2026-01-02', title: 'S1' } }],
    [interactionsPath]: [{ id: 'i1', data: { url: 'https://example.com/a', topic: 'ai' } }],
  })
  await loadWidgetFeedInputs(db, UID, 'ai')
  const paths = new Set(db.calls.map(call => call.path))
  assert.ok(paths.has(personalPath('ai')))
  assert.ok(paths.has(sharedPath('ai')))
  assert.ok(paths.has(interactionsPath))
  assert.equal(paths.size, 3)
})

test('topicがmobileならmobileのパスから読む', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [personalPath('mobile')]: [{ id: 'p1', data: { date: '2026-01-02' } }],
    [sharedPath('mobile')]: [{ id: 's1', data: { date: '2026-01-02' } }],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'mobile')
  assert.equal(input.topic, 'mobile')
  assert.deepEqual(input.personalDocs.map(d => d.id), ['p1'])
  assert.deepEqual(input.sharedDocs.map(d => d.id), ['s1'])
  assert.ok(db.calls.every(call => call.path !== personalPath('ai') && call.path !== sharedPath('ai')))
})

test('最新日は date 降順の先頭1件から得て、その日付の全件を取る', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [personalPath('ai')]: [
      { id: 'old', data: { date: '2026-01-01' } },
      { id: 'new-a', data: { date: '2026-01-03' } },
      { id: 'new-b', data: { date: '2026-01-03' } },
      { id: 'mid', data: { date: '2026-01-02' } },
    ],
    [sharedPath('ai')]: [
      { id: 's-old', data: { date: '2026-01-02' } },
      { id: 's-new', data: { date: '2026-01-04' } },
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  assert.equal(input.personalDate, '2026-01-03')
  assert.deepEqual(input.personalDocs.map(d => d.id).sort(), ['new-a', 'new-b'])
  assert.equal(input.sharedDate, '2026-01-04')
  assert.deepEqual(input.sharedDocs.map(d => d.id), ['s-new'])

  const latest = db.calls.filter(call => call.kind === 'latest')
  assert.equal(latest.length, 2)
  for (const call of latest) {
    assert.equal(call.field, 'date')
    assert.equal(call.direction, 'desc')
    assert.equal(call.count, 1)
  }
  const personalWhere = db.calls.find(call => call.kind === 'where' && call.path === personalPath('ai'))
  assert.deepEqual([personalWhere.field, personalWhere.op, personalWhere.value], ['date', '==', '2026-01-03'])
  const sharedWhere = db.calls.find(call => call.kind === 'where' && call.path === sharedPath('ai'))
  assert.deepEqual([sharedWhere.field, sharedWhere.op, sharedWhere.value], ['date', '==', '2026-01-04'])
})

test('記事のidは doc.id、データは doc.data() のスプレッド（idが後勝ちではなく {id, ...data} の順）', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [personalPath('ai')]: [{ id: 'doc-id-1', data: { date: '2026-01-02', title: '架空の記事', id: 'data-id' } }],
    [sharedPath('ai')]: [{ id: 'doc-id-2', data: { date: '2026-01-02', title: '共有の記事' } }],
    [interactionsPath]: [{ id: 'rec-1', data: { url: 'https://example.com/x', shownCount: 2 } }],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  assert.deepEqual(input.personalDocs, [{ id: 'data-id', date: '2026-01-02', title: '架空の記事' }])
  assert.deepEqual(input.sharedDocs, [{ id: 'doc-id-2', date: '2026-01-02', title: '共有の記事' }])
  assert.deepEqual(input.interactions, [{ id: 'rec-1', url: 'https://example.com/x', shownCount: 2 }])
})

test('データが無ければ日付は null、配列は空', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({})
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  assert.deepEqual(input, {
    topic: 'ai',
    personalDate: null,
    personalDocs: [],
    sharedDate: null,
    sharedDocs: [],
    interactions: [],
  })
  assert.ok(!db.calls.some(call => call.kind === 'where'), '最新日が無ければ日付指定の取得は行わない')
})

test('個別フィードだけ、共有だけ、のどちらでも片方は null と空配列', async () => {
  const { loadWidgetFeedInputs } = mod()
  const onlyShared = await loadWidgetFeedInputs(createDb({
    [sharedPath('ai')]: [{ id: 's1', data: { date: '2026-01-02' } }],
  }), UID, 'ai')
  assert.equal(onlyShared.personalDate, null)
  assert.deepEqual(onlyShared.personalDocs, [])
  assert.equal(onlyShared.sharedDate, '2026-01-02')

  const onlyPersonal = await loadWidgetFeedInputs(createDb({
    [personalPath('ai')]: [{ id: 'p1', data: { date: '2026-01-02' } }],
  }), UID, 'ai')
  assert.equal(onlyPersonal.sharedDate, null)
  assert.deepEqual(onlyPersonal.sharedDocs, [])
  assert.equal(onlyPersonal.personalDate, '2026-01-02')
})

test('読み込みは読み取りだけで、書き込み系のメソッドを呼ばない', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({ [personalPath('ai')]: [{ id: 'p1', data: { date: '2026-01-02' } }] })
  await loadWidgetFeedInputs(db, UID, 'ai')
  assert.ok(db.calls.every(call => ['latest', 'where', 'all'].includes(call.kind)))
})
