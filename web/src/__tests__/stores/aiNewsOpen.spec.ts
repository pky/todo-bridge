import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiNewsStore } from '@/stores/aiNews'
import { cacheKey, demoUid, feedBytes, makeFeed, nowMs } from '../fixtures/aiNewsV2'

const deps = vi.hoisted(() => ({ fetch: vi.fn(), post: vi.fn(), user: { uid: 'ai-news-demo-user', getIdToken: vi.fn(), getIdTokenResult: vi.fn() } }))
vi.mock('@/services/firebase', () => ({ auth: { currentUser: deps.user }, db: {}, functions: {} }))
vi.mock('@/services/aiNewsFeedSource', () => ({ AI_FEED_LATEST_PATH: 'news/v2/ai/latest.json', fetchLatestAiFeedBytes: deps.fetch, classifyStorageError: () => 'transient' }))
vi.mock('@/services/newsActionClient', () => ({ postNewsAction: deps.post }))

// 欠けた公開メソッドを型キャストで隠さず、実装前でも型チェックできる境界にする。
function open(store: ReturnType<typeof useAiNewsStore>, id = 'demo-first'): Promise<void> {
  const method: unknown = Reflect.get(store, 'open')
  expect(method, 'openをstoreから公開する').toBeTypeOf('function')
  if (typeof method !== 'function') throw new Error('openが未実装です')
  return Promise.resolve(method(id))
}
function state(store: ReturnType<typeof useAiNewsStore>) {
  return JSON.stringify({ articles: store.visibleArticles, pending: store.pendingArticles, error: store.error, ops: localStorage.getItem(`${cacheKey}:ops`), first: store.readLaterState('demo-first'), second: store.readLaterState('demo-second') })
}

describe('AI記事を開く操作', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(nowMs)
    setActivePinia(createPinia())
    deps.user.uid = demoUid
    deps.user.getIdToken.mockResolvedValue('fiction-token')
    deps.user.getIdTokenResult.mockResolvedValue({ claims: { newsRole: 'curator' } })
    deps.fetch.mockResolvedValue(feedBytes())
    deps.post.mockResolvedValue({ kind: 'unknown' })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('原本の情報と新しいoperationIdでopenを送る', async () => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    await open(store)
    expect(deps.post).toHaveBeenCalledTimes(1)
    expect(deps.post.mock.calls[0]?.[0]).toEqual({ schemaVersion: 2, topic: 'ai', feedDate: makeFeed().feedDate, revision: makeFeed().revision, articleId: 'demo-first', action: 'open', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/i) })
  })
  it('既存のdismissとreadLaterとpendingを保持しopsを書かない', async () => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    deps.post.mockImplementationOnce(async body => ({ kind: 'ok', result: { ...body, status: 'created' } }))
    await store.readLater('demo-second')
    await store.dismiss('demo-first')
    expect(store.readLaterState('demo-second')).toBe('added')
    expect(store.error).not.toBeNull()
    expect(store.pendingArticles.length).toBeGreaterThan(0)
    const before = state(store)
    const write = vi.spyOn(Storage.prototype, 'setItem')
    await open(store, 'demo-second')
    expect(state(store)).toBe(before)
    expect(write.mock.calls.filter(([key]) => key === `${cacheKey}:ops`)).toEqual([])
  })
  it.each([{ kind: 'unknown' }, { kind: 'auth', status: 401 }, { kind: 'auth', status: 403 }, new Error('架空通信障害')])('送信結果が%jでも表示・エラー・操作状態を変えず例外を出さない', async result => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    if (result instanceof Error) deps.post.mockRejectedValue(result)
    else deps.post.mockResolvedValue(result)
    const before = state(store)
    await expect(open(store)).resolves.toBeUndefined()
    expect(state(store)).toBe(before)
    expect(store.canManage).toBe(true)
  })
  it('同じ記事は同時押下・失敗後もセッション内で1回だけ送り別記事は別operationId', async () => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    await Promise.all([open(store), open(store)])
    await open(store)
    await open(store, 'demo-second')
    expect(deps.post).toHaveBeenCalledTimes(2)
    expect(deps.post.mock.calls[0]?.[0].operationId).not.toBe(deps.post.mock.calls[1]?.[0].operationId)
  })
  it.each(['viewer', 'missing', 'blocked', 'no-feed', 'no-uid'])('%sでは送信しない', async condition => {
    const store = useAiNewsStore()
    if (condition === 'viewer') deps.user.getIdTokenResult.mockResolvedValue({ claims: { newsRole: 'viewer' } })
    if (condition !== 'no-feed' && condition !== 'no-uid') await store.load(demoUid)
    if (condition === 'no-uid') store.feed = makeFeed()
    if (condition === 'blocked') {
      deps.post.mockResolvedValueOnce({ kind: 'auth', status: 403 })
      await store.dismiss('demo-first')
      deps.post.mockClear()
    }
    await open(store, condition === 'missing' ? 'fiction-missing' : 'demo-first')
    expect(deps.post).not.toHaveBeenCalled()
  })
})
