const test = require('node:test')
const assert = require('node:assert/strict')

// AI ニュースの共有記事は feedEligible == true だけを問い合わせで読む。
// 最新日を決める1本目の問い合わせ、個別フィード、mobile の共有記事は変えない。

// 未ビルドでファイル全体が落ちないよう、読み込み失敗は各テスト内の失敗として報告する。
let loader = null
let feed = null
let loadError = null
try {
  loader = require('../lib/news/widgetNewsLoader')
  feed = require('../lib/news/widgetFeed')
} catch (error) {
  loadError = error
}
function mod() {
  if (!loader || !feed) throw new Error(`モジュールを読み込めません: ${loadError && loadError.message}`)
  return { ...loader, ...feed }
}

const UID = 'user-fictional-1'
const personalPath = topic => `users/${UID}/newsFeed/${topic}/articles`
const sharedPath = topic => `topics/${topic}/articles`
const interactionsPath = `users/${UID}/newsInteractions`
const url = name => `https://example.com/${name}`
const LATEST = '2026-02-02'
const OLDER = '2026-02-01'

// where は何回でも連結でき、実物と同じく == と in を結果に反映する。
// 問い合わせの形は calls に { path, kind: 'latest' | 'query' | 'getAll', wheres } として記録する。
function createDb(collections) {
  const calls = []
  const snapshot = items => ({
    empty: items.length === 0,
    docs: items.map(item => ({ id: item.id, exists: true, data: () => item.data })),
  })
  const matches = (item, wheres) => wheres.every(({ field, op, value }) => {
    if (op === '==') return item.data[field] === value
    if (op === 'in') return Array.isArray(value) && value.includes(item.data[field])
    return false
  })
  const builder = (path, wheres) => ({
    where(field, op, value) {
      return builder(path, [...wheres, { field, op, value }])
    },
    async get() {
      calls.push({ path, kind: 'query', wheres })
      return snapshot((collections[path] || []).filter(item => matches(item, wheres)))
    },
  })
  return {
    calls,
    collection(path) {
      const items = collections[path] || []
      return {
        ...builder(path, []),
        orderBy(field, direction) {
          return {
            limit(count) {
              return {
                async get() {
                  calls.push({ path, kind: 'latest', field, direction, count, wheres: [] })
                  const sorted = [...items].sort((a, b) => String(b.data[field]).localeCompare(String(a.data[field])))
                  return snapshot(sorted.slice(0, count))
                },
              }
            },
          }
        },
      }
    },
    doc(path) {
      const index = path.lastIndexOf('/')
      return { path, id: path.slice(index + 1), parentPath: path.slice(0, index) }
    },
    async getAll(...refs) {
      if (refs.length === 0) throw new Error('getAll には1件以上の参照が必要')
      calls.push({ path: refs[0].parentPath, kind: 'getAll', ids: refs.map(ref => ref.id), wheres: [] })
      return refs.map(ref => {
        const found = (collections[ref.parentPath] || []).find(item => item.id === ref.id)
        return found
          ? { id: ref.id, exists: true, data: () => found.data }
          : { id: ref.id, exists: false, data: () => undefined }
      })
    },
  }
}

const article = (id, date, extra = {}) => ({
  id,
  data: { date, title: `題名 ${id}`, summaryJa: '要約', url: url(id), ...extra },
})
const eligible = (id, sharedScore, date = LATEST, extra = {}) =>
  article(id, date, { feedEligible: true, sharedScore, ...extra })
const hasEligibleWhere = wheres =>
  wheres.some(w => w.field === 'feedEligible' && w.op === '==' && w.value === true)
const hasFeedEligibleField = wheres => wheres.some(w => w.field === 'feedEligible')
const callsOn = (db, path, kind) => db.calls.filter(call => call.path === path && call.kind === kind)
const idsOf = list => list.map(item => item.id).sort()

// 完了条件1: 共有記事の2本目の問い合わせに feedEligible == true が付く
test('topic が ai のとき、共有記事の date 指定の問い合わせに feedEligible == true を加える', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [sharedPath('ai')]: [eligible('e1', 10), article('x1', LATEST, { feedEligible: false, sharedScore: 99 })],
  })
  await loadWidgetFeedInputs(db, UID, 'ai')
  const dated = callsOn(db, sharedPath('ai'), 'query')
  assert.equal(dated.length, 1)
  assert.ok(dated[0].wheres.some(w => w.field === 'date' && w.op === '==' && w.value === LATEST),
    'date == 最新日 の条件が無い')
  assert.ok(hasEligibleWhere(dated[0].wheres), 'feedEligible == true の条件が付いていない')
})

// 完了条件2: 表示対象外の共有記事は読まれず、sharedDocs は表示対象のみ
test('topic が ai のとき、sharedDocs に表示対象外の共有記事が入らない', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [sharedPath('ai')]: [
      eligible('e1', 10),
      eligible('e2', 20),
      article('x-false', LATEST, { feedEligible: false, sharedScore: 99 }),
      article('x-none', LATEST, { sharedScore: 98 }),
      article('x-legacy', LATEST),
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  assert.deepEqual(idsOf(input.sharedDocs), ['e1', 'e2'])
})

// 完了条件3: 1本目は変えない
test('最新日を決める1本目の問い合わせ（orderBy date desc, limit 1）には条件を付けない', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({ [sharedPath('ai')]: [eligible('e1', 10)] })
  await loadWidgetFeedInputs(db, UID, 'ai')
  const latest = callsOn(db, sharedPath('ai'), 'latest')
  assert.equal(latest.length, 1)
  assert.equal(latest[0].field, 'date')
  assert.equal(latest[0].direction, 'desc')
  assert.equal(latest[0].count, 1)
  assert.deepEqual(latest[0].wheres, [])
})

