const test = require('node:test')
const assert = require('node:assert/strict')

const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const { cleanReadmeText, AI_README_SOURCE_MAX_LENGTH } = require('../lib/news/collectArticles')

test('AI_README_SOURCE_MAX_LENGTH is 20000', () => {
  assert.equal(AI_README_SOURCE_MAX_LENGTH, 20000)
})

const cases = [
  ['unclosed badge links', '[![', 200000],
  ['unclosed angle brackets', '<', 500000],
  ['unclosed image syntax', '![a](', 100000],
]
for (const [name, unit, count] of cases) {
  test(`cleanReadmeText returns quickly and bounded for ${name}`, () => {
    const input = unit.repeat(count)
    const start = Date.now()
    const out = cleanReadmeText(input)
    const elapsed = Date.now() - start
    assert.ok(elapsed <= 1000, `took ${elapsed}ms`)
    assert.ok(out.length <= 20000, `output length ${out.length}`)
  })
}
