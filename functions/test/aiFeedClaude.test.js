const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const feed = require('../lib/news/generatePersonalizedFeed')
const { normalizeUrl, buildReusedAiArticle } = require('../lib/news/collectArticles')

const DAY_MS = 24 * 60 * 60 * 1000

function candidate(overrides = {}) {
  return {
    triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', category: 'llm_engineering',
    relevant: true, developerValue: 'normal', importance: 'normal', ...overrides,
  }
}

test('isEligibleAiFeedArticle は v2 で判定済みの include と hold を通す', () => {
  for (const triageDecision of ['include', 'hold']) {
    assert.equal(feed.isEligibleAiFeedArticle(candidate({ triageDecision })), true, triageDecision)
  }
  assert.equal(feed.isEligibleAiFeedArticle(candidate({ developerValue: 'high' })), true)
})

test('isEligibleAiFeedArticle は done と relevant だけでは通さない', () => {
  assert.equal(feed.isEligibleAiFeedArticle({ triageStatus: 'done', relevant: true }), false)
  assert.equal(feed.isEligibleAiFeedArticle({ triageStatus: 'done', relevant: true, developerValue: 'high' }), false)
  assert.equal(feed.isEligibleAiFeedArticle(candidate({ triageVersion: 'ai-v1' })), false)
  assert.equal(feed.isEligibleAiFeedArticle(candidate({ triageVersion: undefined })), false)
})

test('isEligibleAiFeedArticle は exclude・low・現行版の rejected を通さない', () => {
  assert.equal(feed.isEligibleAiFeedArticle(candidate({ triageDecision: 'exclude', relevant: false })), false)
  assert.equal(feed.isEligibleAiFeedArticle(candidate({ developerValue: 'low' })), false)
  assert.equal(feed.isEligibleAiFeedArticle(candidate({ summaryVersion: 'ai-v2', summaryStatus: 'rejected', summarizedAt: Date.now() })), false)
})

test('isEligibleAiFeedArticle は判定待ちを専用ソースでも汎用ソースでも通さない', () => {
  for (const generalSource of [false, undefined, true]) {
    assert.equal(feed.isEligibleAiFeedArticle({ triageStatus: 'pending', generalSource }), false)
  }
})

test('isEligibleAiFeedArticle は旧形式の記事を通さない', () => {
  assert.equal(feed.isEligibleAiFeedArticle({}), false)
  assert.equal(feed.isEligibleAiFeedArticle({ relevant: true, generalSource: false }), false)
})

test('collectSummaryCandidateArticles と shouldSkipGeminiForJapaneseArticle は export を残す', () => {
  assert.equal(typeof feed.collectSummaryCandidateArticles, 'function')
  assert.equal(typeof feed.shouldSkipGeminiForJapaneseArticle, 'function')
})

test('getImportanceMultiplier は high 1.3、normal 1.0、low 0.6、未設定 1.0', () => {
  for (const [importance, expected] of [['high', 1.3], ['normal', 1], ['low', 0.6], [undefined, 1]]) {
    assert.equal(feed.getImportanceMultiplier(importance), expected)
  }
})

test('AI_SUMMARY_DEADLINE_MS は 60000', () => {
  assert.equal(feed.AI_SUMMARY_DEADLINE_MS, 60000)
})

test('functions/src に geminiService と @google/generative-ai への参照がない', () => {
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) inspect(filename)
      else if (entry.name.endsWith('.ts')) {
        const source = fs.readFileSync(filename, 'utf8')
        assert.equal(source.includes('geminiService'), false, entry.name)
        assert.equal(source.includes('@google/generative-ai'), false, entry.name)
      }
    }
  }
  inspect(path.join(__dirname, '../src'))
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
  assert.equal(Object.hasOwn(pkg.dependencies, '@google/generative-ai'), false)
})

