import type { Timestamp } from 'firebase/firestore'

export type SpaceType = 'personal' | 'family'
export type SpaceRole = 'owner' | 'member'
export type SpaceMemberStatus = 'active'

export interface SpaceMeta {
  id: string
  name: string
  type: SpaceType
  ownerUid: string
  memberCount: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface SpaceMember {
  uid: string
  displayName: string | null
  email: string | null
  role: SpaceRole
  status: SpaceMemberStatus
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface UserMembership {
  spaceId: string
  role: SpaceRole
  status: SpaceMemberStatus
  displayName: string | null
  joinedAt: Timestamp | null
}

export interface SpaceCalendarSettings {
  calendarId: string | null
  calendarEmail: string | null
  calendarRefreshToken: string | null
  updatedAt: Timestamp | null
}
