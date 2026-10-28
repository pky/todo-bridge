const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const collect = require('../lib/news/collectArticles')
const {
  AI_TRIAGE_DEADLINE_MS,
  planAiArticleProcessing,
  buildTriageInput,
  buildTriagedAiArticle,
  buildReusedAiArticle,
} = collect

const TODAY = '2026-10-28'
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-28T00:00:00Z')
const fetchedAt = admin.firestore.Timestamp.fromDate(new Date(NOW))
const rawArticle = (overrides = {}) => ({
  title: 'New title',
  description: 'New description',
  url: 'https://example.com/articles/tool',
  thumbnailUrl: null,
  topic: 'ai',
  source: 'hn',
  sourceName: 'Hacker News',
  score: 100,
  generalSource: true,
  publishedAt: new Date('2026-10-27T00:00:00Z'),
  ...overrides,
})
// 現行版の判定済み記事。タイトルは raw と同じにして、再利用条件を満たす既定値にする。
const existingArticle = (overrides = {}) => ({
  ...rawArticle(),
  title: 'New title',
  description: 'Old description',
  score: 5,
  source: 'rss',
  sourceName: 'Example AI',
  generalSource: false,
  publishedAt: admin.firestore.Timestamp.fromDate(new Date('2026-10-25T00:00:00Z')),
  fetchedAt: admin.firestore.Timestamp.fromDate(new Date('2026-10-26T00:00:00Z')),
  date: '2026-10-26',
  triageStatus: 'done',
  triageVersion: 'ai-v2',
  triageDecision: 'include',
  category: 'llm_engineering',
  triagedAt: NOW - DAY_MS,
  relevant: true,
  importance: 'high',
  developerValue: 'high',
  readReason: '保存済みの読む理由',
  tags: ['llm', 'coding'],
  content: 'Saved content',
  ...overrides,
})
const summarized = (overrides = {}) => ({
  summaryVersion: 'ai-v2', summaryStatus: 'generated', summarySource: 'content',
  summarizedAt: NOW - DAY_MS / 2, titleJa: '保存済みタイトル', summaryJa: '保存済み要約', ...overrides,
})
const triageResult = (overrides = {}) => ({
  id: 'article-1', relevant: true, decision: 'include', category: 'llm_engineering',
  importance: 'high', developerValue: 'high', readReason: '具体的な手順を読める', tags: ['llm'], ...overrides,
})

test('planAiArticleProcessing は現行版・同タイトル・7日以内・URL一致の判定済み記事を再利用に回す', () => {
  const raw = rawArticle({ url: 'https://example.com/articles/tool/?utm_source=test' })
  const fresh = rawArticle({ url: 'https://example.com/articles/new' })
  const source = existingArticle()
  const plan = planAiArticleProcessing([raw, fresh], [source], NOW)
  assert.deepEqual(plan.reuse, [{ raw, source }])
  assert.deepEqual(plan.fresh, [fresh])
})

test('planAiArticleProcessing は正規化後に同じタイトルなら再利用し、変わったタイトルは再判定する', () => {
  const raw = rawArticle({ title: 'New  Title!' })
  assert.deepEqual(planAiArticleProcessing([raw], [existingArticle({ title: 'new title' })], NOW),
    { reuse: [{ raw, source: existingArticle({ title: 'new title' }) }], fresh: [] })
  const changed = rawArticle({ title: 'Brand new headline for the same URL' })
  assert.deepEqual(planAiArticleProcessing([changed], [existingArticle()], NOW), { reuse: [], fresh: [changed] })
})

test('planAiArticleProcessing は旧バージョンや版のない判定を再利用しない', () => {
  const raw = rawArticle()
  for (const triageVersion of ['ai-v1', undefined]) {
    const source = existingArticle({ triageVersion })
    assert.deepEqual(planAiArticleProcessing([raw], [source], NOW), { reuse: [], fresh: [raw] }, String(triageVersion))
  }
})

