import { computed, ref, onScopeDispose } from 'vue'
import { defineStore } from 'pinia'
import { auth } from '@/services/firebase'
import { fetchLatestAiFeedBytes, classifyStorageError } from '@/services/aiNewsFeedSource'
import { postNewsAction, type NewsActionBody } from '@/services/newsActionClient'
import { parseAiFeedV2, type AiFeedV2 } from '@/utils/newsFeedV2'
import { canManualRefresh, decideAutoFetch, refreshPeriodKey, type AiNewsFetchState } from '@/utils/aiNewsRefreshPolicy'

type PendingOperation = { operationId: string; payload: NewsActionBody }
type Action = NewsActionBody['action']
interface Operation {
  dismissed?: boolean
  readLaterAdded?: boolean
  pendingOperation?: PendingOperation | null
  pendingOperations?: Partial<Record<Action, PendingOperation>>
}
function pendingFor(state: Operation | undefined, action: Action): PendingOperation | undefined {
  return state?.pendingOperations?.[action] ?? (state?.pendingOperation?.payload.action === action ? state.pendingOperation : undefined)
}
function isAuthRejection(failure: unknown): boolean {
  const code = typeof failure === 'object' && failure !== null && 'code' in failure ? failure.code : null
  return ['auth/user-token-expired', 'auth/user-disabled', 'auth/invalid-user-token', 'auth/user-not-found', 'auth/requires-recent-login'].includes(String(code))
}
const emptyFetch = (): AiNewsFetchState => ({ periodKey: '', attemptsInPeriod: 0, lastAttemptAt: null,
  lastSuccessAt: null, feedDate: null, generationPending: false, nextAutoAttemptAt: null })
const LEASE_MS = 60_000
function save(key: string, value: string) {
  Storage.prototype.setItem.call(localStorage, key, value)
}

