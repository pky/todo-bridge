const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

// 初回利用時に別々の記事を同時に送っても、同名の「あとで読む」リストが2つできないことを確かめる。
// 未実装のモジュールでファイル全体が落ちないよう、読み込み失敗は各テスト内の失敗として報告する。
let store = null
let loadError = null
try {
  store = require('../lib/news/widgetReadLaterStore')
} catch (error) {
  loadError = error
}
function mod() {
  if (!store) throw new Error(`widgetReadLaterStore が未実装です: ${loadError && loadError.message}`)
  return store
}

const UID = 'user-fictional-1'
const LIST_NAME = 'あとで読む'
const FIXED_LIST_ID = 'readlater_list'
const TS = { __serverTimestamp: true }
const ARTICLE = {
  id: 'article-1',
  title: '架空の記事',
  summary: '架空の概要です',
  url: 'https://example.com/fictional-article',
}

function conflict() {
  const error = new Error('already exists')
  error.code = 6
  return error
}

// collections: パス -> [{ id, data }]（テスト中に書き換えて、失敗後に見える状態を変えられる）。
// existing: すでに存在するドキュメントのパス。
// commitScript: commit の回数順に { error?, afterFail? } を並べる。error があればその commit は書き込まず reject する。
//   指定が無い commit は、create 先が既存なら {code: 6} で reject し、そうでなければ書き込む。
// commitOps: commit ごとの書き込み予定（失敗した commit も含む）。
function createDb({ collections = {}, existing = [], commitScript = [] } = {}) {
  const calls = []
  const writes = []
  const commitOps = []
  const existingPaths = new Set(existing)
  const snapshot = items => ({
    empty: items.length === 0,
    size: items.length,
    docs: items.map(item => ({ id: item.id, data: () => item.data })),
  })
  const db = {
    calls,
    writes,
    commitOps,
    collections,
    existingPaths,
    collection(path) {
      const items = () => collections[path] || []
      return {
        limit(count) {
          return {
            async get() {
              calls.push({ path, kind: 'limit', count })
              return snapshot(items().slice(0, count))
            },
          }
        },
        orderBy(field, direction) {
          return {
            limit(count) {
              return {
                async get() {
                  calls.push({ path, kind: 'latest', field, direction, count })
                  const sign = direction === 'desc' ? -1 : 1
                  const sorted = [...items()].sort((a, b) => sign * (Number(a.data[field]) - Number(b.data[field])))
                  return snapshot(sorted.slice(0, count))
                },
              }
            },
          }
        },
        where(field, op, value) {
          return {
            limit(count) {
              return {
                async get() {
                  calls.push({ path, kind: 'where', field, op, value, count })
                  const matched = items().filter(item => op === '==' && item.data[field] === value)
                  return snapshot(matched.slice(0, count))
                },
              }
            },
          }
        },
        async get() {
          calls.push({ path, kind: 'all' })
          return snapshot(items())
        },
        doc(id) { return db.doc(`${path}/${id}`) },
      }
    },
    doc(path) {
      return {
        path,
        id: path.split('/').pop(),
        async get() {
          calls.push({ path, kind: 'doc' })
          return { exists: existingPaths.has(path), id: path.split('/').pop() }
        },
      }
    },
    batch() {
      const pending = []
      const batch = {
        create(ref, data) { pending.push({ op: 'create', path: ref.path, data }); return batch },
        set(ref, data, options) { pending.push({ op: 'set', path: ref.path, data, options }); return batch },
        async commit() {
          const index = commitOps.length
          commitOps.push([...pending])
          const step = commitScript[index]
          if (step && step.error) {
            if (step.afterFail) step.afterFail(db)
            throw step.error
          }
          for (const write of pending) {
            if (write.op === 'create' && existingPaths.has(write.path)) {
              if (step && step.afterFail) step.afterFail(db)
              throw conflict()
            }
          }
          for (const write of pending) {
            writes.push(write)
            existingPaths.add(write.path)
          }
        },
      }
      return batch
    },
  }
  return db
}

function createDeps(dbOptions) {
  return { db: createDb(dbOptions), serverTimestamp: () => TS }
}

const withMembership = uid => ({ [`users/${uid}/memberships`]: [{ id: `personal_${uid}`, data: {} }] })
function basePath(uid, spaced) { return spaced ? `spaces/personal_${uid}` : `users/${uid}` }

function taskPathFor(base, topic, articleId) {
  const digest = createHash('sha256').update(`${topic}:${articleId}`).digest('hex')
  return `${base}/tasks/readlater_${digest.slice(0, 32)}`
}

async function add(deps, article = ARTICLE, topic = 'ai', uid = UID) {
  return mod().addReadLaterTask(deps, uid, topic, article)
}

function listOps(ops, base) { return ops.filter(w => w.path.startsWith(`${base}/lists/`)) }
function taskOps(ops, base) { return ops.filter(w => w.path.startsWith(`${base}/tasks/`)) }

// 1回目の失敗の後に、別のリクエストが作った「あとで読む」リストが検索に見えるようにする。
function revealExistingList(base) {
  return db => {
    db.collections[`${base}/lists`] = [{ id: FIXED_LIST_ID, data: { name: LIST_NAME, position: 1 } }]
  }
}

