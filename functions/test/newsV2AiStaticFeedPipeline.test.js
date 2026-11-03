const test = require('node:test')
const assert = require('node:assert/strict')
const { runAiStaticFeedPipeline } = require('../lib/news/v2/aiStaticFeedPipeline')
const { PreconditionFailedError, AI_FEED_LATEST_PATH, aiFeedDailyPath, aiFeedPublishedPath } = require('../lib/news/v2/publishAiFeed')
const { buildAiFeedV2, toAiFeedV2Article } = require('../lib/news/v2/feedContract')

const feedDate = '2026-11-04'
const instant = new Date('2026-11-03T21:00:00.000Z')
function article(id, extra = {}) {
  return { id, title: `架空記事${id}`, titleJa: `日本語記事${id}`, summaryJa: ' 架空の概要 ', source: 'rss', sourceName: '架空通信', url: `https://example.com/${id}`, ...extra }
}
function setup() {
  const objects = new Map(), writes = []
  let serial = 0
  const bucket = {
    seed(path, value) { objects.set(path, { data: Buffer.from(JSON.stringify(value)), generation: String(++serial) }) },
    json(path) { return JSON.parse(objects.get(path).data.toString('utf8')) },
    async read(path) { return objects.get(path) ?? null },
    async write(path, data, opts) {
      if (String(opts.ifGenerationMatch) !== (objects.get(path)?.generation ?? '0')) throw new PreconditionFailedError('世代が競合しました')
      const generation = String(++serial)
      objects.set(path, { data: Buffer.from(data), generation })
      writes.push(path)
      return { generation }
    },
  }
  const calls = { collect: 0, generate: 0, contexts: [] }
  const deps = {
    bucket, feedDate, curatorUid: 'fiction-curator', now: () => new Date(instant),
    collect: async () => { calls.collect++; return true },
    generate: async ctx => { calls.generate++; calls.contexts.push(ctx); return { ok: true, curatorArticles: [] } },
    log: { info() {}, warn() {}, error() {} },
  }
  return { bucket, objects, writes, calls, deps }
}

for (const curatorUid of [undefined, '']) {
  test(`curator未設定(${String(curatorUid)})では収集・生成せず失敗する`, async () => {
    const { deps, calls, writes } = setup()
    deps.curatorUid = curatorUid
    assert.deepEqual(await runAiStaticFeedPipeline(deps), { status: 'failed', reason: 'missing-curator' })
    assert.equal(calls.collect, 0)
    assert.equal(calls.generate, 0)
    assert.equal(writes.length, 0)
  })
}

test('dailyが存在する再実行は収集・生成せず同じ原本を公開して復旧する', async () => {
  const { deps, bucket, calls, writes } = setup()
  const feed = buildAiFeedV2({ feedDate, generatedAt: instant.toISOString(), articles: [toAiFeedV2Article(article('saved'))] })
  const daily = { schemaVersion: 2, topic: 'ai', feedDate, learningCutoffAt: instant.toISOString(), feed, actionArticles: [{ id: 'saved', title: '架空原本', summary: '架空の概要' }] }
  bucket.seed(aiFeedDailyPath(feedDate), daily)
  assert.deepEqual(await runAiStaticFeedPipeline(deps), { status: 'recovered', publish: { status: 'published' } })
  assert.equal(calls.collect, 0)
  assert.equal(calls.generate, 0)
  assert.deepEqual(bucket.json(AI_FEED_LATEST_PATH), feed)
  assert.deepEqual(bucket.json(aiFeedDailyPath(feedDate)), daily)
  assert.equal(writes.includes(aiFeedDailyPath(feedDate)), false)
})

for (const reason of ['collect', 'generate']) {
  test(`${reason}失敗ではdaily・publishedを作らず前回latestを維持する`, async () => {
    const { deps, bucket, objects, calls, writes } = setup()
    const previous = buildAiFeedV2({ feedDate: '2026-11-03', generatedAt: instant.toISOString(), articles: [] })
    bucket.seed(AI_FEED_LATEST_PATH, previous)
    const generation = objects.get(AI_FEED_LATEST_PATH).generation
    if (reason === 'collect') deps.collect = async () => { calls.collect++; return false }
    else deps.generate = async () => { calls.generate++; return { ok: false } }
    assert.deepEqual(await runAiStaticFeedPipeline(deps), { status: 'failed', reason })
    assert.equal(calls.collect, 1)
    assert.equal(calls.generate, reason === 'collect' ? 0 : 1)
    assert.deepEqual(bucket.json(AI_FEED_LATEST_PATH), previous)
    assert.equal(objects.get(AI_FEED_LATEST_PATH).generation, generation)
    assert.equal(writes.length, 0)
  })
}

test('正常0件は当日の完全な空feedとしてdaily・latest・publishedへ保存する', async () => {
  const { deps, bucket, calls } = setup()
  const result = await runAiStaticFeedPipeline(deps)
  assert.equal(result.status, 'published')
  assert.equal(calls.collect, 1)
  assert.equal(calls.generate, 1)
  const daily = bucket.json(aiFeedDailyPath(feedDate))
  assert.equal(daily.feedDate, feedDate)
  assert.equal(daily.feed.totalCount, 0)
  assert.deepEqual(daily.feed.articles, [])
  assert.deepEqual(daily.actionArticles, [])
  assert.deepEqual(bucket.json(AI_FEED_LATEST_PATH), daily.feed)
  assert.equal(bucket.json(aiFeedPublishedPath(feedDate)).revision, daily.feed.revision)
})

test('概要空は除外し、http URLは除去してDTO変換結果を配信する', async () => {
  const { deps, bucket } = setup()
  const articles = [article('valid'), article('blank', { summaryJa: '  ' }), article('http', { url: 'http://example.com/article' })]
  deps.generate = async () => ({ ok: true, curatorArticles: articles })
  assert.equal((await runAiStaticFeedPipeline(deps)).status, 'published')
  const feed = bucket.json(AI_FEED_LATEST_PATH)
  assert.deepEqual(feed.articles, articles.map(toAiFeedV2Article).filter(value => value !== null))
  assert.deepEqual(feed.articles.map(value => value.id), ['valid', 'http'])
  assert.equal(feed.totalCount, 2)
  assert.equal('url' in feed.articles[1], false)
  assert.equal(feed.articles[0].title, '日本語記事valid')
})

test('生成開始前のcutoffをgenerateへ渡し、生成中に時計が進んでもdailyに同じ時刻を保存する', async () => {
  const { deps, bucket, calls } = setup()
  let current = new Date(instant)
  deps.now = () => new Date(current)
  deps.generate = async ctx => {
    calls.contexts.push(ctx)
    assert.ok(ctx.learningCutoffAt instanceof Date)
    assert.equal(ctx.learningCutoffAt.toISOString(), instant.toISOString())
    assert.equal(ctx.curatorUid, 'fiction-curator')
    current = new Date(instant.getTime() + 60000)
    return { ok: true, curatorArticles: [article('cutoff')] }
  }
  assert.equal((await runAiStaticFeedPipeline(deps)).status, 'published')
  assert.equal(calls.contexts.length, 1)
  assert.equal(bucket.json(aiFeedDailyPath(feedDate)).learningCutoffAt, instant.toISOString())
})