test('planAiArticleProcessing は triagedAt から7日を超えた判定と時刻のない判定を再判定する', () => {
  const raw = rawArticle()
  const exactlySevenDays = existingArticle({ triagedAt: NOW - 7 * DAY_MS })
  assert.equal(planAiArticleProcessing([raw], [exactlySevenDays], NOW).reuse.length, 1)
  const expired = existingArticle({ triagedAt: NOW - 7 * DAY_MS - 1 })
  assert.deepEqual(planAiArticleProcessing([raw], [expired], NOW), { reuse: [], fresh: [raw] })
  for (const triagedAt of [undefined, null, 'later', admin.firestore.Timestamp.fromMillis(NOW)]) {
    const source = existingArticle({ triagedAt })
    assert.deepEqual(planAiArticleProcessing([raw], [source], NOW), { reuse: [], fresh: [raw] }, String(triagedAt))
  }
})

test('planAiArticleProcessing は now を省略すると現在時刻で期限を判定する', () => {
  const raw = rawArticle()
  const recent = existingArticle({ triagedAt: Date.now() - DAY_MS })
  assert.equal(planAiArticleProcessing([raw], [recent]).reuse.length, 1)
  const old = existingArticle({ triagedAt: Date.now() - 8 * DAY_MS })
  assert.deepEqual(planAiArticleProcessing([raw], [old]), { reuse: [], fresh: [raw] })
})

test('planAiArticleProcessing は pending の過去記事を再利用しない', () => {
  const raw = rawArticle()
  const source = existingArticle({ triageStatus: 'pending' })
  assert.deepEqual(planAiArticleProcessing([raw], [source], NOW), { reuse: [], fresh: [raw] })
})

test('planAiArticleProcessing は判定状態のない旧記事を再利用しない', () => {
  const raw = rawArticle()
  const source = existingArticle()
  delete source.triageStatus
  assert.deepEqual(planAiArticleProcessing([raw], [source], NOW), { reuse: [], fresh: [raw] })
})

test('buildTriageInput は説明文を300文字で切りドメインを入れる', () => {
  const raw = rawArticle({ description: 'あ'.repeat(301) })
  assert.deepEqual(buildTriageInput('article-1', raw), {
    id: 'article-1', sourceName: raw.sourceName, title: raw.title,
    description: 'あ'.repeat(300), domain: 'example.com',
  })
})

test('buildTriageInput は URL を解析できなければドメインを空にする', () => {
  const input = buildTriageInput('article-1', rawArticle({ url: 'invalid-url', description: '短い説明' }))
  assert.equal(input.domain, '')
  assert.equal(input.description, '短い説明')
})

test('buildTriageInput は GitHub の合成説明文を説明なしとして送る', () => {
  const synthetic = rawArticle({
    source: 'github', sourceName: 'GitHub Trending', url: 'https://github.com/sample-owner/sample-repo',
    description: 'GitHub trending repository: sample-owner/sample-repo',
  })
  const input = buildTriageInput('article-1', synthetic)
  assert.equal(input.description, '')
  assert.equal(input.domain, 'github.com')
  const real = buildTriageInput('article-2', { ...synthetic, description: 'A fictional parser library' })
  assert.equal(real.description, 'A fictional parser library')
})

test('buildTriagedAiArticle は relevant false なら本文を持たない', () => {
  const result = triageResult({ relevant: false, decision: 'exclude', category: 'promotion', importance: 'low', tags: ['rust'] })
  const article = buildTriagedAiArticle(rawArticle(), '保存してはいけない本文', result, TODAY, fetchedAt)
  assert.equal(article.triageStatus, 'done')
  assert.equal(article.triageDecision, 'exclude')
  assert.equal(article.category, 'promotion')
  assert.equal(article.relevant, false)
  assert.equal(article.importance, 'low')
  assert.deepEqual(article.tags, ['rust'])
  assert.equal('content' in article, false)
})

test('buildTriagedAiArticle は判定結果がなければ pending で relevant を持たない', () => {
  const article = buildTriagedAiArticle(rawArticle(), '未判定の本文', null, TODAY, fetchedAt)
  assert.equal(article.triageStatus, 'pending')
  assert.equal('relevant' in article, false)
  assert.equal('importance' in article, false)
  assert.equal('triagedAt' in article, false)
  assert.equal('content' in article, false)
  assert.equal(article.date, TODAY)
  assert.equal(article.fetchedAt, fetchedAt)
})

