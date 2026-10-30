const test = require('node:test')
const assert = require('node:assert/strict')

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
const OTHER_UID = 'user-fictional-2'
const LIST_NAME = 'あとで読む'
const TS = { __serverTimestamp: true }
const ARTICLE = {
  id: 'article-1',
  title: '架空の記事',
  summary: '架空の概要です',
  url: 'https://example.com/fictional-article',
}

// collections: パス -> [{ id, data }]。existing: すでに存在するドキュメントのパス。
// 書き込みは batch.commit まで writes に積み、commit で create 先が既存なら {code: 6} で reject する。
function createDb({ collections = {}, existing = [], commitError = null } = {}) {
  const calls = []
  const writes = []
  const commits = []
  const existingPaths = new Set(existing)
  const snapshot = items => ({
    empty: items.length === 0,
    size: items.length,
    docs: items.map(item => ({ id: item.id, data: () => item.data })),
  })
  const db = {
    calls,
    writes,
    commits,
    collection(path) {
      const items = collections[path] || []
      return {
        limit(count) {
          return {
            async get() {
              calls.push({ path, kind: 'limit', count })
              return snapshot(items.slice(0, count))
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
                  const sorted = [...items].sort((a, b) => sign * (Number(a.data[field]) - Number(b.data[field])))
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
                  const matched = items.filter(item => op === '==' && item.data[field] === value)
                  return snapshot(matched.slice(0, count))
                },
              }
            },
          }
        },
        async get() {
          calls.push({ path, kind: 'all' })
          return snapshot(items)
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
          commits.push(pending.length)
          if (commitError) throw commitError
          for (const write of pending) {
            if (write.op === 'create' && existingPaths.has(write.path)) {
              const error = new Error('already exists')
              error.code = 6
              throw error
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
  const db = createDb(dbOptions)
  return { db, serverTimestamp: () => TS }
}

const memberships = uid => `users/${uid}/memberships`
const withMembership = uid => ({ [memberships(uid)]: [{ id: `personal_${uid}`, data: {} }] })

function basePath(uid, spaced) { return spaced ? `spaces/personal_${uid}` : `users/${uid}` }

async function add(deps, article = ARTICLE, topic = 'ai', uid = UID) {
  return mod().addReadLaterTask(deps, uid, topic, article)
}

function writesAt(db, path) { return db.writes.filter(w => w.path === path) }
function taskWrites(db, base) {
  return db.writes.filter(w => w.path.startsWith(`${base}/tasks/`))
}
function firstTaskPath(db) {
  const tasks = taskWrites(db, basePath(UID, false))
  assert.equal(tasks.length, 1, 'タスクが作成されていない')
  return tasks[0].path
}
function listWrites(db, base) {
  return db.writes.filter(w => w.path.startsWith(`${base}/lists/`))
}

async function withSilencedConsole(fn) {
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
  const text = logged.map(args => args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a) ?? String(a))).join(' ')).join('\n')
  return { text, error }
}

test('memberships が空なら users/{uid} 配下の lists と tasks に書く', async () => {
  const deps = createDeps()
  assert.equal(await add(deps), 'created')
  const base = basePath(UID, false)
  assert.equal(listWrites(deps.db, base).length, 1)
  assert.equal(taskWrites(deps.db, base).length, 1)
  assert.ok(!deps.db.writes.some(w => w.path.startsWith('spaces/')))
})

test('memberships があれば spaces/personal_{uid} 配下の lists と tasks に書く', async () => {
  const deps = createDeps({ collections: withMembership(UID) })
  assert.equal(await add(deps), 'created')
  const base = basePath(UID, true)
  assert.equal(listWrites(deps.db, base).length, 1)
  assert.equal(taskWrites(deps.db, base).length, 1)
  assert.ok(!deps.db.writes.some(w => w.path.startsWith(`users/${UID}/lists/`) || w.path.startsWith(`users/${UID}/tasks/`)))
})

test('「あとで読む」リストが既にあれば新しいリストを作らず、そのIDをタスクの listId にする', async () => {
  const base = basePath(UID, false)
  const deps = createDeps({
    collections: {
      [`${base}/lists`]: [
        { id: 'list-other', data: { name: 'Inbox', position: 1 } },
        { id: 'list-readlater', data: { name: LIST_NAME, position: 2 } },
      ],
    },
  })
  assert.equal(await add(deps), 'created')
  assert.equal(listWrites(deps.db, base).length, 0)
  const lookup = deps.db.calls.find(c => c.kind === 'where' && c.path === `${base}/lists`)
  assert.ok(lookup, 'lists を name で検索していない')
  assert.deepEqual([lookup.field, lookup.op, lookup.value, lookup.count], ['name', '==', LIST_NAME, 1])
  const tasks = taskWrites(deps.db, base)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].data.listId, 'list-readlater')
})

