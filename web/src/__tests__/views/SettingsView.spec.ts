import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsView from '@/views/SettingsView.vue'
import { useAuthStore } from '@/stores/auth'
import { useSpaceStore } from '@/stores/space'

const getDocsMock = vi.hoisted(() => vi.fn())
const getDocMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
  }),
}))

vi.mock('@/stores/news', () => ({
  useNewsStore: () => ({
    preferences: { keywords: [] },
    loadPreferences: vi.fn().mockResolvedValue(undefined),
    savePreferences: vi.fn().mockResolvedValue(undefined),
  }),
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

    const wrapper = mount(SettingsView)
    await flushView()

    expect(wrapper.text()).toContain('スペース名を変更')
    expect(wrapper.text()).toContain('メンバー 2 人')
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

    const wrapper = mount(SettingsView)
    await flushView()

    expect(wrapper.text()).not.toContain('スペース名を変更')
    expect(wrapper.text()).toContain('メンバー 2 人')
  })
})
