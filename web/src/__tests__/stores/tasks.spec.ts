import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useTasksStore } from '@/stores/tasks'
import { useAuthStore } from '@/stores/auth'
import { useListsStore } from '@/stores/lists'
import { useSpaceStore } from '@/stores/space'

// Firebase Firestore のモック
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  doc: vi.fn(() => ({ id: 'new-task-id' })),
  setDoc: vi.fn().mockResolvedValue(undefined),
  updateDoc: vi.fn(),
  getDocs: vi.fn(),
  getDocsFromCache: vi.fn(),
  deleteDoc: vi.fn(),
  onSnapshot: vi.fn(),
  serverTimestamp: vi.fn(() => ({ seconds: Date.now() / 1000 })),
  query: vi.fn(),
  orderBy: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
  startAfter: vi.fn(),
  Timestamp: {
    now: vi.fn(() => ({ seconds: Date.now() / 1000, toDate: () => new Date() })),
    fromDate: vi.fn((date: Date) => ({ seconds: date.getTime() / 1000, toDate: () => date })),
  },
}))

vi.mock('@/services/firebase', () => ({
  db: {},
}))

// タスクオブジェクトのデフォルト値（テスト間で共通）
const baseTask = {
  listId: 'inbox-id',
  parentId: null,
  priority: 4 as const,
  tags: [],
  dueDate: null,
  startDate: null,
  repeat: null,
  notes: [],
  url: null,
  completed: false,
  dateCompleted: null,
  dateCreated: {} as any,
  dateModified: {} as any,
  allDay: false,
  addToCalendar: false,
  calendarEventId: null,
}

