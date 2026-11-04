import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiNewsStore } from '@/stores/aiNews'
import { cacheKey, demoUid, feedBytes, makeFeed, nowMs } from '../fixtures/aiNewsV2'

const deps = vi.hoisted(() => ({ fetch: vi.fn(), classify: vi.fn(), post: vi.fn(), currentUser: { uid: 'ai-news-demo-user', getIdToken: vi.fn() } }))
const firestore = vi.hoisted(() => Object.fromEntries([
  'collection', 'doc', 'query', 'where', 'orderBy', 'limit', 'getDoc', 'getDocs', 'setDoc', 'addDoc',
  'updateDoc', 'deleteDoc', 'writeBatch', 'runTransaction', 'onSnapshot', 'increment', 'serverTimestamp',
].map(name => [name, vi.fn()])))
vi.mock('firebase/firestore', () => firestore)
vi.mock('@/services/firebase', () => ({ auth: { currentUser: deps.currentUser }, db: {}, functions: {} }))
vi.mock('@/services/aiNewsFeedSource', () => ({ AI_FEED_LATEST_PATH: 'news/v2/ai/latest.json', fetchLatestAiFeedBytes: deps.fetch, classifyStorageError: deps.classify }))
vi.mock('@/services/newsActionClient', () => ({ postNewsAction: deps.post, newsActionUrl: () => 'http://127.0.0.1:15001/demo-rertm/asia-northeast1/newsAction' }))

const ids = (store: ReturnType<typeof useAiNewsStore>) => store.visibleArticles.map(article => article.id)

describe('AI専用storeの管理操作拒否時の表示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(nowMs)
    localStorage.clear()
    setActivePinia(createPinia())
    deps.fetch.mockResolvedValue(feedBytes())
    deps.classify.mockReturnValue('transient')
    deps.currentUser.getIdToken.mockResolvedValue('demo-refreshed-token')
    deps.currentUser.uid = demoUid
    let sequence = 0
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      sequence += 1
      return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('興味なしが410で拒否されると記事が再表示され、操作できなかった旨と更新の案内を出す', async () => {
    deps.post.mockResolvedValue({ kind: 'rejected', status: 410 })
    const store = useAiNewsStore()
    await store.load(demoUid)
    await store.dismiss('demo-first')
    expect(ids(store)).toContain('demo-first')
    expect(store.error).toContain('操作できませんでした')
    expect(store.error).toContain('更新')
  })

  it('あとで読むが409で拒否されるとidleに戻り、操作できなかった旨を出す', async () => {
    deps.post.mockResolvedValue({ kind: 'rejected', status: 409 })
    const store = useAiNewsStore()
    await store.load(demoUid)
    await store.readLater('demo-first')
    expect(store.readLaterState('demo-first')).toBe('idle')
    expect(store.error).toContain('操作できませんでした')
  })

  it('取得失敗の表示は、その後の管理操作の成功で消えない', async () => {
    const feed = makeFeed({ feedDate: '2026-11-02', revision: 'b'.repeat(64) })
    localStorage.setItem(cacheKey, JSON.stringify(feed))
    deps.fetch.mockRejectedValue({ code: 'storage/retry-limit-exceeded' })
    deps.post.mockImplementation(async body => ({ kind: 'ok', result: { operationId: body.operationId, articleId: body.articleId, action: body.action, status: 'applied' } }))
    const store = useAiNewsStore()
    await store.load(demoUid)
    const fetchError = store.error
    expect(fetchError).toBeTruthy()
    await store.dismiss(feed.articles[0].id)
    expect(deps.post).toHaveBeenCalledTimes(1)
    expect(store.error).toBe(fetchError)
  })
})
