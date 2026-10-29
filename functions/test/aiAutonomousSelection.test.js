const test = require('node:test')
const assert = require('node:assert/strict')
const { buildTriageRequest, parseTriageResponse } = require('../lib/news/aiClaudeTriage')

const config = { model: 'test-model', effort: 'low', dailyMaxRequests: 1 }
const INCLUDE_CATEGORIES = ['coding_agent', 'llm_engineering', 'ai_security', 'model_capability', 'ml_engineering', 'ai_dev_tool']
const EXCLUDE_CATEGORIES = ['business_policy', 'promotion', 'end_user_usage', 'incidental_ai', 'general_commentary', 'not_ai']

// v2 の autonomous 応答。relevant は出力させず、category と decision を返させる。
const result = overrides => ({
  id: 'candidate', category: 'llm_engineering', decision: 'include', importance: 'normal', tags: ['llm'],
  developerValue: 'high', readReason: 'モデルの評価方法を実装へ取り入れられる', ...overrides,
})
const message = articles => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ articles }) }],
})
const parse = overrides => parseTriageResponse(message([result(overrides)]), ['candidate'], true)
// 不正な項目を、正常な記事と並べて送る。正常な記事は採用され、不正な記事だけが missing になる。
const parseBeside = overrides => parseTriageResponse(
  message([result({ id: 'good' }), result({ id: 'bad', ...overrides })]), ['good', 'bad'], true)
const expectOnlyBadMissing = (parsed, label) => {
  assert.deepEqual(parsed.results.map(item => item.id), ['good'], label)
  assert.deepEqual(parsed.missingIds, ['bad'], label)
}
const autonomousItems = () => buildTriageRequest([{
  id: 'candidate', sourceName: '架空の技術フィード', domain: 'example.com',
  title: 'モデル評価の実装方法', description: '比較実験の具体的な手順を紹介する',
}], config, true).output_config.format.schema.properties.articles.items

test('autonomous の schema は category と decision を必須にし relevant を出力させない', () => {
  const items = autonomousItems()
  assert.deepEqual([...items.required].sort(),
    ['category', 'decision', 'developerValue', 'id', 'importance', 'readReason', 'tags'])
  assert.equal(items.additionalProperties, false)
  assert.equal('relevant' in items.properties, false)
  assert.deepEqual([...items.properties.category.enum].sort(), [...INCLUDE_CATEGORIES, ...EXCLUDE_CATEGORIES].sort())
  assert.deepEqual([...items.properties.decision.enum].sort(), ['exclude', 'hold', 'include'])
  assert.deepEqual(items.properties.developerValue.enum, ['high', 'normal', 'low'])
  assert.deepEqual(items.properties.importance.enum, ['high', 'normal', 'low'])
  assert.equal(items.properties.readReason.type, 'string')
  assert.equal(items.properties.readReason.maxLength, 160)
})

test('autonomous の system は category と decision と hold と全カテゴリ名を含む', () => {
  const request = buildTriageRequest([], config, true)
  assert.match(request.system, /category/)
  assert.match(request.system, /decision/)
  assert.match(request.system, /hold/)
  assert.match(request.system, /developerValue/)
  assert.match(request.system, /readReason/)
  for (const name of [...INCLUDE_CATEGORIES, ...EXCLUDE_CATEGORIES]) {
    assert.ok(request.system.includes(name), name)
  }
})

test('非 autonomous の schema は従来どおり relevant を要求し category を含まない', () => {
  const request = buildTriageRequest([], config)
  const items = request.output_config.format.schema.properties.articles.items
  assert.deepEqual(items.required, ['id', 'relevant', 'importance', 'tags'])
  assert.equal('category' in items.properties, false)
})

test('include の判定は category と decision と readReason を保持し relevant を true にする', () => {
  const parsed = parse({ importance: 'low' })
  assert.deepEqual(parsed.missingIds, [])
  const [item] = parsed.results
  assert.equal(item.category, 'llm_engineering')
  assert.equal(item.decision, 'include')
  assert.equal(item.relevant, true)
  assert.equal(item.importance, 'low')
  assert.equal(item.developerValue, 'high')
  assert.equal(item.readReason, 'モデルの評価方法を実装へ取り入れられる')
})

test('hold の判定は relevant を true にして本文取得へ送れるようにする', () => {
  const parsed = parse({ decision: 'hold', category: 'ai_dev_tool', developerValue: 'normal' })
  assert.deepEqual(parsed.missingIds, [])
  assert.equal(parsed.results[0].decision, 'hold')
  assert.equal(parsed.results[0].relevant, true)
})

test('対象側カテゴリでも decision が exclude なら relevant は false', () => {
  const parsed = parse({ decision: 'exclude', category: 'coding_agent', developerValue: 'low', readReason: '' })
  assert.deepEqual(parsed.missingIds, [])
  assert.equal(parsed.results[0].decision, 'exclude')
  assert.equal(parsed.results[0].relevant, false)
})

test('対象外側カテゴリは decision が include でも exclude に置き換えて relevant を false にする', () => {
  for (const category of EXCLUDE_CATEGORIES) {
    for (const decision of ['include', 'hold']) {
      const parsed = parse({ category, decision, developerValue: 'low', readReason: '対象外の理由' })
      assert.deepEqual(parsed.missingIds, [], `${category}/${decision}`)
      assert.equal(parsed.results[0].category, category)
      assert.equal(parsed.results[0].decision, 'exclude', `${category}/${decision}`)
      assert.equal(parsed.results[0].relevant, false, `${category}/${decision}`)
    }
  }
})

test('exclude 以外で readReason が空なら採用せず missing にする', () => {
  for (const decision of ['include', 'hold']) {
    for (const readReason of ['', '   ']) {
      expectOnlyBadMissing(parseBeside({ decision, readReason }), `${decision}/${JSON.stringify(readReason)}`)
    }
  }
})

test('exclude の判定は readReason が空でも採用する', () => {
  const parsed = parse({ decision: 'exclude', category: 'promotion', developerValue: 'low', readReason: '' })
  assert.deepEqual(parsed.missingIds, [])
  assert.equal(parsed.results[0].readReason, '')
  assert.equal(parsed.results[0].developerValue, 'low')
})

test('対象外側カテゴリは readReason が空でも exclude として受理する', () => {
  for (const decision of ['include', 'hold', 'exclude']) {
    const parsed = parse({ category: 'business_policy', decision, developerValue: 'low', readReason: '' })
    assert.deepEqual(parsed.missingIds, [], decision)
    assert.equal(parsed.results[0].decision, 'exclude', decision)
    assert.equal(parsed.results[0].relevant, false, decision)
  }
})

test('不正な category または decision を含む判定は採用しない', () => {
  for (const overrides of [
    { category: 'unknown_category' }, { category: undefined }, { category: 123 },
    { decision: 'maybe' }, { decision: undefined }, { decision: true },
  ]) {
    expectOnlyBadMissing(parseBeside(overrides), JSON.stringify(overrides))
  }
})

test('不正な価値または読む理由を含む判定は採用しない', () => {
  for (const overrides of [{ developerValue: 'urgent' }, { readReason: 123 }, { readReason: 'あ'.repeat(161) }]) {
    expectOnlyBadMissing(parseBeside(overrides), JSON.stringify(overrides))
  }
})

test('開発者への価値と世間での重要度は独立した値として応答から保持する', () => {
  const parsed = parse({ importance: 'low', developerValue: 'normal' })
  assert.equal(parsed.results[0].importance, 'low')
  assert.equal(parsed.results[0].developerValue, 'normal')
})
