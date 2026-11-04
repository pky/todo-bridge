const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

// 読み込み時にFirestore参照を作る既存モジュール向けに、通信せずデモ用アプリだけを初期化する。
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })

const { addReadLaterTask, readLaterTaskId } = require('../lib/news/widgetReadLaterStore')
const { newsActionEventId } = require('../lib/news/v2/newsActionStore')
const { loadCuratorActionEvents } = require('../lib/news/generatePersonalizedFeed')
const { buildEventSignals, learnKeywordPreferences } = require('../lib/news/interactionLearning')

const UID = 'demo-user'
const TS = { __serverTimestamp: true }
const ALREADY_EXISTS = 6
const ARTICLE = {
  id: 'article-1',
  title: '架空の記事',
  summary: '架空の概要です',
  url: 'https://example.com/fictional-article',
  titleEn: 'Fictional Claude agents article',
  summaryJa: '架空の日本語要約です',
  tags: ['claude', 'agents'],
}

// state: パス -> データ。batch.create は既存パスなら {code: 6} で commit 全体を reject する（何も書かない）。
// set は merge 指定なら既存データに重ねる。
function createDb({ docs = {} } = {}) {
  const state = new Map(Object.entries(docs))
  const writes = []
  const empty = { empty: true, size: 0, docs: [] }
  const db = {
    state,
    writes,
    collection(path) {
      const rows = () => [...state.entries()]
        .filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
        .map(([key, data]) => ({ id: key.split('/').pop(), data }))
      const conditions = []
      const query = {
        where(field, op, value) { conditions.push({ field, op, value }); return query },
        orderBy() { return query },
        limit() { return query },
        async get() {
          if (path.endsWith('/newsActionEvents')) {
            const matched = rows().filter(({ data }) => conditions.every(({ field, op, value }) => {
              const actual = data[field]
              if (op === '==') return actual === value
              if (op === '>=') return actual >= value
              if (op === '<=') return actual <= value
              return false
            }))
            return { empty: matched.length === 0, size: matched.length, docs: matched.map(r => ({ id: r.id, data: () => r.data })) }
          }
          return empty
        },
      }
      return query
    },
    doc(path) {
      return {
        path,
        id: path.split('/').pop(),
        async get() {
          return { exists: state.has(path), id: path.split('/').pop(), data: () => state.get(path) }
        },
      }
    },
    batch() {
      const pending = []
      const batch = {
        create(ref, data) { pending.push({ op: 'create', path: ref.path, data }); return batch },
        set(ref, data, options) { pending.push({ op: 'set', path: ref.path, data, options }); return batch },
        async commit() {
          const seen = new Set(state.keys())
          for (const write of pending) {
            if (write.op === 'create' && seen.has(write.path)) {
              const error = new Error('already exists')
              error.code = ALREADY_EXISTS
              throw error
            }
            seen.add(write.path)
          }
          for (const write of pending) {
            writes.push(write)
            const merged = write.op === 'set' && write.options?.merge ? { ...(state.get(write.path) || {}), ...write.data } : write.data
            state.set(write.path, merged)
          }
        },
      }
      return batch
    },
  }
  return db
}

function createDeps(options, serverTimestamp = () => TS) {
  return { db: createDb(options), serverTimestamp }
}

const eventPath = (action = 'readLater', articleId = ARTICLE.id) =>
  `users/${UID}/newsActionEvents/${newsActionEventId(UID, 'ai', articleId, action)}`
const taskPath = (topic = 'ai') => `users/${UID}/tasks/${readLaterTaskId(topic, ARTICLE.id)}`
const interactionPath = (topic = 'ai') => `users/${UID}/newsInteractions/${topic}_${ARTICLE.id}`
const eventPaths = db => [...db.state.keys()].filter(path => path.includes('/newsActionEvents/'))