test('buildTriagedAiArticle は include の判定と本文を版・判定時刻つきで保存する', () => {
  const raw = rawArticle()
  const article = buildTriagedAiArticle(raw, '新しい本文', triageResult(), TODAY, fetchedAt)
  assert.equal(article.triageStatus, 'done')
  assert.equal(article.triageVersion, 'ai-v2')
  assert.equal(article.triageDecision, 'include')
  assert.equal(article.category, 'llm_engineering')
  assert.equal(article.relevant, true)
  assert.equal(article.importance, 'high')
  assert.equal(article.developerValue, 'high')
  assert.equal(article.readReason, '具体的な手順を読める')
  assert.deepEqual(article.tags, ['llm'])
  assert.equal(article.triagedAt, fetchedAt.toMillis())
  assert.equal(article.content, '新しい本文')
  assert.equal(article.url, raw.url)
  assert.equal(article.topic, 'ai')
  assert.equal(article.date, TODAY)
  assert.equal(article.fetchedAt, fetchedAt)
  assert.equal(article.publishedAt.toMillis(), raw.publishedAt.getTime())
})

test('buildTriagedAiArticle は hold の記事も本文を保存する', () => {
  const result = triageResult({ decision: 'hold', category: 'ai_dev_tool', developerValue: 'normal' })
  const article = buildTriagedAiArticle(rawArticle(), 'README の本文', result, TODAY, fetchedAt)
  assert.equal(article.triageDecision, 'hold')
  assert.equal(article.relevant, true)
  assert.equal(article.content, 'README の本文')
})

test('buildTriagedAiArticle は raw の publisherDomain を保存し、なければ項目を作らない', () => {
  const withDomain = buildTriagedAiArticle(rawArticle({ publisherDomain: 'publisher.example.com' }), '', triageResult(), TODAY, fetchedAt)
  assert.equal(withDomain.publisherDomain, 'publisher.example.com')
  const without = buildTriagedAiArticle(rawArticle(), '', triageResult(), TODAY, fetchedAt)
  assert.equal('publisherDomain' in without, false)
})

test('buildTriagedAiArticle は pending 記事にも raw の publisherDomain を保存する', () => {
  const pending = buildTriagedAiArticle(rawArticle({ publisherDomain: 'publisher.example.com' }), '', null, TODAY, fetchedAt)
  assert.equal(pending.triageStatus, 'pending')
  assert.equal(pending.publisherDomain, 'publisher.example.com')
})

test('保存する記事は raw の URL から求めた normalizedUrl を持つ(判定済み・pending・再利用とも)', () => {
  const raw = rawArticle({ url: 'https://www.example.com/post/?utm_source=feed&id=7' })
  const expected = collect.normalizeUrl(raw.url)
  assert.equal(expected, 'www.example.com/post?id=7')
  assert.equal(buildTriagedAiArticle(raw, '', triageResult(), TODAY, fetchedAt).normalizedUrl, expected)
  assert.equal(buildTriagedAiArticle(raw, '', null, TODAY, fetchedAt).normalizedUrl, expected)
  const source = existingArticle({ normalizedUrl: 'stale.example.com/other' })
  assert.equal(buildReusedAiArticle(raw, source, TODAY, fetchedAt).normalizedUrl, expected)
})

test('buildTriagedAiArticle は generalSource を引き継ぐ', () => {
  for (const generalSource of [true, false]) {
    const article = buildTriagedAiArticle(rawArticle({ generalSource }), '', null, TODAY, fetchedAt)
    assert.equal(article.generalSource, generalSource)
  }
})

test('buildReusedAiArticle は判定と要約を source から、URL とスコアを raw から取る', () => {
  const raw = rawArticle({ url: 'https://example.com/articles/tool/?utm_source=test' })
  const source = existingArticle(summarized())
  const article = buildReusedAiArticle(raw, source, TODAY, fetchedAt)
  for (const key of ['url', 'title', 'description', 'score', 'source', 'sourceName', 'generalSource']) {
    assert.equal(article[key], raw[key], key)
  }
  for (const key of [
    'triageStatus', 'triageVersion', 'triageDecision', 'category', 'relevant', 'importance', 'developerValue', 'readReason',
    'content', 'titleJa', 'summaryJa', 'summaryVersion', 'summaryStatus', 'summarySource',
  ]) {
    assert.equal(article[key], source[key], key)
  }
  assert.deepEqual(article.tags, source.tags)
  assert.equal(article.publishedAt.toMillis(), raw.publishedAt.getTime())
  assert.equal(article.date, TODAY)
  assert.equal(article.fetchedAt, fetchedAt)
})

