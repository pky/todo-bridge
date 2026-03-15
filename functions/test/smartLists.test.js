const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const {
  buildSmartListCountsDocPath,
  getJstDayBoundaries,
  categorizeTask,
} = require('../lib/smartLists')

test('legacy smartListCounts は users 配下に保存する', () => {
  assert.equal(buildSmartListCountsDocPath('user-1'), 'users/user-1')
})

test('space smartListCounts は spaces ドキュメントに保存する', () => {
  assert.equal(buildSmartListCountsDocPath('user-1', 'family-1'), 'spaces/family-1')
})

test('JST基準の週末境界を正しく計算する', () => {
  const now = new Date('2026-03-10T03:00:00.000Z') // JST 2026-03-10 12:00
  const { todayStart, weekEnd } = getJstDayBoundaries(now)

  assert.equal(todayStart.toISOString(), '2026-03-09T15:00:00.000Z')
  assert.equal(weekEnd.toISOString(), '2026-03-15T14:59:59.999Z')
})

test('今週の期限タスクを thisWeek に含める', () => {
  const now = new Date('2026-03-10T03:00:00.000Z') // JST 2026-03-10
  const categories = categorizeTask({
    name: '買い物',
    listId: 'list-1',
    completed: false,
    priority: 4,
    tags: [],
    dueDate: admin.firestore.Timestamp.fromDate(new Date('2026-03-13T03:00:00.000Z')),
  }, now)

  assert.equal(categories.includes('thisWeek'), true)
})

test('JSTの今日に設定した終日タスクを today に含める', () => {
  const now = new Date('2026-03-10T03:00:00.000Z') // JST 2026-03-10
  const categories = categorizeTask({
    name: '今日のタスク',
    listId: 'list-1',
    completed: false,
    priority: 4,
    tags: [],
    // ブラウザで 2026-03-10 の終日を保存したときの JST 00:00
    dueDate: admin.firestore.Timestamp.fromDate(new Date('2026-03-09T15:00:00.000Z')),
  }, now)

  assert.equal(categories.includes('today'), true)
})
