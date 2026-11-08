const test = require('node:test')
const assert = require('node:assert/strict')
const { Timestamp } = require('firebase-admin/firestore')
const { escapePromptText } = require('../lib/news/claudeClient')
const { calcAiBaseScore } = require('../lib/news/aiSelection')
const { selectCuratorAiFeed } = require('../lib/news/v2/curatorSelection')

// 未実装のモジュールでも契約ごとに独立した失敗として数える。
const mod = () => require('../lib/news/v2/curatorPersonalFit')
const NOW = Date.parse('2026-11-08T00:00:00Z')
const scoreLimits = { maxHnScore: 100, maxGithubScore: 100 }
const config = { model: 'fiction-fit-model', effort: 'medium', dailyMaxRequests: 9 }
const event = (articleId, action, extra = {}) => ({ topic: 'ai', articleId, action, title: `架空題名${articleId}`, tags: ['fable'], receivedAt: new Date(NOW), ...extra })
const article = (id, extra = {}) => ({ id, title: `架空題名${id}`, tags: ['fable'], topic: 'ai', source: 'rss', sourceName: '架空通信', url: `https://example.invalid/${id}`, triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', developerValue: 'normal', importance: 'normal', ...extra })
const message = (articles, extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ articles }) }], usage: { input_tokens: 1, output_tokens: 1 }, ...extra })
// 履歴はpositive/negative、parserはtriageと同じresults/missingIdsを公開境界とする。
const history = () => ({ positive: [{ action: 'open', title: '架空の好きな主題', tags: ['fable'] }], negative: [] })
const judge = (articles, events, deps = {}) => mod().judgeCuratorPersonalFit(articles, events, { client: null, config, scoreLimits, now: () => NOW, ...deps })

