import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'

export type SpaceType = 'personal' | 'family'
export type SpaceRole = 'owner' | 'member'
export type SpaceMemberStatus = 'active'

export interface VisibilityControlled {
  spaceId?: string
  visibleToMemberIds?: string[]
  editableByMemberIds?: string[]
}

export interface SpaceMeta {
  id: string
  name: string
  type: SpaceType
  ownerUid: string
  memberCount: number
  createdAt: admin.firestore.Timestamp
  updatedAt: admin.firestore.Timestamp
}

export interface SpaceMember {
  uid: string
  displayName: string | null
  email: string | null
  role: SpaceRole
  status: SpaceMemberStatus
  createdAt: admin.firestore.Timestamp
  updatedAt: admin.firestore.Timestamp
}

export interface UserMembership {
  spaceId: string
  role: SpaceRole
  status: SpaceMemberStatus
  displayName: string | null
  joinedAt: admin.firestore.Timestamp | null
}

export interface SpaceCalendarSettings {
  calendarId: string | null
  calendarEmail: string | null
  calendarRefreshToken: string | null
  updatedAt: admin.firestore.Timestamp | null
}

export interface ScopedRequest {
  spaceId?: string
  useLegacyPath?: boolean
}

export function buildScopedCollectionPath(
  userId: string,
  collectionName: 'lists' | 'tasks' | 'tags',
  scope?: ScopedRequest
): string {
  if (!scope?.spaceId || scope.useLegacyPath) {
    return `users/${userId}/${collectionName}`
  }

  return `spaces/${scope.spaceId}/${collectionName}`
}

// スペース配下へ進む前に、呼び出し元の有効な所属を確認する。
export async function assertActiveSpaceMembership(
  userId: string,
  scope?: ScopedRequest
): Promise<void> {
  if (!scope?.spaceId || scope.useLegacyPath) return
  if (typeof scope.spaceId !== 'string' || scope.spaceId.includes('/')) {
    throw new functions.https.HttpsError('invalid-argument', '無効なスペースです')
  }
  const membership = await admin.firestore().doc(`spaces/${scope.spaceId}/members/${userId}`).get()
  if (!membership.exists || membership.data()?.status !== 'active') {
    throw new functions.https.HttpsError('permission-denied', 'スペースへのアクセス権がありません')
  }
}

export function resolveCallerUserId(
  requestedUserId: unknown,
  context: functions.https.CallableContext
): string {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
  }
  if (requestedUserId !== undefined && requestedUserId !== context.auth.uid) {
    throw new functions.https.HttpsError('permission-denied', '本人のデータだけを操作できます')
  }
  return context.auth.uid
}
