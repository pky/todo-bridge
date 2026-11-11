const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

// 読み込み失敗や関数の未実装は各テスト内で報告する。
let store = null
let loadError = null
try {
  store = require('../lib/news/widgetReadLaterStore')
} catch (error) {
  loadError = error
}
function mod() {
  if (!store) throw new Error(`widgetReadLaterStore が未実装です: ${loadError && loadError.code}`)
  return store
}

const UID = 'user-fictional-1'
const TS = { __serverTimestamp: true }
const LIST_NAME = 'あとで読む'
const LIST_ID = 'readlater_list'
const ENTRY = {
  url: 'https://example.com/shared?source=fictional#section',
  title: '架空の共有タイトル',
  description: '架空の共有説明文',
}
const expectedId = url => `readlater_url_${createHash('sha256').update(`url:${url}`).digest('hex').slice(0, 32)}`
const basePath = spaced => spaced ? `spaces/personal_${UID}` : `users/${UID}`
const taskPath = (base, url = ENTRY.url) => `${base}/tasks/${expectedId(url)}`
const conflict = () => Object.assign(new Error('fictional-already-exists'), { code: 6 })

// 実装するFirestore APIは設計で指定された検索・参照・トランザクションだけ。
// 台本のbeforeCommitで別リクエストを反映し、retryなら未反映の書き込みを捨ててコールバックを再実行する。
// error/afterFailはトランザクションの失敗と、その後に検索へ現れる競合リストを表す。
function createDb({ documents = {}, transactionScript = [] } = {}) {
  const state = new Map(Object.entries(structuredClone(documents)))
  const script = [...transactionScript]
  const calls = []
  const writes = []
  const transactions = []
  const attempts = []
  const db = {
    state, calls, writes, transactions, attempts,
    collection(path) {
      calls.push({ kind: 'collection', path })
      const items = () => [...state.entries()]
        .filter(([key]) => key.slice(0, key.lastIndexOf('/')) === path)
        .map(([key, data]) => ({ id: key.split('/').pop(), data: () => structuredClone(data) }))
      const query = (kind, transform, details = {}) => ({
        limit(count) {
          return {
            async get() {
              calls.push({ kind, path, count, ...details })
              const docs = transform(items()).slice(0, count)
              return { empty: docs.length === 0, size: docs.length, docs }
            },
          }
        },
      })
      return {
        limit: count => query('limit', rows => rows).limit(count),
        where(field, op, value) {
          assert.equal(op, '==')
          return query('where', rows => rows.filter(row => row.data()[field] === value), { field, op, value })
        },
        orderBy(field, direction) {
          assert.equal(direction, 'desc')
          return query('latest', rows => rows.sort((a, b) => Number(b.data()[field]) - Number(a.data()[field])), { field, direction })
        },
      }
    },
    doc(path) {
      calls.push({ kind: 'doc', path })
      return { path, id: path.split('/').pop() }
    },
    async runTransaction(callback) {
      const transaction = []
      transactions.push(transaction)
      for (;;) {
        const step = script.shift() || {}
        const attempt = { reads: [], pending: [], committed: false }
        attempts.push(attempt)
        transaction.push(attempt)
        const tx = {
          async get(ref) {
            assert.equal(attempt.pending.length, 0, '読み取りは書き込みより先に行う')
            calls.push({ kind: 'tx.get', path: ref.path })
            attempt.reads.push(ref.path)
            const exists = state.has(ref.path)
            const data = structuredClone(state.get(ref.path))
            return { exists, data: () => structuredClone(data) }
          },
          create(ref, data) {
            attempt.pending.push({ op: 'create', path: ref.path, data: structuredClone(data) })
            return tx
          },
          set(ref, data, options) {
            assert.equal(options, undefined, '全体上書きなのでmergeオプションは使わない')
            attempt.pending.push({ op: 'set', path: ref.path, data: structuredClone(data) })
            return tx
          },
        }
        const result = await callback(tx)
        if (step.beforeCommit) await step.beforeCommit(db)
        if (step.retry) continue
        try {
          if (step.error) throw step.error
          // createの競合はcommit時に検出し、全書き込みを未反映のまま失敗させる。
          const paths = new Set(state.keys())
          for (const write of attempt.pending) {
            if (write.op === 'create' && paths.has(write.path)) throw conflict()
            paths.add(write.path)
          }
          for (const write of attempt.pending) {
            state.set(write.path, structuredClone(write.data))
            writes.push(write)
          }
          attempt.committed = true
          return result
        } catch (error) {
          if (step.afterFail) await step.afterFail(db)
          throw error
        }
      }
    },
  }
  return db
}

