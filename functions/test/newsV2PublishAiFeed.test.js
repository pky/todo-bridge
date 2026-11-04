const test = require('node:test')
const assert = require('node:assert/strict')
const { buildAiFeedV2, computeFeedRevision } = require('../lib/news/v2/feedContract')
const { AI_FEED_LATEST_PATH, aiFeedDailyPath, aiFeedPublishedPath, saveDailyIfAbsent, publishDaily, PreconditionFailedError } = require('../lib/news/v2/publishAiFeed')

const now = '2026-11-03T21:00:00.000Z'
function daily(feedDate = '2026-11-04', title = '架空記事') {
  const article = { id: 'fiction-1', title, sourceName: '架空通信', summary: '架空の概要', publishedAt: null, url: 'https://example.com/article' }
  return { schemaVersion: 2, topic: 'ai', feedDate, learningCutoffAt: now, feed: buildAiFeedV2({ feedDate, generatedAt: now, articles: [article] }), actionArticles: [{ id: article.id, title, summary: article.summary, url: article.url }] }
}
function fakeBucket() {
  const objects = new Map()
  const writes = []
  let serial = 0
  return {
    objects, writes, beforeWrite: null,
    seed(path, value) { const object = { data: Buffer.from(JSON.stringify(value)), generation: String(++serial) }; objects.set(path, object); return object.generation },
    json(path) { return JSON.parse(objects.get(path).data.toString('utf8')) },
    async read(path) { const object = objects.get(path); return object ? { data: Buffer.from(object.data), generation: object.generation } : null },
    async write(path, data, opts) {
      if (this.beforeWrite) await this.beforeWrite(path, data, opts)
      const generation = objects.get(path)?.generation ?? '0'
      if (String(opts.ifGenerationMatch) !== generation) throw new PreconditionFailedError('世代が競合しました')
      const next = String(++serial)
      objects.set(path, { data: Buffer.from(data), generation: next })
      writes.push({ path, data: Buffer.from(data), opts: { ...opts }, generation: next })
      return { generation: next }
    },
  }
}

test('初回はdaily→latest→publishedを条件付き保存し、公開バイトとmetadataが一致する', async () => {
  const bucket = fakeBucket(), value = daily()
  assert.equal(AI_FEED_LATEST_PATH, 'news/v2/ai/latest.json')
  assert.equal(aiFeedDailyPath(value.feedDate), `news-private/v2/ai/daily/${value.feedDate}.json`)
  assert.equal(aiFeedPublishedPath(value.feedDate), `news-private/v2/ai/published/${value.feedDate}.json`)
  assert.deepEqual(await saveDailyIfAbsent(bucket, value), value)
  assert.deepEqual(await publishDaily(bucket, value, now), { status: 'published' })
  assert.deepEqual(bucket.writes.map(w => w.path), [aiFeedDailyPath(value.feedDate), AI_FEED_LATEST_PATH, aiFeedPublishedPath(value.feedDate)])
  assert.ok(bucket.writes.every(w => String(w.opts.ifGenerationMatch) === '0'))
  const latest = bucket.writes[1]
  assert.equal(latest.data.toString('utf8'), JSON.stringify(value.feed))
  assert.equal(latest.opts.contentType, 'application/json; charset=utf-8')
  assert.equal(latest.opts.cacheControl, 'private, no-store')
  assert.deepEqual(bucket.json(aiFeedPublishedPath(value.feedDate)), { feedDate: value.feedDate, revision: value.feed.revision, publishedAt: now, latestGeneration: latest.generation })
})

test('daily保存競合では最初の原本を返し、二つ目で上書きしない', async () => {
  const bucket = fakeBucket(), first = daily(), second = daily(undefined, '別の架空記事')
  bucket.beforeWrite = async path => { if (path === aiFeedDailyPath(first.feedDate)) { bucket.beforeWrite = null; bucket.seed(path, first) } }
  assert.deepEqual(await saveDailyIfAbsent(bucket, second), first)
  assert.deepEqual(bucket.json(aiFeedDailyPath(first.feedDate)), first)
  assert.equal(bucket.writes.length, 0)
})