test('buildReusedAiArticle は triagedAt と summarizedAt を元の値のまま引き継ぐ', () => {
  const source = existingArticle(summarized({ triagedAt: NOW - 3 * DAY_MS, summarizedAt: NOW - 2 * DAY_MS }))
  const article = buildReusedAiArticle(rawArticle(), source, TODAY, fetchedAt)
  assert.equal(article.triagedAt, NOW - 3 * DAY_MS)
  assert.equal(article.summarizedAt, NOW - 2 * DAY_MS)
  assert.notEqual(article.triagedAt, fetchedAt.toMillis())
})

test('buildReusedAiArticle は rejected の要約結果も引き継ぐ', () => {
  const source = existingArticle({
    summaryVersion: 'ai-v2', summaryStatus: 'rejected', summarizedAt: NOW - DAY_MS,
  })
  const article = buildReusedAiArticle(rawArticle(), source, TODAY, fetchedAt)
  assert.equal(article.summaryVersion, 'ai-v2')
  assert.equal(article.summaryStatus, 'rejected')
  assert.equal(article.summarizedAt, NOW - DAY_MS)
  assert.equal('summaryJa' in article, false)
})

test('buildReusedAiArticle は developerValue のない判定でも要約項目を引き継ぐ', () => {
  const source = existingArticle(summarized())
  delete source.developerValue
  delete source.readReason
  const article = buildReusedAiArticle(rawArticle(), source, TODAY, fetchedAt)
  assert.equal(article.summaryStatus, 'generated')
  assert.equal(article.summarySource, 'content')
  assert.equal(article.summaryVersion, 'ai-v2')
  assert.equal(article.summaryJa, '保存済み要約')
})

test('buildReusedAiArticle の publisherDomain は raw から取り、source の値を使わない', () => {
  const source = existingArticle({ publisherDomain: 'stale.example.com' })
  const withRaw = buildReusedAiArticle(rawArticle({ publisherDomain: 'publisher.example.com' }), source, TODAY, fetchedAt)
  assert.equal(withRaw.publisherDomain, 'publisher.example.com')
  const withoutRaw = buildReusedAiArticle(rawArticle(), source, TODAY, fetchedAt)
  assert.equal('publisherDomain' in withoutRaw, false)
})

test('buildReusedAiArticle は exclude の保存済み判定も再利用する', () => {
  const raw = rawArticle()
  const source = existingArticle({
    relevant: false, triageDecision: 'exclude', category: 'promotion', importance: 'low', developerValue: 'low',
  })
  delete source.content
  const plan = planAiArticleProcessing([raw], [source], NOW)
  assert.deepEqual(plan.fresh, [])
  assert.deepEqual(plan.reuse, [{ raw, source }])
  const article = buildReusedAiArticle(raw, source, TODAY, fetchedAt)
  assert.equal(article.relevant, false)
  assert.equal(article.triageDecision, 'exclude')
  assert.equal(article.category, 'promotion')
  assert.equal(article.triageStatus, 'done')
  assert.equal('content' in article, false)
})

test('AI_TRIAGE_DEADLINE_MS は 120000', () => {
  assert.equal(AI_TRIAGE_DEADLINE_MS, 120000)
})

test('buildReusedAiArticle は過去のサムネイルを保持し、新しい画像があれば優先する', () => {
  const previousImage = 'https://example.com/previous.png'
  const currentImage = 'https://example.com/current.png'
  const source = existingArticle({ thumbnailUrl: previousImage })
  const reused = buildReusedAiArticle(rawArticle({ thumbnailUrl: null }), source, TODAY, fetchedAt)
  assert.equal(reused.thumbnailUrl, previousImage)
  const current = buildReusedAiArticle(rawArticle({ thumbnailUrl: currentImage }), source, TODAY, fetchedAt)
  assert.equal(current.thumbnailUrl, currentImage)
})