// 現行版（ai-v2）で判定済みの本文つき記事を既定値にする。
function article(id, overrides = {}) {
  const merged = {
    id, url: `https://example.com/${id}`, title: 'Fictional AI tool article',
    description: '架空の記事の説明です', content: '架空の本文です', source: 'rss', sourceName: 'AI Feed',
    topic: 'ai', score: null, tags: ['llm'], generalSource: false,
    triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', category: 'llm_engineering',
    relevant: true, developerValue: 'normal', importance: 'normal', ...overrides,
  }
  // 収集時に保存される正規化URL。明示しなければ url から求める。
  if (!('normalizedUrl' in overrides)) merged.normalizedUrl = normalizeUrl(merged.url)
  return merged
}
const confirmed = (id, overrides = {}) => article(id, {
  summaryVersion: 'ai-v2', summaryStatus: 'generated', summarySource: 'content', summarizedAt: Date.now() - DAY_MS,
  titleJa: '確認済みのタイトル', summaryJa: '確認済みの概要です', ...overrides,
})
const rejectedBefore = (id, overrides = {}) => article(id, {
  summaryVersion: 'ai-v2', summaryStatus: 'rejected', summarizedAt: Date.now() - DAY_MS, ...overrides,
})

// メモリー上の代替だけを渡し、Firestore と外部 API への接続を防ぐ。
// options.summary(input) は要約結果の指定: undefined なら include=true、'pending' なら未取得、{ include: false } なら不採用。
async function generate(articles, options = {}) {
  const {
    reusable = [], summary = () => undefined, users = ['reader-demo'], preferences = {}, interactions = {},
    onQuery = () => {},
  } = options
  const writes = []
  const summaryCalls = []
  const timestamp = Date.now()
  const snapshot = docs => ({ empty: docs.length === 0, docs })
  const document = data => ({ id: data.id, data: () => data, ref: { path: `topics/ai/articles/${data.id}` } })
  const matches = (data, filters) => filters.every(([field, operator, value]) => {
    if (field === 'date') return true
    if (operator === '==') return data[field] === value
    if (operator === 'in') return value.includes(data[field])
    return true
  })
  function reference(pathName) {
    return {
      path: pathName,
      get: async () => {
        const match = /^users\/([^/]+)\/newsPreferences\/ai$/.exec(pathName)
        const data = match && preferences[match[1]]
        return { exists: Boolean(data), data: () => data }
      },
      update: async value => { writes.push({ op: 'update', path: pathName, value }) },
      set: async (value, setOptions) => { writes.push({ op: 'set', path: pathName, value, options: setOptions }) },
    }
  }
  function collection(name, filters = [], max = Infinity) {
    return {
      where: (...filter) => collection(name, [...filters, filter], max),
      limit: count => collection(name, filters, count),
      doc: id => reference(`${name}/${id}`),
      get: async () => {
        if (name === 'users') return snapshot(users.map(id => ({ id })))
        const interactionMatch = /^users\/([^/]+)\/newsInteractions$/.exec(name)
        if (interactionMatch) {
          return snapshot((interactions[interactionMatch[1]] ?? []).map((data, index) => ({ id: data.articleId ?? `i-${index}`, data: () => data })))
        }
        if (name === 'topics/ai/articles') {
          onQuery(filters)
          const pool = filters.some(([field]) => field === 'date') ? articles : reusable
          return snapshot(pool.filter(data => matches(data, filters)).slice(0, max).map(document))
        }
        return snapshot([])
      },
    }
  }
  const db = {
    collection,
    doc: name => reference(name),
    batch: () => ({
      update: (ref, value) => { writes.push({ op: 'update', path: ref.path, value }) },
      delete: ref => { writes.push({ op: 'delete', path: ref.path }) },
      set: (ref, value, setOptions) => { writes.push({ op: 'set', path: ref.path, value, options: setOptions }) },
      commit: async () => {},
    }),
  }
  const firestore = Object.assign(() => db, { Timestamp: admin.firestore.Timestamp, FieldValue: admin.firestore.FieldValue })
  const replacements = [
    ['firebase-admin', { firestore }],
    ['../lib/news/aiClaudeSummary', {
      getAiSummaryConfig: () => ({ model: 'test-model', effort: 'low', dailyMaxRequests: 10 }),
      summarizeAiArticles: async (inputs, deps) => {
        summaryCalls.push({ inputs, deps })
        const results = new Map()
        const pendingIds = []
        for (const input of inputs) {
          const decided = summary(input)
          if (decided === 'pending') pendingIds.push(input.id)
          else if (decided && decided.include === false) results.set(input.id, { id: input.id, include: false, titleJa: '', summaryJa: '' })
          else results.set(input.id, { id: input.id, include: true, titleJa: '架空の日本語タイトル', summaryJa: '架空の日本語要約です' })
        }
        return { results, pendingIds, requestCount: 1 }
      },
    }],
    ['../lib/news/claudeClient', { createClaudeMessagesClient: () => null }],
  ]
  const target = require.resolve('../lib/news/generatePersonalizedFeed')
  const originalTarget = require.cache[target]
  const originals = replacements.map(([name]) => {
    const key = require.resolve(name)
    return [key, require.cache[key]]
  })
  try {
    for (const [name, exports] of replacements) {
      const key = require.resolve(name)
      require.cache[key] = { id: key, filename: key, loaded: true, exports }
    }
    delete require.cache[target]
    await require(target).runGeneratePersonalizedFeed()
  } finally {
    require.cache[target] = originalTarget
    for (const [key, original] of originals) {
      if (original) require.cache[key] = original
      else delete require.cache[key]
    }
  }
  const feedWrites = uid => writes
    .filter(item => item.op === 'set' && item.path.startsWith(`users/${uid}/newsFeed/ai/articles/`))
    .map(item => item.value)
  // 共有記事への書き込みを時系列で合成し、最終的な保存内容を返す。
  const shared = id => {
    const merged = writes
      .filter(item => item.path === `topics/ai/articles/${id}` && item.op !== 'delete')
      .reduce((all, item) => ({ ...all, ...item.value }), {})
    return Object.keys(merged).length > 0 ? merged : null
  }
  return {
    saved: feedWrites(users[0]), feedWrites, shared, writes, summaryCalls, timestamp,
    sentIds: summaryCalls.flatMap(call => call.inputs.map(input => input.id)),
  }
}

