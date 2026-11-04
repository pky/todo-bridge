import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useAiNewsStore } from '@/stores/aiNews'
import { cacheKey, deferred, demoUid, feedBytes, makeAction, makeFeed, nowMs, operationId } from '../fixtures/aiNewsV2'

const deps = vi.hoisted(() => ({ fetch: vi.fn(), classify: vi.fn(), post: vi.fn(), getIdToken: vi.fn(), currentUser: { uid: 'ai-news-demo-user', getIdToken: vi.fn() } }))
const firestore = vi.hoisted(() => Object.fromEntries([
  'collection', 'doc', 'query', 'where', 'orderBy', 'limit', 'getDoc', 'getDocs', 'setDoc', 'addDoc',
  'updateDoc', 'deleteDoc', 'writeBatch', 'runTransaction', 'onSnapshot', 'increment', 'serverTimestamp',
].map(name => [name, vi.fn()])))
vi.mock('firebase/firestore', () => firestore)
vi.mock('@/services/firebase', () => ({ auth: { currentUser: deps.currentUser }, db: {}, functions: {} }))
vi.mock('@/services/aiNewsFeedSource', () => ({ AI_FEED_LATEST_PATH: 'news/v2/ai/latest.json', fetchLatestAiFeedBytes: deps.fetch, classifyStorageError: deps.classify }))
vi.mock('@/services/newsActionClient', () => ({ postNewsAction: deps.post, newsActionUrl: () => 'http://127.0.0.1:15001/demo-rertm/asia-northeast1/newsAction' }))

interface SavedOperation {
  dismissed?: boolean
  readLaterAdded?: boolean
  pendingOperation?: { operationId: string; payload: ReturnType<typeof makeAction> } | null
}
// 原本はDTO、操作はarticleIdをキーにする保存契約を観測し、store内部のstate名は固定しない。
const savedFeed = () => JSON.parse(localStorage.getItem(cacheKey) ?? 'null')
const savedFetch = () => JSON.parse(localStorage.getItem(`${cacheKey}:fetch`) ?? 'null')
const savedOps = (): Record<string, SavedOperation> => JSON.parse(localStorage.getItem(`${cacheKey}:ops`) ?? '{}')
const ids = (store: ReturnType<typeof useAiNewsStore>) => store.visibleArticles.map(article => article.id)

function seedCache(current = false) {
  const feed = makeFeed({ feedDate: current ? '2026-11-03' : '2026-11-02', revision: 'b'.repeat(64) })
  localStorage.setItem(cacheKey, JSON.stringify(feed))
  localStorage.setItem(`${cacheKey}:fetch`, JSON.stringify({
    periodKey: current ? '2026-11-03' : '2026-11-02', attemptsInPeriod: 1,
    lastAttemptAt: nowMs - 86_400_000, lastSuccessAt: nowMs - 86_400_000,
    feedDate: feed.feedDate, generationPending: false, nextAutoAttemptAt: null,
  }))
  return feed
}

function ok(body: ReturnType<typeof makeAction>, status = body.action === 'dismiss' ? 'applied' : 'created') {
  const { operationId, articleId, action } = body
  return { kind: 'ok', result: { operationId, articleId, action, status } }
}

