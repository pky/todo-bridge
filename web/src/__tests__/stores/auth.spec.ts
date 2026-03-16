import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'

// Firebase Auth のモック
vi.mock('firebase/auth', () => ({
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn((_auth, callback) => {
    // すぐに未認証状態をコールバック
    callback(null)
    return vi.fn() // unsubscribe関数
  }),
}))

vi.mock('@/services/firebaseAuth', () => ({
  auth: {},
  googleProvider: {},
}))

const validateCurrentUserAccessApiMock = vi.hoisted(() => vi.fn())

vi.mock('@/services/cloudFunctionsService', () => ({
  validateCurrentUserAccessApi: validateCurrentUserAccessApiMock,
}))

describe('Auth Store', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    validateCurrentUserAccessApiMock.mockResolvedValue({
      success: true,
      allowed: true,
      personalSpaceId: 'personal_test-uid',
      joinedFamilySpaceIds: [],
    })
  })

  it('初期状態は未認証', () => {
    const store = useAuthStore()
    expect(store.user).toBeNull()
    expect(store.isAuthenticated).toBe(false)
  })

  it('loading は初期状態で true', () => {
    const store = useAuthStore()
    expect(store.loading).toBe(true)
  })

  it('initAuth 後に loading が false になる', async () => {
    const store = useAuthStore()
    await store.initAuth()
    expect(store.loading).toBe(false)
  })

  it('ログイン成功時にユーザー情報が設定される', async () => {
    const mockUser = {
      uid: 'test-uid',
      email: 'test@example.com',
      displayName: 'Test User',
      photoURL: 'https://example.com/photo.jpg',
    }

    const { signInWithPopup } = await import('firebase/auth')
    vi.mocked(signInWithPopup).mockResolvedValueOnce({
      user: mockUser,
    } as any)

    const store = useAuthStore()
    await store.loginWithGoogle()

    expect(validateCurrentUserAccessApiMock).toHaveBeenCalledTimes(1)
    expect(store.user).toEqual({
      uid: 'test-uid',
      email: 'test@example.com',
      displayName: 'Test User',
      photoURL: 'https://example.com/photo.jpg',
    })
    expect(store.isAuthenticated).toBe(true)
  })

  it('ログイン失敗時にエラーが設定される', async () => {
    const { signInWithPopup } = await import('firebase/auth')
    vi.mocked(signInWithPopup).mockRejectedValueOnce(new Error('Auth failed'))

    const store = useAuthStore()

    await expect(store.loginWithGoogle()).rejects.toThrow('Auth failed')
    expect(store.error).toBe('Auth failed')
    expect(store.user).toBeNull()
  })

  it('モバイルでも popup ログインを使う', async () => {
    const { signInWithPopup } = await import('firebase/auth')
    vi.mocked(signInWithPopup).mockResolvedValueOnce({
      user: {
        uid: 'mobile-uid',
        email: 'mobile@example.com',
        displayName: 'Mobile User',
        photoURL: null,
      },
    } as any)

    const store = useAuthStore()
    await store.loginWithGoogle()

    expect(signInWithPopup).toHaveBeenCalledTimes(1)
  })

  it('未許可アカウントはログイン後に拒否される', async () => {
    const mockUser = {
      uid: 'blocked-uid',
      email: 'blocked@example.com',
      displayName: 'Blocked User',
      photoURL: null,
    }

    const { signInWithPopup, signOut } = await import('firebase/auth')
    vi.mocked(signInWithPopup).mockResolvedValueOnce({ user: mockUser } as any)
    vi.mocked(signOut).mockResolvedValueOnce(undefined)
    validateCurrentUserAccessApiMock.mockRejectedValueOnce({ code: 'functions/permission-denied' })

    const store = useAuthStore()

    await expect(store.loginWithGoogle()).rejects.toThrow('このアカウントは利用を許可されていません')
    expect(signOut).toHaveBeenCalled()
    expect(store.user).toBeNull()
    expect(store.error).toBe('このアカウントは利用を許可されていません')
  })

  it('ログアウト成功時にユーザーがクリアされる', async () => {
    const mockUser = {
      uid: 'test-uid',
      email: 'test@example.com',
      displayName: 'Test User',
      photoURL: null,
    }

    const { signInWithPopup, signOut } = await import('firebase/auth')
    vi.mocked(signInWithPopup).mockResolvedValueOnce({ user: mockUser } as any)
    vi.mocked(signOut).mockResolvedValueOnce(undefined)

    const store = useAuthStore()
    await store.loginWithGoogle()
    expect(store.isAuthenticated).toBe(true)

    await store.logout()
    expect(store.user).toBeNull()
    expect(store.isAuthenticated).toBe(false)
  })
})