test('リストが無ければ同じバッチで作る（position は最大+1、メンバーは自分だけ）', async () => {
  const base = basePath(UID, false)
  const deps = createDeps({
    collections: {
      [`${base}/lists`]: [
        { id: 'l1', data: { name: 'Inbox', position: 3 } },
        { id: 'l2', data: { name: 'Work', position: 7 } },
      ],
    },
  })
  assert.equal(await add(deps), 'created')
  const lists = listWrites(deps.db, base)
  assert.equal(lists.length, 1)
  assert.deepEqual(lists[0].data, {
    name: LIST_NAME,
    position: 8,
    spaceId: `personal_${UID}`,
    visibleToMemberIds: [UID],
    editableByMemberIds: [UID],
    dateCreated: TS,
    dateModified: TS,
  })
  const order = deps.db.calls.find(c => c.kind === 'latest' && c.path === `${base}/lists`)
  assert.ok(order, 'position の最大値を orderBy で取っていない')
  assert.deepEqual([order.field, order.direction, order.count], ['position', 'desc', 1])
  const newListId = lists[0].path.split('/').pop()
  assert.equal(taskWrites(deps.db, base).length, 1)
  assert.equal(taskWrites(deps.db, base)[0].data.listId, newListId)
})

test('既存リストが無ければ position は 1', async () => {
  const deps = createDeps()
  await add(deps)
  const lists = listWrites(deps.db, basePath(UID, false))
  assert.equal(lists.length, 1)
  assert.equal(lists[0].data.position, 1)
})

test('タスクは Web の createTask と同じ形（記事のタイトル・概要・URL）', async () => {
  const deps = createDeps()
  await add(deps)
  const base = basePath(UID, false)
  const lists = listWrites(deps.db, base)
  const tasks = taskWrites(deps.db, base)
  assert.equal(tasks.length, 1)
  assert.equal(lists.length, 1)
  assert.equal(tasks[0].op, 'create')
  assert.deepEqual(tasks[0].data, {
    name: ARTICLE.title,
    listId: lists[0].path.split('/').pop(),
    parentId: null,
    priority: 4,
    tags: ['ai-news'],
    dueDate: null,
    startDate: null,
    repeat: null,
    notes: [ARTICLE.summary],
    url: ARTICLE.url,
    completed: false,
    dateCompleted: null,
    deleted: false,
    spaceId: `personal_${UID}`,
    visibleToMemberIds: [UID],
    editableByMemberIds: [UID],
    allDay: false,
    addToCalendar: false,
    calendarEventId: null,
    dateCreated: TS,
    dateModified: TS,
  })
})

test('記事に url が無ければタスクの url は null', async () => {
  const deps = createDeps()
  await add(deps, { ...ARTICLE, url: null })
  const tasks = taskWrites(deps.db, basePath(UID, false))
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].data.url, null)
})

