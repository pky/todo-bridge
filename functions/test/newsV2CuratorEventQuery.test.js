const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

// 読み込み時にFirestore参照を作る既存モジュール向けに、通信せずデモ用アプリだけを初期化する。
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })

const UID = 'fiction-curator'
const CUTOFF = new Date('2026-11-04T00:00:00.000Z')
const WINDOW_MS = 90 * 86400000

function millis(value) {
  if (value instanceof Date) return value.getTime()
  assert.equal(typeof value?.toMillis, 'function', '時刻条件はDateかTimestampを使う')
  return value.toMillis()
}

function fakeDb(rows = []) {
  const collections = []
  const conditions = []
  let reads = 0
  const query = {
    where(field, operator, value) { conditions.push([field, operator, value]); return this },
    async get() {
      reads += 1
      assert.equal(conditions.length, 3, '全履歴取得を避け、get前にtopicと両端の時刻条件を付ける')
      return { docs: rows.map(data => ({ data: () => data })) }
    },
  }
  return {
    db: { collection(path) { collections.push(path); return query } },
    collections, conditions, reads: () => reads,
  }
}

// 既存の管理者読み込み箇所と同じモジュールで、範囲条件付き取得を公開する。
function loader() {
  const mod = require('../lib/news/generatePersonalizedFeed')
  assert.equal(typeof mod.loadCuratorActionEvents, 'function', 'generatePersonalizedFeedにloadCuratorActionEventsを公開する')
  return mod.loadCuratorActionEvents
}

test('管理者のAIイベントだけをcutoff以前90日以内の条件で1回取得し、data配列を返す', async () => {
  const rows = [{ topic: 'ai', articleId: 'fiction-article', action: 'readLater', title: '架空の記事', receivedAt: CUTOFF }]
  const fake = fakeDb(rows)
  const result = await loader()(fake.db, UID, CUTOFF)
  assert.deepEqual(fake.collections, [`users/${UID}/newsActionEvents`])
  assert.equal(fake.reads(), 1)
  assert.deepEqual(fake.conditions.find(([field]) => field === 'topic'), ['topic', '==', 'ai'])
  const lower = fake.conditions.find(([field, operator]) => field === 'receivedAt' && operator === '>=')
  const upper = fake.conditions.find(([field, operator]) => field === 'receivedAt' && operator === '<=')
  assert.ok(lower, '90日前を含む下限条件が必要')
  assert.ok(upper, 'cutoffを含む上限条件が必要')
  assert.equal(millis(lower[2]), CUTOFF.getTime() - WINDOW_MS)
  assert.equal(millis(upper[2]), CUTOFF.getTime())
  assert.deepEqual(result, rows)
})

test('正常な0件は空配列として返す', async () => {
  const fake = fakeDb()
  assert.deepEqual(await loader()(fake.db, UID, CUTOFF), [])
  assert.equal(fake.reads(), 1)
})

test('取得失敗を正常な0件に変換せず呼び出し元へ返す', async () => {
  const failure = new Error('架空の取得障害')
  const query = { where() { return this }, async get() { throw failure } }
  const db = { collection() { return query } }
  await assert.rejects(() => loader()(db, UID, CUTOFF), error => error === failure)
})