const githubRaw = (overrides = {}) => rawArticle({
  source: 'github', sourceName: 'GitHub Trending', url: 'https://github.com/sample-owner/sample-repo',
  description: 'GitHub trending repository: sample-owner/sample-repo', generalSource: true, ...overrides,
})

test('cleanReadmeText は画像・バッジ・HTMLタグを取り除き本文を残して空白を詰める', () => {
  assert.equal(typeof collect.cleanReadmeText, 'function', 'cleanReadmeText が export されていない')
  const cleaned = collect.cleanReadmeText([
    '[![build](https://example.com/badge.svg)](https://example.com/ci)',
    '![logo](https://example.com/logo.png)',
    '<p align="center"><img src="https://example.com/banner.png" alt="banner"></p>',
    '# Sample Tool',
    '',
    '',
    'Sample   Tool   runs   fictional   agents.',
    '<details><summary>More</summary>Usage notes</details>',
  ].join('\n'))
  assert.ok(!cleaned.includes('!['), cleaned)
  assert.ok(!cleaned.includes('badge.svg'), cleaned)
  assert.ok(!cleaned.includes('logo.png'), cleaned)
  assert.ok(!/<[a-z/][^>]*>/i.test(cleaned), cleaned)
  assert.ok(!/\s{2,}/.test(cleaned), cleaned)
  assert.ok(cleaned.includes('Sample Tool'), cleaned)
  assert.ok(cleaned.includes('runs fictional agents.'), cleaned)
  assert.ok(cleaned.includes('Usage notes'), cleaned)
})

test('scrapeAiArticles は GitHub で本文が空なら README を取得して整形し先頭5000字を本文にする', async () => {
  const calls = []
  const out = await collect.scrapeAiArticles([githubRaw()], {
    deadlineAt: Date.now() + 1000,
    scrape: async () => ({ content: '', ogImage: null }),
    fetchReadme: async (repoPath, options) => {
      calls.push({ repoPath, options })
      return `![logo](https://example.com/logo.png)\n# Title\n${'x'.repeat(6000)}`
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].repoPath, 'sample-owner/sample-repo')
  assert.ok(calls[0].options.signal instanceof AbortSignal)
  assert.equal(out.length, 1)
  assert.equal(out[0].content.length, 5000)
  assert.ok(!out[0].content.includes('!['))
  assert.ok(out[0].content.startsWith('# Title'))
})

test('scrapeAiArticles は GitHub でも本文が取れていれば README を取得しない', async () => {
  let calls = 0
  const out = await collect.scrapeAiArticles([githubRaw()], {
    deadlineAt: Date.now() + 1000,
    scrape: async () => ({ content: 'ページから取れた本文', ogImage: null }),
    fetchReadme: async () => { calls++; return 'README' },
  })
  assert.equal(calls, 0)
  assert.equal(out[0].content, 'ページから取れた本文')
})

test('scrapeAiArticles は GitHub 以外の記事では本文が空でも README を取得しない', async () => {
  let calls = 0
  const out = await collect.scrapeAiArticles([rawArticle({ source: 'rss' }), rawArticle({ source: 'hn', url: 'https://example.com/hn' })], {
    deadlineAt: Date.now() + 1000,
    scrape: async () => ({ content: '', ogImage: null }),
    fetchReadme: async () => { calls++; return 'README' },
  })
  assert.equal(calls, 0)
  assert.ok(out.every(item => item.content === ''))
})

test('scrapeAiArticles は締め切り済みなら README も取得しない', async () => {
  let readmeCalls = 0
  let scrapeCalls = 0
  const out = await collect.scrapeAiArticles([githubRaw()], {
    deadlineAt: 1000,
    now: () => 1000,
    scrape: async () => { scrapeCalls++; return { content: '', ogImage: null } },
    fetchReadme: async () => { readmeCalls++; return 'README' },
  })
  assert.equal(scrapeCalls, 0)
  assert.equal(readmeCalls, 0)
  assert.equal(out[0].content, '')
})

test('scrapeAiArticles は README 取得に失敗した GitHub 記事を本文空で残す', async () => {
  const out = await collect.scrapeAiArticles([githubRaw()], {
    deadlineAt: Date.now() + 1000,
    scrape: async () => ({ content: '', ogImage: null }),
    fetchReadme: async () => { throw new Error('README 取得失敗の模擬') },
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].content, '')
})