test('spaces 保存でもタスクの形は同じで spaceId は personal_{uid}', async () => {
  const deps = createDeps({ collections: withMembership(UID) })
  await add(deps)
  const tasks = taskWrites(deps.db, basePath(UID, true))
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].data.spaceId, `personal_${UID}`)
  assert.deepEqual(tasks[0].data.visibleToMemberIds, [UID])
  assert.deepEqual(tasks[0].data.editableByMemberIds, [UID])
  assert.equal(tasks[0].data.name, ARTICLE.title)
  assert.deepEqual(tasks[0].data.tags, ['ai-news'])
})

test('タスクのドキュメントIDは topic と記事IDから決まる固定値（readlater_ + 32桁の16進）', async () => {
  async function taskId(topic, articleId, uid = UID) {
    const deps = createDeps()
    await add(deps, { ...ARTICLE, id: articleId }, topic, uid)
    const tasks = taskWrites(deps.db, basePath(uid, false))
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].op, 'create')
    return tasks[0].path.split('/').pop()
  }
  const first = await taskId('ai', 'article-1')
  const again = await taskId('ai', 'article-1')
  const otherTopic = await taskId('mobile', 'article-1')
  const otherArticle = await taskId('ai', 'article-2')
  assert.match(first, /^readlater_[0-9a-f]{32}$/)
  assert.equal(first, again)
  assert.notEqual(first, otherTopic)
  assert.notEqual(first, otherArticle)
})

test('同じバッチで newsInteractions/{topic}_{articleId} に dismissed を set({merge:true}) する', async () => {
  const deps = createDeps()
  await add(deps, ARTICLE, 'mobile')
  const writes = writesAt(deps.db, `users/${UID}/newsInteractions/mobile_${ARTICLE.id}`)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].op, 'set')
  assert.deepEqual(writes[0].options, { merge: true })
  assert.deepEqual(writes[0].data, {
    topic: 'mobile',
    articleId: ARTICLE.id,
    dismissed: true,
    dismissedAt: TS,
    url: ARTICLE.url,
  })
})

test('spaces 保存でも newsInteractions は users/{uid} 配下に書く', async () => {
  const deps = createDeps({ collections: withMembership(UID) })
  await add(deps)
  assert.equal(writesAt(deps.db, `users/${UID}/newsInteractions/ai_${ARTICLE.id}`).length, 1)
})

test('url が null のときは newsInteractions に url キーを含めない', async () => {
  const deps = createDeps()
  await add(deps, { ...ARTICLE, url: null })
  const writes = writesAt(deps.db, `users/${UID}/newsInteractions/ai_${ARTICLE.id}`)
  assert.equal(writes.length, 1)
  assert.ok(!('url' in writes[0].data), 'url キーが含まれている')
  assert.deepEqual(writes[0].data, {
    topic: 'ai',
    articleId: ARTICLE.id,
    dismissed: true,
    dismissedAt: TS,
  })
})

test('リスト作成・タスク作成・interaction の set は1回の commit にまとまる', async () => {
  const deps = createDeps()
  await add(deps)
  assert.deepEqual(deps.db.commits, [3])
})

test('既存リストを使う場合も commit は1回（タスクと interaction の2書き込み）', async () => {
  const base = basePath(UID, false)
  const deps = createDeps({ collections: { [`${base}/lists`]: [{ id: 'list-readlater', data: { name: LIST_NAME, position: 1 } }] } })
  await add(deps)
  assert.deepEqual(deps.db.commits, [2])
})

test('commit が {code: 6} で reject したら already を返す', async () => {
  const first = createDeps()
  await add(first)
  const taskPath = firstTaskPath(first.db)

  const deps = createDeps({ existing: [taskPath] })
  assert.equal(await add(deps), 'already')
  assert.equal(deps.db.commits.length, 1)
})

test('commit が {code: 6} 以外で reject したら投げ直す', async () => {
  const failure = new Error('commit-failed-fictional')
  failure.code = 14
  const deps = createDeps({ commitError: failure })
  let silenced
  const result = await withSilencedConsole(async () => { await add(deps) })
  silenced = result
  assert.ok(silenced.error, '例外が投げ直されていない')
  assert.equal(silenced.error, failure)
})

