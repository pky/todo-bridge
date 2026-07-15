import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import TaskDetail from '@/components/TaskDetail.vue'

const getDocumentSuggestionsMock = vi.hoisted(() => vi.fn())

const tasksStoreState = reactive({
  selectedTaskId: 'child-task',
  selectedTask: null as Record<string, unknown> | null,
  tasks: [] as Array<Record<string, unknown>>,
  selectTask: vi.fn(),
  toggleComplete: vi.fn(),
  updateTask: vi.fn().mockResolvedValue(undefined),
  createTask: vi.fn().mockResolvedValue(undefined),
  deleteTask: vi.fn().mockResolvedValue(undefined),
  getIncompleteSubtasks: vi.fn<(parentId: string) => Array<Record<string, unknown>>>(),
})

const listsStoreState = reactive({
  lists: [
    { id: 'list-1', name: 'テストリスト' },
  ],
})

const documentsStoreState = reactive({
  documents: [] as Array<Record<string, unknown>>,
  thumbnailUrls: {} as Record<string, string>,
  getAccessUrl: vi.fn(),
})

const documentTaskLinksStoreState = reactive({
  documentIds: [] as string[],
  loading: false,
  error: null as string | null,
  mutatingDocumentIds: [] as string[],
  linkDocuments: vi.fn(),
  unlinkDocument: vi.fn(),
})

const calendarStoreState = reactive({
  configured: false,
  registerTask: vi.fn(),
})
const spaceStoreState = reactive({
  currentSpaceId: 'space-1',
})

vi.mock('@/stores/tasks', () => ({
  useTasksStore: () => tasksStoreState,
}))

vi.mock('@/stores/lists', () => ({
  useListsStore: () => listsStoreState,
}))

vi.mock('@/stores/documents', () => ({
  useDocumentsStore: () => documentsStoreState,
}))

vi.mock('@/stores/documentTaskLinks', () => ({
  useDocumentTaskLinksStore: () => documentTaskLinksStoreState,
}))

vi.mock('@/stores/calendar', () => ({
  useCalendarStore: () => calendarStoreState,
}))

vi.mock('@/stores/space', () => ({
  useSpaceStore: () => spaceStoreState,
}))

vi.mock('@/services/documentService', () => ({
  getDocumentSuggestionsApi: getDocumentSuggestionsMock,
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    showError: vi.fn(),
    showInfo: vi.fn(),
  }),
}))

describe('TaskDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spaceStoreState.currentSpaceId = 'space-1'
    documentsStoreState.documents = []
    documentTaskLinksStoreState.documentIds = []

    tasksStoreState.tasks = [
      {
        id: 'parent-task',
        name: '親タスク',
        parentId: null,
        completed: false,
        tags: [],
        notes: [],
        listId: 'list-1',
        priority: 4,
        dueDate: null,
        url: null,
        allDay: true,
      },
      {
        id: 'child-task',
        name: '子タスク',
        parentId: 'parent-task',
        completed: false,
        tags: [],
        notes: [],
        listId: 'list-1',
        priority: 4,
        dueDate: null,
        url: null,
        allDay: true,
      },
      {
        id: 'grandchild-task',
        name: '孫タスク',
        parentId: 'child-task',
        completed: false,
        tags: [],
        notes: [],
        listId: 'list-1',
        priority: 4,
        dueDate: null,
        url: null,
        allDay: true,
      },
    ]
    tasksStoreState.selectedTaskId = 'child-task'
    tasksStoreState.selectedTask = tasksStoreState.tasks[1] ?? null
    tasksStoreState.getIncompleteSubtasks.mockImplementation((parentId: string) =>
      tasksStoreState.tasks.filter((task) => task.parentId === parentId && !task.completed)
    )
  })

  it('サブタスクを選択中でも、その子タスクを表示する', () => {
    const wrapper = mount(TaskDetail, {
      global: {
        stubs: {
          DocumentAttachmentPicker: true,
          TaskItem: {
            props: ['task'],
            template: '<div class="task-item-stub">{{ task.name }}</div>',
          },
        },
      },
    })

    expect(wrapper.text()).toContain('孫タスク')
    expect(wrapper.text()).toContain('←')
    expect(wrapper.text()).not.toContain('サブタスクなし')
  })

  it('メモ本文クリックでは編集モードに入らず、編集ボタンで編集できる', async () => {
    if (tasksStoreState.selectedTask) {
      tasksStoreState.selectedTask.notes = ['選択してコピーしたいメモ']
    }

    const wrapper = mount(TaskDetail, {
      global: {
        stubs: {
          DocumentAttachmentPicker: true,
          TaskItem: {
            props: ['task'],
            template: '<div class="task-item-stub">{{ task.name }}</div>',
          },
        },
      },
    })

    await wrapper.get('p.whitespace-pre-wrap').trigger('click')
    expect(wrapper.find('textarea').exists()).toBe(false)

    const editButton = wrapper.findAll('button').find((button) => button.text() === '編集')
    expect(editButton).toBeDefined()
    await editButton?.trigger('click')

    expect(wrapper.get('textarea').element.value).toBe('選択してコピーしたいメモ')
  })

  it('書類の読み取り候補を確認してから既存タスクへ反映する', async () => {
    documentsStoreState.documents = [{
      id: 'document-1',
      spaceId: 'space-1',
      name: '園のお知らせ.jpg',
      mimeType: 'image/jpeg',
      classificationVersion: 1,
      ocrStatus: 'completed',
    }]
    documentTaskLinksStoreState.documentIds = ['document-1']
    getDocumentSuggestionsMock.mockResolvedValue([{
      id: 'suggestion-1',
      type: 'calendar_event',
      status: 'pending',
      title: '保護者会',
      value: {
        date: '2026-07-25',
        time: '13:00',
        endTime: '14:30',
        location: '多目的室',
      },
      sourceExcerpt: '7月25日 13時から14時30分まで',
    }])

    const wrapper = mount(TaskDetail, {
      global: {
        stubs: {
          DocumentAttachmentPicker: true,
          TaskItem: true,
        },
      },
    })

    const applyButton = wrapper.findAll('button').find(
      (button) => button.text() === '読み取り候補を反映'
    )
    await applyButton?.trigger('click')

    expect(getDocumentSuggestionsMock).toHaveBeenCalledWith('space-1', 'document-1')
    expect(tasksStoreState.updateTask).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="task-suggestion-dialog"]').text()).toContain('保護者会')
    expect(wrapper.get('[data-testid="task-suggestion-dialog"]').text()).toContain('多目的室')

    await wrapper.get('[data-testid="confirm-task-suggestion"]').trigger('click')

    expect(tasksStoreState.updateTask).toHaveBeenCalledOnce()
    const [taskId, update] = tasksStoreState.updateTask.mock.calls[0]!
    expect(taskId).toBe('child-task')
    expect(update).toEqual(expect.objectContaining({
      name: '保護者会',
      allDay: false,
      notes: ['場所: 多目的室', '7月25日 13時から14時30分まで'],
    }))
    expect(update.startDate.toDate()).toEqual(new Date('2026-07-25T13:00'))
    expect(update.dueDate.toDate()).toEqual(new Date('2026-07-25T14:30'))
  })
})
