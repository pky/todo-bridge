// 要対応記事の集約ドキュメント（topics/mobile/meta/actionItems）と
// 利用者の状態ドキュメント（users/{uid}/newsState/mobileActionItems）を扱う store の検証。
// 画面表示1回で2読み込み、対応済み操作1回で1書き込みに抑える。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useNewsStore } from '@/stores/news'
import type { NewsArticle } from '@/types'

const getDocsMock = vi.hoisted(() => vi.fn())
const getDocsFromServerMock = vi.hoisted(() => vi.fn())
const getDocMock = vi.hoisted(() => vi.fn())
const getDocFromServerMock = vi.hoisted(() => vi.fn())
const setDocMock = vi.hoisted(() => vi.fn())
const updateDocMock = vi.hoisted(() => vi.fn())
const deleteFieldMock = vi.hoisted(() => vi.fn(() => ({ __delete: true })))
const batchSetMock = vi.hoisted(() => vi.fn())
const batchCommitMock = vi.hoisted(() => vi.fn())
const incrementMock = vi.hoisted(() => vi.fn((value: number) => ({ __increment: value })))

vi.mock('@/services/firebase', () => ({
  db: {},
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ type: 'collection', path: segments.join('/') })),
  doc: vi.fn((base: { path?: string }, ...segments: string[]) => ({
    type: 'doc',
    path: typeof base?.path === 'string' ? `${base.path}/${segments.join('/')}` : segments.join('/'),
  })),
  documentId: vi.fn(() => '__name__'),
  getDocs: getDocsMock,
  getDocsFromServer: getDocsFromServerMock,
  getDoc: getDocMock,
  getDocFromServer: getDocFromServerMock,
  setDoc: setDocMock,
  updateDoc: updateDocMock,
  deleteField: deleteFieldMock,
  writeBatch: vi.fn(() => ({
    set: batchSetMock,
    commit: batchCommitMock,
  })),
  increment: incrementMock,
  query: vi.fn((target: unknown, ...clauses: unknown[]) => ({ type: 'query', target, clauses })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ type: 'where', field, op, value })),
  orderBy: vi.fn((field: string, direction: string) => ({ type: 'orderBy', field, direction })),
  limit: vi.fn((value: number) => ({ type: 'limit', value })),
  serverTimestamp: vi.fn(() => ({ seconds: Date.now() / 1000 })),
}))

const listsState = vi.hoisted(() => ({ lists: [] as Array<{ id: string; name: string; spaceId: string }> }))
const createTaskMock = vi.hoisted(() => vi.fn())
const createListMock = vi.hoisted(() => vi.fn())

vi.mock('@/stores/lists', () => ({
  useListsStore: () => ({
    get lists() { return listsState.lists },
    createList: createListMock,
  }),
}))

vi.mock('@/stores/tasks', () => ({
  useTasksStore: () => ({ createTask: createTaskMock }),
}))

vi.mock('@/stores/space', () => ({
  buildPersonalSpaceId: (uid: string) => `personal_${uid}`,
  useSpaceStore: () => ({
    getCollectionRefForSpace: vi.fn((name: string, spaceId: string) => ({ type: 'collection', path: `spaces/${spaceId}/${name}` })),
  }),
}))

const AGGREGATE_PATH ='topics/mobile/meta/actionItems'
const STATE_PATH = 'users/user-1/newsState/mobileActionItems'
const BASE = Date.UTC(2026, 9, 1)

function actionItem(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    url: `https://example.com/${key}`,
    titleJa: `要対応 ${key}`,
    title: `Action ${key}`,
    platform: 'ios',
    sourceName: 'Example',
    isOfficial: true,
    importantLevel: 'urgent',
    actionRequired: true,
    actionType: 'security',
    publishedAt: BASE,
    firstSeenDate: '2026-10-01',
    ...overrides,
  }
}

function installDocs(options: {
  aggregate?: Record<string, unknown> | null
  state?: Record<string, unknown> | null
}) {
  const serve = async (ref: { path: string }) => {
    if (ref.path === AGGREGATE_PATH) {
      const data = options.aggregate
      return { id: 'actionItems', exists: () => data != null, data: () => data ?? undefined }
    }
    if (ref.path === STATE_PATH) {
      const data = options.state
      return { id: 'mobileActionItems', exists: () => data != null, data: () => data ?? undefined }
    }
    return { id: ref.path.slice(ref.path.lastIndexOf('/') + 1), exists: () => false, data: () => undefined }
  }
  getDocMock.mockImplementation(serve)
  getDocFromServerMock.mockImplementation(serve)
  const emptyDocs = async () => ({ empty: true, docs: [] })
  getDocsMock.mockImplementation(emptyDocs)
  getDocsFromServerMock.mockImplementation(emptyDocs)
}

