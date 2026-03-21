import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Sidebar from '@/components/Sidebar.vue'
import { useAuthStore } from '@/stores/auth'
import { useListsStore } from '@/stores/lists'
import { useSpaceStore } from '@/stores/space'

const getDocsMock = vi.hoisted(() => vi.fn())
const onSnapshotMock = vi.hoisted(() => vi.fn())

vi.mock('@/stores/tasks', () => ({
  useTasksStore: () => ({
    clearTagFilter: vi.fn(),
    subscribeToList: vi.fn(),
    loadSmartListTasks: vi.fn(),
  }),
}))

vi.mock('@/services/firebase', () => ({
  db: {},
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((...args: unknown[]) => args),
  getDocs: getDocsMock,
  onSnapshot: onSnapshotMock,
  query: vi.fn((...args: unknown[]) => args),
  where: vi.fn((...args: unknown[]) => args),
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

describe('Sidebar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    getDocsMock.mockResolvedValue(createDocs([]))

    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'user-1', email: 'test@example.com', displayName: 'Test', photoURL: null },
      loading: false,
    })

    const listsStore = useListsStore()
    listsStore.$patch({
      smartListCounts: {
        today: 0,
        tomorrow: 0,
        overdue: 0,
        thisWeek: 0,
        noDate: 0,
      },
    })

    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      currentSpaceId: 'personal_user-1',
      useLegacyPath: false,
      initialized: true,
      memberships: [],
    })
  })

  it('期限切れが0件のときは警告アイコンを表示しない', async () => {
    const wrapper = mount(Sidebar)

    await flushView()

    expect(wrapper.text()).toContain('期限切れ')
    expect(wrapper.text()).not.toContain('⚠️')
  })

  it('共有スペースのリスト件数更新を購読して反映する', async () => {
    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      currentSpaceId: 'personal_user-1',
      memberships: [{ spaceId: 'shared-space', displayName: '家族' } as any],
    })

    onSnapshotMock.mockImplementation((source, callback) => {
      const sourceText = JSON.stringify(source)
      if (sourceText.includes('shared-space')) {
        callback(createDocs([
          {
            id: 'family-list',
            data: {
              name: '家族',
              incompleteTaskCount: 3,
              dateCreated: {} as any,
              dateModified: {} as any,
              visibleToMemberIds: ['user-1'],
            },
          },
        ]))
      }
      return () => {}
    })

    const wrapper = mount(Sidebar)
    await flushView()

    expect(wrapper.text()).toContain('家族')
    expect(wrapper.text()).toContain('3')
  })
})
