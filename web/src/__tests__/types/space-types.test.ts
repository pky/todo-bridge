import { describe, expectTypeOf, it } from 'vitest'
import type {
  AppUser,
  SpaceCalendarSettings,
  SpaceMember,
  SpaceMeta,
  Tag,
  Task,
  TaskList,
  UserMembership,
} from '@/types'

describe('共有スペース用型定義', () => {
  it('共有スペース関連の型を公開している', () => {
    expectTypeOf<SpaceMeta>().toMatchTypeOf<{
      id: string
      ownerUid: string
      memberCount: number
    }>()

    expectTypeOf<SpaceMember>().toMatchTypeOf<{
      uid: string
      role: 'owner' | 'member'
    }>()

    expectTypeOf<UserMembership>().toMatchTypeOf<{
      spaceId: string
      status: 'active'
    }>()

    expectTypeOf<SpaceCalendarSettings>().toMatchTypeOf<{
      calendarId: string | null
    }>()
  })

  it('既存エンティティが共有向けフィールドを受け取れる', () => {
    expectTypeOf<Task>().toMatchTypeOf<{
      spaceId?: string
      visibleToMemberIds?: string[]
      editableByMemberIds?: string[]
    }>()

    expectTypeOf<TaskList>().toMatchTypeOf<{
      spaceId?: string
      visibleToMemberIds?: string[]
    }>()

    expectTypeOf<Tag>().toMatchTypeOf<{
      spaceId?: string
      visibleToMemberIds?: string[]
    }>()

    expectTypeOf<AppUser>().toMatchTypeOf<{
      currentSpaceId?: string | null
    }>()
  })
})
