const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const { AI_SUMMARY_VERSION, AI_TRIAGE_VERSION, AI_REUSE_MAX_AGE_MS, isAiFeedCandidate } = require('../lib/news/aiSelection')
const NOW = Date.now()
const USER_UID = 'fiction-user-a'
const CURATOR_UID = 'fiction-curator'
const preferences = {
  [USER_UID]: { keywords: [{ word: 'fictionusertoken', weight: 5 }] },
  [CURATOR_UID]: { keywords: [{ word: 'fictioncuratortoken', weight: 3 }] },
}

const article = (id, extra = {}) => ({
  id, title: `架空記事 fictioncuratortoken ${id}`, url: `https://example.invalid/${id}`,
  content: '架空の本文', description: '架空の説明', source: 'rss', sourceName: '架空通信',
  score: null, triageStatus: 'done', triageVersion: AI_TRIAGE_VERSION, triageDecision: 'include',
  developerValue: 'normal', importance: 'normal', ...extra,
})

function candidates() {
  // 各ソース枠の合計を20件より多くし、好みによって選定が分かれるようにする。
  const groups = [
    ['hn', 5, { source: 'hn' }],
    ['github', 4, { source: 'github' }],
    ['japanese', 8, { sourceName: 'Zenn 架空通信' }],
    ['rss', 6, {}],
  ]
  return [
    ...groups.flatMap(([name, count, extra]) => Array.from({ length: count }, (_, n) => article(`fiction-${name}-${n}`, extra))),
    article('user-only', { title: '架空記事 fictionusertoken 未要約' }),
    article('user-saved', {
      title: '架空記事 fictionusertoken 要約済み', titleJa: '架空の保存済み題名',
      summaryVersion: AI_SUMMARY_VERSION, summaryStatus: 'generated', summarySource: 'content',
      summarizedAt: NOW, summaryJa: '架空の保存済み概要',
    }),
  ]
}

async function generate(articles, { curatorUid } = {}) {
  const fitModule = require('../lib/news/v2/curatorPersonalFit')
  const calls = { summaryIds: [], saved: new Map() }
  const snapshot = rows => ({ empty: rows.length === 0, docs: rows.map(row => ({ id: row.id, data: () => ({ ...row }) })) })
  const ref = path => ({ path, get: async () => {
    const uid = path.split('/')[1]
    const value = path === `users/${uid}/newsPreferences/ai` ? preferences[uid] : undefined
    return { exists: value !== undefined, data: () => value }
  } })
  function collection(path, filters = []) {
    return {
      where: (...filter) => collection(path, [...filters, filter]),
      doc: id => ref(`${path}/${id}`),
      get: async () => {
        if (path === 'users') return snapshot([{ id: USER_UID }])
        if (path === 'topics/ai/articles') return snapshot(filters.some(([field]) => field === 'date') ? articles : [])
        return snapshot([])
      },
    }
  }
  const db = { collection, doc: ref, batch: () => ({
    update() {}, delete() {},
    set(doc, value) { calls.saved.set(doc.path, { ...value }) },
    commit: async () => {},
  }) }
  const replacements = [
    ['firebase-admin', { firestore: Object.assign(() => db, { Timestamp: admin.firestore.Timestamp, FieldValue: admin.firestore.FieldValue }) }],
    ['../lib/news/claudeClient', { ...require('../lib/news/claudeClient'), createClaudeMessagesClient: () => ({}) }],
    ['../lib/news/claudeDailyBudget', { createClaudeDailyRequestReservation: () => async () => true }],
    ['../lib/news/v2/curatorPersonalFit', {
      ...fitModule,
      getAiFitConfig: () => ({ model: 'fiction-fit', effort: 'low', dailyMaxRequests: 1 }),
      judgeCuratorPersonalFit: async () => ({ status: 'judged', fit: new Map(), judged: 0, missing: 0, requestCount: 0 }),
    }],
    ['../lib/news/aiClaudeSummary', {
      getAiSummaryConfig: () => ({ model: 'fiction-summary', effort: 'low', dailyMaxRequests: 10 }),
      summarizeAiArticles: async inputs => {
        calls.summaryIds.push(...inputs.map(input => input.id))
        return { requestCount: 1, pendingIds: [], results: new Map(inputs.map(input => [input.id, {
          id: input.id, include: true, titleJa: '架空の題名', summaryJa: '架空の概要',
        }])) }
      },
    }],
  ]
  const target = require.resolve('../lib/news/generatePersonalizedFeed')
  const original = require.cache[target]
  const originals = replacements.map(([name]) => [require.resolve(name), require.cache[require.resolve(name)]])
  try {
    for (const [name, exports] of replacements) {
      const key = require.resolve(name)
      require.cache[key] = { id: key, filename: key, loaded: true, exports }
    }
    delete require.cache[target]
    const result = await require(target).runGeneratePersonalizedFeed({ curatorUid, learningCutoffAt: new Date(NOW) })
    const feed = [...calls.saved.entries()]
      .filter(([path]) => path.startsWith(`users/${USER_UID}/newsFeed/ai/articles/`))
      .map(([, value]) => value)
    return { result, calls, feed }
  } finally {
    if (original) require.cache[target] = original
    else delete require.cache[target]
    for (const [key, value] of originals) {
      if (value) require.cache[key] = value
      else delete require.cache[key]
    }
  }
}

