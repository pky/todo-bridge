const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const { matchesTaskSearchTerms } = require('../lib/searchApi')

test('タスク検索はメモ本文を対象にする', () => {
  const task = {
    name: '会議準備',
    tags: [],
    notes: ['議事録に予算レビューの内容を残す'],
  }

  assert.equal(matchesTaskSearchTerms(task, ['予算レビュー']), true)
})

test('タスク検索は複数語を名前、タグ、メモにまたがって判定する', () => {
  const task = {
    name: '会議準備',
    tags: ['仕事'],
    notes: ['議事録に予算レビューの内容を残す'],
  }

  assert.equal(matchesTaskSearchTerms(task, ['会議', '仕事', '予算レビュー']), true)
})

