import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCalendarStore } from '@/stores/calendar'
import { useAuthStore } from '@/stores/auth'
import { useSpaceStore } from '@/stores/space'

const { onSnapshotMock, httpsCallableMock } = vi.hoisted(() => ({
  onSnapshotMock: vi.fn(),
  httpsCallableMock: vi.fn(),
}))

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((...segments: string[]) => segments),
  onSnapshot: onSnapshotMock,
  setDoc: vi.fn(),
  getDoc: vi.fn().mockResolvedValue({
    exists: () => false,
    data: () => ({}),
  }),
}))

vi.mock('firebase/functions', () => ({
  httpsCallable: httpsCallableMock,
}))

vi.mock('@/services/firebase', () => ({
  db: {},
  functions: {},
}))

describe('Calendar Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()

    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'user-1', email: 'test@example.com', displayName: 'Test', photoURL: null },
      loading: false,
    })
  })

  it('legacy path では users 配下を監視する', () => {
    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      useLegacyPath: true,
      currentSpaceId: 'personal_user-1',
    })

    const store = useCalendarStore()
    store.subscribe()

    expect(onSnapshotMock).toHaveBeenCalledWith(
      [{}, 'users', 'user-1'],
      expect.any(Function)
    )
  })

  it('space path では integrations 設定を監視する', () => {
    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      useLegacyPath: false,
      currentSpaceId: 'space-1',
    })

    const store = useCalendarStore()
    store.subscribe()

    expect(onSnapshotMock).toHaveBeenCalledWith(
      [{}, 'spaces', 'space-1', 'settings', 'integrations'],
      expect.any(Function)
    )
  })

  it('disconnect が current space を callable に渡す', async () => {
    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      useLegacyPath: false,
      currentSpaceId: 'space-1',
    })

    const callable = vi.fn().mockResolvedValue({ data: undefined })
    httpsCallableMock.mockReturnValue(callable)

    const store = useCalendarStore()
    await store.disconnect()

    expect(httpsCallableMock).toHaveBeenCalledWith({}, 'disconnectGoogleCalendar')
    expect(callable).toHaveBeenCalledWith({
      spaceId: 'space-1',
      useLegacyPath: false,
    })
  })
})
