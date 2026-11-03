import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import LoginView from '@/views/LoginView.vue'

const replace = vi.hoisted(() => vi.fn())
const state = reactive({ accessMode: 'newsViewer', isAuthenticated: false, loading: false, error: null,
  loginWithGoogle: vi.fn(), loginForLocalDevelopment: vi.fn() })
vi.mock('vue-router', () => ({ useRouter: () => ({ replace }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => state }))
enableAutoUnmount(afterEach)
describe('viewerのログイン画面', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.isAuthenticated = false
    state.loginWithGoogle.mockImplementation(async () => { state.isAuthenticated = true })
    state.loginForLocalDevelopment.mockImplementation(async () => { state.isAuthenticated = true })
  })
  it('認証済みviewerは表示直後からnews-aiへ進む', async () => {
    state.isAuthenticated = true
    mount(LoginView)
    await flushPromises()
    expect(replace).toHaveBeenCalledWith({ name: 'news-ai' })
    expect(replace).not.toHaveBeenCalledWith({ name: 'home' })
  })
  it.each(['google', 'local'])('%sのログイン成功後もhomeを経由しない', async (path) => {
    const wrapper = mount(LoginView)
    await wrapper.get(path === 'local' ? '[data-testid="local-login"]' : 'button').trigger('click')
    await flushPromises()
    expect(path === 'local' ? state.loginForLocalDevelopment : state.loginWithGoogle).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledWith({ name: 'news-ai' })
    expect(replace).not.toHaveBeenCalledWith({ name: 'home' })
  })
})
