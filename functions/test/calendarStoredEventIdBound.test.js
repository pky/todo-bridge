const test = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const {
  buildTaskCalendarEventId,
  isStoredTaskCalendarEventId,
} = require('../lib/taskCalendarRegistration')

// 保存IDの照合は最大100世代に制限し、入力値に比例する大量のハッシュ計算を防ぐ。
const MAX_VERSION = 100

test('100万世代と一致しないランダムIDの照合を50ms未満で拒否する', () => {
  const storedId = randomBytes(32).toString('hex')
  const started = process.hrtime.bigint()
  const accepted = isStoredTaskCalendarEventId(storedId, 'space-1', 'task-1', 1_000_000)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000
  assert.equal(accepted, false)
  assert.ok(elapsedMs < 50, `照合時間 ${elapsedMs.toFixed(2)}ms は50ms未満であること`)
})

for (const currentVersion of [MAX_VERSION + 1, 1_000_000]) {
  for (const version of [0, currentVersion]) {
    test(`上限を超える現在世代${currentVersion}では自分の世代${version}のIDも拒否する`, () => {
      const id = buildTaskCalendarEventId('space-1', 'task-1', version)
      assert.equal(isStoredTaskCalendarEventId(id, 'space-1', 'task-1', currentVersion), false)
    })
  }
}

for (const version of [0, 1, 2, 3]) {
  test(`現在世代3では自分の世代${version}のIDを採用する`, () => {
    const id = buildTaskCalendarEventId('space-1', 'task-1', version)
    assert.equal(isStoredTaskCalendarEventId(id, 'space-1', 'task-1', 3), true)
  })
}

test('上限100の世代そのものは採用できる', () => {
  const id = buildTaskCalendarEventId('space-1', 'task-1', MAX_VERSION)
  assert.equal(isStoredTaskCalendarEventId(id, 'space-1', 'task-1', MAX_VERSION), true)
})
