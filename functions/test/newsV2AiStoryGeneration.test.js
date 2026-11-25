const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })

function article(id, developerValue, summarizedAt) {
  return {
    id, title: `架空の更新 ${id}`, url: `https://example.test/${id}`, source: 'rss', sourceName: '架空通信',
    triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', developerValue, importance: 'normal',
    summaryVersion: 'ai-v2', summaryStatus: 'generated', summarizedAt, summaryJa: '架空の概要',
  }
}

test('話題のグルーピングで通信が失敗しても公開用フィードを生成し、個人フィードを保存する', async t => {
  const now = Date.now()
  const articles = [article('normal', 'normal', now), article('high', 'high', now)]
  const uid = 'fictional-curator'
  const feedPath = `users/${uid}/newsFeed/ai/articles`
  const saved = []
  const stages = []
  const ref = path => ({ path, get: async () => ({ exists: false }) })
  const snapshot = docs => ({ empty: docs.length === 0, docs })
  function collection(path, filters = []) {
    return {
      where: (...filter) => collection(path, [...filters, filter]),
      limit: () => collection(path, filters),
      doc: id => ref(`${path}/${id}`),
      get: async () => {
        if (path === 'users') return snapshot([{ id: uid }])
        if (path === 'topics/ai/articles' && filters.some(([field]) => field === 'date')) {
          return snapshot(articles.map(row => ({ id: row.id, data: () => row })))
        }
        return snapshot([])
      },
    }
  }
  const db = { collection, doc: ref, batch: () => ({
    update() {}, delete() {},
    set: (document, row) => { if (document.path.startsWith(`${feedPath}/`)) saved.push(row) },
    commit: async () => {},
  }) }
  const create = t.mock.fn(async () => { throw new Error('架空の話題判定通信エラー') })
  const log = t.mock.method(console, 'log', () => {})
  const warn = t.mock.method(console, 'warn', () => {})
  const claude = require('../lib/news/claudeClient')
  const replacements = [
    ['firebase-admin', { firestore: Object.assign(() => db, {
      Timestamp: admin.firestore.Timestamp, FieldValue: admin.firestore.FieldValue,
    }) }],
    ['../lib/news/claudeClient', { ...claude, createClaudeMessagesClient: () => ({ create }) }],
    ['../lib/news/claudeDailyBudget', { createClaudeDailyRequestReservation: (_db, stage) => async () => {
      stages.push(stage)
      return true
    } }],
  ]
  const target = require.resolve('../lib/news/generatePersonalizedFeed')
  const savedModules = [target, ...replacements.map(([name]) => require.resolve(name))]
    .map(path => [path, require.cache[path]])
  try {
    for (const [name, exports] of replacements) {
      const path = require.resolve(name)
      require.cache[path] = { id: path, filename: path, loaded: true, exports }
    }
    delete require.cache[target]
    const { runGeneratePersonalizedFeed } = require(target)
    const result = await runGeneratePersonalizedFeed({ curatorUid: uid, learningCutoffAt: new Date(now) })

    assert.equal(result.ok, true)
    assert.deepEqual(result.curatorArticles.map(item => item.id), ['high', 'normal'])
    assert.deepEqual(saved.map(item => item.id), ['high', 'normal'])
    assert.deepEqual(stages, ['ai-story'])
    assert.equal(create.mock.callCount(), 1)
    const logs = [...log.mock.calls, ...warn.mock.calls].map(call => call.arguments.join(' '))
    assert.ok(logs.some(line => line.includes('[generatePersonalizedFeed] storyGrouping status=error groups=0 requests=1')))
  } finally {
    for (const [path, previous] of savedModules) {
      if (previous) require.cache[path] = previous
      else delete require.cache[path]
    }
  }
})
