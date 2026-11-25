const test = require('node:test')
const assert = require('node:assert/strict')
const { selectCuratorAiFeed } = require('../lib/news/v2/curatorSelection')

const cutoff = Date.parse('2026-11-25T00:00:00Z')

function article(id, overrides = {}) {
  return {
    id, title: `架空の記事 ${id}`, url: `https://example.test/${id}`, source: 'rss', sourceName: '架空通信',
    triageStatus: 'done', triageVersion: 'ai-v2', triageDecision: 'include', developerValue: 'normal', importance: 'normal',
    ...overrides,
  }
}

function select(articles, storyGroups, overrides = {}) {
  return selectCuratorAiFeed({
    articles, storyGroups, preferences: { keywords: [] }, events: [], learningCutoffMs: cutoff,
    scoreLimits: { maxHnScore: 99, maxGithubScore: 99 }, ...overrides,
  })
}

test('話題を公式の代表1件にまとめ、代表の設定とpersonalFitの倍率を合計点に掛ける', () => {
  const coverage = article('coverage', { source: 'hn', score: 9, developerValue: 'high' })
  const official = article('official', { title: '架空の評価ツールの公式発表', publisherDomain: 'openai.com', importance: 'high' })
  const repository = article('repository', { source: 'github', score: 99 })
  const solo = article('solo')
  const result = select([coverage, official, repository, solo], [['repository', 'official', 'coverage']], {
    preferences: { keywords: [{ word: '評価ツール', weight: 1.5 }] },
    personalFit: new Map([['official', 'high'], ['coverage', 'low'], ['repository', 'low']]),
  })

  assert.deepEqual(result.map(item => item.article.id), ['official', 'solo'])
  assert.deepEqual(result[0].members.map(item => item.id), ['coverage', 'repository'])
  assert.deepEqual(result[1].members, [])
  const expected = (60 + 20 + 60 * 1.5) * 1.5 * 1.3
  assert.ok(Math.abs(result[0].displayScore - expected) < 1e-9)
  assert.equal(result[1].displayScore, 90)
})

test('personalFitがなければ代表に一致する学習の倍率を話題の点数に掛ける', () => {
  const official = article('official', { title: 'fabletool', publisherDomain: 'openai.com' })
  const coverage = article('coverage', { source: 'hn', score: 99 })
  const result = select([coverage, official], [['official', 'coverage']], { events: [{
    topic: 'ai', articleId: 'history', action: 'readLater', title: 'fabletool', receivedAt: new Date(cutoff - 1000),
  }] })
  assert.deepEqual(result.map(item => [item.article.id, item.displayScore]), [['official', (60 + 60) * 1.5]])
})

test('情報源の上限は代表だけで数え、組のHN記事は独立カードとHN枠を取り合わない', () => {
  const officials = Array.from({ length: 7 }, (_, n) => article(`official-${n}`, { publisherDomain: 'openai.com' }))
  const members = officials.map((_, n) => article(`member-${n}`, { source: 'hn', score: 99 }))
  const standalone = Array.from({ length: 5 }, (_, n) => article(`hn-${n}`, { source: 'hn', score: 0 }))
  const groups = officials.map((item, n) => [item.id, members[n].id])
  const result = select([...officials, ...members, ...standalone], groups)

  assert.deepEqual(result.filter(item => item.article.source === 'rss').map(item => item.article.id), officials.slice(0, 6).map(item => item.id))
  assert.deepEqual(result.filter(item => item.article.source === 'hn').map(item => item.article.id), standalone.map(item => item.id))
})

test('代表が候補から外れたら同じ組の残りから選び直し、1件だけなら組にしない', () => {
  const first = article('first', { publisherDomain: 'openai.com', developerValue: 'high' })
  const replacement = article('replacement', { publisherDomain: 'openai.com' })
  const coverage = article('coverage', { source: 'hn', score: 99, developerValue: 'high' })
  const groups = [[first.id, replacement.id, coverage.id]]

  assert.deepEqual(select([coverage, replacement, first], groups).map(item => item.article.id), ['first'])
  const reselected = select([coverage, replacement], groups)
  assert.deepEqual(reselected.map(item => item.article.id), ['replacement'])
  assert.deepEqual(reselected[0].members.map(item => item.id), ['coverage'])
  const solo = select([coverage], groups)
  assert.deepEqual(solo.map(item => item.article.id), ['coverage'])
  assert.deepEqual(solo[0].members, [])
})
