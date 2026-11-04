import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiNewsStore } from '@/stores/aiNews'
import { cacheKey, demoUid, feedBytes, makeFeed, nowMs } from '../fixtures/aiNewsV2'

const deps = vi.hoisted(() => ({ fetch: vi.fn(), classify: vi.fn(), post: vi.fn(), currentUser: { uid: 'ai-news-demo-user', getIdToken: vi.fn() } }))
vi.mock('@/services/firebase', () => ({ auth: { currentUser: deps.currentUser }, db: {}, functions: {} }))
vi.mock('@/services/aiNewsFeedSource', () => ({ AI_FEED_LATEST_PATH: 'news/v2/ai/latest.json', fetchLatestAiFeedBytes: deps.fetch, classifyStorageError: deps.classify }))
vi.mock('@/services/newsActionClient', () => ({ postNewsAction: deps.post, newsActionUrl: () => 'http://127.0.0.1:15001/demo-rertm/asia-northeast1/newsAction' }))

const ids = (store: ReturnType<typeof useAiNewsStore>) => store.visibleArticles.map(article => article.id)
const feedA = () => makeFeed({ feedDate: '2026-11-02', revision: 'b'.repeat(64),
  articles: [{ id: 'old-only', title: '架空の旧記事', sourceName: '架空技術通信', summary: '古い版の記事', publishedAt: null, url: 'https://example.test/old' }], totalCount: 1 })
const feedB = () => makeFeed({ feedDate: '2026-11-03', revision: 'c'.repeat(64) })

function seedCache() {
  const feed = feedA()
  localStorage.setItem(cacheKey, JSON.stringify(feed))
  localStorage.setItem(`${cacheKey}:fetch`, JSON.stringify({
    periodKey: '2026-11-02', attemptsInPeriod: 1,
    lastAttemptAt: nowMs - 86_400_000, lastSuccessAt: nowMs - 86_400_000,
    feedDate: feed.feedDate, generationPending: false, nextAutoAttemptAt: null,
  }))
}

function failAllWrites() {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function () {
    throw new DOMException('容量不足', 'QuotaExceededError')
  })
}

describe('メモリだけで表示中の再load', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(nowMs)
    localStorage.clear()
    setActivePinia(createPinia())
    deps.fetch.mockResolvedValue(feedBytes(feedB()))
    deps.classify.mockReturnValue('transient')
    deps.currentUser.getIdToken.mockResolvedValue('demo-token')
    deps.currentUser.uid = demoUid
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('書き込み失敗中の手動更新後にloadしても、メモリ上の新しい記事を旧保存データで置き換えない', async () => {
    seedCache()
    failAllWrites()
    const store = useAiNewsStore()
    await store.load(demoUid, true)
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    expect(store.feedDate).toBe('2026-11-03')
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])

    // 後続のloadが再取得で救われないよう、取得失敗にして保持だけを検証する。
    deps.fetch.mockRejectedValue(new Error('offline'))
    await store.load(demoUid)
    expect(store.feedDate).toBe('2026-11-03')
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
  })

  it('再load直後の手動更新は、メモリ上の60秒クールダウンによりStorage取得を繰り返さない', async () => {
    seedCache()
    failAllWrites()
    const store = useAiNewsStore()
    await store.load(demoUid, true)
    deps.fetch.mockRejectedValue(new Error('offline'))
    await store.load(demoUid)
    deps.fetch.mockClear()

    await store.load(demoUid, true)
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('書き込みが正常なら、後続のloadは従来どおり永続キャッシュを読む', async () => {
    seedCache()
    const store = useAiNewsStore()
    await store.load(demoUid, true)
    expect(store.feedDate).toBe('2026-11-03')

    // 別タブが保存したと想定し、永続側を差し替えてから再loadする。
    const other = makeFeed({ feedDate: '2026-11-04', revision: 'd'.repeat(64),
      articles: [{ id: 'other-tab', title: '架空の別タブ記事', sourceName: '架空技術通信', summary: '別タブで保存', publishedAt: null, url: 'https://example.test/other' }], totalCount: 1 })
    localStorage.setItem(cacheKey, JSON.stringify(other))
    localStorage.setItem(`${cacheKey}:fetch`, JSON.stringify({
      periodKey: '2026-11-03', attemptsInPeriod: 1, lastAttemptAt: nowMs, lastSuccessAt: nowMs,
      feedDate: '2026-11-04', generationPending: false, nextAutoAttemptAt: null,
    }))
    await store.load(demoUid)
    expect(store.feedDate).toBe('2026-11-04')
    expect(ids(store)).toEqual(['other-tab'])
  })
})
