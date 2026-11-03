import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import App from '@/App.vue'
import router from '@/router'
import Sidebar from '@/components/Sidebar.vue'

const boundary = vi.hoisted(() => {
  const token = vi.fn(async () => ({ claims: { newsRole: 'viewer' } }))
  const user = { uid: 'viewer-demo', email: null, displayName: '架空の閲覧者', photoURL: null, getIdTokenResult: token }
  return { user, token, validate: vi.fn(), paths: [] as Array<{ operation: string; path: string }>, fetchFeed: vi.fn() }
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
  const pathOf = (base: unknown, parts: string[]) => {
    const parent = typeof base === 'object' && base !== null && 'path' in base ? String(base.path) : ''
    return [parent, ...parts].filter(Boolean).join('/')
  }
  const reference = (operation: string) => (base: unknown, ...parts: string[]) => {
    const path = pathOf(base, parts)
    boundary.paths.push({ operation, path })
    return { path }
  }
  const snapshot = { docs: [], empty: true, size: 0, exists: () => false, data: () => undefined, forEach: () => {} }
  const read = (operation: string) => vi.fn(async (source) => {
    boundary.paths.push({ operation, path: source.path })
    return snapshot
  })
  return { ...actual, collection: vi.fn(reference('collection')), doc: vi.fn(reference('doc')),
    collectionGroup: vi.fn((_db, path: string) => { boundary.paths.push({ operation: 'collectionGroup', path }); return { path } }),
    query: vi.fn(source => source), getDocs: read('getDocs'), getDoc: read('getDoc'),
    getDocsFromCache: read('getDocsFromCache'), getDocsFromServer: read('getDocsFromServer'),
    onSnapshot: vi.fn((source, callback) => {
      boundary.paths.push({ operation: 'onSnapshot', path: source.path })
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
  boundary.paths.length = 0
  boundary.validate.mockResolvedValue({ success: true, allowed: true })
  boundary.fetchFeed.mockResolvedValue(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2, topic: 'ai', feedDate: '2026-11-03', generatedAt: '2026-11-03T00:00:00Z', revision: 'a'.repeat(64), totalCount: 1,
    articles: [{ id: 'viewer-article', title: '架空の閲覧用ニュース', sourceName: '架空技術通信', summary: '架空の記事概要', publishedAt: null, url: 'https://example.test/viewer' }],
  })).buffer)
})
const forbidden = /(^|\/)(tasks|lists|spaces|memberships|newsPreferences|newsInteractions|newsState|newsFeed|newsFeeds|newsArticles|topics|mobile)(\/|$)/
async function openApp() {
  await router.push('/news/ai')
  await router.isReady()
  const wrapper = mount(App, { global: { plugins: [pinia, router], stubs: { TaskList: true, TaskDetail: true } } })
  await flushPromises()
  return wrapper
}
describe('実Appとストアのviewer配線', () => {
  it('通常の認証通知から記事を表示し、個人スペース初期化APIを呼ばない', async () => {
    const wrapper = await openApp()
    expect.soft(wrapper.text()).toContain('架空の閲覧用ニュース')
    expect.soft(boundary.fetchFeed).toHaveBeenCalled()
    expect.soft(boundary.token).toHaveBeenCalled()
    expect(boundary.validate).not.toHaveBeenCalled()
  })
  it('ニュース表示からHomeへ移動しようとしてもSidebarを表示せず禁止コレクションを参照しない', async () => {
    const wrapper = await openApp()
    expect.soft(wrapper.text()).toContain('架空の閲覧用ニュース')
    await router.push('/')
    await flushPromises()
    expect.soft(router.currentRoute.value.name).toBe('news-ai')
    expect.soft(wrapper.findComponent(Sidebar).exists()).toBe(false)
    expect(boundary.paths.filter(({ path }) => forbidden.test(path))).toEqual([])
  })
})