function createDeps({ spaced = false, documents = {}, transactionScript = [] } = {}) {
  return {
    db: createDb({
      documents: {
        ...(spaced ? { [`users/${UID}/memberships/personal_${UID}`]: {} } : {}),
        ...documents,
      },
      transactionScript,
    }),
    serverTimestamp: () => TS,
  }
}

async function add(deps, entry = ENTRY) {
  assert.equal(typeof mod().addReadLaterUrlTask, 'function', 'addReadLaterUrlTask が未実装です')
  return mod().addReadLaterUrlTask(deps, UID, entry)
}

function expectedTask(entry = ENTRY, listId = LIST_ID) {
  return {
    name: entry.title ?? entry.url,
    listId, parentId: null, priority: 4, tags: [], dueDate: null, startDate: null,
    repeat: null, notes: entry.description !== undefined ? [entry.description] : [],
    url: entry.url, completed: false, dateCompleted: null, deleted: false,
    spaceId: `personal_${UID}`, visibleToMemberIds: [UID], editableByMemberIds: [UID],
    allDay: false, addToCalendar: false, calendarEventId: null,
    dateCreated: TS, dateModified: TS,
  }
}

function expectedList(position = 1) {
  return {
    name: LIST_NAME, position, spaceId: `personal_${UID}`,
    visibleToMemberIds: [UID], editableByMemberIds: [UID],
    dateCreated: TS, dateModified: TS,
  }
}

function taskDocuments(db, base) {
  return [...db.state.entries()].filter(([path]) => path.startsWith(`${base}/tasks/`))
}

function assertOnlyOwnPaths(db, base) {
  for (const call of db.calls) {
    assert.ok(call.path === `users/${UID}/memberships` || call.path.startsWith(`${base}/`), '別ユーザーや別領域を参照している')
    assert.doesNotMatch(call.path, /newsInteractions|newsActionEvents|newsActionReceipts/)
  }
  for (const write of db.writes) {
    assert.ok(write.path.startsWith(`${base}/lists/`) || write.path.startsWith(`${base}/tasks/`))
  }
}

test('URLタスクIDはsha256の先頭32桁で決まり、aiとmobileの記事IDと重ならない', () => {
  assert.equal(typeof mod().readLaterUrlTaskId, 'function', 'readLaterUrlTaskId が未実装です')
  const id = mod().readLaterUrlTaskId(ENTRY.url)
  assert.equal(id, expectedId(ENTRY.url))
  assert.equal(mod().readLaterUrlTaskId(ENTRY.url), id)
  for (const topic of ['ai', 'mobile']) {
    assert.notEqual(id, mod().readLaterTaskId(topic, ENTRY.url))
  }
})