test('T1: キュレーター指定時だけ利用者固有の未要約記事を要約対象から除く', async () => {
  const rows = candidates()
  assert.ok(rows.filter(row => isAiFeedCandidate(row) && !row.summaryStatus).length > 20, '未要約の有効候補を20件より多く用意する')
  const withoutCurator = await generate(rows)
  assert.equal(withoutCurator.result.ok, true)
  assert.ok(withoutCurator.calls.summaryIds.includes('user-only'), 'キュレーター未指定では利用者の上位記事を要約する')
  assert.ok(withoutCurator.feed.some(row => row.id === 'user-only'), '利用者固有の記事が利用者の上位20件に入る')

  const withCurator = await generate(rows, { curatorUid: CURATOR_UID })
  assert.equal(withCurator.result.ok, true)
  const curatorIds = new Set(withCurator.result.curatorArticles.map(row => row.id))
  assert.equal(curatorIds.size, 20)
  assert.ok(!curatorIds.has('user-only'), '利用者固有の記事はキュレーター選定外である')
  assert.ok(withCurator.calls.summaryIds.length > 0, 'キュレーターが選んだ未要約記事の要約は行う')
  assert.ok(!withCurator.calls.summaryIds.includes('user-only'), 'キュレーター指定時は利用者固有の記事を要約しない')
  assert.ok(withCurator.calls.summaryIds.every(id => curatorIds.has(id)), '要約に渡る全記事がキュレーター選定に含まれる')
})

test('T2: キュレーター指定時のv1保存は選定外の既存要約を含み未要約記事を除く', async () => {
  const rows = candidates()
  const unsummarized = rows.find(row => row.id === 'user-only')
  assert.equal(unsummarized.summaryStatus, undefined, '利用者固有の記事は実行前に未要約である')
  const { result, calls, feed } = await generate(rows, { curatorUid: CURATOR_UID })
  assert.equal(result.ok, true)
  const curatorIds = new Set(result.curatorArticles.map(row => row.id))
  assert.ok(!curatorIds.has('user-saved'), '既存要約の記事はキュレーター選定外である')
  assert.ok(!curatorIds.has('user-only'), '未要約の記事もキュレーター選定外である')
  assert.ok(!calls.summaryIds.includes('user-saved'), '現行の既存要約を再生成しない')
  assert.equal(feed.length, 20, '表示可能な候補が十分あれば利用者の20件枠を満たす')
  for (const row of feed) {
    assert.equal(row.summaryStatus, 'generated', `${row.id}の要約が生成済みである`)
    assert.equal(row.summaryVersion, AI_SUMMARY_VERSION, `${row.id}の要約が現行版である`)
    assert.equal(typeof row.summarizedAt, 'number')
    assert.ok(Date.now() - row.summarizedAt <= AI_REUSE_MAX_AGE_MS, `${row.id}の要約が有効期限内である`)
    assert.ok(typeof row.summaryJa === 'string' && row.summaryJa.trim() !== '', `${row.id}の概要が空でない`)
  }
  assert.ok(feed.some(row => row.id === 'user-saved'), '利用者が好む選定外の既存要約記事をv1へ保存する')
  assert.ok(!feed.some(row => row.id === 'user-only'), 'キュレーター選定外の未要約記事をv1へ保存しない')
})