describe('Tasks Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()

    // AuthStore のモック設定
    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'test-user-id', email: 'test@example.com', displayName: 'Test', photoURL: null },
      loading: false,
    })

    // ListsStore のモック設定
    const listsStore = useListsStore()
    listsStore.$patch({
      selectedListId: 'inbox-id',
      lists: [{ id: 'inbox-id', name: 'Inbox', dateCreated: {} as any, dateModified: {} as any }],
    })

    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      currentSpaceId: 'space-a',
      useLegacyPath: false,
      initialized: true,
    })
  })

  it('初期状態でタスクは空', () => {
    const store = useTasksStore()
    expect(store.tasks).toEqual([])
    expect(store.selectedTaskId).toBeNull()
  })

  it('filteredTasks はtasksをそのまま返す（リストフィルタはFirestoreクエリで実行）', () => {
    const store = useTasksStore()
    store.$patch({
      tasks: [
        { ...baseTask, id: '1', name: 'Task 1' },
        { ...baseTask, id: '2', name: 'Task 2' },
      ],
    })

    expect(store.filteredTasks).toHaveLength(2)
    expect(store.filteredTasks[0]?.name).toBe('Task 1')
  })

  it('incompleteTasks は未完了タスクのみ返す', () => {
    const store = useTasksStore()
    store.$patch({
      tasks: [
        { ...baseTask, id: '1', name: 'Task 1' },
        { ...baseTask, id: '2', name: 'Task 2', completed: true, dateCompleted: {} as any },
      ],
    })

    expect(store.incompleteTasks).toHaveLength(1)
    expect(store.incompleteTasks[0]?.name).toBe('Task 1')
  })

  it('completedTasks は完了タスクのみ返す', () => {
    const store = useTasksStore()
    store.$patch({
      tasks: [
        { ...baseTask, id: '1', name: 'Task 1' },
        { ...baseTask, id: '2', name: 'Task 2', completed: true, dateCompleted: {} as any },
      ],
    })

    expect(store.completedTasks).toHaveLength(1)
    expect(store.completedTasks[0]?.name).toBe('Task 2')
  })

  it('loadCompletedTasks(forceRefresh) は古い完了タスク一覧をサーバー結果で置き換える', async () => {
    const { getDocs, getDocsFromCache } = await import('firebase/firestore')
    vi.mocked(getDocsFromCache).mockResolvedValue({
      docs: [
        {
          id: 'stale-completed',
          data: () => ({ ...baseTask, name: '古い完了タスク', completed: true, dateCompleted: {} as any }),
        },
      ],
    } as any)
    vi.mocked(getDocs).mockResolvedValue({ docs: [] } as any)

    const store = useTasksStore()
    store.$patch({
      tasks: [
        { ...baseTask, id: 'active-task', name: '未完了タスク' },
        { ...baseTask, id: 'stale-completed', name: '古い完了タスク', completed: true, dateCompleted: {} as any },
      ],
    })

    await store.loadCompletedTasks('inbox-id', true)

    expect(getDocs).toHaveBeenCalled()
    expect(store.tasks.map(t => t.id)).toEqual(['active-task'])
  })

  it('selectTask でタスクを選択できる', () => {
    const store = useTasksStore()
    store.$patch({
      tasks: [
        { ...baseTask, id: '1', name: 'Task 1' },
      ],
    })

    store.selectTask('1')
    expect(store.selectedTaskId).toBe('1')
    expect(store.selectedTask?.name).toBe('Task 1')
  })

  it('selectTask(null) で選択解除できる', () => {
    const store = useTasksStore()
    store.$patch({ selectedTaskId: '1' })

    store.selectTask(null)
    expect(store.selectedTaskId).toBeNull()
  })

  it('createTask が正しいパラメータで setDoc を呼ぶ（optimistic update）', async () => {
    const { setDoc, doc } = await import('firebase/firestore')

    const store = useTasksStore()
    const taskId = await store.createTask({ name: 'New Task' })

    expect(doc).toHaveBeenCalled()
    expect(taskId).toBe('new-task-id')
    // setDoc はバックグラウンドで実行されるため非同期で確認
    await vi.waitFor(() => expect(setDoc).toHaveBeenCalled())
  })

  it('createTask が選択中リストの共有範囲を継承する', async () => {
    const { setDoc } = await import('firebase/firestore')

    const listsStore = useListsStore()
    listsStore.$patch({
      selectedListId: 'family-list',
      lists: [
        {
          id: 'family-list',
          name: '家族',
          visibleToMemberIds: ['test-user-id', 'member-a'],
          editableByMemberIds: ['test-user-id', 'member-a'],
          dateCreated: {} as any,
          dateModified: {} as any,
        },
      ],
    })

    const store = useTasksStore()
    await store.createTask({ name: '牛乳を買う' })

    await vi.waitFor(() =>
      expect(setDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          listId: 'family-list',
          visibleToMemberIds: ['test-user-id', 'member-a'],
          editableByMemberIds: ['test-user-id', 'member-a'],
        })
      )
    )
  })

  it('createTask が別スペースのリストへ保存される場合はそのスペースに書き込む', async () => {
    const { setDoc, collection } = await import('firebase/firestore')

    const listsStore = useListsStore()
    listsStore.$patch({
      selectedListId: 'read-later-id',
      lists: [
        {
          id: 'read-later-id',
          name: 'あとで読む',
          spaceId: 'personal_test-user-id',
          visibleToMemberIds: ['test-user-id'],
          editableByMemberIds: ['test-user-id'],
          dateCreated: {} as any,
          dateModified: {} as any,
        },
      ],
    })

    const store = useTasksStore()
    await store.createTask({ name: '記事を読む', listId: 'read-later-id' })

    expect(collection).toHaveBeenCalledWith({}, 'spaces', 'personal_test-user-id', 'tasks')
    await vi.waitFor(() =>
      expect(setDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          listId: 'read-later-id',
          spaceId: 'personal_test-user-id',
        })
      )
    )
  })

  it('unsubscribe でタスクがクリアされる', () => {
    const store = useTasksStore()
    store.$patch({
      tasks: [{ ...baseTask, id: '1', name: 'Task' }],
      selectedTaskId: '1',
    })

    store.unsubscribe()

    expect(store.tasks).toEqual([])
    expect(store.selectedTaskId).toBeNull()
  })

  describe('サブタスク機能', () => {
    it('rootTasks は親タスクのみ返す（parentIdがnull）', () => {
      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'parent-1', name: '親タスク1' },
          { ...baseTask, id: 'subtask-1', name: 'サブタスク1', parentId: 'parent-1' },
          { ...baseTask, id: 'parent-2', name: '親タスク2' },
        ],
      })

      expect(store.rootTasks).toHaveLength(2)
      expect(store.rootTasks.map(t => t.name)).toEqual(['親タスク1', '親タスク2'])
    })

    it('getSubtasks は指定した親タスクのサブタスクを返す', () => {
      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'parent-1', name: '親タスク1' },
          { ...baseTask, id: 'subtask-1a', name: 'サブタスク1a', parentId: 'parent-1' },
          { ...baseTask, id: 'subtask-1b', name: 'サブタスク1b', parentId: 'parent-1' },
          { ...baseTask, id: 'parent-2', name: '親タスク2' },
          { ...baseTask, id: 'subtask-2a', name: 'サブタスク2a', parentId: 'parent-2' },
        ],
      })

      const subtasks1 = store.getSubtasks('parent-1')
      expect(subtasks1).toHaveLength(2)
      expect(subtasks1.map(t => t.name)).toEqual(['サブタスク1a', 'サブタスク1b'])

      const subtasks2 = store.getSubtasks('parent-2')
      expect(subtasks2).toHaveLength(1)
      expect(subtasks2[0]?.name).toBe('サブタスク2a')
    })

    it('getSubtasks はサブタスクがない場合は空配列を返す', () => {
      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'parent-1', name: '親タスク1' },
        ],
      })

      expect(store.getSubtasks('parent-1')).toEqual([])
    })

    it('incompleteTasks はサブタスクを含まない', () => {
      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'parent-1', name: '親タスク' },
          { ...baseTask, id: 'subtask-1', name: 'サブタスク', parentId: 'parent-1' },
        ],
      })

      expect(store.incompleteTasks).toHaveLength(1)
      expect(store.incompleteTasks[0]?.name).toBe('親タスク')
    })

    it('completedTasks は完了したサブタスクも含む', () => {
      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'parent-1', name: '完了した親タスク', completed: true, dateCompleted: {} as any },
          { ...baseTask, id: 'subtask-1', name: '完了したサブタスク', parentId: 'parent-1', completed: true, dateCompleted: {} as any },
        ],
      })

      expect(store.completedTasks).toHaveLength(2)
      expect(store.completedTasks.map(t => t.name)).toEqual(['完了したサブタスク', '完了した親タスク'])
    })

    it('getIncompleteSubtasks は未完了のサブタスクのみ返す', () => {
      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'parent-1', name: '親タスク' },
          { ...baseTask, id: 'subtask-1', name: '未完了サブタスク', parentId: 'parent-1' },
          { ...baseTask, id: 'subtask-2', name: '完了サブタスク', parentId: 'parent-1', completed: true, dateCompleted: {} as any },
          { ...baseTask, id: 'subtask-3', name: '未完了サブタスク2', parentId: 'parent-1' },
        ],
      })

      const incompleteSubtasks = store.getIncompleteSubtasks('parent-1')
      expect(incompleteSubtasks).toHaveLength(2)
      expect(incompleteSubtasks.map(t => t.name)).toEqual(['未完了サブタスク', '未完了サブタスク2'])
    })

    it('hasSubtasks はサブタスクがあればtrue、なければfalseを返す', () => {
      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'parent-1', name: '親タスク（サブタスクあり）' },
          { ...baseTask, id: 'subtask-1', name: 'サブタスク', parentId: 'parent-1' },
          { ...baseTask, id: 'parent-2', name: '親タスク（サブタスクなし）' },
        ],
      })

      expect(store.hasSubtasks('parent-1')).toBe(true)
      expect(store.hasSubtasks('parent-2')).toBe(false)
      expect(store.hasSubtasks('subtask-1')).toBe(false)
    })

    it('getSubtaskCounts は合計と未完了のサブタスク数を返す', () => {
      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'parent-1', name: '親タスク' },
          { ...baseTask, id: 'subtask-1', name: 'サブタスク1', parentId: 'parent-1' },
          { ...baseTask, id: 'subtask-2', name: 'サブタスク2', parentId: 'parent-1', completed: true, dateCompleted: {} as any },
          { ...baseTask, id: 'subtask-3', name: 'サブタスク3', parentId: 'parent-1' },
        ],
      })

      const counts = store.getSubtaskCounts('parent-1')
      expect(counts.total).toBe(3)
      expect(counts.incomplete).toBe(2)
    })

    it('deleteTask で親タスク削除時にサブタスクも連鎖削除される', async () => {
      const { deleteDoc, updateDoc } = await import('firebase/firestore')
      vi.mocked(deleteDoc).mockResolvedValue(undefined as any)
      vi.mocked(updateDoc).mockResolvedValue(undefined as any)

      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'parent-1', name: '親タスク' },
          { ...baseTask, id: 'subtask-1', name: 'サブタスク1', parentId: 'parent-1' },
          { ...baseTask, id: 'subtask-2', name: 'サブタスク2', parentId: 'parent-1', completed: true, dateCompleted: {} as any },
          { ...baseTask, id: 'other-task', name: '別タスク' },
        ],
      })

      await store.deleteTask('parent-1')

      // 親タスク + サブタスク2件 = 3回の updateDoc 呼び出し（論理削除）
      expect(updateDoc).toHaveBeenCalledTimes(3)
      // deleted: true で論理削除されることを確認
      const calls = vi.mocked(updateDoc).mock.calls
      expect(calls.every(call => call[1] && typeof call[1] === 'object' && 'deleted' in call[1] && call[1].deleted === true)).toBe(true)
      // 別タスクだけが残る（削除されたタスクはUIから非表示）
      expect(store.tasks).toHaveLength(1)
      expect(store.tasks[0]?.id).toBe('other-task')
    })

    it('deleteTask でサブタスク単体を削除しても他のタスクに影響しない', async () => {
      const { deleteDoc, updateDoc } = await import('firebase/firestore')
      vi.mocked(deleteDoc).mockResolvedValue(undefined as any)
      vi.mocked(updateDoc).mockResolvedValue(undefined as any)

      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'parent-1', name: '親タスク' },
          { ...baseTask, id: 'subtask-1', name: 'サブタスク1', parentId: 'parent-1' },
          { ...baseTask, id: 'subtask-2', name: 'サブタスク2', parentId: 'parent-1' },
        ],
      })

      await store.deleteTask('subtask-1')

      // サブタスク1件のみ削除（論理削除）
      expect(updateDoc).toHaveBeenCalledTimes(1)
      // deleted: true で論理削除されることを確認
      const calls = vi.mocked(updateDoc).mock.calls
      expect(calls[0]?.[1] && typeof calls[0][1] === 'object' && 'deleted' in calls[0][1] && calls[0][1].deleted === true).toBe(true)
      expect(store.tasks).toHaveLength(2)
      expect(store.tasks.map(t => t.id)).toEqual(['parent-1', 'subtask-2'])
    })

    it('deleteTask で選択中のサブタスクが削除されたら選択解除される', async () => {
      const { deleteDoc, updateDoc } = await import('firebase/firestore')
      vi.mocked(deleteDoc).mockResolvedValue(undefined as any)
      vi.mocked(updateDoc).mockResolvedValue(undefined as any)

      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'parent-1', name: '親タスク' },
          { ...baseTask, id: 'subtask-1', name: 'サブタスク1', parentId: 'parent-1' },
        ],
        selectedTaskId: 'subtask-1',
      })

      await store.deleteTask('parent-1')

      expect(store.selectedTaskId).toBeNull()
    })

    it('deleteCompletedTasksInCurrentList で選択中リストの完了タスクを一括削除できる', async () => {
      const { getDocs, updateDoc } = await import('firebase/firestore')
      vi.mocked(updateDoc).mockResolvedValue(undefined as any)
      vi.mocked(getDocs).mockResolvedValue({
        docs: [
          {
            id: 'completed-parent',
            data: () => ({ ...baseTask, name: '完了した親', completed: true, dateCompleted: {} as any }),
          },
          {
            id: 'completed-subtask',
            data: () => ({ ...baseTask, name: '完了したサブタスク', parentId: 'active-parent', completed: true, dateCompleted: {} as any }),
          },
        ],
      } as any)

      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'completed-parent', name: '完了した親', completed: true, dateCompleted: {} as any },
          { ...baseTask, id: 'child-of-completed-parent', name: '完了親の未完了サブタスク', parentId: 'completed-parent' },
          { ...baseTask, id: 'active-parent', name: '未完了の親' },
          { ...baseTask, id: 'completed-subtask', name: '完了したサブタスク', parentId: 'active-parent', completed: true, dateCompleted: {} as any },
          { ...baseTask, id: 'active-subtask', name: '未完了サブタスク', parentId: 'active-parent' },
        ],
      })

      const deletedCount = await store.deleteCompletedTasksInCurrentList()

      expect(deletedCount).toBe(2)
      expect(updateDoc).toHaveBeenCalledTimes(3)
      expect(store.tasks.map(t => t.id)).toEqual(['active-parent', 'active-subtask'])
    })

    it('deleteCompletedTasksInCurrentList で削除に失敗した場合はローカル状態を消さない', async () => {
      const { getDocs, updateDoc } = await import('firebase/firestore')
      vi.mocked(getDocs).mockResolvedValue({
        docs: [
          {
            id: 'completed-parent',
            data: () => ({ ...baseTask, name: '完了した親', completed: true, dateCompleted: {} as any }),
          },
        ],
      } as any)
      vi.mocked(updateDoc).mockRejectedValue(new Error('permission denied'))

      const store = useTasksStore()
      store.$patch({
        tasks: [
          { ...baseTask, id: 'completed-parent', name: '完了した親', completed: true, dateCompleted: {} as any },
          { ...baseTask, id: 'active-parent', name: '未完了の親' },
        ],
      })

      await expect(store.deleteCompletedTasksInCurrentList()).rejects.toThrow('タスクの削除に失敗しました')
      expect(store.tasks.map(t => t.id)).toEqual(['completed-parent', 'active-parent'])
    })
  })
})