const getDocPaths = () => getDocMock.mock.calls.map(([ref]) => (ref as { path: string }).path)
const stateWrites = () => setDocMock.mock.calls.filter(([ref]) => (ref as { path: string }).path === STATE_PATH)

describe('要対応記事の集約と対応済み状態', () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
    useAuthStore().$patch({
      user: { uid: 'user-1', email: 'test@example.com', displayName: 'Test', photoURL: null },
      loading: false,
    })
    listsState.lists = [{ id: 'list-readlater', name: 'あとで読む', spaceId: 'personal_user-1' }]
    createTaskMock.mockResolvedValue(undefined)
    createListMock.mockResolvedValue(undefined)
    setDocMock.mockResolvedValue(undefined)
    updateDocMock.mockResolvedValue(undefined)
    batchCommitMock.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('loadMobileActionItems', () => {
    it('集約ドキュメントと状態ドキュメントを getDoc で1回ずつ、計2回だけ読む', async () => {
      installDocs({
        aggregate: { items: { a: actionItem('a') } },
        state: { resolved: {} },
      })
      await useNewsStore().loadMobileActionItems()

      expect(getDocMock).toHaveBeenCalledTimes(2)
      expect(getDocPaths().sort()).toEqual([AGGREGATE_PATH, STATE_PATH].sort())
    })

    it('読んだ items と resolved を state に入れる', async () => {
      installDocs({
        aggregate: { items: { a: actionItem('a'), b: actionItem('b') } },
        state: { resolved: { a: { state: 'done', at: BASE } } },
      })
      const store = useNewsStore()
      await store.loadMobileActionItems()

      expect(Object.keys(store.mobileActionItems).sort()).toEqual(['a', 'b'])
      expect(store.mobileActionItems.a.titleJa).toBe('要対応 a')
      expect(store.mobileActionItemStates).toEqual({ a: { state: 'done', at: BASE } })
    })

    it('どちらのドキュメントも無ければ空として扱う', async () => {
      installDocs({ aggregate: null, state: null })
      const store = useNewsStore()
      await store.loadMobileActionItems()

      expect(store.mobileActionItems).toEqual({})
      expect(store.mobileActionItemStates).toEqual({})
    })
  })

  describe('resolveMobileActionItem', () => {
    it('状態ドキュメントの対象キーだけをmergeで1回書き、既存状態を残して手元も更新する', async () => {
      installDocs({
        aggregate: { items: { a: actionItem('a'), b: actionItem('b') } },
        state: { resolved: { b: { state: 'dismissed', at: BASE }, gone: { state: 'done', at: BASE } } },
      })
      const store = useNewsStore()
      await store.loadMobileActionItems()
      setDocMock.mockClear()

      await store.resolveMobileActionItem('a', 'done')

      expect(setDocMock).toHaveBeenCalledTimes(1)
      const [ref, data] = setDocMock.mock.calls[0] as [{ path: string }, { resolved: Record<string, unknown> }]
      expect(ref.path).toBe(STATE_PATH)
      expect(Object.keys(data.resolved)).toEqual(['a'])
      expect(setDocMock.mock.calls[0]?.[2]).toEqual({ merge: true })
      expect(getDocFromServerMock).not.toHaveBeenCalled()
      expect(getDocMock).toHaveBeenCalledTimes(2)
      expect(data.resolved.a).toEqual({ state: 'done', at: expect.any(Number) })
      expect(store.mobileActionItemStates.b).toEqual({ state: 'dismissed', at: BASE })

      expect(store.mobileActionItemStates.a).toEqual({ state: 'done', at: expect.any(Number) })
      expect(store.mobileActionItemStates.gone).toEqual({ state: 'done', at: BASE })
    })

    it('dismissed も同じく1回の書き込みで記録する', async () => {
      installDocs({ aggregate: { items: { a: actionItem('a') } }, state: null })
      const store = useNewsStore()
      await store.loadMobileActionItems()
      setDocMock.mockClear()

      await store.resolveMobileActionItem('a', 'dismissed')

      expect(setDocMock).toHaveBeenCalledTimes(1)
      const [, data] = setDocMock.mock.calls[0] as [unknown, { resolved: Record<string, unknown> }]
      expect(data.resolved).toEqual({ a: { state: 'dismissed', at: expect.any(Number) } })
      expect(store.mobileActionItemStates.a?.state).toBe('dismissed')
      expect(stateWrites()[0]?.[2]).toEqual({ merge: true })
      expect(getDocFromServerMock).not.toHaveBeenCalled()
    })
  })

  describe('restoreMobileActionItem', () => {
    it('対象キーだけをupdateDocとdeleteFieldで1回削除し、手元からも消す', async () => {
      installDocs({
        aggregate: { items: { a: actionItem('a'), b: actionItem('b') } },
        state: { resolved: { a: { state: 'done', at: BASE }, b: { state: 'dismissed', at: BASE + 1 } } },
      })
      const store = useNewsStore()
      await store.loadMobileActionItems()
      setDocMock.mockClear()

      await store.restoreMobileActionItem('a')

      expect(setDocMock).not.toHaveBeenCalled()
      expect(updateDocMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ path: STATE_PATH }), { 'resolved.a': { __delete: true } },
      )
      expect(deleteFieldMock).toHaveBeenCalledTimes(1)
      expect(getDocFromServerMock).not.toHaveBeenCalled()
      expect(getDocMock).toHaveBeenCalledTimes(2)
      expect(store.mobileActionItemStates.a).toBeUndefined()
      expect(store.mobileActionItemStates.b).toEqual({ state: 'dismissed', at: BASE + 1 })
    })
  })

  describe('興味なしとあとで読み', () => {
    const actionArticle: NewsArticle = {
      id: 'mobile-sec-1',
      title: 'Security update',
      titleJa: 'セキュリティ更新',
      summaryJa: '要約',
      url: 'https://example.com/a',
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'rss',
      sourceName: 'Example',
      isOfficial: true,
      importantLevel: 'urgent',
      actionRequired: true,
      actionType: 'security',
      actionItemKey: 'a',
      score: null,
      publishedAt: {} as NewsArticle['publishedAt'],
      fetchedAt: {} as NewsArticle['fetchedAt'],
      date: '2026-10-31',
    }

    it('要対応記事に興味なしを押すと newsInteractions に加えて状態ドキュメントへ dismissed を書く', async () => {
      installDocs({ aggregate: { items: { a: actionItem('a') } }, state: null })
      const store = useNewsStore()
      await store.loadMobileActionItems()
      store.articles = [actionArticle]
      setDocMock.mockClear()

      await store.dismissArticle(actionArticle.id, actionArticle.url, 'mobile')

      const interactionWrites = setDocMock.mock.calls.filter(([ref]) =>
        (ref as { path: string }).path.startsWith('users/user-1/newsInteractions/'))
      expect(interactionWrites).toHaveLength(1)
      expect(stateWrites()).toHaveLength(1)
      const [, data] = stateWrites()[0] as [unknown, { resolved: Record<string, { state: string }> }]
      expect(data.resolved.a?.state).toBe('dismissed')
      expect(store.mobileActionItemStates.a?.state).toBe('dismissed')
      expect(stateWrites()[0]?.[2]).toEqual({ merge: true })
      expect(getDocFromServerMock).not.toHaveBeenCalled()
    })

    it('あとで読むでは状態ドキュメントに書かない', async () => {
      installDocs({ aggregate: { items: { a: actionItem('a') } }, state: null })
      const store = useNewsStore()
      await store.loadMobileActionItems()
      store.articles = [actionArticle]
      setDocMock.mockClear()

      await store.bookmarkArticle(actionArticle)

      expect(createTaskMock).toHaveBeenCalledTimes(1)
      expect(stateWrites()).toHaveLength(0)
      expect(store.mobileActionItemStates.a).toBeUndefined()
    })
  })

  describe('loadMobileAlertCount', () => {
    it('集約の未処理かつ urgent の件数を mobileAlertCount にする', async () => {
      installDocs({
        aggregate: {
          items: {
            u1: actionItem('u1', { importantLevel: 'urgent' }),
            u2: actionItem('u2', { importantLevel: 'urgent' }),
            u3: actionItem('u3', { importantLevel: 'urgent' }),
            doneUrgent: actionItem('doneUrgent', { importantLevel: 'urgent' }),
            dismissedUrgent: actionItem('dismissedUrgent', { importantLevel: 'urgent' }),
            review: actionItem('review', { importantLevel: 'review' }),
          },
        },
        state: {
          resolved: {
            doneUrgent: { state: 'done', at: BASE },
            dismissedUrgent: { state: 'dismissed', at: BASE },
          },
        },
      })
      const store = useNewsStore()
      await store.loadMobileActionItems()
      await store.loadMobileAlertCount()

      expect(store.mobileAlertCount).toBe(3)
    })
  })
})
