import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiNewsStore } from '@/stores/aiNews'
import { cacheKey, demoUid, feedBytes, makeFeed, nowMs } from '../fixtures/aiNewsV2'

const deps = vi.hoisted(() => ({ fetch: vi.fn(), classify: vi.fn(), post: vi.fn(), currentUser: { uid: 'ai-news-demo-user', getIdToken: vi.fn() } }))
vi.mock('@/services/firebase', () => ({ auth: { currentUser: deps.currentUser }, db: {}, functions: {} }))
vi.mock('@/services/aiNewsFeedSource', () => ({ AI_FEED_LATEST_PATH: 'news/v2/ai/latest.json', fetchLatestAiFeedBytes: deps.fetch, classifyStorageError: deps.classify }))
vi.mock('@/services/newsActionClient', () => ({ postNewsAction: deps.post, newsActionUrl: () => 'http://127.0.0.1:15001/demo-rertm/asia-northeast1/newsAction' }))

const ids = (store: ReturnType<typeof useAiNewsStore>) => store.visibleArticles.map(article => article.id)

function seedCache(current = false) {
  const feed = makeFeed({ feedDate: current ? '2026-11-03' : '2026-11-02', revision: 'b'.repeat(64) })
  localStorage.setItem(cacheKey, JSON.stringify(feed))
  localStorage.setItem(`${cacheKey}:fetch`, JSON.stringify({
    periodKey: current ? '2026-11-03' : '2026-11-02', attemptsInPeriod: 1,
    lastAttemptAt: nowMs - 86_400_000, lastSuccessAt: nowMs - 86_400_000,
    feedDate: feed.feedDate, generationPending: false, nextAutoAttemptAt: null,
  }))
}

function failLeaseSave() {
  const original = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === `${cacheKey}:lease`) throw new DOMException('容量不足', 'QuotaExceededError')
    original.call(this, key, value)
  })
}

describe('AI専用storeのlease保存失敗', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(nowMs)
    localStorage.clear()
    setActivePinia(createPinia())
    deps.fetch.mockResolvedValue(feedBytes())
    deps.classify.mockReturnValue('transient')
    deps.currentUser.getIdToken.mockResolvedValue('demo-token')
    deps.currentUser.uid = demoUid
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('lease保存が失敗しても取得を1回試み、記事をメモリ表示して保存エラーを示す', async () => {
    failLeaseSave()
    const store = useAiNewsStore()
    await store.load(demoUid)
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
    expect(store.error).toContain('保存')
    expect(localStorage.getItem(`${cacheKey}:lease`)).toBeNull()
  })

  it('手動更新でもlease保存失敗を黙って無視せず取得してエラーを示す', async () => {
    seedCache(true)
    failLeaseSave()
    const store = useAiNewsStore()
    await store.load(demoUid, true)
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    expect(store.error).toContain('保存')
  })

  it('他タブの有効なleaseがあれば取得せずエラーも出さない', async () => {
    seedCache()
    localStorage.setItem(`${cacheKey}:lease`, JSON.stringify({ owner: 'other-tab', expiresAt: nowMs + 30_000 }))
    const store = useAiNewsStore()
    await store.load(demoUid)
    expect(deps.fetch).not.toHaveBeenCalled()
    expect(store.error).toBeNull()
  })
})
