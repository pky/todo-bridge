const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

test('管理者イベントのtopicとreceivedAtによる範囲取得をcollection scopeの複合indexで支える', () => {
  const { indexes } = JSON.parse(readFileSync(resolve(__dirname, '../../firestore.indexes.json'), 'utf8'))
  assert.ok(indexes.some(index => index.collectionGroup === 'newsActionEvents'
    && index.queryScope === 'COLLECTION'
    && index.fields.length === 2
    && index.fields[0].fieldPath === 'topic' && index.fields[0].order === 'ASCENDING'
    && index.fields[1].fieldPath === 'receivedAt' && index.fields[1].order === 'ASCENDING'),
  'newsActionEventsのtopic ASC、receivedAt ASCのindexが必要')
})