const idsOf = items => items.map(item => item.id)

test('フィード生成は判定待ち・旧版・low・exclude・rejected を保存せず、新しい点数式で順位付けする', async () => {
  const result = await generate([
    article('high', { developerValue: 'high' }),
    article('normal'),
    article('high-low-importance', { developerValue: 'high', importance: 'low' }),
    article('normal-high-importance', { importance: 'high' }),
    article('pending-ai', { triageStatus: 'pending', generalSource: false }),
    article('pending-general', { triageStatus: 'pending', generalSource: true, source: 'hn', score: 999 }),
    article('excluded', { triageDecision: 'exclude', relevant: false }),
    article('legacy', { triageStatus: undefined, triageVersion: undefined }),
    article('old-version', { triageVersion: 'ai-v1' }),
    article('low-value', { developerValue: 'low' }),
    rejectedBefore('rejected', { developerValue: 'high' }),
  ])
  assert.deepEqual(new Set(idsOf(result.saved)), new Set(['high', 'normal', 'high-low-importance', 'normal-high-importance']))
  const scoreOf = id => result.saved.find(item => item.id === id).displayScore
  assert.equal(scoreOf('high'), 110)
  assert.equal(scoreOf('high-low-importance'), 100)
  assert.equal(scoreOf('normal-high-importance'), 90)
  assert.equal(scoreOf('normal'), 70)
  for (const id of ['pending-ai', 'pending-general', 'excluded', 'legacy', 'old-version', 'low-value', 'rejected']) {
    assert.ok(!result.sentIds.includes(id), `${id} を要約へ送っている`)
  }
})

test('要約へ送るのは選ばれた候補の未確認だけで、verify=true と共有の締め切りを付ける', async () => {
  const result = await generate([
    article('english', { content: 'x'.repeat(3000), description: 'English description', tags: ['triage-tag'] }),
    article('description-only', { description: 'd'.repeat(2100), content: undefined }),
    confirmed('confirmed'),
  ])
  assert.equal(result.summaryCalls.length, 1)
  const { inputs, deps } = result.summaryCalls[0]
  assert.deepEqual(new Set(idsOf(inputs)), new Set(['english', 'description-only']))
  assert.equal(inputs.find(input => input.id === 'english').text, 'x'.repeat(2000))
  assert.equal(inputs.find(input => input.id === 'description-only').text, 'd'.repeat(2000))
  assert.equal(deps.verify, true)
  assert.ok(deps.deadlineAt >= result.timestamp + 60000)
  assert.ok(deps.deadlineAt <= Date.now() + 60000)
  const english = result.saved.find(item => item.id === 'english')
  assert.equal(english.titleJa, '架空の日本語タイトル')
  assert.equal(english.summaryJa, '架空の日本語要約です')
  assert.equal(english.summaryVersion, 'ai-v2')
  assert.equal(english.summaryStatus, 'generated')
  assert.equal(english.summarySource, 'content')
  assert.equal(typeof english.summarizedAt, 'number')
  assert.deepEqual(english.tags, ['triage-tag'])
  assert.equal(result.saved.find(item => item.id === 'description-only').summarySource, 'description')
  const kept = result.saved.find(item => item.id === 'confirmed')
  assert.equal(kept.summaryJa, '確認済みの概要です')
})

