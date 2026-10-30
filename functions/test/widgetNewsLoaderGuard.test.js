const test = require('node:test')
const assert = require('node:assert/strict')

// 未ビルドでファイル全体が落ちないよう、読み込み失敗は各テスト内の失敗として報告する。
let loader = null
let loadError = null
try {
  loader = require('../lib/news/widgetNewsLoader')
} catch (error) {
  loadError = error
}
function mod() {
  if (!loader) throw new Error(`モジュールを読み込めません: ${loadError && loadError.message}`)
  return loader
}

const UID = 'user-fictional-1'
const personalPath = topic => `users/${UID}/newsFeed/${topic}/articles`
const sharedPath = topic => `topics/${topic}/articles`
const interactionsPath = `users/${UID}/newsInteractions`
const url = (name) => `https://example.com/${name}`

// 本物の Firestore と同じく、db.doc はドキュメントパスでない（セグメント数が奇数）か
// 空のセグメントを含むパスで、同期的に例外を投げる。
function assertDocumentPath(path) {
  const segments = String(path).split('/')
  if (segments.some(segment => segment === '')) {
    throw new Error('Value for argument "documentPath" must point to a document, but contains an empty segment')
  }
  if (segments.length % 2 !== 0) {
    throw new Error('Value for argument "documentPath" must point to a document, but was a collection path')
  }
}

function createDb(collections) {
  const calls = []
  const snapshot = items => ({
    empty: items.length === 0,
    docs: items.map(item => ({ id: item.id, exists: true, data: () => item.data })),
  })
  return {
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
              return snapshot(items.filter(item => {
                if (op === '==') return item.data[field] === value
                if (op === 'in') return Array.isArray(value) && value.includes(item.data[field])
                return false
              }))
            },
          }
        },
        async get() {
          calls.push({ path, kind: 'all' })
          return snapshot(items)
        },
      }
    },
    doc(path) {
      assertDocumentPath(path)
      const index = path.lastIndexOf('/')
      return { path, id: path.slice(index + 1), parentPath: path.slice(0, index) }
    },
    async getAll(...refs) {
      if (refs.length === 0) throw new Error('getAll には1件以上の参照が必要')
      calls.push({
        path: refs[0].parentPath,
        kind: 'getAll',
        ids: refs.map(ref => ref.id),
        paths: refs.map(ref => ref.path),
      })
      return refs.map(ref => {
        const found = (collections[ref.parentPath] || []).find(item => item.id === ref.id)
        return found
          ? { id: ref.id, exists: true, data: () => found.data }
          : { id: ref.id, exists: false, data: () => undefined }
      })
    },
  }
}

const interactionCalls = db => db.calls.filter(call => call.path === interactionsPath)
const getAllCalls = db => db.calls.filter(call => call.kind === 'getAll')
const getAllPaths = db => getAllCalls(db).flatMap(call => call.paths)
const urlInCalls = db => interactionCalls(db).filter(call =>
  call.kind === 'where' && call.field === 'url' && call.op === 'in')
const sortedIds = interactions => interactions.map(item => item.id).sort()

// Firestore のドキュメント id が docId、データ側の id フィールドが dataId の記事。
function article(docId, dataId, extra = {}) {
  return { id: docId, data: { date: '2026-02-01', title: `題名 ${docId}`, summaryJa: '要約', id: dataId, ...extra } }
}
function normal(id, extra = {}) {
  return { id, data: { date: '2026-02-01', title: `題名 ${id}`, summaryJa: '要約', ...extra } }
}

// 2. id が 'a/b' でも API 全体が失敗しない
test("データ側の id が 'a/b' の個人記事があっても例外を投げず、共有記事 p2 の記録を取得する", async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [personalPath('ai')]: [article('doc-ab', 'a/b')],
    [sharedPath('ai')]: [normal('p2', { feedEligible: true })],
    [interactionsPath]: [
      { id: 'ai_p2', data: { topic: 'ai', shownCount: 1 } },
      { id: 'ai_a', data: { topic: 'ai', shownCount: 1 } },
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  assert.ok(sortedIds(input.interactions).includes('ai_p2'), 'ai_p2 の記録が含まれていない')
  const paths = getAllPaths(db)
  assert.ok(paths.length > 0, 'p2 の ID 取得が行われていない')
  assert.ok(paths.every(path => !path.includes('a/b')), "'a/b' に関する ID 取得が行われた")
  assert.ok(paths.includes(`${interactionsPath}/ai_p2`))
})

