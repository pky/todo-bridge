import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { signOut } from 'firebase/auth'
import App from '@/App.vue'
import router from '@/router'
import { useAuthStore } from '@/stores/auth'

const boundary = vi.hoisted(() => {
  const token = vi.fn(async () => ({ claims: { newsRole: 'viewer' } }))
  const user = { uid: 'viewer-demo', email: null, displayName: '架空の閲覧者', photoURL: null, getIdTokenResult: token }
  return { user, token, validate: vi.fn(), fetchFeed: vi.fn() }
})
vi.mock('@/services/firebase', () => ({ db: {}, auth: { currentUser: boundary.user, authStateReady: async () => {} }, storage: {} }))
vi.mock('@/services/firebaseAuth', () => ({ auth: { currentUser: boundary.user }, googleProvider: {} }))
vi.mock('@/services/firebaseFunctions', () => ({ functions: {} }))
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: vi.fn((_auth, callback) => { void callback(boundary.user); return vi.fn() }),
  getIdTokenResult: boundary.token, signOut: vi.fn(), signInWithPopup: vi.fn(), signInAnonymously: vi.fn(),
}))
vi.mock('@/services/documentSearchCache', () => ({ clearDocumentSearchCache: vi.fn() }))
vi.mock('@/services/cloudFunctionsService', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/cloudFunctionsService')>(),
  validateCurrentUserAccessApi: boundary.validate,
}))
vi.mock('firebase/functions', () => ({ httpsCallable: () => vi.fn(async () => ({ data: { success: true, counts: {} } })) }))
vi.mock('virtual:pwa-register/vue', () => ({ useRegisterSW: () => ({ needRefresh: false, updateServiceWorker: vi.fn() }) }))
vi.mock('@/services/aiNewsFeedSource', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/aiNewsFeedSource')>(), fetchLatestAiFeedBytes: boundary.fetchFeed,
}))
vi.mock('firebase/firestore', async importOriginal => {
  const actual = await importOriginal<typeof import('firebase/firestore')>()
  const snapshot = { docs: [], empty: true, size: 0, exists: () => false, data: () => undefined, forEach: () => {} }
  const pathOf = (base: unknown, parts: string[]) => {
    const parent = typeof base === 'object' && base !== null && 'path' in base ? String(base.path) : ''
    return [parent, ...parts].filter(Boolean).join('/')
  }
  return { ...actual,
    collection: vi.fn((base: unknown, ...parts: string[]) => ({ path: pathOf(base, parts) })),
    doc: vi.fn((base: unknown, ...parts: string[]) => ({ path: pathOf(base, parts) })),
    collectionGroup: vi.fn((_db, path: string) => ({ path })),
    query: vi.fn(source => source),
    getDocs: vi.fn(async () => snapshot), getDoc: vi.fn(async () => snapshot),
    getDocsFromCache: vi.fn(async () => snapshot), getDocsFromServer: vi.fn(async () => snapshot),
    onSnapshot: vi.fn((_source, callback) => {
      if (typeof callback === 'function') callback(snapshot)
      return vi.fn()
    }),
  }
})
enableAutoUnmount(afterEach)
let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  localStorage.clear()
  vi.clearAllMocks()
  boundary.validate.mockResolvedValue({ success: true, allowed: true })
  boundary.fetchFeed.mockResolvedValue(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2, topic: 'ai', feedDate: '2026-11-03', generatedAt: '2026-11-03T00:00:00Z', revision: 'a'.repeat(64), totalCount: 1,
    articles: [{ id: 'viewer-article', title: '架空の閲覧用ニュース', sourceName: '架空技術通信', summary: '架空の記事概要', publishedAt: null, url: 'https://example.test/viewer' }],
  })).buffer)
})
async function openApp() {
  await router.push('/news/ai')
  await router.isReady()
  const wrapper = mount(App, { global: { plugins: [pinia, router], stubs: { TaskList: true, TaskDetail: true } } })
  await flushPromises()
  return wrapper
}
describe('viewerのログアウト失敗表示（App経由）', () => {
  it('loadingによるrouter-view再生成後も失敗メッセージを表示し、/news/aiに留まる', async () => {
    // 文字列で拒否するとストアは既定の「ログアウトに失敗しました」をerrorに入れる
    vi.mocked(signOut).mockRejectedValueOnce('架空のsignOut失敗')
    const wrapper = await openApp()
    const authStore = useAuthStore()
    expect(authStore.accessMode).toBe('newsViewer')
    const logoutButton = wrapper.findAll('button').find(button => button.text() === 'ログアウト')
    expect(logoutButton).toBeDefined()
    await logoutButton!.trigger('click')
    await flushPromises()
    expect.soft(authStore.loading).toBe(false)
    expect.soft(router.currentRoute.value.path).toBe('/news/ai')
    expect.soft(wrapper.text()).toContain('架空の閲覧用ニュース')
    expect(wrapper.text()).toContain('ログアウトに失敗しました')
  })
})