test('要約の確認結果は共有記事にも版・状態・時刻つきで保存する', async () => {
  const result = await generate([article('stored')])
  const sharedArticle = result.shared('stored')
  assert.equal(sharedArticle.summaryVersion, 'ai-v2')
  assert.equal(sharedArticle.summaryStatus, 'generated')
  assert.equal(sharedArticle.summarySource, 'content')
  assert.equal(typeof sharedArticle.summarizedAt, 'number')
  assert.equal(sharedArticle.summaryJa, '架空の日本語要約です')
})

test('日本語記事も説明文をそのまま概要にせず要約へ送り、結果が得られなければ保存しない', async () => {
  const japanese = article('japanese', {
    sourceName: 'Zenn ai', title: '架空の評価手法の紹介', description: '説明文による暫定概要です。'.repeat(8),
    content: '本文にだけ載っている評価結果です'.repeat(300),
  })
  const ok = await generate([japanese])
  assert.deepEqual(ok.sentIds, ['japanese'])
  assert.equal(ok.summaryCalls[0].inputs[0].text, japanese.content.slice(0, 2000))
  assert.equal(ok.saved.length, 1)
  assert.equal(ok.saved[0].summaryJa, '架空の日本語要約です')
  assert.notEqual(ok.saved[0].summaryJa, japanese.description.slice(0, 300))
  const pending = await generate([japanese], { summary: () => 'pending' })
  assert.deepEqual(pending.saved, [])
})

test('要約が得られなかった記事は保存せず、rejected にもしないで翌日再試行できる', async () => {
  const current = article('pending-summary', { developerValue: 'high', description: '説明文による暫定概要です' })
  const first = await generate([current], { summary: () => 'pending' })
  assert.ok(first.sentIds.includes('pending-summary'))
  assert.deepEqual(first.saved, [])
  const written = first.shared('pending-summary')
  assert.ok(!written || written.summaryStatus !== 'rejected', '失敗を rejected として保存してはいけない')
  assert.ok(!written || written.summaryStatus !== 'generated')
  const next = await generate([article('pending-summary-next', { ...current, id: 'pending-summary-next' })])
  assert.deepEqual(next.sentIds, ['pending-summary-next'])
  assert.equal(next.saved[0].summaryStatus, 'generated')
})

test('要約が pending の記事はその実行で再送せず、次の候補で補充し、保存も rejected にもしない', async () => {
  const candidates = Array.from({ length: 7 }, (_, index) => article(`hn-${index}`, {
    source: 'hn', sourceName: 'Hacker News', score: 70 - index * 10,
  }))
  const result = await generate(candidates, { summary: input => (input.id === 'hn-1' ? 'pending' : undefined) })
  assert.equal(result.sentIds.filter(id => id === 'hn-1').length, 1, '同じ実行で再送しない')
  assert.deepEqual(result.sentIds.filter(id => id !== 'hn-1').sort(), ['hn-0', 'hn-2', 'hn-3', 'hn-4', 'hn-5'])
  assert.deepEqual(new Set(idsOf(result.saved)), new Set(['hn-0', 'hn-2', 'hn-3', 'hn-4', 'hn-5']))
  const written = result.shared('hn-1')
  assert.ok(!written || (written.summaryStatus !== 'rejected' && written.summaryStatus !== 'generated'))
})

