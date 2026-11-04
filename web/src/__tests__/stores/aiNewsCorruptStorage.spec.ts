import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useAiNewsStore } from '@/stores/aiNews'
import { cacheKey, deferred, demoUid, feedBytes, makeAction, makeFeed, nowMs } from '../fixtures/aiNewsV2'

const deps = vi.hoisted(() => ({ fetch: vi.fn(), classify: vi.fn(), post: vi.fn(), currentUser: { uid: 'ai-news-demo-user', getIdToken: vi.fn() } }))
vi.mock('@/services/firebase', () => ({ auth: { currentUser: deps.currentUser }, db: {}, functions: {} }))
vi.mock('@/services/aiNewsFeedSource', () => ({ AI_FEED_LATEST_PATH: 'news/v2/ai/latest.json', fetchLatestAiFeedBytes: deps.fetch, classifyStorageError: deps.classify }))
vi.mock('@/services/newsActionClient', () => ({ postNewsAction: deps.post, newsActionUrl: () => 'http://127.0.0.1:15001/demo-rertm/asia-northeast1/newsAction' }))

const ids = (store: ReturnType<typeof useAiNewsStore>) => store.visibleArticles.map(article => article.id)
function ok(body: ReturnType<typeof makeAction>) {
  const { operationId, articleId, action } = body
  return { kind: 'ok', result: { operationId, articleId, action, status: action === 'dismiss' ? 'applied' : 'created' } }
}

describe('AI専用storeの壊れた保存データと古い応答', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(nowMs)
    localStorage.clear()
    setActivePinia(createPinia())
    deps.fetch.mockResolvedValue(feedBytes())
    deps.classify.mockReturnValue('transient')
    deps.currentUser.uid = demoUid
    deps.post.mockImplementation(async body => ok(body))
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

  it('opsのJSONが壊れていても空として扱い、次の保存成功で上書きして操作が成功する', async () => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    deps.post.mockResolvedValueOnce({ kind: 'unknown' })
    await store.dismiss('demo-first')
    localStorage.setItem(`${cacheKey}:ops`, '{')
    await store.readLater('demo-second')
    expect(store.error).toBeNull()
    expect(deps.post).toHaveBeenCalledTimes(2)
    const saved = JSON.parse(localStorage.getItem(`${cacheKey}:ops`) ?? 'null')
    expect(saved['demo-second']).toMatchObject({ readLaterAdded: true })
    expect(ids(store)).toEqual(['demo-second'])
  })

  it('leaseのJSONが壊れていても無いものとして扱い、原本と試行予算を保存する', async () => {
    localStorage.setItem(`${cacheKey}:lease`, '{')
    const store = useAiNewsStore()
    await store.load(demoUid)
    expect(store.error).toBeNull()
    expect(JSON.parse(localStorage.getItem(cacheKey) ?? 'null')).toEqual(makeFeed())
    expect(JSON.parse(localStorage.getItem(`${cacheKey}:fetch`) ?? 'null')).toMatchObject({ attemptsInPeriod: 1, feedDate: '2026-11-03' })
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
  })

  it('別タブで解決済みの操作への遅いunknown応答は未確認エラーを出さず無視する', async () => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    const pending = deferred<{ kind: 'unknown' }>()
    deps.post.mockReturnValue(pending.promise)
    const action = store.dismiss('demo-first')
    await flushPromises()
    // 別タブが同じ操作を完了し、pendingを消した状態を保存して同期させる。
    localStorage.setItem(`${cacheKey}:ops`, JSON.stringify({ 'demo-first': { dismissed: true, pendingOperation: null, pendingOperations: {} } }))
    window.dispatchEvent(new StorageEvent('storage', { key: `${cacheKey}:ops` }))
    pending.resolve({ kind: 'unknown' })
    await action
    expect(store.error).toBeNull()
    expect(ids(store)).toEqual(['demo-second'])
  })
})
