const test = require('node:test')
const assert = require('node:assert/strict')

const { buildScopedCollectionPath } = require('../lib/sharedTypes')

test('legacy path のときは users 配下を返す', () => {
  assert.equal(
    buildScopedCollectionPath('user-1', 'tasks', { useLegacyPath: true }),
    'users/user-1/tasks'
  )
})

test('spaceId があるときは spaces 配下を返す', () => {
  assert.equal(
    buildScopedCollectionPath('user-1', 'tasks', { spaceId: 'personal_user-1', useLegacyPath: false }),
    'spaces/personal_user-1/tasks'
  )
})
