import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { buildPersonalSpaceId, useSpaceStore } from '@/stores/space'

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  doc: vi.fn((...segments: string[]) => segments),
  getDocs: vi.fn(),
}))

vi.mock('@/services/firebase', () => ({
  db: {},
}))

const migrateCurrentUserToPersonalSpaceApiMock = vi.hoisted(() => vi.fn())

vi.mock('@/services/cloudFunctionsService', () => ({
  migrateCurrentUserToPersonalSpaceApi: migrateCurrentUserToPersonalSpaceApiMock,
}))

describe('Space Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()

    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'test-user-id', email: 'test@example.com', displayName: 'Test', photoURL: null },
      loading: false,
    })

    localStorage.clear()
    migrateCurrentUserToPersonalSpaceApiMock.mockResolvedValue({
      success: true,
      migrated: false,
      spaceId: 'personal_test-user-id',
      lists: { sourceCount: 0, targetCount: 0 },
      tasks: { sourceCount: 0, targetCount: 0 },
      tags: { sourceCount: 0, targetCount: 0 },
    })
  })

  it('membership がない場合は personal space を既定にする', async () => {
    const { getDocs } = await import('firebase/firestore')
    vi.mocked(getDocs).mockResolvedValueOnce({
      empty: true,
      docs: [],
    } as never)

    const store = useSpaceStore()
    await store.initSpace()

    expect(store.currentSpaceId).toBe(buildPersonalSpaceId('test-user-id'))
    expect(store.useLegacyPath).toBe(true)
  })

  it('membership がある場合は spaces パスへ切り替える', async () => {
    const { getDocs } = await import('firebase/firestore')
    vi.mocked(getDocs).mockResolvedValueOnce({
      empty: false,
      docs: [
        {
          id: 'personal_test-user-id',
          data: () => ({
            spaceId: 'personal_test-user-id',
            role: 'owner',
            status: 'active',
            displayName: 'Personal',
            joinedAt: null,
          }),
        },
      ],
    } as never)

    const store = useSpaceStore()
    await store.initSpace()

    expect(store.currentSpaceId).toBe('personal_test-user-id')
    expect(store.useLegacyPath).toBe(false)
    expect(store.getCollectionPath('lists')).toEqual(['spaces', 'personal_test-user-id', 'lists'])
    expect(store.getSmartListCountsDocPath()).toEqual(['spaces', 'personal_test-user-id'])
  })

  it('selectSpace で current space を切り替える', () => {
    const store = useSpaceStore()
    store.selectSpace('family-space')

    expect(store.currentSpaceId).toBe('family-space')
    expect(store.useLegacyPath).toBe(false)
    expect(localStorage.getItem('rertm-current-space-id')).toBe('family-space')
  })

  it('legacy データが personal space より多い場合は移行する', async () => {
    const { getDocs } = await import('firebase/firestore')
    vi.mocked(getDocs).mockResolvedValueOnce({
      empty: false,
      docs: [
        {
          id: 'personal_test-user-id',
          data: () => ({
            spaceId: 'personal_test-user-id',
            role: 'owner',
            status: 'active',
            displayName: 'Personal',
            joinedAt: null,
          }),
        },
      ],
    } as never)

    const store = useSpaceStore()
    await store.initSpace()

    expect(migrateCurrentUserToPersonalSpaceApiMock).toHaveBeenCalledTimes(1)
    expect(store.currentSpaceId).toBe('personal_test-user-id')
  })

  it('別ユーザーへ切り替わったら再初期化する', async () => {
    const { getDocs } = await import('firebase/firestore')
    vi.mocked(getDocs)
      .mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'family-space-a',
            data: () => ({
              spaceId: 'family-space-a',
              role: 'member',
              status: 'active',
              displayName: 'Family A',
              joinedAt: null,
            }),
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'family-space-b',
            data: () => ({
              spaceId: 'family-space-b',
              role: 'member',
              status: 'active',
              displayName: 'Family B',
              joinedAt: null,
            }),
          },
        ],
      } as never)

    const authStore = useAuthStore()
    const store = useSpaceStore()

    await store.initSpace()
    expect(store.currentSpaceId).toBe('family-space-a')

    authStore.$patch({
      user: { uid: 'other-user-id', email: 'other@example.com', displayName: 'Other', photoURL: null },
    })

    await store.initSpace()
    expect(store.currentSpaceId).toBe('family-space-b')
  })
})
