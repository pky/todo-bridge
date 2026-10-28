const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

const DAY_MS = 24 * 60 * 60 * 1000
const jstDate = offsetDays => new Date(Date.now() + 9 * 60 * 60 * 1000 - offsetDays * DAY_MS).toISOString().slice(0, 10)

// 古い記事の整理だけを実行する。永続化先はメモリー上の Map で、削除は commit 時に反映する。
async function runCleanup(topic, documents) {
  const store = new Map(documents.map(document => [document.id, document]))
  const queries = []
  const commits = []
  function collection(name, filters = [], max = Infinity) {
    assert.equal(name, `topics/${topic}/articles`)
    return {
      where: (...filter) => collection(name, [...filters, filter], max),
      limit: count => collection(name, filters, count),
      get: async () => {
        queries.push({ filters, max })
        let found = [...store.values()]
        for (const [field, operator, value] of filters) {
          assert.equal(operator, '<', '想定外の検索条件')
          found = found.filter(document => document[field] < value)
        }
        found = found.slice(0, max)
        return {
          empty: found.length === 0,
          size: found.length,
          docs: found.map(document => ({ id: document.id, data: () => document, ref: { id: document.id } })),
        }
      },
    }
  }
  const db = {
    collection,
    batch: () => {
      const pending = []
      return {
        delete: ref => pending.push(ref.id),
        set: () => { throw new Error('整理では書き込まない') },
        commit: async () => {
          commits.push(pending.length)
          for (const id of pending) store.delete(id)
        },
      }
    },
  }
  const firestore = Object.assign(() => db, { Timestamp: admin.firestore.Timestamp })
  const target = require.resolve('../lib/news/collectArticles')
  const adminKey = require.resolve('firebase-admin')
  const originalTarget = require.cache[target]
  const originalAdmin = require.cache[adminKey]
  let cleanupOldArticles
  try {
    require.cache[adminKey] = { id: adminKey, filename: adminKey, loaded: true, exports: { firestore } }
    delete require.cache[target]
    cleanupOldArticles = require(target).cleanupOldArticles
    assert.equal(typeof cleanupOldArticles, 'function', 'cleanupOldArticles が export されていない')
    await cleanupOldArticles(topic)
  } finally {
    if (originalTarget) require.cache[target] = originalTarget
    else delete require.cache[target]
    if (originalAdmin) require.cache[adminKey] = originalAdmin
    else delete require.cache[adminKey]
  }
  return { store, queries, commits }
}

const documents = (prefix, count, date) => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index}`, date,
}))

test('cleanupOldArticles は500件ずつ取得して、14日より前の記事を残らず削除する', async () => {
  const old = documents('old', 1200, jstDate(30))
  const recent = [...documents('recent', 5, jstDate(0)), ...documents('edge', 3, jstDate(13))]
  const { store, queries, commits } = await runCleanup('ai', [...old, ...recent])
  assert.deepEqual([...store.keys()].sort(), recent.map(document => document.id).sort())
  assert.ok(commits.every(count => count <= 500), `1回の削除は500件以内: ${commits}`)
  assert.equal(commits.reduce((sum, count) => sum + count, 0), 1200)
  assert.ok(queries.every(query => query.max === 500), '取得は limit(500) で行う')
  assert.ok(queries.every(query => query.filters.length === 1 && query.filters[0][0] === 'date' && query.filters[0][1] === '<'))
})

test('cleanupOldArticles は古い記事がなければ何も削除しない', async () => {
  const recent = documents('recent', 10, jstDate(1))
  const { store, commits } = await runCleanup('ai', recent)
  assert.equal(store.size, 10)
  assert.deepEqual(commits, [])
})

test('cleanupOldArticles は1回20巡までで止め、1万件を超える分は次回に残す', async () => {
  const { store, queries, commits } = await runCleanup('ai', documents('old', 11000, jstDate(40)))
  assert.equal(store.size, 1000)
  assert.equal(queries.length, 20)
  assert.equal(commits.length, 20)
  assert.ok(commits.every(count => count === 500))
})
