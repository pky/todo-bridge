const test = require('node:test')
const assert = require('node:assert/strict')

// トランザクションを直列化し、別の予約関数でも同じ台帳を使う。
function memoryDb() {
  const documents = new Map()
  let queue = Promise.resolve()
  return {
    documents,
    doc: path => ({ path }),
    runTransaction(callback) {
      const operation = queue.then(() => callback({
        get: async ref => ({ exists: documents.has(ref.path), data: () => documents.get(ref.path) }),
        set: (ref, data, options) => documents.set(ref.path,
          options?.merge ? { ...documents.get(ref.path), ...data } : data),
        update: (ref, data) => documents.set(ref.path, { ...documents.get(ref.path), ...data }),
      }))
      queue = operation.catch(() => {})
      return operation
    },
  }
}

const reserve = (...args) => require('../lib/news/claudeDailyBudget').createClaudeDailyRequestReservation(...args)
const now = () => new Date('2026-10-28T00:00:00Z')

test('日次予約はJST日付の指定ドキュメントへ実送信予定数を保存する', async () => {
  const db = memoryDb()
  const take = reserve(db, 'ai-triage', 2, now)
  assert.equal(await take(), true)
  assert.equal(await take(), true)
  assert.equal(await take(), false)
  assert.equal(db.documents.get('newsApiUsage/ai-triage-2026-10-28').requestCount, 2)
})

test('同日の別インスタンスと並行予約でも日次上限を共有する', async () => {
  const db = memoryDb()
  const first = reserve(db, 'ai-summary', 3, now)
  const second = reserve(db, 'ai-summary', 3, now)
  const outcomes = await Promise.all([first(), second(), first(), second(), first(), second()])
  assert.equal(outcomes.filter(Boolean).length, 3)
  assert.equal(db.documents.get('newsApiUsage/ai-summary-2026-10-28').requestCount, 3)
})

test('ふるい分けと要約は日次予算を独立に持つ', async () => {
  const db = memoryDb()
  const triage = reserve(db, 'ai-triage', 1, now)
  const summary = reserve(db, 'ai-summary', 1, now)
  assert.equal(await triage(), true)
  assert.equal(await triage(), false)
  assert.equal(await summary(), true)
  assert.equal(await summary(), false)
})

test('同じ予約関数でもJST午前0時で翌日分へ切り替わる', async () => {
  const db = memoryDb()
  let date = new Date('2026-10-28T14:59:59Z')
  const take = reserve(db, 'ai-summary', 1, () => date)
  assert.equal(await take(), true)
  assert.equal(await take(), false)
  date = new Date('2026-10-28T15:00:00Z')
  assert.equal(await take(), true)
  assert.equal(await take(), false)
  assert.equal(db.documents.get('newsApiUsage/ai-summary-2026-10-28').requestCount, 1)
  assert.equal(db.documents.get('newsApiUsage/ai-summary-2026-10-29').requestCount, 1)
})

test('上限0はすべて拒否し台帳を増加させない', async () => {
  const db = memoryDb()
  const take = reserve(db, 'ai-triage', 0, now)
  assert.equal(await take(), false)
  const record = db.documents.get('newsApiUsage/ai-triage-2026-10-28')
  assert.equal(record?.requestCount ?? 0, 0)
})

test('DB失敗はfalseを返しエラー本文をログへ漏らさない', async t => {
  const logged = []
  for (const method of ['log', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => logged.push(args.map(String).join(' ')))
  }
  const db = {
    doc: path => ({ path }),
    runTransaction: async () => { throw new Error('機密を模した非公開エラー本文') },
  }
  assert.equal(await reserve(db, 'ai-summary', 1, now)(), false)
  assert.equal(logged.join('\n').includes('機密を模した非公開エラー本文'), false)
})
