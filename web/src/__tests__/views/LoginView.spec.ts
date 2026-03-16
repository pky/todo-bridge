import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import LoginView from '@/views/LoginView.vue'
import { useAuthStore } from '@/stores/auth'

const replaceMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
}))

vi.mock('firebase/auth', () => ({
  signInWithPopup: vi.fn(),
  signInWithRedirect: vi.fn(),
  getRedirectResult: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn((_auth, callback) => {
    callback(null)
    return vi.fn()
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

describe('LoginView', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    validateCurrentUserAccessApiMock.mockResolvedValue({
      success: true,
      allowed: true,
      personalSpaceId: 'personal_test-uid',
      joinedFamilySpaceIds: [],
    })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    const { getRedirectResult } = await import('firebase/auth')
    vi.mocked(getRedirectResult).mockResolvedValue(undefined as any)
  })

  it('認証済みなら表示時にホームへ遷移する', async () => {
    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'user-1', email: 'user@example.com', displayName: 'User', photoURL: null },
      loading: false,
    })

    mount(LoginView)
    await nextTick()

    expect(replaceMock).toHaveBeenCalledWith({ name: 'home' })
  })

  it('ログイン成功後にホームへ遷移する', async () => {
    const { signInWithPopup } = await import('firebase/auth')
    vi.mocked(signInWithPopup).mockResolvedValueOnce({
      user: {
        uid: 'user-1',
        email: 'user@example.com',
        displayName: 'User',
        photoURL: null,
      },
    } as any)

    const authStore = useAuthStore()
    authStore.$patch({ loading: false })

    const wrapper = mount(LoginView)

    await wrapper.get('button').trigger('click')
    await nextTick()

    expect(signInWithPopup).toHaveBeenCalledTimes(1)
    expect(replaceMock).toHaveBeenCalledWith({ name: 'home' })
  })
})
