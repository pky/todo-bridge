const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const {
  applyPersonalVisibility,
  buildPersonalSpaceId,
  createPersonalSpaceSeedData,
} = require('../lib/migrate')

test('buildPersonalSpaceId は決定的な ID を返す', () => {
  assert.equal(buildPersonalSpaceId('user-123'), 'personal_user-123')
})

test('applyPersonalVisibility は共有制御フィールドを追加する', () => {
  const result = applyPersonalVisibility({ name: 'Inbox' }, 'user-123', 'personal_user-123')

  assert.deepEqual(result, {
    name: 'Inbox',
    spaceId: 'personal_user-123',
    visibleToMemberIds: ['user-123'],
    editableByMemberIds: ['user-123'],
  })
})

test('createPersonalSpaceSeedData は personal space の初期データを作る', () => {
  const now = {
    seconds: 123,
    nanoseconds: 0,
  }

  const result = createPersonalSpaceSeedData('user-123', now, {
    displayName: 'Taro',
    email: 'taro@example.com',
  })

  assert.equal(result.spaceId, 'personal_user-123')
  assert.equal(result.spaceMeta.ownerUid, 'user-123')
  assert.equal(result.spaceMeta.type, 'personal')
  assert.equal(result.member.displayName, 'Taro')
  assert.equal(result.member.email, 'taro@example.com')
  assert.equal(result.membership.spaceId, 'personal_user-123')
  assert.equal(result.membership.role, 'owner')
})
