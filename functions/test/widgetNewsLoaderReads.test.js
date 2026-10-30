const test = require('node:test')
const assert = require('node:assert/strict')

// 未実装・未ビルドでファイル全体が落ちないよう、読み込み失敗は各テスト内の失敗として報告する。
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
const url = (name) => `https://example.com/${name}`

// collections: パス -> [{ id, data }]。newsInteractions に対する呼び出しを calls に、書き込みを writes に記録する。
function createDb(collections) {
  const calls = []
  const writes = []
  const snapshot = items => ({
    empty: items.length === 0,
    docs: items.map(item => ({ id: item.id, exists: true, data: () => item.data })),
  })
  const writer = (label) => (...args) => { writes.push({ label, args }); return Promise.resolve() }
  return {
    calls,
    writes,
    collection(path) {
      const items = collections[path] || []
      return {
        orderBy(field, direction) {
          return {
            limit(count) {
              return {
                async get() {
                  calls.push({ path, kind: 'latest', field, direction, count })
                  const sorted = [...items].sort((a, b) => String(b.data[field]).localeCompare(String(a.data[field])))
                  return snapshot(sorted.slice(0, count))
                },
              }
            },
            async get() {
              calls.push({ path, kind: 'orderBy', field, direction })
              return snapshot(items)
            },
          }
        },
        where(field, op, value) {
          return {
            async get() {
              calls.push({ path, kind: 'where', field, op, value })
              return snapshot(items.filter(item => {
                if (op === '==') return item.data[field] === value
                if (op === 'in') return Array.isArray(value) && value.includes(item.data[field])
                return false
              }))
            },
          }
        },
        async get() {
          calls.push({ path, kind: 'all' })
          return snapshot(items)
        },
        add: writer('collection.add'),
      }
    },
    doc(path) {
      const index = path.lastIndexOf('/')
      return {
        path,
        id: path.slice(index + 1),
        parentPath: path.slice(0, index),
        set: writer('doc.set'),
        update: writer('doc.update'),
        delete: writer('doc.delete'),
        create: writer('doc.create'),
      }
    },
    async getAll(...refs) {
      if (refs.length === 0) throw new Error('getAll には1件以上の参照が必要')
      calls.push({
        path: refs[0].parentPath,
        kind: 'getAll',
        ids: refs.map(ref => ref.id),
        paths: refs.map(ref => ref.path),
      })
      return refs.map(ref => {
        const found = (collections[ref.parentPath] || []).find(item => item.id === ref.id)
        return found
          ? { id: ref.id, exists: true, data: () => found.data }
          : { id: ref.id, exists: false, data: () => undefined }
      })
    },
    batch: writer('batch'),
    bulkWriter: writer('bulkWriter'),
    runTransaction: writer('runTransaction'),
  }
}

const interactionCalls = db => db.calls.filter(call => call.path === interactionsPath)
const getAllIds = db => interactionCalls(db).filter(call => call.kind === 'getAll').flatMap(call => call.ids)
const urlInCalls = db => interactionCalls(db).filter(call =>
  call.kind === 'where' && call.field === 'url' && call.op === 'in')
const sortedIds = interactions => interactions.map(item => item.id).sort()

function aiDoc(id, extra = {}) {
  return { id, data: { date: '2026-02-01', title: `題名 ${id}`, summaryJa: '要約', ...extra } }
}

// 1. 全件読みをしない
test('記録が1000件あっても newsInteractions の全件 get と orderBy だけの取得をしない', async () => {
  const { loadWidgetFeedInputs } = mod()
  const records = Array.from({ length: 1000 }, (_, i) => ({
    id: `ai_old${i}`,
    data: { topic: 'ai', url: url(`old/${i}`), shownCount: 1 },
  }))
  const db = createDb({
    [personalPath('ai')]: [aiDoc('p1', { url: url('p1') })],
    [sharedPath('ai')]: [aiDoc('s1', { url: url('s1'), feedEligible: true })],
    [interactionsPath]: records,
  })
  await loadWidgetFeedInputs(db, UID, 'ai')
  const bad = interactionCalls(db).filter(call => call.kind === 'all' || call.kind === 'orderBy')
  assert.deepEqual(bad, [], '記録の全件読みまたは orderBy だけの取得が呼ばれた')
  assert.ok(interactionCalls(db).length > 0, '関係する記録を読む呼び出しが無い')
})

