import { describe, it, expect, beforeEach, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsView from '@/views/SettingsView.vue'
import { useAuthStore } from '@/stores/auth'
import { useSpaceStore } from '@/stores/space'

const getDocsMock = vi.hoisted(() => vi.fn())
const getDocMock = vi.hoisted(() => vi.fn())
const routeQueryMock = vi.hoisted(() => ({ value: {} as Record<string, string> }))
const calendarStoreMock = vi.hoisted(() => ({
  configured: false,
  serviceAccountEmail: 'app@example.iam.gserviceaccount.com',
  loading: false,
  error: null,
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  saveConfig: vi.fn(),
  clearConfig: vi.fn(),
  saveAutomationConfig: vi.fn(),
  calendarId: '',
  calendarName: '',
  autoRegistrationEnabled: false,
  autoRegistrationCategories: ['school_childcare'],
  autoRegistrationMinConfidence: 0.9,
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQueryMock.value }),
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
  }),
}))

vi.mock('@/stores/news', () => ({
  useNewsStore: () => ({
    preferences: { keywords: [] },
    mobileNotificationPreferences: {
      discord: {
        enabled: false,
        webhookUrl: '',
        urgentImmediate: true,
        dailyDigest: true,
      },
    },
    loadPreferences: vi.fn().mockResolvedValue(undefined),
    savePreferences: vi.fn().mockResolvedValue(undefined),
    loadMobileNotificationPreferences: vi.fn().mockResolvedValue(undefined),
    saveMobileNotificationPreferences: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/stores/calendar', () => ({
  useCalendarStore: () => calendarStoreMock,
}))

vi.mock('@/services/cloudFunctionsService', () => ({
  createFamilySpaceApi: vi.fn(),
  updateFamilySpaceNameApi: vi.fn(),
}))

vi.mock('@/services/firebase', () => ({
  db: {},
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((...args: unknown[]) => args),
  collectionGroup: vi.fn((...args: unknown[]) => args),
  doc: vi.fn((...args: unknown[]) => args),
  query: vi.fn((...args: unknown[]) => args),
  where: vi.fn((...args: unknown[]) => args),
  getDocs: getDocsMock,
  getDoc: getDocMock,
}))

function createDocs(items: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    docs: items.map((item) => ({
      id: item.id,
      data: () => item.data,
    })),
  }
}

async function flushView() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function buildMembersDocs() {
  return createDocs([
    {
      id: 'owner-1',
      data: {
        displayName: 'Owner',
        email: 'owner@example.com',
        role: 'owner',
        status: 'active',
        createdAt: {},
        updatedAt: {},
      },
    },
    {
      id: 'member-1',
      data: {
        displayName: 'Member',
        email: 'member@example.com',
        role: 'member',
        status: 'active',
        createdAt: {},
        updatedAt: {},
      },
    },
  ])
}

describe('SettingsView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    routeQueryMock.value = {}
    calendarStoreMock.configured = false
    calendarStoreMock.calendarId = ''
    calendarStoreMock.calendarName = ''
    calendarStoreMock.autoRegistrationEnabled = false
    calendarStoreMock.autoRegistrationCategories = ['school_childcare']
    calendarStoreMock.autoRegistrationMinConfidence = 0.9

    getDocsMock.mockResolvedValue(createDocs([]))
    getDocMock.mockResolvedValue({
      exists: () => true,
      id: 'family-space',
      data: () => ({
        name: '家族共有',
        type: 'family',
        ownerUid: 'owner-1',
        memberCount: 2,
        createdAt: {},
        updatedAt: {},
      }),
    })
  })

  it('owner にはスペース名変更導線が表示される', async () => {
    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'owner-1', email: 'owner@example.com', displayName: 'Owner', photoURL: null },
      loading: false,
    })

    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      currentSpaceId: 'family-space',
      useLegacyPath: false,
      initialized: true,
      memberships: [{
        spaceId: 'family-space',
        role: 'owner',
        status: 'active',
        displayName: '家族共有',
        joinedAt: null,
      }],
    })

    getDocsMock.mockResolvedValue(buildMembersDocs())

    const wrapper = shallowMount(SettingsView)
    await flushView()

    expect(wrapper.text()).toContain('スペース名を変更')
    expect(wrapper.text()).toContain('メンバー 2 人')
    expect(wrapper.text()).toContain('左側の「共有する相手」')
    expect(wrapper.text()).toContain('「ユーザーやグループを追加」')
    expect(wrapper.text()).toContain('左側の「カレンダーの統合」')
    expect(wrapper.text()).toContain('共有先を確認して保存')
  })

  it('設定カテゴリをタブで切り替える', async () => {
    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'owner-1', email: 'owner@example.com', displayName: 'Owner', photoURL: null },
      loading: false,
    })
    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      currentSpaceId: 'family-space',
      useLegacyPath: false,
      initialized: true,
      memberships: [{
        spaceId: 'family-space',
        role: 'owner',
        status: 'active',
        displayName: '家族共有',
        joinedAt: null,
      }],
    })

    const wrapper = shallowMount(SettingsView)
    await flushView()

    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map((tab) => tab.text())).toEqual(['アカウント', '書類・連携', '通知', 'データ'])
    expect(tabs[0].attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-testid="settings-account"]').attributes('style')).toBeUndefined()
    expect(wrapper.get('[data-testid="settings-integrations"]').attributes('style')).toContain('display: none')

    await tabs[1].trigger('click')

    expect(tabs[0].attributes('aria-selected')).toBe('false')
    expect(tabs[1].attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-testid="settings-account"]').attributes('style')).toContain('display: none')
    expect(wrapper.get('[data-testid="settings-integrations"]').attributes('style')).toBeUndefined()
  })

  it('連携設定へのURLでは書類・連携タブを最初から表示する', async () => {
    routeQueryMock.value = { tab: 'integrations' }
    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'owner-1', email: 'owner@example.com', displayName: 'Owner', photoURL: null },
      loading: false,
    })
    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      currentSpaceId: 'family-space',
      useLegacyPath: false,
      initialized: true,
      memberships: [{
        spaceId: 'family-space',
        role: 'owner',
        status: 'active',
        displayName: '家族共有',
        joinedAt: null,
      }],
    })

    const wrapper = shallowMount(SettingsView)
    await flushView()

    expect(wrapper.get('[data-testid="settings-account"]').attributes('style')).toContain('display: none')
    expect(wrapper.get('[data-testid="settings-integrations"]').attributes('style')).toBeUndefined()
  })

  it('member には owner 管理導線が表示されない', async () => {
    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'member-1', email: 'member@example.com', displayName: 'Member', photoURL: null },
      loading: false,
    })

    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      currentSpaceId: 'family-space',
      useLegacyPath: false,
      initialized: true,
      memberships: [{
        spaceId: 'family-space',
        role: 'member',
        status: 'active',
        displayName: '家族共有',
        joinedAt: null,
      }],
    })

    getDocsMock.mockResolvedValue(buildMembersDocs())

    const wrapper = shallowMount(SettingsView)
    await flushView()

    expect(wrapper.text()).not.toContain('スペース名を変更')
    expect(wrapper.text()).toContain('メンバー 2 人')
    expect(wrapper.text()).not.toContain('共有先を確認して保存')
    expect(wrapper.text()).toContain('Google Calendar連携は家族スペースのownerが設定します')
  })

  it('Calendar設定済みのownerには書類予定の自動登録設定を表示する', async () => {
    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'owner-1', email: 'owner@example.com', displayName: 'Owner', photoURL: null },
      loading: false,
    })
    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      currentSpaceId: 'family-space',
      useLegacyPath: false,
      initialized: true,
      memberships: [{
        spaceId: 'family-space',
        role: 'owner',
        status: 'active',
        displayName: '家族共有',
        joinedAt: null,
      }],
    })
    getDocsMock.mockResolvedValue(buildMembersDocs())
    calendarStoreMock.configured = true
    calendarStoreMock.calendarId = 'family@group.calendar.google.com'
    calendarStoreMock.calendarName = '家族'

    const wrapper = shallowMount(SettingsView)
    await flushView()

    expect(wrapper.text()).toContain('明確な予定を自動登録する')
    expect(wrapper.text()).toContain('自動登録する書類カテゴリ')
    expect(wrapper.text()).toContain('自動登録設定を保存')
  })

  it('移行済みの個人スペースでもOCR設定を表示する', async () => {
    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'owner-1', email: 'owner@example.com', displayName: 'Owner', photoURL: null },
      loading: false,
    })

    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      currentSpaceId: 'personal_owner-1',
      useLegacyPath: false,
      initialized: true,
      memberships: [{
        spaceId: 'personal_owner-1',
        role: 'owner',
        status: 'active',
        displayName: '個人スペース',
        joinedAt: null,
      }],
    })

    const wrapper = shallowMount(SettingsView)
    await flushView()

    expect(wrapper.find('[data-testid="document-ocr-settings"]').exists()).toBe(true)
  })
})
