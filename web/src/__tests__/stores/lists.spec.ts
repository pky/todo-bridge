import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useListsStore } from '@/stores/lists'
import { useAuthStore } from '@/stores/auth'
import { useSpaceStore } from '@/stores/space'

// Firebase Firestore のモック
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  doc: vi.fn(),
  addDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  getDocs: vi.fn(),
  onSnapshot: vi.fn(),
  serverTimestamp: vi.fn(() => ({ seconds: Date.now() / 1000 })),
  query: vi.fn(),
  orderBy: vi.fn(),
  where: vi.fn(),
  writeBatch: vi.fn(() => ({ update: vi.fn(), commit: vi.fn(), delete: vi.fn() })),
  Timestamp: {
    now: vi.fn(() => ({ seconds: Date.now() / 1000, toDate: () => new Date() })),
  },
}))

vi.mock('@/services/firebase', () => ({
  db: {},
}))

vi.mock('@/services/cloudFunctionsService', () => ({
  refreshSmartListCounts: vi.fn().mockResolvedValue({
    today: 0,
    tomorrow: 0,
    overdue: 0,
    thisWeek: 0,
    noDate: 0,
  }),
}))

describe('Lists Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()

    // AuthStore のモック設定
    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'test-user-id', email: 'test@example.com', displayName: 'Test', photoURL: null },
      loading: false,
    })

    const spaceStore = useSpaceStore()
    spaceStore.$patch({
      currentSpaceId: 'space-a',
      useLegacyPath: false,
      initialized: true,
    })
  })

  it('初期状態でリストは空', () => {
    const store = useListsStore()
    expect(store.lists).toEqual([])
    expect(store.selectedListId).toBeNull()
  })

  it('selectList でリストを選択できる', () => {
    const store = useListsStore()
    store.$patch({
      lists: [
        { id: 'list-1', name: 'Inbox', dateCreated: {} as any, dateModified: {} as any },
        { id: 'list-2', name: 'Work', dateCreated: {} as any, dateModified: {} as any },
      ],
    })

    store.selectList('list-2')
    expect(store.selectedListId).toBe('list-2')
    expect(store.selectedList?.name).toBe('Work')
  })

  it('selectedList は選択中のリストを返す', () => {
    const store = useListsStore()
    store.$patch({
      lists: [
        { id: 'list-1', name: 'Inbox', dateCreated: {} as any, dateModified: {} as any },
      ],
      selectedListId: 'list-1',
    })

    expect(store.selectedList).not.toBeNull()
    expect(store.selectedList?.name).toBe('Inbox')
  })

  it('selectedList は未選択時に null を返す', () => {
    const store = useListsStore()
    expect(store.selectedList).toBeNull()
  })

  it('createList が addDoc を呼ぶ', async () => {
    const { addDoc } = await import('firebase/firestore')
    vi.mocked(addDoc).mockResolvedValueOnce({ id: 'new-list-id' } as any)

    const store = useListsStore()
    await store.createList({ name: 'New List' })

    expect(addDoc).toHaveBeenCalled()
  })

  it('createList が共有メンバーを保存し、自分も含める', async () => {
    const { addDoc } = await import('firebase/firestore')
    vi.mocked(addDoc).mockResolvedValueOnce({ id: 'shared-list-id' } as any)

    const store = useListsStore()
    await store.createList({
      name: '家族の買い物',
      visibleToMemberIds: ['member-a'],
    })

    expect(vi.mocked(addDoc).mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      name: '家族の買い物',
      spaceId: 'space-a',
      visibleToMemberIds: ['test-user-id', 'member-a'],
      editableByMemberIds: ['test-user-id', 'member-a'],
    }))
    expect(store.lists[0]?.visibleToMemberIds).toEqual(['test-user-id', 'member-a'])
  })

  it('createList が明示した別スペースへ保存する場合は現在の一覧を汚さない', async () => {
    const { addDoc, collection } = await import('firebase/firestore')
    vi.mocked(addDoc).mockResolvedValueOnce({ id: 'personal-read-later' } as any)

    const store = useListsStore()
    await store.createList({
      name: 'あとで読む',
      spaceId: 'personal_test-user-id',
    })

    expect(collection).toHaveBeenCalledWith({}, 'spaces', 'personal_test-user-id', 'lists')
    expect(store.lists).toEqual([])
  })

  it('deleteList 後に selectedListId がリセットされる', async () => {
    const { deleteDoc, getDocs } = await import('firebase/firestore')
    // タスクが存在しない場合のモック
    vi.mocked(getDocs).mockResolvedValueOnce({
      docs: [],
      empty: true,
      size: 0,
    } as any)
    vi.mocked(deleteDoc).mockResolvedValueOnce(undefined)

    const store = useListsStore()
    store.$patch({
      lists: [
        { id: 'inbox', name: 'Inbox', dateCreated: {} as any, dateModified: {} as any },
        { id: 'work', name: 'Work', dateCreated: {} as any, dateModified: {} as any },
      ],
      selectedListId: 'work',
    })

    await store.deleteList('work')

    expect(store.selectedListId).toBe('inbox')
  })

  it('unsubscribe でリストがクリアされる', () => {
    const store = useListsStore()
    store.$patch({
      lists: [{ id: 'list-1', name: 'Inbox', dateCreated: {} as any, dateModified: {} as any }],
      tags: [{ id: 'tag-1', name: 'important' }],
      selectedListId: 'list-1',
    })

    store.unsubscribe()

    expect(store.lists).toEqual([])
    expect(store.tags).toEqual([])
    expect(store.selectedListId).toBeNull()
  })

  it('tags の初期状態は空', () => {
    const store = useListsStore()
    expect(store.tags).toEqual([])
  })

  it('createTag が addDoc を呼ぶ', async () => {
    const { addDoc } = await import('firebase/firestore')
    vi.mocked(addDoc).mockResolvedValueOnce({ id: 'new-tag-id' } as any)

    const store = useListsStore()
    await store.createTag('important')

    expect(addDoc).toHaveBeenCalled()
  })

  it('subscribe で実データからスマートリスト件数を再同期する', async () => {
    const { getDocs, onSnapshot } = await import('firebase/firestore')
    const { refreshSmartListCounts } = await import('@/services/cloudFunctionsService')

    vi.mocked(getDocs)
      .mockResolvedValueOnce({
        docs: [
          {
            id: 'inbox-id',
            data: () => ({ name: 'Inbox', dateCreated: {} as any, dateModified: {} as any }),
          },
        ],
      } as any)
      .mockResolvedValueOnce({ docs: [] } as any)
    vi.mocked(onSnapshot).mockReturnValue(() => {})
    vi.mocked(refreshSmartListCounts).mockResolvedValueOnce({
      today: 0,
      tomorrow: 0,
      overdue: 2,
      thisWeek: 0,
      noDate: 0,
    })

    const store = useListsStore()
    await store.subscribe()

    expect(refreshSmartListCounts).toHaveBeenCalled()
    expect(store.smartListCounts.overdue).toBe(2)
  })

  it('deleteList がリスト内のタスクも削除する', async () => {
    const { deleteDoc, getDocs, query, where, writeBatch } = await import('firebase/firestore')

    // タスク取得のモック（リスト内に2件のタスクがある）
    vi.mocked(getDocs).mockResolvedValueOnce({
      docs: [
        { id: 'task-1', data: () => ({}) },
        { id: 'task-2', data: () => ({}) },
      ],
      empty: false,
      size: 2,
    } as any)

    const batchMock = { delete: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) }
    vi.mocked(writeBatch).mockReturnValue(batchMock as any)
    vi.mocked(deleteDoc).mockResolvedValueOnce(undefined)

    const store = useListsStore()
    store.$patch({
      lists: [
        { id: 'inbox', name: 'Inbox', dateCreated: {} as any, dateModified: {} as any },
        { id: 'work', name: 'Work', dateCreated: {} as any, dateModified: {} as any },
      ],
      selectedListId: 'work',
    })

    await store.deleteList('work')

    // タスク取得クエリが呼ばれたことを確認
    expect(query).toHaveBeenCalled()
    expect(where).toHaveBeenCalledWith('listId', '==', 'work')
    expect(getDocs).toHaveBeenCalled()

    // バッチ削除が2回呼ばれたことを確認（タスク2件）
    expect(batchMock.delete).toHaveBeenCalledTimes(2)
    expect(batchMock.commit).toHaveBeenCalled()

    // リスト削除が呼ばれたことを確認
    expect(deleteDoc).toHaveBeenCalled()
  })

  it('updateList がリスト名を更新する', async () => {
    const { updateDoc } = await import('firebase/firestore')
    vi.mocked(updateDoc).mockResolvedValueOnce(undefined)

    const store = useListsStore()
    store.$patch({
      lists: [
        { id: 'work', name: 'Work', dateCreated: {} as any, dateModified: {} as any },
      ],
    })

    await store.updateList('work', { name: 'Personal' })

    expect(updateDoc).toHaveBeenCalled()
    expect(store.lists[0]?.name).toBe('Personal')
  })

  it('updateList が共有メンバーを更新し、自分を維持する', async () => {
    const { updateDoc } = await import('firebase/firestore')
    vi.mocked(updateDoc).mockResolvedValueOnce(undefined)

    const store = useListsStore()
    store.$patch({
      lists: [
        {
          id: 'family',
          name: '家族',
          visibleToMemberIds: ['test-user-id'],
          editableByMemberIds: ['test-user-id'],
          dateCreated: {} as any,
          dateModified: {} as any,
        },
      ],
    })

    await store.updateList('family', {
      visibleToMemberIds: ['member-a', 'member-b'],
    })

    expect(vi.mocked(updateDoc).mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      visibleToMemberIds: ['test-user-id', 'member-a', 'member-b'],
      editableByMemberIds: ['test-user-id', 'member-a', 'member-b'],
    }))
    expect(store.lists[0]?.visibleToMemberIds).toEqual(['test-user-id', 'member-a', 'member-b'])
    expect(store.lists[0]?.editableByMemberIds).toEqual(['test-user-id', 'member-a', 'member-b'])
  })
})