for (const [name, existing, status] of [
  ['新しい日付', daily('2026-11-05'), 'skipped-newer'],
  ['同日同revision', daily(), 'already'],
  ['同日別revision', daily(undefined, '別の架空記事'), 'skipped-same-day-conflict'],
]) {
  test(`${name}のlatestを維持して${status}を返す`, async () => {
    const bucket = fakeBucket(), value = daily()
    const generation = bucket.seed(AI_FEED_LATEST_PATH, existing.feed)
    assert.deepEqual(await publishDaily(bucket, value, now), { status })
    assert.equal(bucket.objects.get(AI_FEED_LATEST_PATH).generation, generation)
    assert.deepEqual(bucket.json(AI_FEED_LATEST_PATH), existing.feed)
    assert.equal(bucket.objects.has(aiFeedPublishedPath(value.feedDate)), status === 'already')
  })
}

for (const [competitor, status] of [[daily('2026-11-05'), 'skipped-newer'], [daily(undefined, '割込記事'), 'skipped-same-day-conflict'], [daily(), 'already']]) {
  test(`latest書込みへの割込後に読み直して${status}にする`, async () => {
    const bucket = fakeBucket(), value = daily()
    bucket.beforeWrite = async path => { if (path === AI_FEED_LATEST_PATH) { bucket.beforeWrite = null; bucket.seed(path, competitor.feed) } }
    assert.deepEqual(await publishDaily(bucket, value, now), { status })
    assert.deepEqual(bucket.json(AI_FEED_LATEST_PATH), competitor.feed)
    assert.equal(bucket.writes.filter(w => w.path === AI_FEED_LATEST_PATH).length, 0)
  })
}

test('generation競合は5回で打ち切り、無限再試行もpublished保存もしない', async () => {
  const bucket = fakeBucket(), value = daily(), old = daily('2026-11-03')
  let attempts = 0, reads = 0
  const read = bucket.read.bind(bucket)
  bucket.read = async path => { if (path === AI_FEED_LATEST_PATH) reads++; return read(path) }
  bucket.beforeWrite = async path => { if (path === AI_FEED_LATEST_PATH) { attempts++; if (attempts > 5) throw new Error('再試行上限を超えた'); bucket.seed(path, old.feed) } }
  await assert.rejects(publishDaily(bucket, value, now))
  assert.equal(attempts, 5)
  assert.equal(reads, 5)
  assert.equal(bucket.objects.has(aiFeedPublishedPath(value.feedDate)), false)
})

test('daily保存直後の停止は再実行で公開を完了する', async () => {
  const bucket = fakeBucket(), value = daily()
  await saveDailyIfAbsent(bucket, value)
  assert.equal(bucket.objects.has(AI_FEED_LATEST_PATH), false)
  await publishDaily(bucket, bucket.json(aiFeedDailyPath(value.feedDate)), now)
  assert.deepEqual(bucket.json(AI_FEED_LATEST_PATH), value.feed)
  assert.equal(bucket.objects.has(aiFeedPublishedPath(value.feedDate)), true)
})

test('latest保存後に停止しても再実行はpublishedだけを保存する', async () => {
  const bucket = fakeBucket(), value = daily()
  await saveDailyIfAbsent(bucket, value)
  bucket.beforeWrite = async path => { if (path === aiFeedPublishedPath(value.feedDate)) throw new Error('停止') }
  await assert.rejects(publishDaily(bucket, value, now), /停止/)
  const generation = bucket.objects.get(AI_FEED_LATEST_PATH).generation
  bucket.beforeWrite = null
  assert.deepEqual(await publishDaily(bucket, value, now), { status: 'already' })
  assert.equal(bucket.objects.get(AI_FEED_LATEST_PATH).generation, generation)
  assert.equal(bucket.writes.filter(w => w.path === AI_FEED_LATEST_PATH).length, 1)
  assert.equal(bucket.json(aiFeedPublishedPath(value.feedDate)).latestGeneration, generation)
})