export const useAiNewsStore = defineStore('aiNews', () => {
  const feed = ref<AiFeedV2 | null>(null)
  const operations = ref<Record<string, Operation>>({})
  const sending = ref<Record<string, boolean>>({})
  const loading = ref(false)
  const error = ref<string | null>(null)
  const canManage = ref(false)
  const blocked = ref(false)
  let uid: string | null = null
  let generation = 0
  let active: Promise<void> | null = null
  let tokenRefresh: Promise<string> | null = null
  let fetchState = emptyFetch()
  const key = () => `todobridge:aiNewsV2:v1:${uid}:ai`
  const valid = (session: number, user: string) => generation === session && uid === user
  const visibleArticles = computed(() => blocked.value ? [] : (feed.value?.articles ?? []).filter(article => !operations.value[article.id]?.dismissed))
  const feedDate = computed(() => feed.value?.feedDate ?? null)
  const pendingArticles = computed(() => blocked.value ? [] : Object.entries(operations.value)
    .filter(([articleId, state]) => (['dismiss', 'readLater'] as const).some(action => pendingFor(state, action) && !sending.value[`${articleId}:${action}`]))
    .map(([articleId]) => articleId))

  function reset() {
    generation += 1
    uid = null
    feed.value = null
    operations.value = {}
    sending.value = {}
    fetchState = emptyFetch()
    blocked.value = false
    canManage.value = false
    loading.value = false
    error.value = null
    active = null
    tokenRefresh = null
  }
  function readCache() {
    try {
      const raw = localStorage.getItem(key())
      if (raw) {
        const parsed = parseAiFeedV2(new TextEncoder().encode(raw))
        if (parsed.ok) feed.value = parsed.feed
      }
      const saved = localStorage.getItem(`${key()}:fetch`)
      if (saved) fetchState = { ...emptyFetch(), ...JSON.parse(saved) }
      // 原本が利用できない場合も試行予算は保持し、取得済みの短絡だけ避ける。
      if (!feed.value) fetchState = { ...fetchState, feedDate: null }
      const ops = localStorage.getItem(`${key()}:ops`)
      if (ops) operations.value = JSON.parse(ops)
    } catch { error.value = '保存済みニュースを読み込めませんでした。' }
  }
  function stopAccess(kind: string) {
    blocked.value = true
    canManage.value = false
    error.value = kind === 'unauthenticated' ? '再ログインしてください。' : 'ニュースを利用する権限がありません。'
  }
  function refreshToken(user: string): Promise<string> {
    if (auth.currentUser?.uid !== user) return Promise.reject(new Error('ログインが必要です'))
    tokenRefresh ??= auth.currentUser.getIdToken(true)
    return tokenRefresh
  }
  async function checkRole(user: string, session: number) {
    if (typeof auth.authStateReady === 'function') await auth.authStateReady()
    if (!valid(session, user)) return
    if (typeof auth.authStateReady === 'function' && auth.currentUser?.uid !== user) { stopAccess('unauthenticated'); return }
    const firebaseUser = auth.currentUser
    if (firebaseUser?.uid !== user || typeof firebaseUser.getIdTokenResult !== 'function') return
    let result = await firebaseUser.getIdTokenResult()
    if (!valid(session, user)) return
    if (result.claims.newsRole !== 'curator' && result.claims.newsRole !== 'viewer') {
      await refreshToken(user)
      if (!valid(session, user)) return
      result = await firebaseUser.getIdTokenResult()
    }
    if (!valid(session, user)) return
    const role = result.claims.newsRole
    if (role !== 'curator' && role !== 'viewer') stopAccess('unauthorized')
    else canManage.value = role === 'curator'
  }
  async function acquireLease(user: string, session: number, cacheKey: string): Promise<string | null> {
    const acquire = () => {
      if (!valid(session, user)) return null
      readCache()
      const leaseKey = `${cacheKey}:lease`
      const raw = localStorage.getItem(leaseKey)
      if (raw) {
        const current = JSON.parse(raw)
        if (current.expiresAt > Date.now()) return null
      }
      // 操作用UUIDとは分け、leaseの所有権だけを照合する。
      const owner = `${Date.now()}:${Math.random()}`
      save(leaseKey, JSON.stringify({ owner, expiresAt: Date.now() + LEASE_MS }))
      return JSON.parse(localStorage.getItem(leaseKey) ?? 'null')?.owner === owner ? owner : null
    }
    try {
      if (navigator.locks) return await navigator.locks.request(`${cacheKey}:lock`, acquire)
      return acquire()
    } catch { return null }
  }
  async function fetchFeed(user: string, session: number, manual: boolean) {
    const cacheKey = key()
    const owner = await acquireLease(user, session, cacheKey)
    if (!owner || !valid(session, user)) return
    try {
      if (!manual && !decideAutoFetch(fetchState, Date.now()).fetch) return
      if (manual && !canManualRefresh(fetchState.lastManualAt ?? null, Date.now())) return
      const now = Date.now()
      const periodKey = refreshPeriodKey(now)
      const attempted: AiNewsFetchState = { ...fetchState, periodKey,
        attemptsInPeriod: (fetchState.periodKey === periodKey ? fetchState.attemptsInPeriod : 0) + 1,
        lastAttemptAt: now, lastManualAt: manual ? now : fetchState.lastManualAt }
      attempted.nextAutoAttemptAt = now + (attempted.attemptsInPeriod === 1 ? 30 : 120) * 60_000
      // 失敗時にも試行予算を記録する。成功時刻は完全保存後だけ進める。
      save(`${cacheKey}:fetch`, JSON.stringify(attempted))
      fetchState = attempted
      loading.value = true
      if (typeof auth.authStateReady === 'function') await auth.authStateReady()
      if (!valid(session, user)) return
      let bytes: ArrayBuffer
      try { bytes = await fetchLatestAiFeedBytes() }
      catch (failure) {
        const kind = classifyStorageError(failure)
        if (kind !== 'unauthenticated' && kind !== 'unauthorized') throw failure
        if (!valid(session, user)) return
        try {
          if (auth.currentUser?.uid !== user) { stopAccess(kind); return }
          try { await refreshToken(user) }
          catch (refreshFailure) {
            if (valid(session, user) && isAuthRejection(refreshFailure)) stopAccess('unauthenticated')
            throw refreshFailure
          }
          if (!valid(session, user)) return
          bytes = await fetchLatestAiFeedBytes()
          await checkRole(user, session)
        } catch (retryFailure) {
          if (!valid(session, user)) return
          const retryKind = classifyStorageError(retryFailure)
          if (retryKind === 'unauthenticated' || retryKind === 'unauthorized') stopAccess(retryKind)
          throw retryFailure
        }
      }
      if (!valid(session, user) || blocked.value || auth.currentUser?.uid !== user) return
      const lease = JSON.parse(localStorage.getItem(`${cacheKey}:lease`) ?? 'null')
      if (lease?.owner !== owner || lease.expiresAt <= Date.now()) return
      const parsed = parseAiFeedV2(bytes)
      if (!parsed.ok) throw new Error('配信データを検証できませんでした')
      const nextState: AiNewsFetchState = { ...attempted, lastSuccessAt: Date.now(), feedDate: parsed.feed.feedDate,
        generationPending: parsed.feed.feedDate < periodKey, nextAutoAttemptAt: parsed.feed.feedDate >= periodKey ? null : attempted.nextAutoAttemptAt }
      const previousFeed = localStorage.getItem(cacheKey)
      const previousFetch = localStorage.getItem(`${cacheKey}:fetch`)
      try {
        save(cacheKey, JSON.stringify(parsed.feed))
        save(`${cacheKey}:fetch`, JSON.stringify(nextState))
      } catch (failure) {
        // 片方だけ保存された場合も旧完全原本へ戻す。
        if (previousFeed === null) localStorage.removeItem(cacheKey)
        else save(cacheKey, previousFeed)
        if (previousFetch !== null) {
          try { save(`${cacheKey}:fetch`, previousFetch) } catch { /* 旧取得状態が残っている。 */ }
        }
        throw failure
      }
      feed.value = parsed.feed
      fetchState = nextState
      error.value = null
    } catch (failure) {
      if (valid(session, user) && isAuthRejection(failure)) stopAccess('unauthenticated')
      if (valid(session, user) && !blocked.value) error.value = 'ニュースを更新できませんでした。保存済みの記事を表示しています。'
    } finally {
      try {
        if (JSON.parse(localStorage.getItem(`${cacheKey}:lease`) ?? 'null')?.owner === owner) localStorage.removeItem(`${cacheKey}:lease`)
      } catch { /* 期限切れでも再取得できる。 */ }
      if (valid(session, user)) loading.value = false
    }
  }
  const syncFromStorage = (event: StorageEvent) => {
    if (!uid || blocked.value) return
    if (event.key === `${key()}:fetch` || event.key === `${key()}:ops` || event.key === key()) readCache()
  }
  window.addEventListener('storage', syncFromStorage)
  onScopeDispose(() => window.removeEventListener('storage', syncFromStorage))

  function load(user: string, manual = false): Promise<void> {
    if (uid !== user) { reset(); uid = user; readCache() }
    if (active) return active
    if (blocked.value) return Promise.resolve()
    const session = generation
    tokenRefresh = null
    // SDKが保持するclaimを使用し、閲覧権限と管理権限を分ける。
    const roleTask = checkRole(user, session).catch(failure => {
      if (!valid(session, user)) return
      if (isAuthRejection(failure)) stopAccess('unauthenticated')
      else error.value = 'ニュースの権限を確認できませんでした。通信回復後に再試行してください。'
    })
    readCache()
    const shouldFetch = manual || decideAutoFetch(fetchState, Date.now()).fetch
    const task = Promise.all([roleTask, shouldFetch ? fetchFeed(user, session, manual) : Promise.resolve()])
      .then(() => undefined).finally(() => { if (active === task) active = null })
    active = task
    return task
  }
  function readLaterState(articleId: string): 'idle' | 'sending' | 'added' | 'unknown' {
    const state = operations.value[articleId]
    if (sending.value[`${articleId}:readLater`]) return 'sending'
    if (state?.readLaterAdded) return 'added'
    return pendingFor(state, 'readLater') ? 'unknown' : 'idle'
  }
  async function retryPending(articleId: string, action?: Action) {
    if (!action) {
      await Promise.all([retryPending(articleId, 'dismiss'), retryPending(articleId, 'readLater')])
      return
    }
    const state = operations.value[articleId]
    const pending = pendingFor(state, action)
    if (!pending || !uid || blocked.value) return
    const sendingKey = `${articleId}:${pending.payload.action}`
    if (sending.value[sendingKey]) return
    const user = uid
    const session = generation
    sending.value[sendingKey] = true
    const result = await postNewsAction(pending.payload, { getIdToken: async () => {
      if (auth.currentUser?.uid !== user) throw new Error('ログインが必要です')
      return auth.currentUser.getIdToken()
    } })
    if (!valid(session, user) || auth.currentUser?.uid !== user) return
    sending.value[sendingKey] = false
    const current = operations.value[articleId]
    if (pendingFor(current, pending.payload.action)?.operationId !== pending.operationId) return
    if (result.kind === 'auth') { stopAccess(result.status === 401 ? 'unauthenticated' : 'unauthorized'); return }
    if (result.kind === 'unknown') { error.value = '操作結果が未確認です。再試行してください。'; return }
    const remaining = { ...current?.pendingOperations }
    // 旧形式の操作も取り込み、別actionの未確定操作を維持する。
    if (current?.pendingOperation) remaining[current.pendingOperation.payload.action] ??= current.pendingOperation
    delete remaining[pending.payload.action]
    const updated: Operation = { ...current, pendingOperations: remaining,
      pendingOperation: remaining.dismiss ?? remaining.readLater ?? null }
    if (pending.payload.action === 'dismiss') updated.dismissed = result.kind === 'ok'
    else updated.readLaterAdded = result.kind === 'ok'
    try {
      const next = { ...operations.value, [articleId]: updated }
      save(`${key()}:ops`, JSON.stringify(next))
      operations.value = next
    } catch { error.value = '操作結果を保存できませんでした。再試行してください。' }
  }
  async function act(articleId: string, action: NewsActionBody['action']) {
    if (!feed.value || !uid || blocked.value || !feed.value.articles.some(article => article.id === articleId)) return
    if (pendingFor(operations.value[articleId], action)) { await retryPending(articleId, action); return }
    if (action === 'readLater' && operations.value[articleId]?.readLaterAdded) return
    const previous = operations.value
    const operationId = crypto.randomUUID()
    const payload: NewsActionBody = { schemaVersion: 2, topic: 'ai', feedDate: feed.value.feedDate,
      revision: feed.value.revision, articleId, action, operationId }
    operations.value = { ...previous, [articleId]: { ...previous[articleId],
      dismissed: action === 'dismiss' || previous[articleId]?.dismissed,
      pendingOperation: previous[articleId]?.pendingOperation ?? { operationId, payload },
      pendingOperations: { ...previous[articleId]?.pendingOperations, [action]: { operationId, payload } } } }
    try { save(`${key()}:ops`, JSON.stringify(operations.value)) }
    catch { operations.value = previous; error.value = '操作を保存できませんでした。'; return }
    await retryPending(articleId, action)
  }
  return { feed, feedDate, visibleArticles, loading, error, canManage, pendingArticles,
    load, reset, dismiss: (id: string) => act(id, 'dismiss'), readLater: (id: string) => act(id, 'readLater'), retryPending, readLaterState }
})