async function captureConsoleError(fn) {
  const original = console.error
  const logged = []
  console.error = (...args) => { logged.push(args) }
  let error = null
  try {
    await fn()
  } catch (e) {
    error = e
  } finally {
    console.error = original
  }
  const text = logged
    .map(args => args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a) ?? String(a))).join(' '))
    .join('\n')
  return { text, error }
}

for (const spaced of [false, true]) {
  const label = spaced ? 'memberships あり: spaces/personal_{uid}' : 'memberships 空: users/{uid}'
  test(`新しく作るリストの ID は固定値 readlater_list で、タスクの listId も同じ（${label}）`, async () => {
    const base = basePath(UID, spaced)
    const deps = createDeps({ collections: spaced ? withMembership(UID) : {} })
    assert.equal(await add(deps), 'created')
    const lists = listOps(deps.db.writes, base)
    assert.equal(lists.length, 1)
    assert.equal(lists[0].op, 'create')
    assert.equal(lists[0].path, `${base}/lists/${FIXED_LIST_ID}`)
    assert.ok(lists[0].path.endsWith('readlater_list'))
    const tasks = taskOps(deps.db.writes, base)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].data.listId, FIXED_LIST_ID)
  })
}

test('競合: 固定IDのリストが既にあって create が失敗しタスクが無ければ、1回だけやり直してリストを作らず created', async () => {
  const base = basePath(UID, false)
  const taskPath = taskPathFor(base, 'ai', ARTICLE.id)
  const deps = createDeps({
    existing: [`${base}/lists/${FIXED_LIST_ID}`],
    commitScript: [{ afterFail: revealExistingList(base) }],
  })
  assert.equal(await add(deps), 'created')
  const { db } = deps
  assert.equal(db.commitOps.length, 2, 'commit は計2回')

  const retry = db.commitOps[1]
  assert.equal(listOps(retry, base).length, 0, 'やり直しでリストを create してはいけない')
  assert.equal(retry.length, 2)
  const task = retry.find(w => w.path === taskPath)
  assert.ok(task, 'やり直しでタスクを書いていない')
  assert.equal(task.op, 'create')
  assert.equal(task.data.listId, FIXED_LIST_ID)
  const interaction = retry.find(w => w.path === `users/${UID}/newsInteractions/ai_${ARTICLE.id}`)
  assert.ok(interaction, 'やり直しで interaction を書いていない')
  assert.equal(interaction.op, 'set')

  const lookups = db.calls.filter(c => c.kind === 'where' && c.path === `${base}/lists`)
  assert.equal(lookups.length, 2, 'やり直しで名前検索をしていない')
  assert.deepEqual([lookups[1].field, lookups[1].op, lookups[1].value, lookups[1].count], ['name', '==', LIST_NAME, 1])
  assert.equal(taskOps(db.writes, base).length, 1)
  assert.equal(listOps(db.writes, base).length, 0)
})

test('タスクが既に存在して {code: 6} で reject されたら already を返し、再試行しない', async () => {
  const base = basePath(UID, false)
  const deps = createDeps({ existing: [taskPathFor(base, 'ai', ARTICLE.id)] })
  assert.equal(await add(deps), 'already')
  assert.equal(deps.db.commitOps.length, 1)
  assert.equal(deps.db.writes.length, 0)
})

test('やり直しの commit も {code: 6} で reject され、タスクが無いままなら、その例外を投げる（計2回）', async () => {
  const base = basePath(UID, false)
  const second = conflict()
  const deps = createDeps({
    commitScript: [
      { error: conflict(), afterFail: revealExistingList(base) },
      { error: second },
    ],
  })
  await assert.rejects(add(deps), error => error === second)
  assert.equal(deps.db.commitOps.length, 2)
  assert.equal(deps.db.writes.length, 0)
})

test('{code: 6} 以外の例外は再試行せずに投げ直す', async () => {
  const failure = Object.assign(new Error('unavailable'), { code: 14 })
  const deps = createDeps({ commitScript: [{ error: failure }] })
  await assert.rejects(add(deps), error => error === failure)
  assert.equal(deps.db.commitOps.length, 1)
})

test('「あとで読む」リストが既にあれば新しいリストを作らず、既存のIDを listId にする（commit は1回）', async () => {
  const base = basePath(UID, false)
  const deps = createDeps({
    collections: {
      [`${base}/lists`]: [{ id: 'list-existing', data: { name: LIST_NAME, position: 1 } }],
    },
  })
  assert.equal(await add(deps), 'created')
  assert.equal(deps.db.commitOps.length, 1)
  assert.equal(listOps(deps.db.commitOps[0], base).length, 0)
  const tasks = taskOps(deps.db.writes, base)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].data.listId, 'list-existing')
})

test('競合の再現でも、ログに uid と記事の内容を出さない', async () => {
  const base = basePath(UID, false)
  const deps = createDeps({
    existing: [`${base}/lists/${FIXED_LIST_ID}`],
    commitScript: [{ afterFail: revealExistingList(base) }],
  })
  let result = null
  const { text, error } = await captureConsoleError(async () => { result = await add(deps) })
  assert.equal(error, null)
  assert.equal(result, 'created')
  assert.equal(deps.db.commitOps.length, 2, '競合が再現されていない')
  for (const secret of [UID, ARTICLE.id, ARTICLE.title, ARTICLE.summary, ARTICLE.url]) {
    assert.ok(!text.includes(secret), `ログに ${secret} が含まれている`)
  }
})
