import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useAiNewsStore } from '@/stores/aiNews'
import { cacheKey, deferred, demoUid, feedBytes, makeFeed, nowMs } from '../fixtures/aiNewsV2'

const deps = vi.hoisted(() => ({ fetch: vi.fn(), classify: vi.fn(), post: vi.fn(), currentUser: { uid: 'ai-news-demo-user', getIdToken: vi.fn() } }))
vi.mock('@/services/firebase', () => ({ auth: { currentUser: deps.currentUser }, db: {}, functions: {} }))
vi.mock('@/services/aiNewsFeedSource', () => ({ AI_FEED_LATEST_PATH: 'news/v2/ai/latest.json', fetchLatestAiFeedBytes: deps.fetch, classifyStorageError: deps.classify }))
vi.mock('@/services/newsActionClient', () => ({ postNewsAction: deps.post, newsActionUrl: () => 'http://127.0.0.1:15001/demo-rertm/asia-northeast1/newsAction' }))

const ids = (store: ReturnType<typeof useAiNewsStore>) => store.visibleArticles.map(article => article.id)
const savedOps = () => JSON.parse(localStorage.getItem(`${cacheKey}:ops`) ?? '{}')
const otherTabAction = {
  schemaVersion: 2 as const, topic: 'ai' as const, feedDate: '2026-11-03', revision: 'b'.repeat(64),
  articleId: 'demo-second', action: 'dismiss' as const, operationId: '11111111-1111-4111-8111-111111111111',
}

describe('AI専用storeのタブ間操作競合', () => {
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

  async function loadedTab1() {
    const feed = makeFeed({ revision: 'b'.repeat(64) })
    localStorage.setItem(cacheKey, JSON.stringify(feed))
    localStorage.setItem(`${cacheKey}:fetch`, JSON.stringify({
      periodKey: '2026-11-03', attemptsInPeriod: 1, lastAttemptAt: nowMs - 3_600_000, lastSuccessAt: nowMs - 3_600_000,
      feedDate: '2026-11-03', generationPending: false, nextAutoAttemptAt: null,
    }))
    const store = useAiNewsStore()
    await store.load(demoUid)
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
    // 別タブがtab1の読込後に未確定の操作を直接保存した状態。
    const pending = { operationId: otherTabAction.operationId, payload: otherTabAction }
    localStorage.setItem(`${cacheKey}:ops`, JSON.stringify({
      'demo-second': { dismissed: true, pendingOperation: pending, pendingOperations: { dismiss: pending } },
    }))
    return store
  }

  it('別タブの未確定操作を残したまま自タブの操作を保存する', async () => {
    const response = deferred<unknown>()
    deps.post.mockReturnValue(response.promise)
    const store = await loadedTab1()
    const dismissing = store.dismiss('demo-first')
    await flushPromises()
    const ops = savedOps()
    expect(ops['demo-second'].pendingOperations.dismiss.operationId).toBe(otherTabAction.operationId)
    expect(ops['demo-second'].dismissed).toBe(true)
    expect(ops['demo-first'].pendingOperations.dismiss.operationId).toBe('00000000-0000-4000-8000-000000000001')
    response.resolve({ kind: 'unknown' })
    await dismissing
  })

  it('自タブの応答保存でも別タブの未確定操作を落とさない', async () => {
    const response = deferred<unknown>()
    deps.post.mockReturnValue(response.promise)
    const store = await loadedTab1()
    const dismissing = store.dismiss('demo-first')
    await flushPromises()
    const body = deps.post.mock.calls[0][0]
    response.resolve({ kind: 'ok', result: { operationId: body.operationId, articleId: body.articleId, action: 'dismiss', status: 'applied' } })
    await dismissing
    const ops = savedOps()
    expect(ops['demo-first'].dismissed).toBe(true)
    expect(ops['demo-first'].pendingOperations?.dismiss).toBeUndefined()
    expect(ops['demo-second'].pendingOperations.dismiss.operationId).toBe(otherTabAction.operationId)
    expect(ops['demo-second'].dismissed).toBe(true)
  })
})