test('ai: created を返し、タスク・newsInteractions・学習イベントの3つを書く', async () => {
  const deps = createDeps()
  assert.equal(await addReadLaterTask(deps, UID, 'ai', ARTICLE), 'created')
  assert.ok(deps.db.state.has(taskPath()), 'タスクが書かれていない')
  assert.ok(deps.db.state.has(interactionPath()), 'newsInteractions が書かれていない')
  const event = deps.db.state.get(eventPath())
  assert.ok(event, 'newsActionEvents に readLater イベントが書かれていない')
  assert.deepEqual(event, {
    topic: 'ai',
    articleId: ARTICLE.id,
    action: 'readLater',
    receivedAt: TS,
    title: ARTICLE.title,
    summary: ARTICLE.summary,
    source: 'widget',
    url: ARTICLE.url,
    titleEn: ARTICLE.titleEn,
    tags: ARTICLE.tags,
  })
})

test('ai: url が null で titleEn と tags が無ければ、イベントに url・titleEn・tags のキーを含めない', async () => {
  const deps = createDeps()
  const article = { id: ARTICLE.id, title: ARTICLE.title, summary: ARTICLE.summary, url: null }
  assert.equal(await addReadLaterTask(deps, UID, 'ai', article), 'created')
  const event = deps.db.state.get(eventPath())
  assert.ok(event, 'newsActionEvents に readLater イベントが書かれていない')
  for (const key of ['url', 'titleEn', 'tags']) assert.ok(!(key in event), `${key} キーが含まれている`)
  assert.deepEqual(event, {
    topic: 'ai',
    articleId: ARTICLE.id,
    action: 'readLater',
    receivedAt: TS,
    title: ARTICLE.title,
    summary: ARTICLE.summary,
    source: 'widget',
  })
})

test('mobile: newsActionEvents には何も書かず、タスクと newsInteractions は書く', async () => {
  const deps = createDeps()
  assert.equal(await addReadLaterTask(deps, UID, 'mobile', ARTICLE), 'created')
  assert.ok(deps.db.state.has(taskPath('mobile')), 'タスクが書かれていない')
  assert.ok(deps.db.state.has(interactionPath('mobile')), 'newsInteractions が書かれていない')
  assert.deepEqual(eventPaths(deps.db), [])
})

test('同じ ID のイベントが先にあり、タスクが無いとき: created を返し、タスクを作り、既存イベントを変えない', async () => {
  const existing = {
    topic: 'ai',
    articleId: ARTICLE.id,
    action: 'readLater',
    receivedAt: new Date('2026-10-01T00:00:00.000Z'),
    title: '移行済みの題名',
    summary: '移行済みの概要',
    source: 'migration',
  }
  const snapshot = structuredClone(existing)
  const deps = createDeps({ docs: { [eventPath()]: existing } })
  assert.equal(await addReadLaterTask(deps, UID, 'ai', ARTICLE), 'created')
  assert.ok(deps.db.state.has(taskPath()), 'タスクが作られていない')
  assert.deepEqual(deps.db.state.get(eventPath()), snapshot, '既存イベントの中身が変わっている')
  assert.equal(eventPaths(deps.db).length, 1)
})

test('タスクがすでにあれば already を返す', async () => {
  const deps = createDeps({ docs: { [taskPath()]: { name: '既存タスク' } } })
  assert.equal(await addReadLaterTask(deps, UID, 'ai', ARTICLE), 'already')
})

test('書かれたイベントを AI 選別の学習側に通すと、その記事の語に readLater の正の重みが付く', async () => {
  const now = new Date('2026-11-04T00:00:00.000Z')
  const deps = createDeps({}, () => now)
  assert.equal(await addReadLaterTask(deps, UID, 'ai', ARTICLE), 'created')
  assert.ok(deps.db.state.has(eventPath()), 'newsActionEvents に readLater イベントが書かれていない')

  const cutoff = new Date(now.getTime() + 60 * 60 * 1000)
  const events = await loadCuratorActionEvents(deps.db, UID, cutoff)
  assert.equal(events.length, 1, '学習側の読み込みでイベントが取得できない')

  const signals = events.flatMap(buildEventSignals)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].kind, 'readLater')
  const learned = learnKeywordPreferences(signals, cutoff.getTime())
  for (const word of ['claude', 'agents', 'fictional']) {
    assert.ok(learned.positive.includes(word), `${word} に正の重みが付いていない`)
  }
  assert.deepEqual(learned.negative, [])
})
