import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import TaskList from '@/components/TaskList.vue'

const tasksStore = reactive({
  isSearching: false,
  isTagFiltering: false,
  selectedTag: null as string | null,
  searchQuery: '',
  searchResults: [],
  searchIncludeCompleted: false,
  searchCacheLoading: false,
  selectedTaskId: null as string | null,
  selectedTask: null,
  incompleteTasks: [],
  completedTasks: [],
  smartListTasksLoading: false,
  loading: false,
  sortOrder: 'created',
  createTask: vi.fn(),
  clearTagFilter: vi.fn(),
  setTagFilter: vi.fn(),
  setSortOrder: vi.fn(),
  toggleSearchIncludeCompleted: vi.fn(),
  loadCompletedTasks: vi.fn(),
  toggleComplete: vi.fn(),
  selectTask: vi.fn(),
  deleteCompletedTasksInCurrentList: vi.fn(),
})

const listsStore = reactive({
  selectedSmartList: null,
  selectedListId: 'list-1',
  selectedList: { id: 'list-1', name: '家族' },
  tags: [],
})

const documentsStore = reactive({
  documents: [{
    id: 'document-1',
    spaceId: 'document-space',
    name: '園のお知らせ.pdf',
    status: 'uploaded',
    mimeType: 'application/pdf',
    ocrStatus: 'completed',
    classificationVersion: 1,
    analysisVersion: 1,
  }],
  thumbnailUrls: {},
})

const documentTaskLinksStore = reactive({
  linkDocuments: vi.fn(),
})

const calendarStore = reactive({
  configured: true,
  registerTask: vi.fn(),
})
const spaceStore = reactive({
  currentSpaceId: 'space-1',
})

const suggestionMock = vi.hoisted(() => vi.fn())
const replaceMock = vi.hoisted(() => vi.fn())

vi.mock('@/stores/tasks', () => ({ useTasksStore: () => tasksStore }))
vi.mock('@/stores/lists', () => ({ useListsStore: () => listsStore }))
vi.mock('@/stores/documents', () => ({ useDocumentsStore: () => documentsStore }))
vi.mock('@/stores/documentTaskLinks', () => ({
  useDocumentTaskLinksStore: () => documentTaskLinksStore,
}))
vi.mock('@/stores/calendar', () => ({ useCalendarStore: () => calendarStore }))
vi.mock('@/stores/space', () => ({
  useSpaceStore: () => spaceStore,
}))
vi.mock('@/services/documentService', () => ({
  getDocumentSuggestionsApi: suggestionMock,
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ showInfo: vi.fn(), showError: vi.fn() }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => reactive({ query: {} }),
  useRouter: () => ({ replace: replaceMock }),
}))

