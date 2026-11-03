import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import NewsView from '@/views/NewsView.vue'

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }))
const logout = vi.hoisted(() => vi.fn())
const auth = reactive({ user: { uid: 'viewer-demo' }, loading: false, accessMode: 'newsViewer', logout })
vi.mock('vue-router', () => ({ useRoute: () => ({ name: 'news-ai' }), useRouter: () => navigation }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('@/stores/news', () => ({ useNewsStore: () => ({ loadPreferences: vi.fn(), loadTodayFeed: vi.fn() }) }))
vi.mock('@/stores/aiNews', () => ({ useAiNewsStore: () => ({
  visibleArticles: [{ id: 'viewer-article', title: '架空の閲覧用ニュース', summary: '架空の記事概要',
    sourceName: '架空技術通信', url: 'https://example.test/viewer', publishedAt: null }],
  loading: false, error: null, feedDate: '2026-11-03', feed: {}, canManage: false,
  load: vi.fn(), reset: vi.fn(), pendingArticles: [], readLaterState: () => 'idle',
}) }))
enableAutoUnmount(afterEach)

const logoutButtons = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll('button').filter(b => b.text() === 'ログアウト' || b.attributes('aria-label') === 'ログアウト')
const navigatedToLogin = () => [...navigation.push.mock.calls, ...navigation.replace.mock.calls]
  .some(([target]) => target === '/login' || (typeof target === 'object' && target?.name === 'login'))

describe('viewerのAIニュース画面のログアウト', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    logout.mockResolvedValue(undefined)
    auth.accessMode = 'newsViewer'
  })

  it('viewerにはログアウトボタンが1つ表示される', async () => {
    const wrapper = mount(NewsView)
    await flushPromises()
    expect(logoutButtons(wrapper)).toHaveLength(1)
  })

  it('クリックでlogoutを呼び、ログイン画面へ遷移する', async () => {
    const wrapper = mount(NewsView)
    await flushPromises()
    await logoutButtons(wrapper)[0]!.trigger('click')
    await flushPromises()
    expect(logout).toHaveBeenCalledTimes(1)
    expect(navigatedToLogin()).toBe(true)
  })

  it('logoutが完了する前にログイン画面へ遷移しない', async () => {
    let finish!: () => void
    logout.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const wrapper = mount(NewsView)
    await flushPromises()
    await logoutButtons(wrapper)[0]!.trigger('click')
    expect(navigatedToLogin()).toBe(false)
    finish()
    await flushPromises()
    expect(navigatedToLogin()).toBe(true)
  })

  it('通常利用者(full)のニュース画面にはログアウトボタンを出さない', async () => {
    auth.accessMode = 'full'
    const wrapper = mount(NewsView)
    await flushPromises()
    expect(logoutButtons(wrapper)).toHaveLength(0)
  })
})
