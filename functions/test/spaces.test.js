const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const {
  buildFamilySpaceRecord,
  buildMembershipRecord,
  buildPersonalSpaceRecord,
  buildSpaceNameUpdate,
  buildSpaceMemberRecord,
  normalizeEmail,
  isAllowedEmail,
  appendMemberToVisibility,
} = require('../lib/spaces')

test('family space record を作成する', () => {
  const now = { seconds: 1, nanoseconds: 0 }
  const result = buildFamilySpaceRecord('user-1', '家族', now)

  assert.equal(result.ownerUid, 'user-1')
  assert.equal(result.name, '家族')
  assert.equal(result.type, 'family')
  assert.equal(result.memberCount, 1)
})

test('personal space record を作成する', () => {
  const now = { seconds: 1, nanoseconds: 0 }
  const result = buildPersonalSpaceRecord('user-1', now)

  assert.equal(result.ownerUid, 'user-1')
  assert.equal(result.name, '個人スペース')
  assert.equal(result.type, 'personal')
  assert.equal(result.memberCount, 1)
})

test('membership record を作成する', () => {
  const now = { seconds: 1, nanoseconds: 0 }
  const result = buildMembershipRecord('space-1', '家族', now, 'owner', 'active')

  assert.equal(result.spaceId, 'space-1')
  assert.equal(result.displayName, '家族')
  assert.equal(result.role, 'owner')
})

test('space member record を作成する', () => {
  const now = { seconds: 1, nanoseconds: 0 }
  const result = buildSpaceMemberRecord('user-1', 'test@example.com', 'Test', now, 'owner', 'active')

  assert.equal(result.uid, 'user-1')
  assert.equal(result.email, 'test@example.com')
  assert.equal(result.displayName, 'Test')
})

test('member 用の active membership record を作成する', () => {
  const now = { seconds: 1, nanoseconds: 0 }
  const result = buildMembershipRecord('space-1', '家族', now, 'member', 'active')

  assert.equal(result.role, 'member')
  assert.equal(result.status, 'active')
  assert.equal(result.joinedAt, now)
})

test('space name update を作成する', () => {
  const now = { seconds: 1, nanoseconds: 0 }
  const result = buildSpaceNameUpdate('新しい家族', now)

  assert.equal(result.name, '新しい家族')
  assert.equal(result.updatedAt, now)
})

test('メールアドレスを正規化する', () => {
  assert.equal(normalizeEmail('  TEST@Example.COM '), 'test@example.com')
  assert.equal(normalizeEmail('   '), null)
})

test('許可メール一覧に含まれるか判定する', () => {
  assert.equal(isAllowedEmail(['owner@example.com', 'family@example.com'], ' FAMILY@example.com '), true)
  assert.equal(isAllowedEmail(['owner@example.com'], 'other@example.com'), false)
})

test('visibility 配列へ新メンバーを追加する', () => {
  const result = appendMemberToVisibility({
    visibleToMemberIds: ['owner-1'],
    editableByMemberIds: ['owner-1'],
  }, 'member-2')

  assert.deepEqual(result, {
    visibleToMemberIds: ['owner-1', 'member-2'],
    editableByMemberIds: ['owner-1', 'member-2'],
  })
})

test('visibility 配列に既に含まれる場合は更新しない', () => {
  const result = appendMemberToVisibility({
    visibleToMemberIds: ['owner-1', 'member-2'],
    editableByMemberIds: ['owner-1', 'member-2'],
  }, 'member-2')

  assert.equal(result, null)
})