// 2. 関係する記録だけを返す
test('今日の記事に関係する記録（ID一致・裸ID・url一致）だけを返し、無関係な記録は返さない', async () => {
  const { loadWidgetFeedInputs } = mod()
  const U1 = url('p1')
  const db = createDb({
    [personalPath('ai')]: [aiDoc('p1', { url: U1 })],
    [interactionsPath]: [
      { id: 'ai_p1', data: { topic: 'ai', shownCount: 1 } },
      { id: 'p1', data: { shownCount: 1 } },
      { id: 'other-id', data: { topic: 'ai', url: U1, shownCount: 2 } },
      { id: 'ai_zz', data: { topic: 'ai', url: url('zz'), dismissed: true } },
      { id: 'ai_q', data: { topic: 'ai' } },
      { id: 'rec-x', data: { url: url('x'), clickedAt: { seconds: 1 } } },
      { id: 'mobile_p1', data: { topic: 'mobile', shownCount: 1 } },
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  assert.deepEqual(sortedIds(input.interactions), ['ai_p1', 'other-id', 'p1'])
  const ids = getAllIds(db)
  assert.ok(ids.includes('ai_p1'), 'ai_p1 を getAll で取っていない')
  assert.ok(ids.includes('p1'), 'topic が ai のとき裸のidを getAll で取っていない')
})

test('topic が mobile のときも refs に mobile_p1 と裸の p1 の両方を含める', async () => {
  const { loadWidgetFeedInputs } = mod()
  const U1 = url('p1')
  const db = createDb({
    [personalPath('mobile')]: [{ id: 'p1', data: { date: '2026-02-01', title: '題名', url: U1 } }],
    [interactionsPath]: [
      { id: 'mobile_p1', data: { topic: 'mobile', shownCount: 1 } },
      { id: 'p1', data: { shownCount: 1 } },
      { id: 'ai_p1', data: { topic: 'ai', shownCount: 1 } },
      { id: 'url-only', data: { topic: 'mobile', url: U1, shownCount: 2 } },
      { id: 'mobile_zz', data: { topic: 'mobile', url: url('zz') } },
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'mobile')
  assert.deepEqual(getAllIds(db).sort(), ['mobile_p1', 'p1'], 'refs は mobile_p1 と裸の p1 のはず')
  for (const call of interactionCalls(db).filter(c => c.kind === 'getAll')) {
    for (const path of call.paths) assert.ok(path.startsWith(`${interactionsPath}/`))
  }
  assert.deepEqual(sortedIds(input.interactions), ['mobile_p1', 'p1', 'url-only'])
})

// 3. 読み取りの数が有界
test('無関係な記録が5000件あっても getAll の refs 数と where in の回数が候補記事数で抑えられる', async () => {
  const { loadWidgetFeedInputs } = mod()
  const personal = Array.from({ length: 10 }, (_, i) => aiDoc(`p${i}`, { url: url(`p/${i}`) }))
  const shared = Array.from({ length: 8 }, (_, i) => aiDoc(`s${i}`, { url: url(`s/${i}`), feedEligible: true }))
  const noise = Array.from({ length: 5000 }, (_, i) => ({
    id: `ai_noise${i}`,
    data: { topic: 'ai', url: url(`noise/${i}`), shownCount: 3, dismissed: true },
  }))
  const relevant = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `ai_p${i}`, data: { topic: 'ai', shownCount: 1 } })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `by-url-${i}`, data: { topic: 'ai', url: url(`s/${i}`) } })),
  ]
  const db = createDb({
    [personalPath('ai')]: personal,
    [sharedPath('ai')]: shared,
    [interactionsPath]: [...noise, ...relevant],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  const candidates = personal.length + shared.length
  const urlCount = candidates
  assert.deepEqual(interactionCalls(db).filter(c => c.kind === 'all' || c.kind === 'orderBy'), [])
  assert.ok(getAllIds(db).length >= 1, 'getAll が呼ばれていない')
  assert.ok(getAllIds(db).length <= candidates * 2, `refs が多すぎる: ${getAllIds(db).length}`)
  assert.ok(urlInCalls(db).length >= 1, 'where url in が呼ばれていない')
  assert.ok(urlInCalls(db).length <= Math.ceil(urlCount / 30))
  assert.deepEqual(sortedIds(input.interactions), [
    'ai_p0', 'ai_p1', 'ai_p2', 'ai_p3', 'ai_p4', 'ai_p5', 'by-url-0', 'by-url-1', 'by-url-2',
  ])
})

// 4. url が31個以上
test('urlが31個以上なら where in を30個以下ずつに分け、url の無い記事は値に含めない', async () => {
  const { loadWidgetFeedInputs } = mod()
  const personal = Array.from({ length: 70 }, (_, i) => aiDoc(`p${i}`, { url: url(`p/${i}`) }))
  const shared = [
    aiDoc('s-none', { feedEligible: true }),
    aiDoc('s-empty', { feedEligible: true, url: '' }),
    aiDoc('s-number', { feedEligible: true, url: 12345 }),
    aiDoc('s-null', { feedEligible: true, url: null }),
    aiDoc('s-dup', { feedEligible: true, url: url('p/0') }),
  ]
  const db = createDb({
    [personalPath('ai')]: personal,
    [sharedPath('ai')]: shared,
    [interactionsPath]: [{ id: 'by-url', data: { topic: 'ai', url: url('p/65') } }],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  const calls = urlInCalls(db)
  assert.ok(calls.length >= 3, `url in が分割されていない: ${calls.length} 回`)
  assert.ok(calls.length <= Math.ceil(70 / 30))
  for (const call of calls) {
    assert.ok(call.value.length >= 1 && call.value.length <= 30, `1回の値が範囲外: ${call.value.length}`)
  }
  const values = calls.flatMap(call => call.value)
  assert.equal(new Set(values).size, values.length, 'url の値に重複がある')
  assert.deepEqual([...values].sort(), personal.map(d => d.data.url).sort())
  assert.ok(values.every(value => typeof value === 'string' && value !== ''))
  assert.deepEqual(sortedIds(input.interactions), ['by-url'])
})

// 5. 候補が0件
test('候補の記事が0件なら newsInteractions を一切読まず interactions は空', async () => {
  const { loadWidgetFeedInputs } = mod()
  const db = createDb({
    [interactionsPath]: [
      { id: 'ai_p1', data: { topic: 'ai', url: url('p1') } },
      { id: 'p1', data: {} },
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  assert.deepEqual(input.interactions, [])
  assert.deepEqual(interactionCalls(db), [], 'newsInteractions への読み取りが呼ばれた')
  assert.ok(!db.calls.some(call => call.kind === 'getAll'))
})

// 6. 重複除去
test('同じ記録がID一致とurl一致の両方に当たっても interactions に重複がない', async () => {
  const { loadWidgetFeedInputs } = mod()
  const U1 = url('p1')
  const db = createDb({
    [personalPath('ai')]: [aiDoc('p1', { url: U1 })],
    [interactionsPath]: [
      { id: 'ai_p1', data: { topic: 'ai', url: U1, shownCount: 2 } },
      { id: 'p1', data: { url: U1, dismissed: true } },
    ],
  })
  const input = await loadWidgetFeedInputs(db, UID, 'ai')
  assert.ok(getAllIds(db).includes('ai_p1'), 'ID一致の経路が使われていない')
  assert.ok(urlInCalls(db).some(call => call.value.includes(U1)), 'url一致の経路が使われていない')
  assert.deepEqual(sortedIds(input.interactions), ['ai_p1', 'p1'])
  assert.deepEqual(input.interactions.find(item => item.id === 'ai_p1'),
    { id: 'ai_p1', topic: 'ai', url: U1, shownCount: 2 })
})

// 7. 同値性
function createRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildScenario(seed) {
  const rand = createRng(seed)
  const chance = p => rand() < p
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1))
  const pick = list => list[Math.floor(rand() * list.length)]
  const pool = Array.from({ length: 14 }, (_, i) => url(`s${seed}/n${i}`))

  const personalDate = pick(['2026-02-01', '2026-02-02'])
  const sharedDate = pick(['2026-02-01', '2026-02-02', '2026-02-03'])
  const makeArticle = (id, date) => {
    const millis = int(1, 1000)
    const data = {
      date,
      score: int(0, 50),
      sharedScore: int(0, 50),
      displayScore: int(0, 100),
      publishedAt: { toMillis: () => millis },
      feedEligible: chance(0.85),
      inScope: chance(0.85),
      classificationStatus: chance(0.85) ? 'done' : 'pending',
    }
    if (chance(0.9)) data.title = `題名 ${id}`
    data.summaryJa = chance(0.85) ? `要約 ${id}` : ''
    if (chance(0.15)) data.importantLevel = 'urgent'
    const urlKind = rand()
    if (urlKind < 0.8) data.url = pick(pool)
    else if (urlKind < 0.87) data.url = ''
    else if (urlKind < 0.93) data.url = 7
    return { id, data }
  }

  const personal = Array.from({ length: int(5, 15) }, (_, i) => makeArticle(`p${i}`, personalDate))
  const shared = Array.from({ length: int(5, 15) }, (_, i) =>
    makeArticle(chance(0.25) ? `p${i}` : `s${i}`, sharedDate))
  const olderDate = '2026-01-01'
  const older = Array.from({ length: 3 }, (_, i) => makeArticle(`old-art${i}`, olderDate))
  const today = [...personal, ...shared]
  const todayUrls = [...new Set(today.map(a => a.data.url).filter(u => typeof u === 'string' && u))]

  const flags = () => {
    const data = {}
    if (chance(0.6)) data.dismissed = chance(0.6)
    if (chance(0.7)) data.shownCount = int(0, 3)
    if (chance(0.2)) data.clickedAt = { seconds: int(1, 9) }
    return data
  }
  const unrelatedUrl = n => url(`s${seed}/unrelated${n}`)

  const records = []
  const used = new Set()
  const add = (id, data) => {
    if (used.has(id)) return
    used.add(id)
    records.push({ id, data })
  }
  const total = int(50, 300)
  for (let n = 0; records.length < total && n < total * 3; n++) {
    const roll = rand()
    if (roll < 0.3) {
      // 今日（または古い日）の記事のIDに一致する記録
      const article = pick(chance(0.9) ? today : older)
      const data = flags()
      if (chance(0.7)) data.articleId = article.id
      if (chance(0.5)) data.url = chance(0.6) && typeof article.data.url === 'string' ? article.data.url : unrelatedUrl(n)
      const form = rand()
      if (form < 0.4) {
        data.topic = pick(['ai', 'ai', undefined])
        if (data.topic === undefined) delete data.topic
        add(`ai_${article.id}`, data)
      } else if (form < 0.6) {
        data.topic = 'mobile'
        add(`mobile_${article.id}`, data)
      } else {
        // 旧形式の裸のid。topic は ai、mobile、無しのどれもあり得る
        const bareTopic = pick(['ai', 'mobile', undefined])
        if (bareTopic) data.topic = bareTopic
        add(article.id, data)
      }
    } else if (roll < 0.55 && todayUrls.length > 0) {
      // urlだけが今日の記事に一致する記録
      const data = { ...flags(), url: pick(todayUrls) }
      const topic = pick(['ai', 'mobile', undefined])
      if (topic) data.topic = topic
      if (chance(0.3)) data.articleId = pick(today).id
      add(`rec-${n}`, data)
    } else {
      // 無関係な記録。articleId は今日の記事に当たらない値にする
      const data = { ...flags() }
      if (chance(0.7)) data.url = unrelatedUrl(n)
      if (chance(0.5)) data.articleId = `gone-${n}`
      const topic = pick(['ai', 'mobile', undefined])
      if (topic) data.topic = topic
      add(chance(0.5) ? `ai_gone-${n}` : `gone-${n}`, data)
    }
  }
  return { personal: [...personal, ...older], shared: [...shared, ...older], records }
}

test('同値性: 全記録を渡した場合と新しい loadWidgetFeedInputs の入力で selectWidgetFeed の結果が一致する', async () => {
  const { loadWidgetFeedInputs, selectWidgetFeed } = mod()
  let nonEmpty = 0
  let interactionsMatter = 0
  let compared = 0
  for (let seed = 1; seed <= 40; seed++) {
    const scenario = buildScenario(seed * 7919)
    assert.ok(scenario.records.length >= 50 && scenario.records.length <= 300)
    for (const topic of ['ai', 'mobile']) {
      const db = createDb({
        [personalPath(topic)]: scenario.personal,
        [sharedPath(topic)]: scenario.shared,
        [interactionsPath]: scenario.records,
      })
      const loaded = await loadWidgetFeedInputs(db, UID, topic)
      const all = scenario.records.map(record => ({ id: record.id, ...record.data }))
      const full = selectWidgetFeed({ ...loaded, interactions: all })
      const narrow = selectWidgetFeed(loaded)
      const label = `seed=${seed} topic=${topic}`
      assert.equal(narrow.feedDate, full.feedDate, label)
      assert.equal(narrow.isSharedFallback, full.isSharedFallback, label)
      assert.deepEqual(narrow.articles.map(a => a.id), full.articles.map(a => a.id), label)
      compared++
      if (full.articles.length > 0) nonEmpty++
      const none = selectWidgetFeed({ ...loaded, interactions: [] })
      if (none.articles.map(a => a.id).join() !== full.articles.map(a => a.id).join()) interactionsMatter++
    }
  }
  assert.equal(compared, 80)
  // 比較が空振りしていないこと: 結果が空でないケースと、記録が結果を変えるケースが十分にある
  assert.ok(nonEmpty >= 40, `記事が出るケースが少ない: ${nonEmpty}`)
  assert.ok(interactionsMatter >= 20, `記録が結果に効くケースが少ない: ${interactionsMatter}`)
})

// 8. 読み取り専用、ログ
test('書き込み系を呼ばず、ログに uid・記事の内容・url を出さない', async () => {
  const { loadWidgetFeedInputs } = mod()
  const scenario = buildScenario(12345)
  const db = createDb({
    [personalPath('ai')]: scenario.personal,
    [sharedPath('ai')]: scenario.shared,
    [interactionsPath]: scenario.records,
  })
  const logged = []
  const names = ['error', 'log', 'warn', 'info', 'debug']
  const originals = names.map(name => console[name])
  names.forEach(name => { console[name] = (...args) => { logged.push(args) } })
  try {
    await loadWidgetFeedInputs(db, UID, 'ai')
  } finally {
    names.forEach((name, i) => { console[name] = originals[i] })
  }
  assert.deepEqual(db.writes, [], '書き込み系のメソッドが呼ばれた')
  const text = logged.map(args => args.map(arg => {
    try { return typeof arg === 'string' ? arg : JSON.stringify(arg) } catch { return String(arg) }
  }).join(' ')).join('\n')
  assert.ok(!text.includes(UID), 'ログに uid が出ている')
  assert.ok(!text.includes('https://'), 'ログに url が出ている')
  assert.ok(!text.includes('題名'), 'ログに記事の内容が出ている')
  assert.ok(!text.includes('要約'), 'ログに記事の内容が出ている')
})