test('include=false が返った記事は保存せず rejected を保存し、次の候補で補充する', async () => {
  const candidates = Array.from({ length: 8 }, (_, index) => article(`hn-${index}`, {
    source: 'hn', sourceName: 'Hacker News', score: 80 - index * 10,
  }))
  const result = await generate(candidates, {
    summary: input => (input.id === 'hn-1' || input.id === 'hn-2' ? { include: false } : undefined),
  })
  assert.equal(result.summaryCalls.length, 2)
  assert.deepEqual(idsOf(result.summaryCalls[0].inputs).sort(), ['hn-0', 'hn-1', 'hn-2', 'hn-3', 'hn-4'])
  assert.deepEqual(idsOf(result.summaryCalls[1].inputs).sort(), ['hn-5', 'hn-6'])
  assert.deepEqual(new Set(idsOf(result.saved)), new Set(['hn-0', 'hn-3', 'hn-4', 'hn-5', 'hn-6']))
  for (const id of ['hn-1', 'hn-2']) {
    const rejected = result.shared(id)
    assert.equal(rejected.summaryStatus, 'rejected', id)
    assert.equal(rejected.summaryVersion, 'ai-v2', id)
    assert.equal(typeof rejected.summarizedAt, 'number', id)
  }
  assert.ok(result.summaryCalls.every(call => call.deps.verify === true))
  assert.equal(new Set(result.summaryCalls.map(call => call.deps.deadlineAt)).size, 1, '締め切りは全巡回で共有する')
})

test('保存は最大20件でソース別上限を守り、要約へ送るのも選ばれた20件だけ', async () => {
  const candidates = []
  for (const source of ['hn', 'github', 'japanese', 'other']) {
    for (let index = 0; index < 10; index++) {
      candidates.push(article(`${source}-${index}`, {
        source: source === 'hn' || source === 'github' ? source : 'rss',
        sourceName: source === 'japanese' ? 'Zenn 架空フィード' : source === 'github' ? 'GitHub Trending' : `Fictional ${source}`,
        score: source === 'hn' || source === 'github' ? 100 - index * 5 : null,
        developerValue: 'high',
      }))
    }
  }
  const result = await generate(candidates)
  assert.equal(result.saved.length, 20)
  const count = prefix => result.saved.filter(item => item.id.startsWith(prefix)).length
  assert.ok(count('hn-') <= 5, `hn ${count('hn-')}`)
  assert.ok(count('github-') <= 4, `github ${count('github-')}`)
  assert.ok(count('japanese-') <= 8, `japanese ${count('japanese-')}`)
  assert.ok(count('other-') <= 6, `other ${count('other-')}`)
  assert.equal(result.sentIds.length, 20)
  assert.deepEqual(new Set(result.sentIds), new Set(idsOf(result.saved)))
})

test('候補が上限を満たさない日は20件に満たなくても他の候補で埋めない', async () => {
  const candidates = Array.from({ length: 7 }, (_, index) => article(`hn-${index}`, {
    source: 'hn', sourceName: 'Hacker News', score: 70 - index,
  }))
  const result = await generate(candidates)
  assert.equal(result.saved.length, 5)
  assert.equal(result.sentIds.length, 5)
})

test('概要の根拠がない記事は API を呼ばず、保存も rejected もしない', async () => {
  const result = await generate([
    article('no-body', { description: '', content: '' }),
    article('github-synthetic', {
      source: 'github', sourceName: 'GitHub Trending', description: 'GitHub trending repository: sample-owner/sample-repo',
      content: '', score: 10,
    }),
    article('github-readme', {
      source: 'github', sourceName: 'GitHub Trending', description: 'GitHub trending repository: sample-owner/sample-readme',
      content: '# Sample\nリポジトリの README 本文です', score: 20,
    }),
    article('github-description', {
      source: 'github', sourceName: 'GitHub Trending', description: 'A fictional parser library', content: '', score: 5,
    }),
  ])
  for (const id of ['no-body', 'github-synthetic', 'github-description']) {
    assert.ok(!result.sentIds.includes(id), `${id} を API に送っている`)
    const written = result.shared(id)
    assert.ok(!written || written.summaryStatus !== 'rejected', `${id} を rejected として保存している`)
    assert.ok(!written || written.summaryStatus !== 'generated', id)
    assert.ok(!result.saved.some(item => item.id === id), `${id} を保存している`)
  }
  const readmeInput = result.summaryCalls.flatMap(call => call.inputs).find(input => input.id === 'github-readme')
  assert.equal(readmeInput.text, '# Sample\nリポジトリの README 本文です')
  assert.ok(result.saved.some(item => item.id === 'github-readme'))
})

