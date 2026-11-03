import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import router from '@/router'

const mocks = vi.hoisted(() => ({
  popup: vi.fn(), anonymous: vi.fn(), signOut: vi.fn(), token: vi.fn(), validate: vi.fn(),
  listener: null as null | ((user: unknown) => Promise<void>),
}))
vi.mock('firebase/auth', () => ({
  signInWithPopup: mocks.popup, signInAnonymously: mocks.anonymous, signOut: mocks.signOut,
  getIdTokenResult: mocks.token,
  onAuthStateChanged: vi.fn((_auth, callback) => { mocks.listener = callback; return vi.fn() }),
}))
vi.mock('@/services/firebaseAuth', () => ({ auth: {}, googleProvider: {} }))
vi.mock('@/services/cloudFunctionsService', () => ({ validateCurrentUserAccessApi: mocks.validate }))
vi.mock('@/services/documentSearchCache', () => ({ clearDocumentSearchCache: vi.fn() }))

// 実際に登録されたルートとガードを使い、遷移先の画面だけを描画対象外にする。
for (const route of router.getRoutes()) {
  if (route.components) route.components.default = { template: '<div />' }
}

function firebaseUser(uid = 'claim-demo') {
  return { uid, email: null, displayName: '架空のユーザー', photoURL: null, getIdTokenResult: mocks.token }
}
function deferredClaim() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}
function emit(user: ReturnType<typeof firebaseUser>) {
  if (!mocks.listener) throw new Error('認証リスナーが登録されていません')
  return mocks.listener(user)
}
function setup() {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  vi.useFakeTimers()
  localStorage.clear()
  mocks.listener = null
  mocks.validate.mockResolvedValue({ success: true, allowed: true })
  mocks.signOut.mockResolvedValue(undefined)
}

describe('認証初期化のclaim取得待ち', () => {
  beforeEach(setup)
  afterEach(() => { vi.useRealTimers() })

  it('claimが7秒で届くまでinitAuthは解決せず、届いたあと通常の利用許可検証へ進む', async () => {
    const claim = deferredClaim()
    mocks.token.mockReturnValue(claim.promise)
    const store = useAuthStore()
    let resolved = false
    const ready = store.initAuth().then(() => { resolved = true })
    void emit(firebaseUser())

    await vi.advanceTimersByTimeAsync(6900)
    expect(resolved).toBe(false)
    expect(store.loading).toBe(true)
    expect(mocks.validate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    claim.resolve({ claims: {} })
    await vi.advanceTimersByTimeAsync(0)
    await ready
    expect(store.user?.uid).toBe('claim-demo')
    expect(store.accessMode).toBe('full')
    expect(mocks.validate).toHaveBeenCalledOnce()
    expect(store.loading).toBe(false)
  })

  it('claimが10秒間届かなければ従来の利用許可検証へフォールバックしviewerにしない', async () => {
    mocks.token.mockReturnValue(new Promise(() => {}))
    const store = useAuthStore()
    let resolved = false
    const ready = store.initAuth().then(() => { resolved = true })
    void emit(firebaseUser())

    await vi.advanceTimersByTimeAsync(9900)
    expect(resolved).toBe(false)
    expect(mocks.validate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(200)
    await ready
    expect(mocks.validate).toHaveBeenCalledOnce()
    expect(store.accessMode).toBe('full')
    expect(store.user?.uid).toBe('claim-demo')
  })

  it('viewer claimが届くまでuserを設定せず、設定時点でnewsViewerになっている', async () => {
    const claim = deferredClaim()
    mocks.token.mockReturnValue(claim.promise)
    const store = useAuthStore()
    const seen: Array<{ uid: string, mode: string | null }> = []
    watch(() => [store.user, store.accessMode] as const, ([u, mode]) => {
      if (u) seen.push({ uid: u.uid, mode })
    }, { flush: 'sync' })
    let resolved = false
    const ready = store.initAuth().then(() => { resolved = true })
    void emit(firebaseUser())

    await vi.advanceTimersByTimeAsync(7000)
    expect(resolved).toBe(false)
    expect(store.user).toBeNull()
    expect(seen).toEqual([])

    claim.resolve({ claims: { newsRole: 'viewer' } })
    await vi.advanceTimersByTimeAsync(0)
    await ready
    expect(mocks.validate).not.toHaveBeenCalled()
    expect(store.accessMode).toBe('newsViewer')
    expect(store.user?.uid).toBe('claim-demo')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((s) => s.mode === 'newsViewer')).toBe(true)
  })
})

describe('claim取得が遅いときの実ルーター遷移', () => {
  beforeEach(setup)
  afterEach(() => { vi.useRealTimers() })

  it('fullユーザーが/settingsを開き、claimが7秒遅れても/settingsに着地する', async () => {
    const claim = deferredClaim()
    mocks.token.mockReturnValue(claim.promise)
    const navigation = router.push('/settings')
    await vi.advanceTimersByTimeAsync(0)
    void emit(firebaseUser())

    await vi.advanceTimersByTimeAsync(7000)
    claim.resolve({ claims: {} })
    await vi.advanceTimersByTimeAsync(0)
    await navigation
    expect(router.currentRoute.value.path).toBe('/settings')
  })
})