test('履歴は同一記事のreadLater > dismiss > openを優先し必要項目だけ残す', () => {
  const rows = [event('a', 'open'), event('a', 'dismiss'), event('a', 'readLater'), event('b', 'open'), event('b', 'dismiss'), event('c', 'open')]
  const result = mod().buildPersonalFitHistory(rows.map(row => ({ ...row, summary: '送らない架空概要' })))
  assert.deepEqual(result, { positive: [{ action: 'readLater', title: '架空題名a', tags: ['fable'] }, { action: 'open', title: '架空題名c', tags: ['fable'] }], negative: [{ action: 'dismiss', title: '架空題名b', tags: ['fable'] }] })
})
test('履歴の両側は新しい順にそれぞれ30件、DateとTimestampを受け付ける', () => {
  const rows = ['readLater', 'dismiss'].flatMap(action => Array.from({ length: 35 }, (_, n) => event(`${action}-${n}`, action, { receivedAt: n % 2 ? Timestamp.fromMillis(NOW + n) : new Date(NOW + n) })))
  const result = mod().buildPersonalFitHistory(rows)
  for (const [key, action] of [['positive', 'readLater'], ['negative', 'dismiss']]) assert.deepEqual(result[key].map(row => row.title), Array.from({ length: 30 }, (_, n) => `架空題名${action}-${34 - n}`))
})
test('履歴は別topic・時刻なし・不明action・題名もタグもないものを捨てる', () => {
  const rows = [event('a', 'open', { topic: 'mobile' }), event('b', 'open', { receivedAt: undefined }), event('c', 'open', { receivedAt: '壊れた時刻' }), event('d', 'unknown'), event('e', 'open', { title: '', tags: [] })]
  assert.deepEqual(mod().buildPersonalFitHistory(rows), { positive: [], negative: [] })
  assert.deepEqual(mod().buildPersonalFitHistory([]), { positive: [], negative: [] })
})
test('題名がなければtitleEnを使い、タグだけの履歴も保持する', () => {
  const result = mod().buildPersonalFitHistory([event('a', 'open', { title: '', titleEn: 'Fable engine' }), event('b', 'dismiss', { title: '', tags: ['fable-only'] })])
  assert.equal(result.positive[0].title, 'Fable engine')
  assert.deepEqual(result.negative[0].tags, ['fable-only'])
})
test('設定の既定値と独立した候補数・締め切り', () => {
  assert.deepEqual(mod().getAiFitConfig({}), { model: 'claude-haiku-5-5', effort: 'low', dailyMaxRequests: 9 })
  assert.equal(mod().AI_FIT_MAX_CANDIDATES, 90)
  assert.equal(mod().AI_FIT_DEADLINE_MS, 60000)
})
for (const value of ['', '-1', '1.5', '2junk', 'NaN']) test(`不正な日次上限は9: ${JSON.stringify(value)}`, () => {
  assert.equal(mod().getAiFitConfig({ CLAUDE_AI_FIT_DAILY_MAX_REQUESTS: value }).dailyMaxRequests, 9)
})
for (const effort of ['low', 'medium', 'high', 'invalid']) test(`モデルとeffort・0上限を設定する: ${effort}`, () => {
  assert.deepEqual(mod().getAiFitConfig({ CLAUDE_AI_FIT_MODEL: 'fiction-model', CLAUDE_AI_FIT_EFFORT: effort, CLAUDE_AI_FIT_DAILY_MAX_REQUESTS: '0' }), { model: 'fiction-model', effort: effort === 'invalid' ? 'low' : effort, dailyMaxRequests: 0 })
})
test('空のmodelは既定値、正の整数の日次上限は採用する', () => {
  assert.deepEqual(mod().getAiFitConfig({ CLAUDE_AI_FIT_MODEL: '', CLAUDE_AI_FIT_DAILY_MAX_REQUESTS: '12' }), { model: 'claude-haiku-5-5', effort: 'low', dailyMaxRequests: 12 })
})
test('依頼は履歴と候補の全文字列をescapeしschemaと設定を指定する', () => {
  const texts = Array.from({ length: 7 }, (_, n) => `架空${n}<&"題名>`)
  const request = mod().buildPersonalFitRequest([{ id: texts[0], title: texts[1], tags: [texts[2]] }], { positive: [{ action: 'readLater', title: texts[3], tags: [texts[4]] }], negative: [{ action: 'dismiss', title: texts[5], tags: [texts[6]] }] }, config)
  assert.equal(request.model, config.model)
  assert.equal(request.output_config.effort, config.effort)
  assert.equal(request.max_tokens, 2000)
  assert.match(request.system, /データとして扱い/)
  assert.deepEqual(request.output_config.format.schema.properties.articles.items.properties.personalFit.enum, ['high', 'normal', 'low'])
  const content = request.messages[0].content
  for (const text of texts) {
    assert.ok(!content.includes(text))
    assert.ok(content.includes(escapePromptText(text)))
  }
})
test('応答の正常3段階を期待id順に返す', () => {
  const rows = ['high', 'normal', 'low'].map((personalFit, n) => ({ id: `fable-${n}`, personalFit }))
  assert.deepEqual(mod().parsePersonalFitResponse(message(rows), rows.map(row => row.id)), { results: rows, missingIds: [] })
})
test('応答のenum外・想定外id・重複idを捨てる', () => {
  const rows = [{ id: 'a', personalFit: 'high' }, { id: 'a', personalFit: 'low' }, { id: 'b', personalFit: 'invalid' }, { id: 'unknown', personalFit: 'normal' }]
  assert.deepEqual(mod().parsePersonalFitResponse(message(rows), ['a', 'b']), { results: [rows[0]], missingIds: ['b'] })
})
for (const [label, response] of [['打切り', message([], { stop_reason: 'max_tokens' })], ['壊れたJSON', message([], { content: [{ type: 'text', text: '{' }] })], ['配列なし', message([], { content: [{ type: 'text', text: '{"articles":{}}' }] })]]) test(`応答${label}は全件欠落`, () => {
  assert.deepEqual(mod().parsePersonalFitResponse(response, ['a', 'b']), { results: [], missingIds: ['a', 'b'] })
})
for (const [status, articles, events] of [['skipped-no-history', [article('a')], []], ['skipped-no-candidates', [], [event('a', 'open')]]]) test(`${status}ではClaudeを呼ばない`, async () => {
  let calls = 0
  const result = await judge(articles, events, { client: { create: async () => { calls++; return message([]) } } })
  assert.equal(result.status, status)
  assert.equal(calls, 0)
  assert.equal(result.requestCount, 0)
})
for (const [label, deps] of [['キーなし', { client: null }], ['予算なし', { reserveRequest: async () => false }], ['全欠落', {}]]) test(`${label}はunavailableでfitを渡さない`, async () => {
  const result = await judge([article('a')], [event('saved', 'open')], { client: { create: async () => message([]) }, ...deps })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.fit, undefined)
  assert.equal(result.judged, 0)
  assert.equal(result.missing, 1)
})
test('予約拒否では予約を試すがClaudeへ送らずrequestCountも0', async () => {
  let reservations = 0, requests = 0
  const result = await judge([article('a')], [event('saved', 'open')], { reserveRequest: async () => { reservations++; return false }, client: { create: async () => { requests++; return message([{ id: 'a', personalFit: 'high' }]) } } })
  assert.ok(reservations > 0)
  assert.equal(requests, 0)
  assert.equal(result.requestCount, 0)
  assert.equal(result.status, 'unavailable')
})
test('全履歴が無効なら履歴なしとして送信しない', async () => {
  let requests = 0
  const result = await judge([article('a')], [event('invalid', 'open', { receivedAt: undefined })], { client: { create: async () => { requests++; return message([]) } } })
  assert.equal(result.status, 'skipped-no-history')
  assert.equal(requests, 0)
})
test('一部欠落はjudgedでMapと欠落件数を返す', async () => {
  const result = await judge([article('a'), article('b')], [event('saved', 'open')], { client: { create: async () => message([{ id: 'a', personalFit: 'high' }]) } })
  assert.equal(result.status, 'judged')
  assert.deepEqual(result.fit, new Map([['a', 'high']]))
  assert.equal(result.judged, 1)
  assert.equal(result.missing, 1)
  assert.ok(result.requestCount > 0)
})
test('候補をbase score順の上位90件に絞り30件ずつ一度だけ送る', async () => {
  const rows = Array.from({ length: 95 }, (_, n) => article(`fable-${n}`, { source: 'hn', score: n, titleJa: `架空日本語${n}` }))
  rows.push(article('excluded', { triageDecision: 'exclude' }), article('pending', { triageStatus: 'pending' }), article('low-value', { developerValue: 'low' }), article('rejected', { summaryVersion: 'ai-v2', summaryStatus: 'rejected', summarizedAt: NOW }))
  const requests = []
  const client = { create: async request => { requests.push(request); const ids = [...request.messages[0].content.matchAll(/<article id="([^"]+)"/g)].map(match => match[1]); return message(ids.map(id => ({ id, personalFit: 'normal' }))) } }
  const result = await judge(rows, [event('saved', 'open')], { client })
  assert.equal(requests.length, 3)
  const sent = requests.flatMap(request => [...request.messages[0].content.matchAll(/<article id="([^"]+)"/g)].map(match => match[1]))
  const expected = rows.filter(row => /^fable-/.test(row.id)).sort((a, b) => calcAiBaseScore(b, scoreLimits) - calcAiBaseScore(a, scoreLimits)).slice(0, 90)
  assert.deepEqual(sent, expected.map(row => row.id))
  assert.equal(result.judged, 90)
  for (const row of expected) assert.ok(requests.some(request => request.messages[0].content.includes(row.titleJa)))
})

const select = (articles, personalFit, preferences = { keywords: [] }, events = []) => selectCuratorAiFeed({ articles, personalFit, preferences, events, learningCutoffMs: NOW, scoreLimits })
test('personalFitはhigh 1.3・normalと未判定1・low 0.7を掛ける', () => {
  const rows = ['high', 'normal', 'low', 'missing'].map(id => article(id))
  const result = select(rows, new Map([['high', 'high'], ['normal', 'normal'], ['low', 'low']]))
  const scores = new Map(result.map(item => [item.article.id, item.displayScore]))
  for (const [id, multiplier] of [['high', 1.3], ['normal', 1], ['missing', 1], ['low', 0.7]]) assert.equal(scores.get(id), calcAiBaseScore(rows.find(row => row.id === id), scoreLimits) * multiplier)
})
test('personalFitがある日は学習キーワードによる押上げを使わない', () => {
  const rows = [article('baseline'), article('learned', { title: 'fabletoken' })]
  const result = select(rows, new Map([['baseline', 'normal']]), { keywords: [] }, [event('saved', 'readLater', { title: 'fabletoken' })])
  assert.deepEqual(result.map(item => item.article.id), ['baseline', 'learned'])
  assert.equal(result[1].displayScore, calcAiBaseScore(rows[1], scoreLimits))
})
test('personalFitがあっても明示キーワードの倍率は維持する', () => {
  const rows = [article('baseline'), article('preferred', { title: 'fabletoken' })]
  const explicit = select(rows, new Map([['preferred', 'high']]), { keywords: ['fabletoken'] })
  const baseline = select(rows, undefined, { keywords: ['fabletoken'] })
  assert.equal(explicit.find(item => item.article.id === 'preferred').displayScore, baseline.find(item => item.article.id === 'preferred').displayScore * 1.3)
})