test('GitHub は README 由来の本文を要約入力にし、合成説明文を入力に含めない', async () => {
  const result = await generate([
    article('github-body', {
      source: 'github', sourceName: 'GitHub Trending', description: 'GitHub trending repository: sample-owner/sample-body',
      content: 'README 由来の本文です', score: 20,
    }),
  ])
  assert.deepEqual(result.sentIds, ['github-body'])
  assert.equal(result.summaryCalls[0].inputs[0].text, 'README 由来の本文です')
  assert.ok(!result.summaryCalls[0].inputs[0].text.includes('GitHub trending repository'))
})

test('同じURLの v2 生成結果があればClaudeを呼ばずに再利用する', async () => {
  const current = article('reuse', { title: 'Fictional English article' })
  const result = await generate([current], {
    reusable: [confirmed('previous', {
      url: current.url, title: current.title, titleJa: '再利用するタイトル', summaryJa: '再利用する要約です', summarySource: 'description',
      summarizedAt: Date.now() - 2 * DAY_MS,
    })],
  })
  assert.equal(result.sentIds.length, 0)
  assert.equal(result.saved.length, 1)
  assert.equal(result.saved[0].summaryJa, '再利用する要約です')
  assert.equal(result.saved[0].titleJa, '再利用するタイトル')
  assert.equal(result.saved[0].summaryStatus, 'generated')
  assert.equal(result.saved[0].summarySource, 'description')
})

test('同じURLの v2 rejected があれば再要約せず表示もせず、次の候補で補充する', async () => {
  const skipped = article('skipped', { developerValue: 'high' })
  const alternative = article('alternative')
  const result = await generate([skipped, alternative], {
    reusable: [rejectedBefore('previous-rejected', { url: skipped.url })],
  })
  assert.deepEqual(result.sentIds, ['alternative'])
  assert.deepEqual(idsOf(result.saved), ['alternative'])
})

test('旧版の要約や版のない日本語要約は再利用せず、Claudeで確認し直す', async () => {
  const current = article('stale', { title: 'Fictional English article' })
  for (const previous of [
    article('previous-old', { url: current.url, titleJa: '旧タイトル', summaryJa: '旧版の要約です', summaryVersion: 'ai-v1', summaryStatus: 'generated', summarySource: 'content' }),
    article('previous-none', { url: current.url, titleJa: '旧タイトル', summaryJa: '版のない要約です' }),
  ]) {
    const result = await generate([current], { reusable: [previous] })
    assert.deepEqual(result.sentIds, ['stale'], previous.id)
    assert.equal(result.saved[0].summaryJa, '架空の日本語要約です', previous.id)
  }
})

test('要約から7日を超えた v2 結果は再利用せず確認し直す', async () => {
  const current = article('expired-summary')
  const result = await generate([current], {
    reusable: [confirmed('previous-expired', { url: current.url, summaryJa: '古い要約です', summarizedAt: Date.now() - 8 * DAY_MS })],
  })
  assert.deepEqual(result.sentIds, ['expired-summary'])
  assert.equal(result.saved[0].summaryJa, '架空の日本語要約です')
})

test('保存した記事の共有側に feedEligible と、嗜好倍率を含まない sharedScore を書く', async () => {
  const result = await generate([
    article('saved', { title: 'Fictional preference match', developerValue: 'high', importance: 'high' }),
    article('not-saved', { developerValue: 'low' }),
    rejectedBefore('rejected-one'),
  ], { preferences: { 'reader-demo': { keywords: [{ word: 'fictional', weight: 2 }] } } })
  const saved = result.saved.find(item => item.id === 'saved')
  assert.equal(saved.displayScore, 130 * 2)
  const sharedArticle = result.shared('saved')
  assert.equal(sharedArticle.feedEligible, true)
  assert.equal(sharedArticle.sharedScore, 130)
  for (const id of ['not-saved', 'rejected-one']) {
    const other = result.shared(id)
    assert.ok(!other || other.feedEligible !== true, `${id} に feedEligible=true を書いている`)
  }
})

test('利用者ごとに20件を選び、共有記事の要約は重複して送らない', async () => {
  const articles = ['a1', 'a2', 'a3'].map(id => article(id, { developerValue: 'high' }))
  const result = await generate(articles, {
    users: ['reader-one', 'reader-two'],
    interactions: { 'reader-two': [{ articleId: 'a1', url: articles[0].url, dismissed: true }] },
  })
  assert.deepEqual(new Set(idsOf(result.feedWrites('reader-one'))), new Set(['a1', 'a2', 'a3']))
  assert.deepEqual(new Set(idsOf(result.feedWrites('reader-two'))), new Set(['a2', 'a3']))
  assert.deepEqual([...result.sentIds].sort(), ['a1', 'a2', 'a3'])
})

