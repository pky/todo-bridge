const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const {
  buildCalendarSettingsDocPath,
  buildCalendarTaskDocPath,
} = require('../lib/calendar')

test('legacy calendar settings は users 配下に保存する', () => {
  assert.equal(buildCalendarSettingsDocPath('user-1'), 'users/user-1')
})

test('space calendar settings は spaces settings 配下に保存する', () => {
  assert.equal(
    buildCalendarSettingsDocPath('user-1', 'family-1', false),
    'spaces/family-1/settings/integrations'
  )
})

test('space calendar task path は spaces tasks 配下を返す', () => {
  assert.equal(
    buildCalendarTaskDocPath('user-1', 'task-1', 'family-1', false),
    'spaces/family-1/tasks/task-1'
  )
})