test('isReadLaterAdded: タスクのドキュメントが存在すれば true、無ければ false', async () => {
  const first = createDeps()
  await add(first)
  const taskPath = firstTaskPath(first.db)

  const missing = createDeps()
  assert.equal(await mod().isReadLaterAdded(missing, UID, 'ai', ARTICLE.id), false)

  const present = createDeps({ existing: [taskPath] })
  assert.equal(await mod().isReadLaterAdded(present, UID, 'ai', ARTICLE.id), true)

  const otherTopic = createDeps({ existing: [taskPath] })
  assert.equal(await mod().isReadLaterAdded(otherTopic, UID, 'mobile', ARTICLE.id), false)
})

test('isReadLaterAdded: 保存先は addReadLaterTask と同じ規則（memberships があれば spaces 側を見る）', async () => {
  const first = createDeps()
  await add(first)
  const legacyPath = firstTaskPath(first.db)
  const spacePath = legacyPath.replace(`users/${UID}/`, `spaces/personal_${UID}/`)

  const inSpace = createDeps({ collections: withMembership(UID), existing: [spacePath] })
  assert.equal(await mod().isReadLaterAdded(inSpace, UID, 'ai', ARTICLE.id), true)

  const onlyLegacy = createDeps({ collections: withMembership(UID), existing: [legacyPath] })
  assert.equal(await mod().isReadLaterAdded(onlyLegacy, UID, 'ai', ARTICLE.id), false)
})

test('他のユーザーのパスには一切書かず、書き込みは自分のパスだけ', async () => {
  const deps = createDeps({
    collections: {
      ...withMembership(UID),
      [`spaces/personal_${OTHER_UID}/lists`]: [{ id: 'other-list', data: { name: LIST_NAME, position: 9 } }],
      [`users/${OTHER_UID}/lists`]: [{ id: 'other-list', data: { name: LIST_NAME, position: 9 } }],
    },
  })
  await add(deps)
  assert.ok(deps.db.writes.length > 0)
  for (const write of deps.db.writes) {
    assert.ok(!write.path.includes(OTHER_UID), `他ユーザーのパスに書いている: ${write.path}`)
    assert.ok(
      write.path.startsWith(`users/${UID}/`) || write.path.startsWith(`spaces/personal_${UID}/`),
      `想定外のパス: ${write.path}`,
    )
  }
  for (const call of deps.db.calls) {
    assert.ok(!call.path.includes(OTHER_UID), `他ユーザーのパスを読んでいる: ${call.path}`)
  }
})

test('失敗時の例外とログに uid・記事のタイトル・URL・概要を出さない', async () => {
  const failure = new Error('commit-failed-fictional')
  failure.code = 14
  const deps = createDeps({ commitError: failure })
  const { text, error } = await withSilencedConsole(async () => { await add(deps) })
  assert.ok(error, '例外が投げ直されていない')
  const surfaced = `${error.message}\n${text}`
  for (const secret of [UID, ARTICLE.title, ARTICLE.url, ARTICLE.summary]) {
    assert.ok(!surfaced.includes(secret), `例外またはログに含まれている: ${secret}`)
  }
})

test('already のときも成功時もログに uid・記事のタイトル・URL・概要を出さない', async () => {
  const first = createDeps()
  await add(first)
  const taskPath = firstTaskPath(first.db)

  const { text } = await withSilencedConsole(async () => {
    assert.equal(await add(createDeps()), 'created')
    assert.equal(await add(createDeps({ existing: [taskPath] })), 'already')
  })
  for (const secret of [UID, ARTICLE.title, ARTICLE.url, ARTICLE.summary]) {
    assert.ok(!text.includes(secret), `ログに含まれている: ${secret}`)
  }
})