test('1日の要約送信は合計40件までで、20件に満たなくても打ち切る', async () => {
  const candidates = []
  for (const source of ['hn', 'github', 'japanese', 'other']) {
    for (let index = 0; index < 30; index++) {
      candidates.push(article(`${source}-${index}`, {
        source: source === 'hn' || source === 'github' ? source : 'rss',
        sourceName: source === 'japanese' ? 'Zenn 架空フィード' : source === 'github' ? 'GitHub Trending' : `Fictional ${source}`,
        score: source === 'hn' || source === 'github' ? 1000 - index : null,
      }))
    }
  }
  const result = await generate(candidates, { summary: () => ({ include: false }) })
  assert.equal(result.sentIds.length, 40)
  assert.deepEqual(result.saved, [])
})

test('補充は最大3巡で止まる', async () => {
  const candidates = Array.from({ length: 30 }, (_, index) => article(`other-${index}`, {
    sourceName: 'Fictional other', developerValue: index < 10 ? 'high' : 'normal',
  }))
  const result = await generate(candidates, { summary: () => ({ include: false }) })
  assert.equal(result.summaryCalls.length, 3)
  assert.equal(result.sentIds.length, 18)
  assert.equal(new Set(result.sentIds).size, 18, '同じ記事を再送しない')
  assert.deepEqual(result.saved, [])
})

test('記事自身の summarizedAt が7日超の generated は表示せず再確認に送る', async () => {
  const result = await generate([confirmed('stale-generated', { summarizedAt: Date.now() - 8 * DAY_MS })])
  assert.deepEqual(result.sentIds, ['stale-generated'])
  assert.equal(result.saved[0].summaryJa, '架空の日本語要約です')
})

test('記事自身の summarizedAt が7日超の rejected は候補に戻り再確認に送る', async () => {
  const result = await generate([rejectedBefore('stale-rejected', { summarizedAt: Date.now() - 8 * DAY_MS })])
  assert.deepEqual(result.sentIds, ['stale-rejected'])
  assert.deepEqual(idsOf(result.saved), ['stale-rejected'])
})

test('再判定で古い summarizedAt を引き継いだ記事は、収集から配信の連鎖で期限を越えたまま固定されない', async () => {
  const now = Date.now()
  const raw = {
    title: 'Fictional AI tool article', url: 'https://example.com/chained', description: '架空の記事の説明です',
    thumbnailUrl: null, topic: 'ai', source: 'rss', sourceName: 'AI Feed', score: null, generalSource: false,
    publishedAt: new Date(now),
  }
  const source = {
    ...article('previous', { url: raw.url }), publishedAt: admin.firestore.Timestamp.fromMillis(now), fetchedAt: admin.firestore.Timestamp.fromMillis(now),
    date: '2026-01-01', triagedAt: now - DAY_MS,
    summaryVersion: 'ai-v2', summaryStatus: 'generated', summarySource: 'content', summarizedAt: now - 9 * DAY_MS,
    titleJa: '古いタイトル', summaryJa: '古い要約です',
  }
  const reused = buildReusedAiArticle(raw, source, '2026-10-28', admin.firestore.Timestamp.fromMillis(now))
  assert.equal(reused.summarizedAt, now - 9 * DAY_MS, '収集は元の summarizedAt を引き継ぐ')
  const result = await generate([{ ...reused, id: 'chained' }])
  assert.deepEqual(result.sentIds, ['chained'], '期限切れの要約は再確認に送る')
  assert.equal(result.saved[0].summaryJa, '架空の日本語要約です')
  assert.ok(result.saved[0].summarizedAt > now - DAY_MS, '再確認で summarizedAt が更新される')
})

test('追跡パラメータ付きURLの記事も、正規化URLが同じ v2 結果を再利用する', async () => {
  const current = article('tracked', { url: 'https://example.com/post/?utm_source=new-feed' })
  assert.equal(current.normalizedUrl, 'example.com/post')
  const result = await generate([current], {
    reusable: [confirmed('previous-tracked', { url: 'https://example.com/post?utm_source=old-feed', summaryJa: '正規化URLで再利用する要約です' })],
  })
  assert.equal(result.sentIds.length, 0)
  assert.equal(result.saved[0].summaryJa, '正規化URLで再利用する要約です')
})

