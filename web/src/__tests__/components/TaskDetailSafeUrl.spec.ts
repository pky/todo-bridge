import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import TaskDetail from '@/components/TaskDetail.vue'

const state = vi.hoisted(() => ({
  selectedTaskId: 'task-1',
  selectedTask: {
    id: 'task-1', name: '架空タスク', parentId: null, completed: false,
    tags: [], notes: [], listId: 'list-1', priority: 4, dueDate: null,
    url: '', allDay: true,
  },
  tasks: [],
  getIncompleteSubtasks: vi.fn(() => []),
  updateTask: vi.fn(),
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/stores/tasks', () => ({ useTasksStore: () => state }))
vi.mock('@/stores/lists', () => ({ useListsStore: () => ({ lists: [] }) }))
vi.mock('@/stores/documents', () => ({
  useDocumentsStore: () => ({ documents: [], thumbnailUrls: {}, getAccessUrl: vi.fn() }),
}))
vi.mock('@/stores/documentTaskLinks', () => ({
  useDocumentTaskLinksStore: () => ({
    documentIds: [], loading: false, error: null, mutatingDocumentIds: [],
    linkDocuments: vi.fn(), unlinkDocument: vi.fn(),
  }),
}))
vi.mock('@/stores/calendar', () => ({
  useCalendarStore: () => ({ configured: false, registerTask: vi.fn() }),
}))
vi.mock('@/stores/space', () => ({ useSpaceStore: () => ({ currentSpaceId: 'space-1' }) }))
vi.mock('@/services/documentService', () => ({ getDocumentSuggestionsApi: vi.fn() }))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ showError: vi.fn(), showInfo: vi.fn() }),
}))

enableAutoUnmount(afterEach)

function renderTask(url: string) {
  state.selectedTask.url = url
  return mount(TaskDetail, {
    global: { stubs: { DocumentAttachmentPicker: true, TaskItem: true } },
  })
}

describe('タスク詳細の外部URL', () => {
  beforeEach(() => vi.clearAllMocks())

  it('保存済みのjavascript URLをリンクにしない', () => {
    const wrapper = renderTask('javascript:alert(1)')
    expect(wrapper.find('a[href]').exists()).toBe(false)
    expect(state.updateTask).not.toHaveBeenCalled()
  })

  for (const protocol of ['http', 'https', 'ftp']) {
    it(`${protocol} URLは従来どおりリンクにする`, () => {
      const url = `${protocol}://example.com/task`
      const wrapper = renderTask(url)
      expect(wrapper.get('a[href]').attributes('href')).toBe(url)
    })
  }
})
