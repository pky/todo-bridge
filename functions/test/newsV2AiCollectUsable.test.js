const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })

for (const [name, result, expected] of [
  ['全ソース失敗', { sourcesSucceeded: 0, sourcesFailed: 3 }, false],
  ['成功ソースなし', { sourcesSucceeded: 0, sourcesFailed: 0 }, false],
  ['一部ソース成功', { sourcesSucceeded: 1, sourcesFailed: 2 }, true],
  ['全ソース成功', { sourcesSucceeded: 3, sourcesFailed: 0 }, true],
]) {
  test(`${name}の収集結果を公開可否に反映する`, () => {
    const { isAiCollectUsable } = require('../lib/news/collectArticles')
    assert.equal(isAiCollectUsable(result), expected)
  })
}
