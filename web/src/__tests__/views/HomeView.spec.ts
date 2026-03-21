import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import HomeView from '@/views/HomeView.vue'

const subscribeMock = vi.hoisted(() => vi.fn())
const unsubscribeListsMock = vi.hoisted(() => vi.fn())
const selectListMock = vi.hoisted(() => vi.fn())
const selectSmartListMock = vi.hoisted(() => vi.fn())
const tasksSubscribeMock = vi.hoisted(() => vi.fn())
const tasksUnsubscribeMock = vi.hoisted(() => vi.fn())
const subscribeToListMock = vi.hoisted(() => vi.fn())
const replaceMock = vi.hoisted(() => vi.fn())

const routeState = reactive({
  query: {
    target: 'read-later',
  },
})

const listsStoreState = reactive({
  selectedListId: null as string | null,
  lists: [
    { id: 'inbox-id', name: 'Inbox' },
    { id: 'read-later-id', name: 'あとで読む' },
  ],
})

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceMock,
  }),
  useRoute: () => routeState,
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    isAuthenticated: true,
    loading: false,
    user: { uid: 'user-1', photoURL: null },
    logout: vi.fn(),
  }),
}))

vi.mock('@/stores/lists', () => ({
  useListsStore: () => ({
    ...listsStoreState,
    subscribe: subscribeMock,
    unsubscribe: unsubscribeListsMock,
    selectList: selectListMock,
    selectSmartList: selectSmartListMock,
  }),
}))

vi.mock('@/stores/space', () => ({
  buildPersonalSpaceId: (uid: string) => `personal_${uid}`,
  useSpaceStore: () => ({
    initialized: true,
    currentSpaceId: 'personal_user-1',
    useLegacyPath: false,
  }),
}))

vi.mock('@/stores/tasks', () => ({
  useTasksStore: () => ({
    selectedTaskId: null,
    searchQuery: '',
    unsubscribe: tasksUnsubscribeMock,
    subscribe: tasksSubscribeMock,
    subscribeToList: subscribeToListMock,
    setSearchQuery: vi.fn(),
    clearSearch: vi.fn(),
    selectTask: vi.fn(),
  }),
}))

vi.mock('@/components/Sidebar.vue', () => ({
  default: { template: '<div />' },
}))

vi.mock('@/components/TaskList.vue', () => ({
  default: { template: '<div />' },
}))

vi.mock('@/components/TaskDetail.vue', () => ({
  default: { template: '<div />' },
}))

describe('HomeView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeState.query.target = 'read-later'
    listsStoreState.selectedListId = null
    subscribeMock.mockResolvedValue(undefined)
    replaceMock.mockResolvedValue(undefined)
    selectListMock.mockImplementation((id: string | null) => {
      listsStoreState.selectedListId = id
    })
  })

  it('read-later クエリであとで読むリストを選択する', async () => {
    mount(HomeView, {
      global: {
        stubs: {
          RouterLink: {
            props: ['to'],
            template: '<a><slot /></a>',
          },
        },
      },
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(selectSmartListMock).toHaveBeenCalledWith(null)
    expect(selectListMock).toHaveBeenCalledWith('read-later-id')
    expect(replaceMock).toHaveBeenCalledWith({ name: 'home' })
  })
})
