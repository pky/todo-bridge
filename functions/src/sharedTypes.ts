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