// 完了条件4: 個別フィードと mobile 共有記事は変えない
test('個別フィードの問い合わせには feedEligible 条件を付けない', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [personalPath('ai')]: [article('p1', LATEST, { displayScore: 5 })],
    [sharedPath('ai')]: [eligible('e1', 10)],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  const personalCalls = db.calls.filter(call => call.path === personalPath('ai'))
  assert.ok(personalCalls.length > 0)
  for (const call of personalCalls) assert.equal(hasFeedEligibleField(call.wheres), false)
  assert.deepEqual(idsOf(input.personalDocs), ['p1'])
})

test('topic が mobile のとき、共有記事の問い合わせに feedEligible 条件を付けない', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [personalPath('mobile')]: [article('p1', LATEST)],
    [sharedPath('mobile')]: [
      article('m1', LATEST, { inScope: true, classificationStatus: 'done' }),
      article('m2', LATEST, { inScope: false, classificationStatus: 'done', feedEligible: false }),
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'mobile')
  const sharedCalls = db.calls.filter(call => call.path === sharedPath('mobile'))
  assert.ok(sharedCalls.length > 0)
  for (const call of sharedCalls) assert.equal(hasFeedEligibleField(call.wheres), false)
  assert.deepEqual(idsOf(input.sharedDocs), ['m1', 'm2'])
})

// 完了条件5: 最新日に表示対象が無ければ共有記事なし
test('最新日に feedEligible な記事が無ければ、古い日の表示対象へ広げず共有記事なしとして扱う', async () => {
  const { loadWidgetFeedInputs, selectWidgetFeed } = mod()
  const db = createDb({
    [sharedPath('ai')]: [
      article('x-latest', LATEST, { feedEligible: false, sharedScore: 50 }),
      eligible('e-old', 80, OLDER),
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  assert.deepEqual(input.sharedDocs, [])
  assert.deepEqual(input.interactions, [])
  const selected = selectWidgetFeed(input)
  assert.equal(selected.feedDate, null)
  assert.equal(selected.isSharedFallback, false)
  assert.deepEqual(selected.articles, [])
  // 2本目は最新日のまま読み、古い日に切り替えない。
  const dated = callsOn(db, sharedPath('ai'), 'query')
  assert.equal(dated.length, 1)
  assert.ok(dated[0].wheres.some(w => w.field === 'date' && w.value === LATEST))
})

// 完了条件6: 参照数で固定する
test('getAll の参照数は 2 × (個人 + 表示対象の共有記事のユニークID数) で、表示対象外の id と url は読み取りに現れない', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [personalPath('ai')]: [article('p1', LATEST, { displayScore: 5 }), article('p2', LATEST, { displayScore: 4 })],
    [sharedPath('ai')]: [
      eligible('e1', 10),
      eligible('e2', 20),
      eligible('p1', 30), // 個人フィードと同じ id（ユニークID数では1件）
      article('x-false', LATEST, { feedEligible: false, sharedScore: 99 }),
      article('x-none', LATEST, { sharedScore: 98 }),
      article('x-legacy', LATEST),
    ],
    [interactionsPath]: [
      { id: 'ai_e1', data: { topic: 'ai', shownCount: 1 } },
      { id: 'ai_x-false', data: { topic: 'ai', shownCount: 1 } },
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')

  const getAllCalls = callsOn(db, interactionsPath, 'getAll')
  const refIds = getAllCalls.flatMap(call => call.ids)
  const uniqueCandidates = ['p1', 'p2', 'e1', 'e2']
  assert.equal(refIds.length, 2 * uniqueCandidates.length, `getAll の参照数が違う: ${refIds.length}`)
  for (const id of uniqueCandidates) {
    assert.ok(refIds.includes(id), `裸の ${id} が無い`)
    assert.ok(refIds.includes(`ai_${id}`), `ai_${id} が無い`)
  }
  for (const id of ['x-false', 'x-none', 'x-legacy']) {
    assert.ok(!refIds.some(ref => ref.includes(id)), `表示対象外の ${id} が getAll の参照に現れた`)
  }

  const urlValues = callsOn(db, interactionsPath, 'query')
    .filter(call => call.wheres.some(w => w.field === 'url' && w.op === 'in'))
    .flatMap(call => call.wheres.filter(w => w.field === 'url').flatMap(w => w.value))
  assert.deepEqual([...urlValues].sort(), uniqueCandidates.map(url).sort())
  for (const id of ['x-false', 'x-none', 'x-legacy']) {
    assert.ok(!urlValues.includes(url(id)), `表示対象外の ${id} の url が in 検索に現れた`)
  }
  assert.deepEqual(idsOf(input.interactions), ['ai_e1'])
})

// 完了条件7: 既存の絞り込みと並べ替えは残る
test('summaryJa が空の共有記事は除き、sharedScore 降順で並べる（クエリは入力を狭めるだけ）', async () => {
  const { loadWidgetFeedInputs, selectWidgetFeed } = mod()
  const db = createDb({
    [sharedPath('ai')]: [
      eligible('low', 1),
      eligible('high', 30),
      eligible('empty-summary', 500, LATEST, { summaryJa: '' }),
      eligible('mid', 10),
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  const selected = selectWidgetFeed(input)
  assert.equal(selected.isSharedFallback, true)
  assert.deepEqual(selected.articles.map(a => a.id), ['high', 'mid', 'low'])
})
