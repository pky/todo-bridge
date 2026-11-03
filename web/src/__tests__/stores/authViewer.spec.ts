import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'

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

function firebaseUser(uid = 'viewer-demo') {
  return { uid, email: null, displayName: '架空の閲覧者', photoURL: null, getIdTokenResult: mocks.token }
}
async function emitUser(user: ReturnType<typeof firebaseUser> | null) {
  if (!mocks.listener) throw new Error('認証リスナーが登録されていません')
  await mocks.listener(user)
}

describe('閲覧専用ユーザーの認証', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    vi.useFakeTimers()
    localStorage.clear()
    mocks.listener = null
    mocks.token.mockResolvedValue({ claims: { newsRole: 'viewer' } })
    mocks.validate.mockResolvedValue({ success: true, allowed: true })
    mocks.popup.mockResolvedValue({ user: firebaseUser() })
    mocks.anonymous.mockResolvedValue({ user: firebaseUser() })
    mocks.signOut.mockResolvedValue(undefined)
  })
  afterEach(() => { vi.useRealTimers() })

  it.each(['popup', 'anonymous', 'listener'] as const)('%sのviewerは既存の利用許可APIとsignOutを呼ばない', async (path) => {
    const store = useAuthStore()
    if (path === 'listener') {
      const ready = store.initAuth()
      await emitUser(firebaseUser())
      await ready
    } else if (path === 'anonymous') await store.loginForLocalDevelopment()
    else await store.loginWithGoogle()
    expect.soft(mocks.token).toHaveBeenCalled()
    expect.soft(mocks.validate).not.toHaveBeenCalled()
    expect.soft(mocks.signOut).not.toHaveBeenCalled()
    expect.soft(store).toEqual(expect.objectContaining({ accessMode: 'newsViewer', user: expect.objectContaining({ uid: 'viewer-demo' }) }))
  })

  it.each(['curator', undefined])('%sは既存の利用許可APIを通ってfullになる', async (newsRole) => {
    mocks.token.mockResolvedValue({ claims: newsRole ? { newsRole } : {} })
    const store = useAuthStore()
    await store.loginWithGoogle()
    expect.soft(mocks.token).toHaveBeenCalled()
    expect.soft(mocks.validate).toHaveBeenCalledOnce()
    expect(store).toEqual(expect.objectContaining({ accessMode: 'full' }))
  })

  it('claim取得失敗は利用許可APIにフォールバックしviewerにしない', async () => {
    mocks.token.mockRejectedValue(new Error('検証用のトークン取得失敗'))
    const store = useAuthStore()
    await store.loginWithGoogle()
    expect.soft(mocks.token).toHaveBeenCalled()
    expect.soft(mocks.validate).toHaveBeenCalledOnce()
    expect(store).toEqual(expect.objectContaining({ accessMode: 'full' }))
  })

  it.each(['curator', undefined, 'token-error'])('%sの利用許可拒否は既存の文言とsignOutを維持する', async (role) => {
    if (role === 'token-error') mocks.token.mockRejectedValue(new Error('検証用のトークン取得失敗'))
    else mocks.token.mockResolvedValue({ claims: role ? { newsRole: role } : {} })
    mocks.validate.mockRejectedValue({ code: 'functions/permission-denied' })
    const store = useAuthStore()
    await expect(store.loginWithGoogle()).rejects.toThrow('このアカウントは利用を許可されていません')
    expect(mocks.validate).toHaveBeenCalledOnce()
    expect(mocks.signOut).toHaveBeenCalledOnce()
    expect(store.user).toBeNull()
    expect(store.error).toBe('このアカウントは利用を許可されていません')
  })

  it('logoutはviewerモードとユーザーを解除する', async () => {
    const store = useAuthStore()
    await store.loginWithGoogle()
    expect.soft(store).toEqual(expect.objectContaining({ accessMode: 'newsViewer' }))
    await store.logout()
    expect(store.user).toBeNull()
    expect(store).not.toEqual(expect.objectContaining({ accessMode: 'newsViewer' }))
    expect(mocks.signOut).toHaveBeenCalledOnce()
  })

  it('UID変更では前のviewer判定を使わず新しいUIDの利用許可を検証する', async () => {
    const store = useAuthStore()
    const ready = store.initAuth()
    await emitUser(firebaseUser())
    await ready
    expect.soft(store).toEqual(expect.objectContaining({ accessMode: 'newsViewer' }))
    mocks.validate.mockClear()
    mocks.token.mockResolvedValue({ claims: {} })
    await emitUser(firebaseUser('full-demo'))
    expect(mocks.validate).toHaveBeenCalledOnce()
    expect(store).toEqual(expect.objectContaining({ accessMode: 'full', user: expect.objectContaining({ uid: 'full-demo' }) }))
  })

  it('認証リスナーの未認証通知でもviewerモードを解除する', async () => {
    const store = useAuthStore()
    const ready = store.initAuth()
    await emitUser(firebaseUser())
    await ready
    expect.soft(store).toEqual(expect.objectContaining({ accessMode: 'newsViewer' }))
    await emitUser(null)
    expect(store.user).toBeNull()
    expect(store).not.toEqual(expect.objectContaining({ accessMode: 'newsViewer' }))
  })
})
