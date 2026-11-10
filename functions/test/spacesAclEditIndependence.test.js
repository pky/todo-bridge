const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-rertm' })

const { appendMemberToVisibility } = require('../lib/spaces')

test('共有限定ACL: 閲覧だけを共有した資源ではcarolに編集権限を追加しない', () => {
  const data = {
    visibleToMemberIds: ['alice', 'bob'],
    editableByMemberIds: ['alice'],
  }

  assert.deepEqual(appendMemberToVisibility(data, 'carol', { sharedOnly: true }), {
    visibleToMemberIds: ['alice', 'bob', 'carol'],
  })
})

test('共有限定ACL: 既存の閲覧専用メンバーcarolに編集権限を追加しない', () => {
  const data = {
    visibleToMemberIds: ['alice', 'bob', 'carol'],
    editableByMemberIds: ['alice'],
  }

  assert.equal(appendMemberToVisibility(data, 'carol', { sharedOnly: true }), null)
})

test('共有限定ACL: 閲覧と編集を共有した資源ではcarolを両方に追加する', () => {
  const data = {
    visibleToMemberIds: ['alice', 'bob'],
    editableByMemberIds: ['alice', 'bob'],
  }

  assert.deepEqual(appendMemberToVisibility(data, 'carol', { sharedOnly: true }), {
    visibleToMemberIds: ['alice', 'bob', 'carol'],
    editableByMemberIds: ['alice', 'bob', 'carol'],
  })
})