for (const spaced of [false, true]) {
  const base = basePath(spaced)
  const label = spaced ? 'membershipsあり' : 'membershipsなし'
  test(`${label}: 固定IDのリストと契約どおりのタスクを1トランザクションで作る`, async () => {
    const deps = createDeps({ spaced })
    assert.equal(await add(deps), 'created')
    assert.equal(deps.db.transactions.length, 1)
    assert.deepEqual(deps.db.attempts[0], {
      reads: [taskPath(base)],
      pending: [
        { op: 'create', path: `${base}/lists/${LIST_ID}`, data: expectedList() },
        { op: 'set', path: taskPath(base), data: expectedTask() },
      ],
      committed: true,
    })
    assert.deepEqual(taskDocuments(deps.db, base), [[taskPath(base), expectedTask()]])
    assert.deepEqual(deps.db.state.get(`${base}/lists/${LIST_ID}`), expectedList())
    assertOnlyOwnPaths(deps.db, base)
  })

  test(`${label}: 既存の同名リストを利用し、新リストを作らない`, async () => {
    const list = { name: LIST_NAME, position: 9 }
    const listPath = `${base}/lists/list-fictional-existing`
    const deps = createDeps({ spaced, documents: { [listPath]: list } })
    assert.equal(await add(deps), 'created')
    assert.deepEqual(deps.db.state.get(taskPath(base)), expectedTask(ENTRY, 'list-fictional-existing'))
    assert.deepEqual(deps.db.state.get(listPath), list)
    assert.deepEqual(deps.db.writes.map(write => write.path), [taskPath(base)])
    assertOnlyOwnPaths(deps.db, base)
  })

  test(`${label}: 同じURLの2回目はalreadyで文書を一切書き換えない`, async () => {
    const deps = createDeps({ spaced })
    assert.equal(await add(deps), 'created')
    const before = structuredClone([...deps.db.state])
    const writes = deps.db.writes.length
    assert.equal(await add(deps, { ...ENTRY, title: '更新しない題', description: '更新しない説明' }), 'already')
    assert.deepEqual([...deps.db.state], before)
    assert.equal(deps.db.writes.length, writes)
    assert.equal(taskDocuments(deps.db, base).length, 1)
    assert.deepEqual(deps.db.attempts[1].pending, [])
    assert.deepEqual(deps.db.attempts[1].reads, [taskPath(base)])
  })

  for (const flags of [{ deleted: true, completed: false }, { deleted: false, completed: true }, { deleted: true, completed: true }]) {
    for (const listExists of [false, true]) {
      test(`${label}: deleted=${flags.deleted}, completed=${flags.completed}, リスト有無=${listExists}の文書を全体上書きする`, async () => {
        const oldTask = {
          ...expectedTask(), ...flags, name: '以前の題', notes: ['以前の説明'],
          url: 'https://example.com/old-field', listId: 'list-fictional-old',
          dateCreated: { seconds: 1 }, dateModified: { seconds: 2 }, dateCompleted: { seconds: 3 },
          tags: ['old-tag'], obsoleteField: '残してはいけない値',
        }
        const listId = listExists ? 'list-fictional-current' : LIST_ID
        const deps = createDeps({
          spaced,
          documents: {
            [taskPath(base)]: oldTask,
            ...(listExists ? { [`${base}/lists/${listId}`]: expectedList(5) } : {}),
          },
        })
        assert.equal(await add(deps), 'created')
        assert.deepEqual(deps.db.state.get(taskPath(base)), expectedTask(ENTRY, listId))
        assert.equal(taskDocuments(deps.db, base).length, 1)
        assert.deepEqual(deps.db.state.get(`${base}/lists/${listId}`), expectedList(listExists ? 5 : 1))
        assert.deepEqual(deps.db.attempts[0].reads, [taskPath(base)])
        assert.deepEqual(deps.db.writes.map(write => write.op), listExists ? ['set'] : ['create', 'set'])
        assertOnlyOwnPaths(deps.db, base)
      })
    }
  }

  test(`${label}: 同じURLの同時2件はcreatedとalreadyになり、競合側のコールバックを再実行する`, async () => {
    let winner
    let deps
    deps = createDeps({
      spaced,
      transactionScript: [{
        async beforeCommit() { winner = await add(deps) },
        retry: true,
      }],
    })
    const loser = await add(deps)
    assert.deepEqual([winner, loser], ['created', 'already'])
    assert.equal(deps.db.transactions.length, 2)
    assert.equal(deps.db.transactions[0].length, 2)
    assert.deepEqual(deps.db.transactions[0][1].pending, [])
    assert.deepEqual(taskDocuments(deps.db, base), [[taskPath(base), expectedTask()]])
    assert.equal(deps.db.writes.length, 2, '競合側の未commitの書き込みが残っている')
    assertOnlyOwnPaths(deps.db, base)
  })

  test(`${label}: 別URLによるリストの同時作成はcode 6で失敗し、1回だけ再検索して成功する`, async () => {
    const other = { ...ENTRY, url: 'https://example.com/other-shared' }
    let winner
    let deps
    deps = createDeps({
      spaced,
      transactionScript: [{ async beforeCommit() { winner = await add(deps, other) } }],
    })
    assert.equal(await add(deps), 'created')
    assert.equal(winner, 'created')
    assert.equal(deps.db.transactions.length, 3)
    assert.equal(deps.db.attempts[0].committed, false)
    assert.deepEqual(deps.db.attempts[2].pending, [{ op: 'set', path: taskPath(base), data: expectedTask() }])
    assert.equal(deps.db.calls.filter(call => call.kind === 'where').length, 3)
    assert.equal(deps.db.calls.filter(call => call.kind === 'limit').length, 3, '保存先も再解決する')
    assert.equal(deps.db.writes.filter(write => write.op === 'create').length, 1)
    assert.deepEqual(deps.db.state.get(taskPath(base)), expectedTask())
    assert.deepEqual(deps.db.state.get(taskPath(base, other.url)), expectedTask(other))
    assertOnlyOwnPaths(deps.db, base)
  })
}

