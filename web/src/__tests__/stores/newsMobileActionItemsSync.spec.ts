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
const updateDocMock = vi.hoisted(() => vi.fn())
const deleteFieldMock = vi.hoisted(() => vi.fn(() => ({ __delete: true })))

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
    updateDoc: updateDocMock,
    deleteField: deleteFieldMock,
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
  setDocMock.mockImplementation(async (ref: { path: string }, data: ServerDocuments['state'], options?: { merge: boolean }) => {
    if (ref.path !== STATE_PATH) return
    documents.state = { resolved: options?.merge
      ? { ...documents.state.resolved, ...data.resolved } : { ...data.resolved } }
  })
  updateDocMock.mockImplementation(async (ref: { path: string }, fields: Record<string, unknown>) => {
    if (ref.path !== STATE_PATH) return
    for (const field of Object.keys(fields)) delete documents.state.resolved[field.slice('resolved.'.length)]
  })
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

function expectNoOperationReads() {
  expect.soft(getDocFromServerMock).not.toHaveBeenCalled()
  expect.soft(getDocMock).toHaveBeenCalledTimes(2)
}

function cacheSnapshot() {
  return localStorage.getItem('rertm-mobile-action-items-user-1')
}

function article(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: 'today-article', title: 'Security update', url: 'https://example.com/x',
    thumbnailUrl: null, topic: 'mobile', source: 'rss', sourceName: 'Example',
    isOfficial: true, importantLevel: 'urgent', actionRequired: true, actionType: 'security',
    score: null, publishedAt: Timestamp.fromMillis(BASE), fetchedAt: Timestamp.fromMillis(BASE), date: '2026-10-31',
    ...overrides,
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
    updateDocMock.mockResolvedValue(undefined)
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

    const resolved = { y: { state: 'done', at: expect.any(Number) } }
    expect.soft(setDocMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: STATE_PATH }), { resolved }, { merge: true })
    expect.soft(documents.state.resolved).toEqual({ x: { state: 'done', at: BASE }, ...resolved })
    expect.soft(store.mobileActionItemStates).toEqual(resolved)
    expectNoOperationReads()
  })

  it('戻す操作は対象フィールドだけを削除しサーバーの別キーを保護する', async () => {
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

    expect.soft(updateDocMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: STATE_PATH }), { 'resolved.x': { __delete: true } })
    expect.soft(setDocMock).not.toHaveBeenCalled()
    expect.soft(store.mobileActionItemStates).toEqual({})
    expect.soft(documents.state.resolved.y).toEqual({ state: 'dismissed', at: BASE + 1 })
    expectNoOperationReads()
  })

  it.each([
    { operation: '対応済み', restore: false, code: 'unavailable' },
    { operation: '対応済み', restore: false, code: 'permission-denied' },
    { operation: '戻す', restore: true, code: 'unavailable' },
    { operation: '戻す', restore: true, code: 'permission-denied' },
  ])('$operation の書き込みが$codeで失敗したらエラーを返し状態とキャッシュを変えない', async ({ restore, code }) => {
    const documents: ServerDocuments = {
      aggregate: { items: { x: actionItem('x') } },
      state: { resolved: restore ? { x: { state: 'done', at: BASE } } : {} },
    }
    installDocs(documents)
    const store = useNewsStore()
    await store.loadMobileActionItems()
    const before = {
      items: structuredClone(documents.aggregate.items), resolved: structuredClone(documents.state.resolved),
      count: store.mobileAlertCount, summary: { ...store.mobileAlertSummary }, cache: cacheSnapshot(),
    }
    const failure = Object.assign(new Error('書き込みに失敗'), { code })
    setDocMock.mockRejectedValueOnce(failure)
    updateDocMock.mockRejectedValueOnce(failure)
    const operation = restore ? store.restoreMobileActionItem('x') : store.resolveMobileActionItem('x', 'done')
    await expect(operation).rejects.toBe(failure)
    expect.soft(store.mobileActionItems).toEqual(before.items)
    expect.soft(store.mobileActionItemStates).toEqual(before.resolved)
    expect.soft(store.mobileAlertCount).toBe(before.count)
    expect.soft(store.mobileAlertSummary).toEqual(before.summary)
    expect.soft(cacheSnapshot()).toBe(before.cache)
    expectNoOperationReads()
  })

  it('集約に無いキーの状態を削除せず表示件数から無視する', async () => {
    const documents: ServerDocuments = {
      aggregate: { items: { y: actionItem('y') } },
      state: { resolved: { x: { state: 'done', at: BASE }, gone: { state: 'done', at: BASE } } },
    }
    installDocs(documents)
    const store = useNewsStore()
    await store.loadMobileActionItems()
    documents.aggregate.items = { x: actionItem('x'), y: actionItem('y') }

    await store.resolveMobileActionItem('y', 'done')

    const resolved = { x: { state: 'done', at: BASE }, gone: { state: 'done', at: BASE }, y: { state: 'done', at: expect.any(Number) } }
    expect.soft(setDocMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: STATE_PATH }),
      { resolved: { y: resolved.y } }, { merge: true })
    expect.soft(store.mobileActionItemStates).toEqual(resolved)
    expect.soft(store.mobileAlertCount).toBe(0)
    expect.soft(store.mobileAlertSummary).toEqual({ urgent: 0, review: 0 })
    expectNoOperationReads()
  })

  it('キーなし当日記事に興味なしを押すと手元集約の完全一致URLをdismissedにする', async () => {
    const documents: ServerDocuments = { aggregate: { items: { x: actionItem('x') } }, state: { resolved: {} } }
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

    const resolved = { x: { state: 'dismissed', at: expect.any(Number) } }
    expect.soft(stateWrites()).toEqual([[expect.objectContaining({ path: STATE_PATH }), { resolved }, { merge: true }]])
    expect.soft(setDocMock.mock.calls.filter(([ref]) => ref.path.startsWith('users/user-1/newsInteractions/'))).toHaveLength(1)
    expect.soft(store.mobileActionItemStates).toEqual(resolved)
    expectNoOperationReads()
  })

  it.each([
    { name: '記事キーをURL一致より優先する', key: 'preferred', url: 'https://example.com/x', expected: 'preferred' },
    { name: 'キーと完全一致URLが無ければ状態を書かない', key: undefined, url: 'https://example.com/x?other=1', expected: undefined },
  ])('興味なしは$name', async ({ key, url, expected }) => {
    installDocs({ aggregate: { items: { x: actionItem('x') } }, state: { resolved: {} } })
    const store = useNewsStore()
    await store.loadMobileActionItems()
    const shown = article({ actionItemKey: key, url })
    store.articles = [shown]
    await store.dismissArticle(shown.id, shown.url, 'mobile')
    if (expected) {
      expect(stateWrites()).toEqual([[expect.objectContaining({ path: STATE_PATH }),
        { resolved: { [expected]: { state: 'dismissed', at: expect.any(Number) } } }, { merge: true }]])
    } else expect(stateWrites()).toHaveLength(0)
    expectNoOperationReads()
  })

  it('興味なしはnewsInteractions成功後に状態を書く', async () => {
    installDocs({ aggregate: { items: { x: actionItem('x') } }, state: { resolved: {} } })
    const store = useNewsStore()
    await store.loadMobileActionItems()
    const shown = article({ actionItemKey: 'x' })
    store.articles = [shown]
    let finish!: () => void
    const interaction = new Promise<void>(resolve => { finish = resolve })
    setDocMock.mockImplementation((ref: { path: string }) => ref.path === STATE_PATH ? Promise.resolve() : interaction)
    const pending = store.dismissArticle(shown.id, shown.url, 'mobile')
    await Promise.resolve()
    expect.soft(stateWrites()).toHaveLength(0)
    expect.soft(store.mobileActionItemStates).toEqual({})
    finish()
    await pending
    const paths = setDocMock.mock.calls.map(([ref]) => ref.path)
    expect(paths[0]).toContain('/newsInteractions/')
    expect(paths[1]).toBe(STATE_PATH)
    expect(store.mobileActionItemStates.x?.state).toBe('dismissed')
    expect(JSON.parse(cacheSnapshot() ?? '{}').resolved).toEqual(store.mobileActionItemStates)
  })

  it.each(['interaction', 'state'])('興味なしの%s書き込み失敗はエラーを返し状態とキャッシュを変えない', async (target) => {
    installDocs({ aggregate: { items: { x: actionItem('x') } }, state: { resolved: {} } })
    const store = useNewsStore()
    await store.loadMobileActionItems()
    const before = cacheSnapshot()
    const shown = article({ actionItemKey: 'x' })
    store.articles = [shown]
    const failure = new Error('書き込みに失敗')
    setDocMock.mockImplementation(async (ref: { path: string }) => {
      if ((ref.path === STATE_PATH) === (target === 'state')) throw failure
    })
    await expect(store.dismissArticle(shown.id, shown.url, 'mobile')).rejects.toBe(failure)
    expect.soft(store.mobileActionItemStates).toEqual({})
    expect.soft(cacheSnapshot()).toBe(before)
    if (target === 'interaction') expect.soft(stateWrites()).toHaveLength(0)
    expectNoOperationReads()
  })

  it.each(['done', 'restore', 'dismissed'] as const)('読み込み中の%s成功後に古い応答が来ても状態とキャッシュを戻さない', async (operation) => {
    const documents: ServerDocuments = {
      aggregate: { items: { x: actionItem('x'), y: actionItem('y') } },
      state: { resolved: { y: { state: 'done', at: BASE }, ...(operation === 'restore' ? { x: { state: 'done' as const, at: BASE } } : {}) } },
    }
    installDocs(documents)
    const store = useNewsStore()
    store.latestFeedDateByTopic.mobile = '2026-10-30'
    await store.loadMobileActionItems()
    store.latestFeedDateByTopic.mobile = '2026-10-31'
    let finish!: (value: { data: () => ServerDocuments['state'] }) => void
    const stale = structuredClone(documents.state)
    getDocMock.mockImplementation(async (ref: { path: string }) => {
      if (ref.path === STATE_PATH) return await new Promise(resolve => { finish = resolve })
      return { data: () => documents.aggregate }
    })
    const loading = store.loadMobileActionItems()
    if (operation === 'restore') await store.restoreMobileActionItem('x')
    else if (operation === 'done') await store.resolveMobileActionItem('x', 'done')
    else {
      const shown = article({ actionItemKey: 'x' })
      store.articles = [shown]
      await store.dismissArticle(shown.id, shown.url, 'mobile')
    }
    const written = { ...store.mobileActionItemStates }
    expect.soft(written.x?.state).toBe(operation === 'restore' ? undefined : operation)
    finish({ data: () => stale })
    await loading
    expect.soft(store.mobileActionItemStates).toEqual(written)
    expect.soft(store.mobileActionItemStates.y).toEqual({ state: 'done', at: BASE })
    expect.soft(JSON.parse(cacheSnapshot() ?? '{}').resolved).toEqual(written)
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
    updateDocMock.mockResolvedValue(undefined)
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