describe('AI専用storeの原本・取得・管理操作', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(nowMs)
    localStorage.clear()
    setActivePinia(createPinia())
    deps.fetch.mockResolvedValue(feedBytes())
    deps.classify.mockImplementation(error => {
      const code = error?.code
      if (code === 'storage/unauthenticated') return 'unauthenticated'
      if (code === 'storage/unauthorized') return 'unauthorized'
      if (code === 'storage/object-not-found') return 'not-found'
      return 'transient'
    })
    deps.currentUser.getIdToken.mockResolvedValue('demo-refreshed-token')
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

  it('load・興味なし・あとで読むでFirestoreを一度も読み書きしない', async () => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    await store.dismiss('demo-first')
    await store.readLater('demo-second')
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    expect(deps.post).toHaveBeenCalledTimes(2)
    for (const spy of Object.values(firestore)) expect(spy).not.toHaveBeenCalled()
  })

  it('保存済みの記事を通信完了前に原本順で即表示する', async () => {
    const previous = seedCache()
    const pending = deferred<ArrayBuffer>()
    deps.fetch.mockReturnValue(pending.promise)
    const store = useAiNewsStore()
    const load = store.load(demoUid)
    expect(ids(store)).toEqual(previous.articles.map(article => article.id))
    pending.resolve(feedBytes())
    await load
    expect(savedFeed()).toEqual(makeFeed())
    expect(savedFetch()).toMatchObject({ lastSuccessAt: nowMs, feedDate: '2026-11-03', generationPending: false })
  })

  it('同一タブの同時loadは1回の通信を共有する', async () => {
    const pending = deferred<ArrayBuffer>()
    deps.fetch.mockReturnValue(pending.promise)
    const store = useAiNewsStore()
    const first = store.load(demoUid)
    const second = store.load(demoUid)
    await flushPromises()
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    pending.resolve(feedBytes())
    await Promise.all([first, second])
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
  })

  it('当日0件を完全保存すると次のloadで再取得しない', async () => {
    deps.fetch.mockResolvedValue(feedBytes(makeFeed({ totalCount: 0, articles: [] })))
    const store = useAiNewsStore()
    await store.load(demoUid)
    await store.load(demoUid)
    expect(ids(store)).toEqual([])
    expect(savedFeed()).toMatchObject({ totalCount: 0, articles: [] })
    expect(deps.fetch).toHaveBeenCalledTimes(1)
  })

  it.each([cacheKey, `${cacheKey}:fetch`])('取得できても%sの保存失敗なら旧revisionと成功取得時刻を維持する', async failedKey => {
    const previous = seedCache()
    const previousFetch = savedFetch()
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === failedKey) throw new DOMException('容量不足', 'QuotaExceededError')
      original.call(this, key, value)
    })
    const store = useAiNewsStore()
    await store.load(demoUid)
    expect(savedFeed()).toEqual(previous)
    expect(ids(store)).toEqual(previous.articles.map(article => article.id))
    expect(savedFetch()?.lastSuccessAt).toBe(previousFetch.lastSuccessAt)
  })

  it.each(['invalid-json', 'unknown-version', 'too-large', 'not-found', 'transient'])('%sでは完全キャッシュを空原本や成功に置き換えない', async failure => {
    const previous = seedCache()
    const previousFetch = savedFetch()
    if (failure === 'invalid-json') deps.fetch.mockResolvedValue(new TextEncoder().encode('{').buffer)
    else if (failure === 'unknown-version') deps.fetch.mockResolvedValue(feedBytes({ ...makeFeed(), schemaVersion: 99 }))
    else if (failure === 'too-large') deps.fetch.mockResolvedValue(new ArrayBuffer(1048577))
    else deps.fetch.mockRejectedValue({ code: failure === 'not-found' ? 'storage/object-not-found' : 'storage/retry-limit-exceeded' })
    const store = useAiNewsStore()
    await store.load(demoUid)
    expect(savedFeed()).toEqual(previous)
    expect(ids(store)).toEqual(previous.articles.map(article => article.id))
    expect(savedFetch()?.lastSuccessAt).toBe(previousFetch.lastSuccessAt)
    for (const spy of Object.values(firestore)) expect(spy).not.toHaveBeenCalled()
  })

  it.each(['storage/unauthenticated', 'storage/unauthorized'])('%sはトークンを一度だけ強制更新して成功を再評価する', async code => {
    deps.fetch.mockRejectedValueOnce({ code }).mockResolvedValueOnce(feedBytes())
    const store = useAiNewsStore()
    await store.load(demoUid)
    expect(deps.currentUser.getIdToken).toHaveBeenCalledExactlyOnceWith(true)
    expect(deps.fetch).toHaveBeenCalledTimes(2)
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
  })

  it.each(['storage/unauthenticated', 'storage/unauthorized'])('%sが更新後も続くならキャッシュ利用を停止する', async code => {
    seedCache()
    deps.fetch.mockRejectedValue({ code })
    const store = useAiNewsStore()
    await store.load(demoUid)
    expect(deps.currentUser.getIdToken).toHaveBeenCalledExactlyOnceWith(true)
    expect(deps.fetch).toHaveBeenCalledTimes(2)
    expect(ids(store)).toEqual([])
  })

  it('興味なしは応答を待たず非表示にし、送信前に固定payloadとUUIDを保存する', async () => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    const pending = deferred<ReturnType<typeof ok>>()
    deps.post.mockImplementation(body => {
      expect(savedOps()['demo-first']?.pendingOperation).toMatchObject({ operationId, payload: body })
      return pending.promise
    })
    const action = store.dismiss('demo-first')
    expect(ids(store)).toEqual(['demo-second'])
    await flushPromises()
    expect(deps.post.mock.calls[0]?.[0]).toEqual(makeAction())
    pending.resolve(ok(makeAction()))
    await action
    expect(savedOps()['demo-first']).toMatchObject({ dismissed: true })
    expect(savedOps()['demo-first']?.pendingOperation ?? null).toBeNull()
    expect(savedFeed()?.articles).toHaveLength(2)
  })

  it.each([400, 404, 409, 410])('興味なしのHTTP %iは未適用確定として原本順へ戻す', async status => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    deps.post.mockResolvedValue({ kind: 'rejected', status })
    await store.dismiss('demo-first')
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
    expect(savedOps()['demo-first']?.pendingOperation ?? null).toBeNull()
  })

  it('結果不明の興味なしは非表示とpendingを保持し、同じUUIDとpayloadで再送する', async () => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    deps.post.mockResolvedValueOnce({ kind: 'unknown' })
    await store.dismiss('demo-first')
    expect(ids(store)).toEqual(['demo-second'])
    const pending = savedOps()['demo-first']?.pendingOperation
    expect(pending).toMatchObject({ operationId, payload: makeAction() })
    const sent = deps.post.mock.calls[0]?.[0]
    await store.retryPending('demo-first')
    expect(deps.post.mock.calls[1]?.[0]).toEqual(sent)
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
  })

  it.each(['created', 'already'])('あとで読むはsendingから%sで追加済みになり一覧に残る', async status => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    const pending = deferred<ReturnType<typeof ok>>()
    deps.post.mockReturnValue(pending.promise)
    const action = store.readLater('demo-first')
    await flushPromises()
    expect(savedOps()['demo-first']?.readLaterAdded ?? false).toBe(false)
    expect(savedOps()['demo-first']?.pendingOperation?.payload.action).toBe('readLater')
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
    pending.resolve(ok(makeAction('readLater'), status))
    await action
    expect(savedOps()['demo-first']).toMatchObject({ readLaterAdded: true })
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
  })

  it('あとで読むの未適用確定ではidleへ戻し、結果不明ではpendingを保持する', async () => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    deps.post.mockResolvedValueOnce({ kind: 'rejected', status: 409 })
    await store.readLater('demo-first')
    expect(savedOps()['demo-first']?.readLaterAdded ?? false).toBe(false)
    expect(savedOps()['demo-first']?.pendingOperation ?? null).toBeNull()
    deps.post.mockResolvedValueOnce({ kind: 'unknown' })
    await store.readLater('demo-first')
    expect(savedOps()['demo-first']?.readLaterAdded ?? false).toBe(false)
    expect(savedOps()['demo-first']?.pendingOperation?.payload).toEqual({ ...makeAction('readLater'), operationId: '00000000-0000-4000-8000-000000000002' })
    deps.post.mockImplementationOnce(async body => ok(body, 'already'))
    await store.retryPending('demo-first')
    expect(deps.post.mock.calls[2]?.[0]).toEqual(deps.post.mock.calls[1]?.[0])
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
  })

  it('操作payloadの保存ができなければ送信せず、楽観的な非表示を戻す', async () => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === `${cacheKey}:ops`) throw new DOMException('容量不足', 'QuotaExceededError')
      original.call(this, key, value)
    })
    await Promise.resolve(store.dismiss('demo-first')).catch(() => undefined)
    expect(deps.post).not.toHaveBeenCalled()
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
  })

  it.each(['dismiss', 'readLater'] as const)('%sの認証拒否はキャッシュ表示を停止する', async action => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    deps.post.mockResolvedValue({ kind: 'auth', status: 403 })
    await store[action]('demo-first')
    expect(ids(store)).toEqual([])
  })

  it('reset後の遅い取得結果は新UIDの状態と保存先を変更しない', async () => {
    const pending = deferred<ArrayBuffer>()
    deps.fetch.mockReturnValueOnce(pending.promise)
    const store = useAiNewsStore()
    const oldLoad = store.load(demoUid)
    await flushPromises()
    store.reset()
    deps.currentUser.uid = 'other-demo-user'
    const otherFeed = makeFeed({ revision: 'c'.repeat(64), articles: [], totalCount: 0 })
    deps.fetch.mockResolvedValueOnce(feedBytes(otherFeed))
    await store.load('other-demo-user')
    pending.resolve(feedBytes())
    await oldLoad
    expect(ids(store)).toEqual([])
    expect(localStorage.getItem(cacheKey)).toBeNull()
    expect(JSON.parse(localStorage.getItem('todobridge:aiNewsV2:v1:other-demo-user:ai') ?? 'null')).toEqual(otherFeed)
  })

  it('reset後の遅い操作成功は表示と操作保存を変更しない', async () => {
    const store = useAiNewsStore()
    await store.load(demoUid)
    const pending = deferred<ReturnType<typeof ok>>()
    deps.post.mockReturnValue(pending.promise)
    const action = store.readLater('demo-first')
    await flushPromises()
    store.reset()
    const before = localStorage.getItem(`${cacheKey}:ops`)
    pending.resolve(ok(makeAction('readLater')))
    await action
    expect(ids(store)).toEqual([])
    expect(localStorage.getItem(`${cacheKey}:ops`)).toBe(before)
  })

  it.each([false, true])('revision変更=%sでも操作状態はarticleIdで保持し原本順を使う', async changed => {
    const previous = seedCache()
    const pending = { operationId, payload: { ...makeAction(), revision: 'b'.repeat(64) } }
    localStorage.setItem(`${cacheKey}:ops`, JSON.stringify({
      'demo-first': { dismissed: true, pendingOperation: pending }, 'demo-second': { readLaterAdded: true },
    }))
    const next = changed ? makeFeed({ revision: 'c'.repeat(64) }) : previous
    deps.fetch.mockResolvedValue(feedBytes(next))
    const store = useAiNewsStore()
    await store.load(demoUid)
    expect(ids(store)).toEqual(['demo-second'])
    expect(savedOps()['demo-first']?.pendingOperation).toEqual(pending)
    expect(savedOps()['demo-second']?.readLaterAdded).toBe(true)
    expect(savedFeed()).toEqual(next)
  })

  it('navigator.locks取得後に他タブが保存した当日キャッシュを読み直す', async () => {
    const request = vi.fn().mockImplementation(async (_name, optionsOrCallback, maybeCallback) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
      seedCache(true)
      return callback({ name: 'demo-ai-feed-lock', mode: 'exclusive' })
    })
    vi.stubGlobal('navigator', { locks: { request } })
    const store = useAiNewsStore()
    await store.load(demoUid)
    expect(request).toHaveBeenCalled()
    expect(deps.fetch).not.toHaveBeenCalled()
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
  })

  it('navigator.locks取得失敗を無条件の並列取得へ切り替えない', async () => {
    seedCache()
    vi.stubGlobal('navigator', { locks: { request: vi.fn().mockRejectedValue(new Error('ロックを取得できません')) } })
    const store = useAiNewsStore()
    await Promise.resolve(store.load(demoUid)).catch(() => undefined)
    expect(deps.fetch).not.toHaveBeenCalled()
    expect(ids(store)).toEqual(['demo-first', 'demo-second'])
  })

  it('navigator.locksがない場合も独立store間の取得は期限付きleaseで一つにまとまる', async () => {
    vi.stubGlobal('navigator', {})
    const pending = deferred<ArrayBuffer>()
    deps.fetch.mockReturnValue(pending.promise)
    const first = useAiNewsStore(createPinia())
    // タブごとのモジュールを再現し、モジュール内Promiseだけで共有できない状態にする。
    vi.resetModules()
    const { useAiNewsStore: useOtherTabStore } = await import('@/stores/aiNews')
    const second = useOtherTabStore(createPinia())
    const firstLoad = first.load(demoUid)
    const secondLoad = second.load(demoUid)
    await flushPromises()
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    pending.resolve(feedBytes())
    await firstLoad
    // 保存通知を受けたタブ、または再表示したタブは保存済み原本を再利用する。
    window.dispatchEvent(new StorageEvent('storage', { key: cacheKey, newValue: localStorage.getItem(cacheKey) }))
    await secondLoad
    await second.load(demoUid)
    expect(ids(second)).toEqual(['demo-first', 'demo-second'])
    expect(deps.fetch).toHaveBeenCalledTimes(1)
  })

  describe('オフラインのトークン更新', () => {
    const networkError = { code: 'auth/network-request-failed' }
    const withTokenResult = (impl: () => Promise<unknown>) => Object.assign(deps.currentUser, { getIdTokenResult: vi.fn(impl) })
    afterEach(() => { Reflect.deleteProperty(deps.currentUser, 'getIdTokenResult') })

    it.each(['getIdTokenResult', 'getIdToken(true)'])('%sがネットワークで失敗しても保存済み記事を表示し続け、通信回復後に再取得できる', async point => {
      const previous = seedCache()
      if (point === 'getIdTokenResult') withTokenResult(() => Promise.reject(networkError))
      else {
        withTokenResult(() => Promise.resolve({ claims: {} }))
        deps.currentUser.getIdToken.mockRejectedValue(networkError)
      }
      deps.fetch.mockRejectedValue({ code: 'storage/retry-limit-exceeded' })
      const store = useAiNewsStore()
      await store.load(demoUid)
      expect(ids(store)).toEqual(previous.articles.map(article => article.id))
      expect(store.error ?? '').not.toContain('再ログイン')
      expect(savedFeed()).toEqual(previous)
      expect(savedFetch()).toMatchObject({ periodKey: '2026-11-03', attemptsInPeriod: 1 })

      // 通信が戻り、30分の間隔を過ぎた後のloadは再取得できる。
      withTokenResult(() => Promise.resolve({ claims: { newsRole: 'viewer' } }))
      deps.currentUser.getIdToken.mockResolvedValue('demo-refreshed-token')
      deps.fetch.mockResolvedValue(feedBytes())
      vi.setSystemTime(nowMs + 31 * 60_000)
      const fetchCallsBefore = deps.fetch.mock.calls.length
      await store.load(demoUid)
      expect(deps.fetch.mock.calls.length).toBe(fetchCallsBefore + 1)
      expect(ids(store)).toEqual(['demo-first', 'demo-second'])
      expect(store.error ?? '').not.toContain('再ログイン')
    })

    it.each(['auth/user-token-expired', 'auth/user-disabled'])('%sは本物の認証拒否としてキャッシュ利用を止める', async code => {
      seedCache()
      withTokenResult(() => Promise.reject({ code }))
      const store = useAiNewsStore()
      await store.load(demoUid)
      expect(ids(store)).toEqual([])
    })
  })

  describe('キャッシュなしの取得試行上限', () => {
    it.each([
      ['not-found', { code: 'storage/object-not-found' }],
      ['transient', { code: 'storage/retry-limit-exceeded' }],
    ])('%sで失敗が続く場合、同じ期間内は30分後・2時間後の最大3回で止まり、手動更新だけ60秒間隔で許可する', async (_name, failure) => {
      deps.fetch.mockRejectedValue(failure)
      const store = useAiNewsStore()
      const loadAt = async (minutes: number, manual = false) => {
        vi.setSystemTime(nowMs + minutes * 60_000)
        await store.load(demoUid, manual)
        return deps.fetch.mock.calls.length
      }
      expect(await loadAt(0)).toBe(1)
      expect(await loadAt(0)).toBe(1)
      expect(await loadAt(29)).toBe(1)
      expect(await loadAt(30)).toBe(2)
      expect(await loadAt(31)).toBe(2)
      expect(await loadAt(30 + 119)).toBe(2)
      expect(await loadAt(30 + 120)).toBe(3)
      expect(await loadAt(30 + 120 + 600)).toBe(3)
      expect(await loadAt(30 + 120 + 601, true)).toBe(4)
      expect(await loadAt(30 + 120 + 601, true)).toBe(4)
      expect(await loadAt(30 + 120 + 602, true)).toBe(5)
      expect(ids(store)).toEqual([])
    })
  })

  describe('結果不明のあとで読むがある記事の興味なし', () => {
    it('readLaterのpendingが残っていても楽観的に隠し、新しいoperationIdでdismissを送り、readLaterは再送可能なまま残す', async () => {
      const store = useAiNewsStore()
      await store.load(demoUid)
      deps.post.mockResolvedValueOnce({ kind: 'unknown' })
      await store.readLater('demo-first')
      expect(store.readLaterState('demo-first')).toBe('unknown')
      const dismissResult = deferred<ReturnType<typeof ok>>()
      deps.post.mockReturnValueOnce(dismissResult.promise)

      const action = store.dismiss('demo-first')
      expect(ids(store)).toEqual(['demo-second'])
      await flushPromises()
      expect(deps.post.mock.calls[1]?.[0]).toEqual({ ...makeAction('dismiss'), operationId: '00000000-0000-4000-8000-000000000002' })
      dismissResult.resolve(ok(deps.post.mock.calls[1]?.[0]))
      await action

      expect(ids(store)).toEqual(['demo-second'])
      expect(store.readLaterState('demo-first')).toBe('unknown')
      await store.retryPending('demo-first')
      expect(deps.post.mock.calls[2]?.[0]).toEqual(makeAction('readLater'))
    })
  })

  describe('newsActionの認証結果', () => {
    it('401は再ログイン状態、403は権限エラー状態にする', async () => {
      const first = useAiNewsStore()
      await first.load(demoUid)
      deps.post.mockResolvedValue({ kind: 'auth', status: 401 })
      await first.dismiss('demo-first')
      expect(ids(first)).toEqual([])
      expect(first.error).toContain('再ログイン')

      first.reset()
      localStorage.clear()
      await first.load(demoUid)
      deps.post.mockResolvedValue({ kind: 'auth', status: 403 })
      await first.dismiss('demo-first')
      expect(ids(first)).toEqual([])
      expect(first.error).toContain('権限')
      expect(first.error).not.toContain('再ログイン')
    })
  })
})