describe('TaskList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    documentsStore.documents[0]!.status = 'uploaded'
    documentsStore.documents[0]!.ocrStatus = 'completed'
    documentsStore.documents[0]!.classificationVersion = 1
    spaceStore.currentSpaceId = 'space-1'
    tasksStore.createTask.mockResolvedValue('task-1')
    documentTaskLinksStore.linkDocuments.mockResolvedValue(undefined)
    calendarStore.registerTask.mockResolvedValue({ eventId: 'event-1', alreadyRegistered: false })
    suggestionMock.mockResolvedValue([{
      id: 'suggestion-1',
      type: 'calendar_event',
      status: 'pending',
      title: '茶話会',
      value: { date: '2026-07-20', time: '13:45', endTime: '14:45' },
      sourceExcerpt: '7月20日 13時45分〜14時45分',
    }])
  })

  it('書類候補を反映し、複数処理の前にタスク保存完了を待つ', async () => {
    const wrapper = mount(TaskList, {
      global: {
        stubs: {
          TaskItem: true,
          DocumentAttachmentPicker: {
            emits: ['confirm'],
            template: '<button class="pick-document" @click="$emit(\'confirm\', [\'document-1\'])">選択</button>',
          },
        },
      },
    })

    await wrapper.findAll('button').find((button) => button.text().includes('タスクを追加'))?.trigger('click')
    await wrapper.get('.pick-document').trigger('click')
    await wrapper.get('[data-testid="use-document-content"]').setValue(true)

    expect(suggestionMock).toHaveBeenCalledWith('document-space', 'document-1')
    expect((wrapper.get('[data-testid="new-task-name"]').element as HTMLInputElement).value).toBe('茶話会')
    await wrapper.get('[data-testid="add-task-calendar"]').setValue(true)
    await wrapper.get('[data-testid="submit-task"]').trigger('click')

    expect(tasksStore.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '茶話会',
        allDay: false,
        addToCalendar: true,
      }),
      { waitForCommit: true }
    )
    expect(documentTaskLinksStore.linkDocuments).toHaveBeenCalledWith('task-1', ['document-1'])
    expect(calendarStore.registerTask).toHaveBeenCalledWith('task-1')
  })

  it('OCR処理中は状態を表示し、候補反映を待ってから追加できる', async () => {
    documentsStore.documents[0]!.ocrStatus = 'processing'
    const wrapper = mount(TaskList, {
      global: {
        stubs: {
          TaskItem: true,
          DocumentAttachmentPicker: {
            emits: ['confirm'],
            template: '<button class="pick-document" @click="$emit(\'confirm\', [\'document-1\'])">選択</button>',
          },
        },
      },
    })

    await wrapper.findAll('button').find((button) => button.text().includes('タスクを追加'))?.trigger('click')
    await wrapper.get('.pick-document').trigger('click')
    await wrapper.get('[data-testid="use-document-content"]').setValue(true)

    expect(wrapper.get('[data-testid="document-reading-status"]').text()).toContain('書類を読み取り中')
    expect(wrapper.get('[data-testid="submit-task"]').attributes('disabled')).toBeDefined()
    expect(suggestionMock).not.toHaveBeenCalled()

    documentsStore.documents[0]!.ocrStatus = 'completed'
    documentsStore.documents[0]!.classificationVersion = 2

    await vi.waitFor(() => {
      expect(suggestionMock).toHaveBeenCalledWith('document-space', 'document-1')
      expect(wrapper.find('[data-testid="document-reading-status"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="submit-task"]').attributes('disabled')).toBeUndefined()
    })
  })

  it('OCR処理中でも手入力した日時で家族Calendarへ登録できる', async () => {
    documentsStore.documents[0]!.ocrStatus = 'processing'
    const wrapper = mount(TaskList, {
      global: {
        stubs: {
          TaskItem: true,
          DocumentAttachmentPicker: {
            emits: ['confirm'],
            template: '<button class="pick-document" @click="$emit(\'confirm\', [\'document-1\'])">選択</button>',
          },
        },
      },
    })

    await wrapper.findAll('button').find((button) => button.text().includes('タスクを追加'))?.trigger('click')
    await wrapper.get('.pick-document').trigger('click')
    await wrapper.get('[data-testid="use-document-content"]').setValue(true)
    await wrapper.get('[data-testid="new-task-name"]').setValue('手入力の予定')
    await wrapper.get('[data-testid="new-task-due-date"]').setValue('2026-07-21')

    expect(wrapper.get('[data-testid="submit-task"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="add-task-calendar"]').setValue(true)
    await wrapper.get('[data-testid="submit-task"]').trigger('click')

    expect(tasksStore.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '手入力の予定',
        addToCalendar: true,
      }),
      { waitForCommit: true }
    )
    expect(calendarStore.registerTask).toHaveBeenCalledWith('task-1')
  })

  it('個人タスクには家族Calendar登録を表示しない', async () => {
    spaceStore.currentSpaceId = 'personal_user-1'
    const wrapper = mount(TaskList, {
      global: {
        stubs: {
          TaskItem: true,
          DocumentAttachmentPicker: true,
        },
      },
    })

    await wrapper.findAll('button').find((button) => button.text().includes('タスクを追加'))?.trigger('click')
    await wrapper.get('[data-testid="new-task-name"]').setValue('個人の予定')
    await wrapper.get('[data-testid="new-task-due-date"]').setValue('2026-07-21')

    expect(wrapper.find('[data-testid="add-task-calendar"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('個人タスクは家族のGoogle Calendarへ登録されません')
  })
})
