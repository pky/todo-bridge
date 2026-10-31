import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { Timestamp } from 'firebase/firestore'
import { useAuthStore } from '@/stores/auth'
import { useNewsStore } from '@/stores/news'
import type { MobileActionItem, MobileActionItemState, NewsArticle, NewsPreferences } from '@/types'

const getDocsMock = vi.hoisted(() => vi.fn())
const getDocsFromServerMock = vi.hoisted(() => vi.fn())
const getDocMock = vi.hoisted(() => vi.fn())
const getDocFromServerMock = vi.hoisted(() => vi.fn())
const setDocMock = vi.hoisted(() => vi.fn())

vi.mock('@/services/firebase', () => ({ db: {} }))

vi.mock('firebase/firestore', async () => {
  const { Timestamp } = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore')
  return {
    Timestamp,
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
    writeBatch: vi.fn(() => ({ set: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) })),
    increment: vi.fn((value: number) => ({ __increment: value })),
    query: vi.fn((target: unknown, ...clauses: unknown[]) => ({ type: 'query', target, clauses })),
    where: vi.fn((field: string, op: string, value: unknown) => ({ type: 'where', field, op, value })),
    orderBy: vi.fn((field: string, direction: string) => ({ type: 'orderBy', field, direction })),
    limit: vi.fn((value: number) => ({ type: 'limit', value })),
    serverTimestamp: vi.fn(() => ({ seconds: Date.now() / 1000 })),
  }
})

vi.mock('@/stores/lists', () => ({ useListsStore: () => ({ lists: [], createList: vi.fn() }) }))
vi.mock('@/stores/tasks', () => ({ useTasksStore: () => ({ createTask: vi.fn() }) }))
vi.mock('@/stores/space', () => ({
  buildPersonalSpaceId: (uid: string) => `personal_${uid}`,
  useSpaceStore: () => ({
    getCollectionRefForSpace: vi.fn((name: string, spaceId: string) => ({ type: 'collection', path: `spaces/${spaceId}/${name}` })),
  }),
}))

const AGGREGATE_PATH = 'topics/mobile/meta/actionItems'
const STATE_PATH = 'users/user-1/newsState/mobileActionItems'
const BASE = Date.UTC(2026, 9, 1)
type ActionItemFixture = MobileActionItem & Pick<NewsArticle, 'sourceTier'>
interface ServerDocuments {
  aggregate: { items: Record<string, ActionItemFixture> }
  state: { resolved: Record<string, MobileActionItemState> }
}

