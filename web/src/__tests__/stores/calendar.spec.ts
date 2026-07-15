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
}))

vi.mock('firebase/functions', () => ({
  httpsCallable: httpsCallableMock,
}))

vi.mock('@/services/firebase', () => ({
  db: {},
  functions: {},
}))

vi.mock('@/services/firebaseFunctions', () => ({
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

  it('Functionsのサービスアカウントを取得する', async () => {
    const callable = vi.fn().mockResolvedValue({
      data: { serviceAccountEmail: 'app@example.iam.gserviceaccount.com' },
    })
    httpsCallableMock.mockReturnValue(callable)
    const store = useCalendarStore()

    await store.loadServiceConfig()

    expect(httpsCallableMock).toHaveBeenCalledWith({}, 'getGoogleCalendarServiceConfig')
    expect(store.serviceAccountEmail).toBe('app@example.iam.gserviceaccount.com')
  })

  it('カレンダーIDを家族スペース単位で保存する', async () => {
    const spaceStore = useSpaceStore()
    spaceStore.$patch({ useLegacyPath: false, currentSpaceId: 'space-1' })
    const callable = vi.fn().mockResolvedValue({
      data: {
        success: true,
        calendarId: 'family@group.calendar.google.com',
        calendarName: '家族',
      },
    })
    httpsCallableMock.mockReturnValue(callable)
    const store = useCalendarStore()

    await store.saveConfig('family@group.calendar.google.com')

    expect(httpsCallableMock).toHaveBeenCalledWith({}, 'saveGoogleCalendarConfig')
    expect(callable).toHaveBeenCalledWith({
      spaceId: 'space-1',
      useLegacyPath: false,
      calendarId: 'family@group.calendar.google.com',
    })
    expect(store.calendarName).toBe('家族')
  })

  it('登録先の解除を家族スペース単位で要求する', async () => {
    const spaceStore = useSpaceStore()
    spaceStore.$patch({ useLegacyPath: false, currentSpaceId: 'space-1' })
    const callable = vi.fn().mockResolvedValue({ data: undefined })
    httpsCallableMock.mockReturnValue(callable)
    const store = useCalendarStore()

    await store.clearConfig()

    expect(httpsCallableMock).toHaveBeenCalledWith({}, 'clearGoogleCalendarConfig')
    expect(callable).toHaveBeenCalledWith({ spaceId: 'space-1', useLegacyPath: false })
  })

  it('書類予定の自動登録設定を家族スペース単位で保存する', async () => {
    const spaceStore = useSpaceStore()
    spaceStore.$patch({ useLegacyPath: false, currentSpaceId: 'space-1' })
    const callable = vi.fn().mockResolvedValue({
      data: {
        success: true,
        enabled: true,
        categories: ['school_childcare'],
        minConfidence: 0.9,
      },
    })
    httpsCallableMock.mockReturnValue(callable)
    const store = useCalendarStore()
    store.autoRegistrationEnabled = true

    await store.saveAutomationConfig()

    expect(httpsCallableMock).toHaveBeenCalledWith({}, 'saveGoogleCalendarAutomationConfig')
    expect(callable).toHaveBeenCalledWith({
      spaceId: 'space-1',
      useLegacyPath: false,
      enabled: true,
      categories: ['school_childcare'],
      minConfidence: 0.9,
    })
  })

  it('作成済みタスクを家族スペースのCalendarへ登録する', async () => {
    const spaceStore = useSpaceStore()
    spaceStore.$patch({ useLegacyPath: false, currentSpaceId: 'space-1' })
    const callable = vi.fn().mockResolvedValue({
      data: { success: true, eventId: 'event-1', alreadyRegistered: false },
    })
    httpsCallableMock.mockReturnValue(callable)
    const store = useCalendarStore()

    await expect(store.registerTask('task-1')).resolves.toEqual({
      eventId: 'event-1',
      alreadyRegistered: false,
    })

    expect(httpsCallableMock).toHaveBeenCalledWith({}, 'createTaskCalendarEvent')
    expect(callable).toHaveBeenCalledWith({ spaceId: 'space-1', taskId: 'task-1' })
  })

  it('個人タスクは家族スペースのCalendarへ登録しない', async () => {
    const spaceStore = useSpaceStore()
    spaceStore.$patch({ useLegacyPath: false, currentSpaceId: 'personal_user-1' })
    const store = useCalendarStore()

    await expect(store.registerTask('task-1')).rejects.toThrow(
      '個人タスクは家族のGoogle Calendarへ登録できません'
    )
    expect(httpsCallableMock).not.toHaveBeenCalledWith({}, 'createTaskCalendarEvent')
  })
})
