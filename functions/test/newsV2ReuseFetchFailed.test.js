const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const { planAiArticleProcessing, buildReusedAiArticle } = require('../lib/news/collectArticles')

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-28T00:00:00Z')
const fetchedAt = admin.firestore.Timestamp.fromDate(new Date(NOW))
const raw = (overrides = {}) => ({
  title: 'Sample title', description: 'Sample description', url: 'https://example.com/articles/tool',
  thumbnailUrl: null, topic: 'ai', source: 'hn', sourceName: 'Hacker News', score: 100,
  generalSource: true, publishedAt: new Date('2026-10-27T00:00:00Z'), ...overrides,
})
const existing = (overrides = {}) => ({
  ...raw(), score: 5, source: 'rss', sourceName: 'Example AI', generalSource: false,
  publishedAt: admin.firestore.Timestamp.fromDate(new Date('2026-10-25T00:00:00Z')),
  fetchedAt: admin.firestore.Timestamp.fromDate(new Date('2026-10-26T00:00:00Z')),
  date: '2026-10-26', triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include',
  category: 'llm_engineering', triagedAt: NOW - DAY_MS, relevant: true, importance: 'high',
  developerValue: 'high', readReason: '理由', tags: ['llm'], content: 'Saved content', ...overrides,
})

test('本文取得失敗フラグ付きの記事は再利用に回さず取り直し対象にする', () => {
  const r = raw()
  const plan = planAiArticleProcessing([r], [existing({ content: '', contentFetchFailed: true })], NOW)
  assert.equal(plan.reuse.length, 0)
  assert.deepEqual(plan.fresh, [r])
})

test('本文取得失敗フラグが false の記事は従来どおり再利用する', () => {
  const plan = planAiArticleProcessing([raw()], [existing({ contentFetchFailed: false })], NOW)
  assert.equal(plan.reuse.length, 1)
  assert.equal(plan.fresh.length, 0)
})

test('フラグ無しの記事は従来どおり再利用する', () => {
  const plan = planAiArticleProcessing([raw()], [existing()], NOW)
  assert.equal(plan.reuse.length, 1)
  assert.equal(plan.fresh.length, 0)
})

test('buildReusedAiArticle は本文取得失敗の空本文とフラグを引き継がない', () => {
  const result = buildReusedAiArticle(raw(), existing({ content: '', contentFetchFailed: true }), '2026-10-28', fetchedAt)
  assert.notEqual(result.content, '')
  assert.equal(result.contentFetchFailed, undefined)
})

test('buildReusedAiArticle は正常な本文とフラグ false を従来どおり引き継ぐ', () => {
  const result = buildReusedAiArticle(raw(), existing({ contentFetchFailed: false }), '2026-10-28', fetchedAt)
  assert.equal(result.content, 'Saved content')
  assert.equal(result.contentFetchFailed, false)
})