function actionItem(key: string, overrides: Partial<ActionItemFixture> = {}): ActionItemFixture {
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

function installDocs(documents: ServerDocuments) {
  const serve = async (ref: { path: string }) => {
    const data = ref.path === AGGREGATE_PATH ? documents.aggregate
      : ref.path === STATE_PATH ? documents.state : undefined
    return { exists: () => data !== undefined, data: () => data }
  }
  getDocMock.mockImplementation(serve)
  getDocFromServerMock.mockImplementation(serve)
  getDocsMock.mockResolvedValue({ empty: true, docs: [] })
  getDocsFromServerMock.mockResolvedValue({ empty: true, docs: [] })
  return serve
}

function signIn() {
  useAuthStore().$patch({
    user: { uid: 'user-1', email: 'test@example.com', displayName: 'Test', photoURL: null },
    loading: false,
  })
}

function expectServerReadsBeforeStateWrite() {
  expect.soft(getDocFromServerMock.mock.calls.map(([ref]) => ref.path).sort())
    .toEqual([AGGREGATE_PATH, STATE_PATH].sort())
  const writeIndex = setDocMock.mock.calls.findIndex(([ref]) => ref.path === STATE_PATH)
  const writeOrder = setDocMock.mock.invocationCallOrder[writeIndex]
  expect.soft(writeOrder).toBeDefined()
  for (const readOrder of getDocFromServerMock.mock.invocationCallOrder) {
    expect.soft(readOrder).toBeLessThan(writeOrder ?? -1)
  }
}

function stateWrites() {
  return setDocMock.mock.calls.filter(([ref]) => ref.path === STATE_PATH)
}

function documentReadPaths() {
  return [...getDocMock.mock.calls, ...getDocFromServerMock.mock.calls].map(([ref]) => ref.path)
}

describe('要対応記事の複数端末同期', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 31, 12))
    setActivePinia(createPinia())
    vi.resetAllMocks()
    localStorage.clear()
    signIn()
    setDocMock.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('古い手元の状態で対応済みにしてもサーバーで追加された別キーを残して1回だけ保存する', async () => {
    const documents: ServerDocuments = {
      aggregate: { items: { x: actionItem('x'), y: actionItem('y') } },
      state: { resolved: {} },
    }
    installDocs(documents)
    const store = useNewsStore()
    await store.loadMobileActionItems()
    documents.state = { resolved: { x: { state: 'done', at: BASE } } }

    await store.resolveMobileActionItem('y', 'done')

    const resolved = { x: { state: 'done', at: BASE }, y: { state: 'done', at: expect.any(Number) } }
    expect.soft(setDocMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: STATE_PATH }), { resolved })
    expect.soft(store.mobileActionItemStates).toEqual(resolved)
    expectServerReadsBeforeStateWrite()
  })

  it('戻す操作もサーバーの最新状態を土台に対象キーだけを除いて1回だけ保存する', async () => {
    const documents: ServerDocuments = {
      aggregate: { items: { x: actionItem('x'), y: actionItem('y') } },
      state: { resolved: { x: { state: 'done', at: BASE } } },
    }
    installDocs(documents)
    const store = useNewsStore()
    await store.loadMobileActionItems()
    documents.state = { resolved: {
      x: { state: 'done', at: BASE },
      y: { state: 'dismissed', at: BASE + 1 },
    } }

    await store.restoreMobileActionItem('x')

    const resolved = { y: { state: 'dismissed', at: BASE + 1 } }
    expect.soft(setDocMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: STATE_PATH }), { resolved })
    expect.soft(store.mobileActionItemStates).toEqual(resolved)
    expectServerReadsBeforeStateWrite()
  })

  it.each([
    { operation: '対応済み', restore: false, path: AGGREGATE_PATH },
    { operation: '対応済み', restore: false, path: STATE_PATH },
    { operation: '戻す', restore: true, path: AGGREGATE_PATH },
    { operation: '戻す', restore: true, path: STATE_PATH },
  ])('$operation 操作前の $path の読み直し失敗を返し、書き込みも手元の変更もしない', async ({ restore, path }) => {
    const documents: ServerDocuments = {
      aggregate: { items: { x: actionItem('x') } },
      state: { resolved: restore ? { x: { state: 'done', at: BASE } } : {} },
    }
    const serve = installDocs(documents)
    const store = useNewsStore()
    await store.loadMobileActionItems()
    const before = {
      items: structuredClone(documents.aggregate.items),
      resolved: structuredClone(documents.state.resolved),
      count: store.mobileAlertCount,
      summary: { ...store.mobileAlertSummary },
    }
    documents.aggregate.items = { x: actionItem('x'), serverOnly: actionItem('serverOnly') }
    documents.state.resolved = { serverOnly: { state: 'dismissed', at: BASE + 1 } }
    const failure = new Error('サーバーからの再取得に失敗')
    getDocFromServerMock.mockImplementation(async (ref: { path: string }) => {
      if (ref.path === path) throw failure
      return serve(ref)
    })

    const operation = restore ? store.restoreMobileActionItem('x') : store.resolveMobileActionItem('x', 'done')

    const error = await operation.then(() => undefined, (err: unknown) => err)
    expect.soft(error).toBe(failure)
    expect.soft(setDocMock).not.toHaveBeenCalled()
    expect.soft(store.mobileActionItems).toEqual(before.items)
    expect.soft(store.mobileActionItemStates).toEqual(before.resolved)
    expect.soft(store.mobileAlertCount).toBe(before.count)
    expect.soft(store.mobileAlertSummary).toEqual(before.summary)
  })

  it('pruneは最新の集約を使い、手元の集約になくサーバーに残るキーの状態を消さない', async () => {
    const documents: ServerDocuments = {
      aggregate: { items: { y: actionItem('y') } },
      state: { resolved: { x: { state: 'done', at: BASE }, gone: { state: 'done', at: BASE } } },
    }
    installDocs(documents)
    const store = useNewsStore()
    await store.loadMobileActionItems()
    documents.aggregate.items = { x: actionItem('x'), y: actionItem('y') }

    await store.resolveMobileActionItem('y', 'done')

    const resolved = { x: { state: 'done', at: BASE }, y: { state: 'done', at: expect.any(Number) } }
    expect.soft(setDocMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: STATE_PATH }), { resolved })
    expect.soft(store.mobileActionItemStates).toEqual(resolved)
    expectServerReadsBeforeStateWrite()
  })

  it('キーなし当日記事に興味なしを押すと、手元になく最新集約にある完全一致URLをdismissedにする', async () => {
    const documents: ServerDocuments = { aggregate: { items: {} }, state: { resolved: {} } }
    installDocs(documents)
    const store = useNewsStore()
    await store.loadMobileActionItems()
    const article: NewsArticle = {
      id: 'today-article', title: 'Security update', url: 'https://example.com/x',
      thumbnailUrl: null, topic: 'mobile', source: 'rss', sourceName: 'Example',
      isOfficial: true, importantLevel: 'urgent', actionRequired: true, actionType: 'security',
      score: null, publishedAt: Timestamp.fromMillis(BASE), fetchedAt: Timestamp.fromMillis(BASE), date: '2026-10-31',
    }
    store.articles = [article]
    documents.aggregate.items = { x: actionItem('x'), y: actionItem('y') }
    documents.state.resolved = { y: { state: 'done', at: BASE } }

    await store.dismissArticle(article.id, article.url, 'mobile')

    const resolved = { x: { state: 'dismissed', at: expect.any(Number) }, y: { state: 'done', at: BASE } }
    expect.soft(stateWrites()).toEqual([[expect.objectContaining({ path: STATE_PATH }), { resolved }]])
    expect.soft(setDocMock.mock.calls.filter(([ref]) => ref.path.startsWith('users/user-1/newsInteractions/'))).toHaveLength(1)
    expect.soft(store.mobileActionItemStates).toEqual(resolved)
    expectServerReadsBeforeStateWrite()
  })
})

