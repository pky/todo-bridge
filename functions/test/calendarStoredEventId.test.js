// 期待する純粋API: taskCalendarRegistration の isStoredTaskCalendarEventId(storedId: string, spaceId: string, taskId: string, currentVersion: number): boolean。
// 同タスクのversion 0〜currentVersionに一致する決定的IDだけをupdate対象に採用する。
const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })
const {
  buildTaskCalendarEventId,
  isStoredTaskCalendarEventId,
} = require('../lib/taskCalendarRegistration')

for (const version of [0, 1, 2]) {
  test(`同タスクの過去から現在までの決定的IDを採用する: version ${version}`, () => {
    const id = buildTaskCalendarEventId('space-1', 'task-1', version)
    assert.equal(isStoredTaskCalendarEventId(id, 'space-1', 'task-1', 2), true)
  })
}

for (const [name, id] of [
  ['任意の保存ID', 'unrelated-event'],
  ['別タスクのID', buildTaskCalendarEventId('space-1', 'task-2', 0)],
  ['別スペースのID', buildTaskCalendarEventId('space-2', 'task-1', 0)],
  ['未来versionのID', buildTaskCalendarEventId('space-1', 'task-1', 3)],
  ['空のID', ''],
]) {
  test(`${name}をupdate対象に採用しない`, () => {
    assert.equal(isStoredTaskCalendarEventId(id, 'space-1', 'task-1', 2), false)
  })
}