for (const mode of ['一致', '不一致', '原本なし']) {
  test(`翌日の公開で前日原本が${mode}なら一致時だけ前日publishedを先に補完する`, async () => {
    const bucket = fakeBucket(), old = daily('2026-11-03'), value = daily()
    const generation = bucket.seed(AI_FEED_LATEST_PATH, old.feed)
    if (mode !== '原本なし') bucket.seed(aiFeedDailyPath(old.feedDate), mode === '一致' ? old : daily(old.feedDate, '異なる原本'))
    await publishDaily(bucket, value, now)
    const path = aiFeedPublishedPath(old.feedDate)
    assert.equal(bucket.objects.has(path), mode === '一致')
    if (mode === '一致') {
      assert.ok(bucket.writes.findIndex(w => w.path === path) < bucket.writes.findIndex(w => w.path === AI_FEED_LATEST_PATH))
      assert.deepEqual(bucket.json(path), { feedDate: old.feedDate, revision: old.feed.revision, publishedAt: now, latestGeneration: generation })
    }
    assert.deepEqual(bucket.json(AI_FEED_LATEST_PATH), value.feed)
    assert.equal(bucket.writes.find(w => w.path === AI_FEED_LATEST_PATH).opts.ifGenerationMatch, generation)
  })
}

test('published保存の競合は既存記録を保持して成功する', async () => {
  const bucket = fakeBucket(), value = daily()
  const record = { feedDate: value.feedDate, revision: value.feed.revision, publishedAt: now, latestGeneration: 'fiction-generation' }
  bucket.beforeWrite = async path => { if (path === aiFeedPublishedPath(value.feedDate)) { bucket.beforeWrite = null; bucket.seed(path, record) } }
  assert.deepEqual(await publishDaily(bucket, value, now), { status: 'published' })
  assert.deepEqual(bucket.json(aiFeedPublishedPath(value.feedDate)), record)
})

for (const operation of ['save', 'publish']) {
  for (const level of ['feed', 'article']) for (const key of ['uid', 'sharedScore', 'displayScore', 'date', 'unknownField']) {
    test(`${operation}は${level}の契約外キー${key}を拒否して何も書かない`, async () => {
      const bucket = fakeBucket(), value = daily()
      const target = level === 'feed' ? value.feed : value.feed.articles[0]
      target[key] = '架空値'
      if (level === 'article') value.feed.revision = computeFeedRevision(value.feed)
      await assert.rejects(async () => operation === 'save' ? saveDailyIfAbsent(bucket, value) : publishDaily(bucket, value, now))
      assert.equal(bucket.writes.length, 0)
    })
  }
  for (const invalid of ['count', 'summary', 'url', 'revision', 'date']) {
    test(`${operation}はvalidator不適合${invalid}を拒否しlatestを維持する`, async () => {
      const bucket = fakeBucket(), value = daily(), old = daily('2026-11-03')
      bucket.seed(AI_FEED_LATEST_PATH, old.feed)
      if (invalid === 'count') value.feed.totalCount = 2
      if (invalid === 'summary') value.feed.articles[0].summary = ''
      if (invalid === 'url') value.feed.articles[0].url = 'http://example.com/unsafe'
      if (invalid === 'revision') value.feed.revision = 'invalid'
      if (invalid === 'date') value.feed.feedDate = '2026-02-30'
      await assert.rejects(async () => operation === 'save' ? saveDailyIfAbsent(bucket, value) : publishDaily(bucket, value, now))
      assert.equal(bucket.writes.length, 0)
      assert.deepEqual(bucket.json(AI_FEED_LATEST_PATH), old.feed)
    })
  }
}

test('UTF-8で1MiB超のfeedは公開せずlatestを維持する', async () => {
  const bucket = fakeBucket(), value = daily(), old = daily('2026-11-03')
  bucket.seed(AI_FEED_LATEST_PATH, old.feed)
  value.feed.articles[0].summary = 'あ'.repeat(400000)
  value.feed.revision = computeFeedRevision(value.feed)
  assert.ok(Buffer.byteLength(JSON.stringify(value.feed), 'utf8') > 1048576)
  await assert.rejects(publishDaily(bucket, value, now))
  assert.equal(bucket.writes.length, 0)
  assert.deepEqual(bucket.json(AI_FEED_LATEST_PATH), old.feed)
})