describe('要対応記事のフィード日付キャッシュと設定', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 31, 12))
    setActivePinia(createPinia())
    vi.resetAllMocks()
    localStorage.clear()
    signIn()
    setDocMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([
    { cache: 'メモリ', recreate: false },
    { cache: 'localStorageから作り直したstore', recreate: true },
  ])('端末の日付が同じでもフィードの最新日付が変われば$cacheの集約と状態を読み直す', async ({ recreate }) => {
    const documents: ServerDocuments = {
      aggregate: { items: { old: actionItem('old') } },
      state: { resolved: { old: { state: 'done', at: BASE } } },
    }
    installDocs(documents)
    let store = useNewsStore()
    store.latestFeedDateByTopic.mobile = '2026-10-30'
    await store.loadMobileActionItems()
    expect(documentReadPaths().sort()).toEqual([AGGREGATE_PATH, STATE_PATH].sort())
    if (recreate) {
      store.$dispose()
      setActivePinia(createPinia())
      signIn()
      store = useNewsStore()
      store.latestFeedDateByTopic.mobile = '2026-10-30'
    }
    await store.loadMobileActionItems()
    expect(documentReadPaths().sort()).toEqual([AGGREGATE_PATH, STATE_PATH].sort())
    documents.aggregate.items = { fresh: actionItem('fresh') }
    documents.state.resolved = { fresh: { state: 'dismissed', at: BASE + 1 } }
    if (recreate) {
      store.$dispose()
      setActivePinia(createPinia())
      signIn()
      store = useNewsStore()
    }
    store.latestFeedDateByTopic.mobile = '2026-10-31'

    await store.loadMobileActionItems()

    expect.soft(store.mobileActionItems).toEqual(documents.aggregate.items)
    expect.soft(store.mobileActionItemStates).toEqual(documents.state.resolved)
    expect.soft(documentReadPaths().sort()).toEqual([AGGREGATE_PATH, AGGREGATE_PATH, STATE_PATH, STATE_PATH].sort())
    await store.loadMobileActionItems()
    expect.soft(documentReadPaths().sort()).toEqual([AGGREGATE_PATH, AGGREGATE_PATH, STATE_PATH, STATE_PATH].sort())
    const readsBeforeDateChange = documentReadPaths()
    vi.setSystemTime(new Date(2026, 10, 1, 12))
    await store.loadMobileActionItems()
    expect.soft(documentReadPaths()).toEqual(readsBeforeDateChange)
    expect.soft(documentReadPaths().sort()).toEqual([AGGREGATE_PATH, AGGREGATE_PATH, STATE_PATH, STATE_PATH].sort())
  })

  const filters: Array<{ name: string; preferences: NewsPreferences; excluded: Partial<ActionItemFixture> }> = [
    { name: 'platformsがiosのみ', preferences: { keywords: [], platforms: ['ios'] }, excluded: { platform: 'android' } },
    { name: 'officialOnly', preferences: { keywords: [], officialOnly: true }, excluded: { isOfficial: false } },
    {
      name: 'includeCommunityがfalse', preferences: { keywords: [], includeCommunity: false },
      excluded: { isOfficial: false, sourceTier: 'community-rss' },
    },
    { name: 'actionRequiredOnly', preferences: { keywords: [], actionRequiredOnly: true }, excluded: { actionRequired: false } },
  ]

  it.each(filters)('$nameでは対象外の未処理urgentとreviewをヘッダー件数から除く', async ({ preferences, excluded }) => {
    installDocs({
      aggregate: { items: {
        visibleUrgent: actionItem('visibleUrgent'),
        visibleReview: actionItem('visibleReview', { importantLevel: 'review' }),
        hiddenUrgent: actionItem('hiddenUrgent', excluded),
        hiddenReview: actionItem('hiddenReview', { ...excluded, importantLevel: 'review' }),
      } },
      state: { resolved: {} },
    })
    const store = useNewsStore()
    store.preferences = preferences

    await store.loadMobileAlertCount()

    expect.soft(store.mobileAlertCount).toBe(1)
    expect.soft(store.mobileAlertSummary).toEqual({ urgent: 1, review: 1 })
  })
})