test('同じ正規化URLの文書が6件以上あり古いものが先に返っても、有効な最新結果を使う', async () => {
  const current = article('many', { url: 'https://example.com/many' })
  const stale = Array.from({ length: 5 }, (_, index) => confirmed(`stale-${index}`, {
    url: current.url, summaryJa: `期限切れの要約 ${index}`, summarizedAt: Date.now() - (9 + index) * DAY_MS,
  }))
  const olderValid = confirmed('older-valid', { url: current.url, summaryJa: '有効だが古めの要約です', summarizedAt: Date.now() - 4 * DAY_MS })
  const newest = confirmed('newest-valid', { url: current.url, summaryJa: '有効で最新の要約です', summarizedAt: Date.now() - DAY_MS })
  const result = await generate([current], { reusable: [...stale, olderValid, newest] })
  assert.equal(result.sentIds.length, 0)
  assert.equal(result.saved[0].summaryJa, '有効で最新の要約です')
})

test('同じURLでもタイトルが違う過去の rejected は再利用せず、記事をClaudeに送る', async () => {
  const current = article('title-differs-rejected', { title: 'Fictional AI tool article' })
  const result = await generate([current], {
    reusable: [rejectedBefore('previous-rejected-other-title', { url: current.url, title: 'Completely different headline' })],
  })
  assert.deepEqual(result.sentIds, ['title-differs-rejected'])
  assert.deepEqual(idsOf(result.saved), ['title-differs-rejected'])
})

test('同じURLでもタイトルが違う過去の generated の titleJa と summaryJa は使わない', async () => {
  const current = article('title-differs-generated', { title: 'Fictional AI tool article' })
  const result = await generate([current], {
    reusable: [confirmed('previous-generated-other-title', {
      url: current.url, title: 'Completely different headline', titleJa: '別記事のタイトル', summaryJa: '別記事の要約です',
    })],
  })
  assert.deepEqual(result.sentIds, ['title-differs-generated'])
  assert.equal(result.saved.length, 1)
  assert.notEqual(result.saved[0].titleJa, '別記事のタイトル')
  assert.notEqual(result.saved[0].summaryJa, '別記事の要約です')
  assert.equal(result.saved[0].summaryJa, '架空の日本語要約です')
})

test('同じURLでタイトルが正規化後に一致する過去の generated は従来どおり再利用し、Claudeに送らない', async () => {
  const current = article('title-same-generated', { title: 'Fictional AI tool article' })
  const result = await generate([current], {
    reusable: [confirmed('previous-generated-same-title', {
      url: current.url, title: '  FICTIONAL  ai Tool   Article ', titleJa: '再利用するタイトル', summaryJa: '再利用する要約です',
    })],
  })
  assert.equal(result.sentIds.length, 0)
  assert.equal(result.saved.length, 1)
  assert.equal(result.saved[0].titleJa, '再利用するタイトル')
  assert.equal(result.saved[0].summaryJa, '再利用する要約です')
})

test('同じURLでタイトルが正規化後に一致する過去の rejected は従来どおり再利用し、Claudeに送らない', async () => {
  const skipped = article('title-same-rejected', { title: 'Fictional AI tool article', developerValue: 'high' })
  const alternative = article('title-same-alternative', { title: 'Another fictional article' })
  const result = await generate([skipped, alternative], {
    reusable: [rejectedBefore('previous-rejected-same-title', { url: skipped.url, title: 'FICTIONAL AI TOOL ARTICLE' })],
  })
  assert.deepEqual(result.sentIds, ['title-same-alternative'])
  assert.deepEqual(idsOf(result.saved), ['title-same-alternative'])
})

test('2段目の再利用は正規化URLで引く', async () => {
  const current = article('lookup', { url: 'https://example.com/lookup' })
  const queried = []
  const result = await generate([current], { reusable: [], onQuery: filters => queried.push(filters) })
  assert.equal(result.sentIds.length, 1)
  assert.ok(queried.some(filters => filters.some(([field, operator, value]) =>
    field === 'normalizedUrl' && operator === '==' && value === 'example.com/lookup')),
  `normalizedUrl の照合がない: ${JSON.stringify(queried)}`)
})
