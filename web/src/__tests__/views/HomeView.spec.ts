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
const documentsSubscribeMock = vi.hoisted(() => vi.fn())
const documentsUnsubscribeMock = vi.hoisted(() => vi.fn())
const linksSubscribeMock = vi.hoisted(() => vi.fn())
const linksUnsubscribeMock = vi.hoisted(() => vi.fn())
const calendarSubscribeMock = vi.hoisted(() => vi.fn())
const calendarUnsubscribeMock = vi.hoisted(() => vi.fn())

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

const tasksStoreState = reactive({
  selectedTaskId: null as string | null,
  selectedTask: null as { id: string, name: string } | null,
  searchQuery: '',
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
    get selectedTaskId() {
      return tasksStoreState.selectedTaskId
    },
    get selectedTask() {
      return tasksStoreState.selectedTask
    },
    get searchQuery() {
      return tasksStoreState.searchQuery
    },
    unsubscribe: tasksUnsubscribeMock,
    subscribe: tasksSubscribeMock,
    subscribeToList: subscribeToListMock,
    setSearchQuery: vi.fn(),
    clearSearch: vi.fn(),
    selectTask: (taskId: string | null) => {
      tasksStoreState.selectedTaskId = taskId
    },
  }),
}))

vi.mock('@/stores/documents', () => ({
  useDocumentsStore: () => ({
    subscribe: documentsSubscribeMock,
    unsubscribe: documentsUnsubscribeMock,
  }),
}))

vi.mock('@/stores/documentTaskLinks', () => ({
  useDocumentTaskLinksStore: () => ({
    subscribe: linksSubscribeMock,
    unsubscribe: linksUnsubscribeMock,
  }),
}))

vi.mock('@/stores/calendar', () => ({
  useCalendarStore: () => ({
    subscribe: calendarSubscribeMock,
    unsubscribe: calendarUnsubscribeMock,
  }),
}))

vi.mock('@/components/Sidebar.vue', () => ({
  default: { template: '<div />' },
}))

vi.mock('@/components/TaskList.vue', () => ({
  default: { template: '<div data-testid="task-list" />' },
}))

vi.mock('@/components/TaskDetail.vue', () => ({
  default: {
    emits: ['focus-detail'],
    template: '<button data-testid="detail-focus" @click="$emit(\'focus-detail\')" />',
  },
}))

describe('HomeView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeState.query.target = 'read-later'
    listsStoreState.selectedListId = null
    tasksStoreState.selectedTaskId = null
    tasksStoreState.selectedTask = null
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

  it('デスクトップで詳細内の操作時だけ一覧を閉じ、戻る操作で再表示する', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    const wrapper = mount(HomeView, {
      global: {
        stubs: {
          RouterLink: {
            props: ['to'],
            template: '<a><slot /></a>',
          },
        },
      },
    })

    tasksStoreState.selectedTaskId = 'task-1'
    tasksStoreState.selectedTask = { id: 'task-1', name: 'エレナ' }
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[aria-label="タスク一覧へ戻る"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="desktop-task-list"]').exists()).toBe(true)

    await wrapper.get('[data-testid="detail-focus"]').trigger('click')

    expect(wrapper.find('[aria-label="タスク一覧へ戻る"]').text()).toContain('エレナ')
    expect(wrapper.find('[data-testid="desktop-task-list"]').exists()).toBe(false)

    await wrapper.get('[aria-label="タスク一覧へ戻る"]').trigger('click')

    expect(wrapper.find('[aria-label="タスク一覧へ戻る"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="desktop-task-list"]').exists()).toBe(true)
    expect(tasksStoreState.selectedTaskId).toBe('task-1')
  })
})

describe('HomeViewの画面幅変更', () => {
  it('768pxを往復してもタスク追加の未送信ドラフトとコンポーネントを保持する', async () => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 768 })
    tasksStoreState.selectedTaskId = null
    tasksStoreState.selectedTask = null
    // 子のローカル状態を使い、一覧の複製や再マウントによる下書き消失を検出する。
    const draftList = {
      name: 'DraftTaskList',
      data: () => ({ draft: '' }),
      template: '<input data-testid="task-draft" v-model="draft" />',
    }
    const wrapper = mount(HomeView, {
      attachTo: document.body,
      global: {
        stubs: {
          TaskList: draftList,
          RouterLink: { props: ['to'], template: '<a><slot /></a>' },
        },
      },
    })
    try {
      await wrapper.vm.$nextTick()
      const initialInstance = wrapper.findComponent(draftList).vm
      expect(wrapper.findAllComponents(draftList)).toHaveLength(1)
      await wrapper.get('#desktop-task-list [data-testid="task-draft"]').setValue('送信前の架空タスク')

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 767 })
      window.dispatchEvent(new Event('resize'))
      await wrapper.vm.$nextTick()
      expect(wrapper.findAllComponents(draftList)).toHaveLength(1)
      expect(wrapper.findComponent(draftList).vm).toBe(initialInstance)
      expect(wrapper.get<HTMLInputElement>('#mobile-task-list [data-testid="task-draft"]').element.value)
        .toBe('送信前の架空タスク')

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 768 })
      window.dispatchEvent(new Event('resize'))
      await wrapper.vm.$nextTick()
      expect(wrapper.findAllComponents(draftList)).toHaveLength(1)
      expect(wrapper.findComponent(draftList).vm).toBe(initialInstance)
      expect(wrapper.get<HTMLInputElement>('#desktop-task-list [data-testid="task-draft"]').element.value)
        .toBe('送信前の架空タスク')
    } finally {
      wrapper.unmount()
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
      window.dispatchEvent(new Event('resize'))
    }
  })
})
