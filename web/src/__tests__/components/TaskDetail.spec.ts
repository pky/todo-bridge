import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import TaskDetail from '@/components/TaskDetail.vue'

const getDocumentSuggestionsMock = vi.hoisted(() => vi.fn())
const routerPushMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPushMock }),
}))

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
    expect(wrapper.emitted('focusDetail')).toHaveLength(1)

    const editButton = wrapper.findAll('button').find((button) => button.text() === '編集')
    expect(editButton).toBeDefined()
    await editButton?.trigger('click')

    expect(wrapper.get('textarea').element.value).toBe('選択してコピーしたいメモ')
  })

  it('メモのコピーボタンはクリップボードに本文を渡し、focusDetail を emit しない', async () => {
    if (tasksStoreState.selectedTask) {
      tasksStoreState.selectedTask.notes = ['コピー対象のメモ']
    }
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    try {
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

      const noteRow = wrapper.get('p.whitespace-pre-wrap').element.parentElement
      const copyButton = Array.from(noteRow?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent?.trim() === 'コピー')
      expect(copyButton).toBeDefined()
      copyButton?.click()
      await wrapper.vm.$nextTick()

      expect(writeText).toHaveBeenCalledWith('コピー対象のメモ')
      expect(wrapper.emitted('focusDetail')).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('メモの編集ボタンは編集モードに入り、focusDetail を emit しない', async () => {
    if (tasksStoreState.selectedTask) {
      tasksStoreState.selectedTask.notes = ['編集対象のメモ']
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

    const noteRow = wrapper.get('p.whitespace-pre-wrap').element.parentElement
    const editButton = Array.from(noteRow?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent?.trim() === '編集')
    expect(editButton).toBeDefined()
    editButton?.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.get('textarea').element.value).toBe('編集対象のメモ')
    expect(wrapper.emitted('focusDetail')).toBeUndefined()
  })

  it('メモの削除ボタンはそのメモを除いて更新し、focusDetail を emit しない', async () => {
    if (tasksStoreState.selectedTask) {
      tasksStoreState.selectedTask.notes = ['残すメモ', '削除するメモ']
    }
    tasksStoreState.updateTask.mockClear()

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

    const noteRow = wrapper.findAll('p.whitespace-pre-wrap')
      .find((p) => p.text() === '削除するメモ')?.element.parentElement
    const deleteButton = Array.from(noteRow?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent?.trim() === '✕')
    expect(deleteButton).toBeDefined()
    deleteButton?.click()
    await wrapper.vm.$nextTick()

    expect(tasksStoreState.updateTask).toHaveBeenCalledTimes(1)
    const [, update] = tasksStoreState.updateTask.mock.calls[0]!
    expect(update).toEqual({ notes: ['残すメモ'] })
    expect(wrapper.emitted('focusDetail')).toBeUndefined()
  })

  it('メモ本文のテキスト選択中のクリックでは focusDetail を emit しない', async () => {
    if (tasksStoreState.selectedTask) {
      tasksStoreState.selectedTask.notes = ['選択中のメモ']
    }
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => '選択中',
    } as unknown as Selection)

    try {
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

      expect(wrapper.emitted('focusDetail')).toBeUndefined()
    } finally {
      getSelectionSpy.mockRestore()
    }
  })

  it('サブタスク選択時に詳細表示イベントを通知する', async () => {
    const wrapper = mount(TaskDetail, {
      global: {
        stubs: {
          DocumentAttachmentPicker: true,
          TaskItem: {
            props: ['task'],
            template: '<button data-testid="subtask-item" @click="$emit(\'select\')">{{ task.name }}</button>',
          },
        },
      },
    })

    await wrapper.get('[data-testid="subtask-item"]').trigger('click')

    expect(tasksStoreState.selectTask).toHaveBeenCalledWith('grandchild-task')
    expect(wrapper.emitted('focusDetail')).toHaveLength(1)
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
  it('テキスト書類は原本URLではなく書類画面のプレビューで開く', async () => {
    documentsStoreState.documents = [{
      id: 'document-2',
      spaceId: 'space-1',
      name: '持ち物メモ.md',
      mimeType: 'text/markdown',
      classificationVersion: null,
      ocrStatus: 'completed',
    }]
    documentTaskLinksStoreState.documentIds = ['document-2']
    const windowOpenMock = vi.spyOn(window, 'open').mockImplementation(() => null)

    const wrapper = mount(TaskDetail, {
      global: { stubs: { DocumentAttachmentPicker: true, TaskItem: true } },
    })
    const openButton = wrapper.findAll('button').find((button) => button.text().includes('持ち物メモ.md'))
    await openButton?.trigger('click')

    expect(routerPushMock).toHaveBeenCalledWith({ name: 'documents', query: { document: 'document-2' } })
    expect(documentsStoreState.getAccessUrl).not.toHaveBeenCalled()
    expect(windowOpenMock).not.toHaveBeenCalled()
    windowOpenMock.mockRestore()
  })

  it('画像やPDFの関連書類は従来どおり原本URLを新しいタブで開く', async () => {
    documentsStoreState.documents = [{
      id: 'document-1',
      spaceId: 'space-1',
      name: '園のお知らせ.pdf',
      mimeType: 'application/pdf',
      classificationVersion: null,
      ocrStatus: 'completed',
    }]
    documentTaskLinksStoreState.documentIds = ['document-1']
    documentsStoreState.getAccessUrl.mockResolvedValue({ url: 'https://example.com/notice.pdf' })
    const windowOpenMock = vi.spyOn(window, 'open').mockImplementation(() => null)

    const wrapper = mount(TaskDetail, {
      global: { stubs: { DocumentAttachmentPicker: true, TaskItem: true } },
    })
    const openButton = wrapper.findAll('button').find((button) => button.text().includes('園のお知らせ.pdf'))
    await openButton?.trigger('click')
    await Promise.resolve()

    expect(documentsStoreState.getAccessUrl).toHaveBeenCalledWith('document-1')
    expect(windowOpenMock).toHaveBeenCalledWith('https://example.com/notice.pdf', '_blank', 'noopener')
    expect(routerPushMock).not.toHaveBeenCalled()
    windowOpenMock.mockRestore()
  })

  it('テキスト書類の関連書類にはテキスト用アイコンを表示する', () => {
    documentsStoreState.documents = [{
      id: 'document-2',
      spaceId: 'space-1',
      name: '持ち物メモ.md',
      mimeType: 'text/markdown',
      classificationVersion: null,
      ocrStatus: 'completed',
    }]
    documentTaskLinksStoreState.documentIds = ['document-2']

    const wrapper = mount(TaskDetail, {
      global: { stubs: { DocumentAttachmentPicker: true, TaskItem: true } },
    })

    expect(wrapper.text()).toContain('📝')
  })

})