// 3. そのほかの不正な id
const invalidIds = [
  ['空文字', ''],
  ['数値', 123],
  ['null', null],
  ['undefined', undefined],
  ['オブジェクト', { nested: 'x' }],
]
for (const [label, badId] of invalidIds) {
  test(`データ側の id が ${label} の記事があっても例外を投げず、正常な記事の記録を取得する`, async () => {
    const { loadWidgetFeedInputs } = mod()
    const db = createDb({
      [personalPath('ai')]: [article('doc-bad', badId)],
      [sharedPath('ai')]: [normal('p2', { feedEligible: true })],
      [interactionsPath]: [{ id: 'ai_p2', data: { topic: 'ai', shownCount: 1 } }],
    })
    const input = await loadWidgetFeedInputs(db, UID, 'ai')
    assert.deepEqual(sortedIds(input.interactions), ['ai_p2'])
    assert.deepEqual(getAllPaths(db).sort(), [`${interactionsPath}/ai_p2`, `${interactionsPath}/p2`])
  })
}

// 4. 不正な id の記事でも url による取得には残る
test('不正な id の記事の url は where in の値に含まれ、url に一致する記録が返る', async () => {
  const { loadWidgetFeedInputs } = mod()
  const slash = url('slash')
  const empty = url('empty')
  const num = url('number')
  const db = createDb({
    [personalPath('ai')]: [
      article('doc-1', 'a/b', { url: slash }),
      article('doc-2', '', { url: empty }),
      article('doc-3', 123, { url: num }),
    ],
    [sharedPath('ai')]: [normal('p2', { feedEligible: true, url: url('p2') })],
    [interactionsPath]: [
      { id: 'rec-slash', data: { topic: 'ai', url: slash } },
      { id: 'rec-empty', data: { topic: 'ai', url: empty } },
      { id: 'rec-number', data: { topic: 'ai', url: num } },
      { id: 'ai_p2', data: { topic: 'ai', shownCount: 1 } },
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  const values = urlInCalls(db).flatMap(call => call.value)
  for (const value of [slash, empty, num, url('p2')]) {
    assert.ok(values.includes(value), `url の取得に ${value} が含まれていない`)
  }
  assert.deepEqual(sortedIds(input.interactions), ['ai_p2', 'rec-empty', 'rec-number', 'rec-slash'])
})

// 5. 全部不正な id
test('候補が全部不正な id なら getAll を呼ばず、url があれば url による取得だけを行う', async () => {
  const { loadWidgetFeedInputs } = mod()
  const U1 = url('only-url')
  const db = createDb({
    [personalPath('ai')]: [article('doc-1', 'a/b', { url: U1 }), article('doc-2', '')],
    [sharedPath('ai')]: [article('doc-3', null), article('doc-4', 123)],
    [interactionsPath]: [{ id: 'rec-1', data: { topic: 'ai', url: U1 } }],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  assert.deepEqual(getAllCalls(db), [], 'getAll が呼ばれた')
  assert.deepEqual(urlInCalls(db).flatMap(call => call.value), [U1])
  assert.deepEqual(sortedIds(input.interactions), ['rec-1'])
})

test('候補が全部不正な id で url も無ければ、getAll も url による取得も行わず interactions は空', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [personalPath('ai')]: [article('doc-1', 'a/b'), article('doc-2', '')],
    [interactionsPath]: [{ id: 'ai_x', data: { topic: 'ai' } }],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  assert.deepEqual(getAllCalls(db), [], 'getAll が呼ばれた')
  assert.deepEqual(urlInCalls(db), [], 'url による取得が呼ばれた')
  assert.deepEqual(input.interactions, [])
})

// 6. 通常の場合は変わらない
test('正常な id だけのとき、refs は topic_id と裸の id の両方で、記録を返す', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [personalPath('mobile')]: [normal('p1', { url: url('p1') })],
    [sharedPath('mobile')]: [normal('s1', { feedEligible: true })],
    [interactionsPath]: [
      { id: 'mobile_p1', data: { topic: 'mobile', shownCount: 1 } },
      { id: 's1', data: { shownCount: 1 } },
      { id: 'mobile_zz', data: { topic: 'mobile' } },
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'mobile')
  assert.deepEqual(getAllPaths(db).sort(), [
    `${interactionsPath}/mobile_p1`,
    `${interactionsPath}/mobile_s1`,
    `${interactionsPath}/p1`,
    `${interactionsPath}/s1`,
  ])
  assert.deepEqual(sortedIds(input.interactions), ['mobile_p1', 's1'])
})