for (const [label, entry] of [
  ['両方なし', { url: ENTRY.url }],
  ['titleなし', { url: ENTRY.url, description: ENTRY.description }],
  ['descriptionなし', { url: ENTRY.url, title: ENTRY.title }],
]) {
  test(`${label}ならnameはtitleかURL、notesはdescriptionの有無に対応する`, async () => {
    const deps = createDeps()
    assert.equal(await add(deps, entry), 'created')
    assert.deepEqual(deps.db.state.get(taskPath(basePath(false))), expectedTask(entry))
  })
}

test('クエリだけが異なるURLは独立したIDのタスクになる', async () => {
  const other = { ...ENTRY, url: ENTRY.url.replace('source=fictional', 'source=another') }
  const deps = createDeps()
  assert.equal(await add(deps), 'created')
  assert.equal(await add(deps, other), 'created')
  assert.notEqual(expectedId(ENTRY.url), expectedId(other.url))
  assert.deepEqual(taskDocuments(deps.db, basePath(false)), [
    [taskPath(basePath(false)), expectedTask()],
    [taskPath(basePath(false), other.url), expectedTask(other)],
  ])
})

for (const [label, flags] of [['フラグ欠落', {}], ['厳密なtrue以外', { deleted: 'true', completed: 1 }]]) {
  test(`${label}の既存タスクはalreadyで、リストが無くても作らない`, async () => {
    const path = taskPath(basePath(false))
    const original = { name: '変更しないタスク', ...flags }
    const deps = createDeps({ documents: { [path]: original } })
    assert.equal(await add(deps), 'already')
    assert.deepEqual([...deps.db.state], [[path, original]])
    assert.deepEqual(deps.db.writes, [])
  })
}

for (const [label, position, expected] of [['数値', 7, 8], ['非数値', '7', 1]]) {
  test(`新リストのpositionは既存リストの最大値が${label}なら${expected}`, async () => {
    const base = basePath(false)
    const deps = createDeps({ documents: { [`${base}/lists/list-fictional-other`]: { name: '別のリスト', position } } })
    assert.equal(await add(deps), 'created')
    assert.deepEqual(deps.db.state.get(`${base}/lists/${LIST_ID}`), expectedList(expected))
    const lookup = deps.db.calls.find(call => call.kind === 'latest')
    assert.deepEqual(lookup, { kind: 'latest', path: `${base}/lists`, count: 1, field: 'position', direction: 'desc' })
  })
}

test('2回目もcode 6ならその例外を返し、3回目を試さず部分書き込みも残さない', async () => {
  const second = conflict()
  const deps = createDeps({ transactionScript: [{ error: conflict() }, { error: second }] })
  await assert.rejects(add(deps), error => error === second)
  assert.equal(deps.db.transactions.length, 2)
  assert.deepEqual(deps.db.writes, [])
  assert.equal(deps.db.state.size, 0)
})

test('code 6以外はその例外を投げ、再試行せず部分書き込みも残さない', async () => {
  const failure = Object.assign(new Error('fictional-unavailable'), { code: 14 })
  const deps = createDeps({ transactionScript: [{ error: failure }] })
  await assert.rejects(add(deps), error => error === failure)
  assert.equal(deps.db.transactions.length, 1)
  assert.deepEqual(deps.db.writes, [])
  assert.equal(deps.db.state.size, 0)
})

test('成功・already・失敗のログにUIDやURLやタイトルや説明文を出さない', async t => {
  const logged = []
  for (const level of ['error', 'warn', 'info', 'log', 'debug']) {
    t.mock.method(console, level, (...args) => { logged.push(args) })
  }
  const deps = createDeps()
  assert.equal(await add(deps), 'created')
  assert.equal(await add(deps), 'already')
  const failure = Object.assign(new Error('fictional-unavailable'), { code: 14 })
  await assert.rejects(add(createDeps({ transactionScript: [{ error: failure }] })), error => error === failure)
  const text = JSON.stringify(logged, (_key, value) => value instanceof Error ? value.message : value)
  for (const secret of [UID, ...Object.values(ENTRY)]) {
    assert.equal(text.includes(secret), false)
  }
})
