const test = require('node:test')
const assert = require('node:assert/strict')
const exported = require('../lib/index')
for (const name of ['searchTask', 'migrateUserToPersonalSpace', 'checkPersonalSpaceMigration']) {
  test(`${name}: 公開exportから削除されている`, () => assert.equal(Object.hasOwn(exported, name), false))
}
for (const name of ['manualBackup', 'listBackups', 'restoreFromBackup', 'migrateCurrentUserToPersonalSpace', 'searchTasks']) {
  test(`${name}: 現行callableのexportを維持する`, () => assert.equal(typeof exported[name]?.run, 'function'))
}
