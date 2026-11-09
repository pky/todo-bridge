import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import NewsView from '@/views/NewsView.vue'
import { demoUid, makeFeed } from '../fixtures/aiNewsV2'

const actions = vi.hoisted(() => ({
  load: vi.fn(), reset: vi.fn(), retryPending: vi.fn(),
  loadPreferences: vi.fn(), loadTodayFeed: vi.fn(), loadMobileActionItems: vi.fn(),
}))
const route = reactive({ name: 'news-ai' })
const auth = reactive({ user: { uid: demoUid }, loading: false, accessMode: 'full', error: null })
const aiState = reactive({
  visibleArticles: makeFeed().articles, feed: makeFeed(), feedDate: makeFeed().feedDate,
  loading: false, error: null as string | null, canManage: true, pendingArticles: [] as string[],
})

vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('@/stores/aiNews', () => ({ useAiNewsStore: () => ({
  ...aiState, load: actions.load, reset: actions.reset, retryPending: actions.retryPending,
  readLaterState: () => 'idle',
}) }))
vi.mock('@/stores/news', () => ({ useNewsStore: () => ({
  articles: [], loading: false, error: null, mobileActionItems: {}, mobileActionItemStates: {},
  latestFeedDateByTopic: { ai: null, mobile: null },
  feedDiagnosticsByTopic: { mobile: { state: 'no-feed', message: 'ニュースはまだありません' } },
  preferences: { platforms: ['ios', 'android'] },
  loadPreferences: actions.loadPreferences, loadTodayFeed: actions.loadTodayFeed,
  loadMobileActionItems: actions.loadMobileActionItems,
}) }))
vi.mock('@/components/NewsCard.vue', () => ({ default: {
  props: ['article', 'readLaterState', 'canManage'],
  template: '<article>{{ article.title }}</article>',
} }))
enableAutoUnmount(afterEach)

function buttonsNamed(wrapper: ReturnType<typeof mount>, name: string) {
  return wrapper.findAll('button').filter(button => (button.attributes('aria-label') ?? button.text()) === name)
}

describe('NewsViewのニュース更新ボタン', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const action of Object.values(actions)) action.mockResolvedValue(undefined)
    route.name = 'news-ai'
    auth.accessMode = 'full'
    aiState.canManage = true
    aiState.error = null
    aiState.pendingArticles = []
    aiState.visibleArticles = makeFeed().articles
  })

  it('管理ユーザーの更新ボタンはヘッダー内であとで読むを開くより前にある', async () => {
    const wrapper = mount(NewsView)
    await flushPromises()
    const header = wrapper.get('header')
    const refresh = buttonsNamed(header, 'ニュースを更新')
    expect(refresh).toHaveLength(1)
    const readLater = buttonsNamed(header, 'あとで読むを開く')
    expect(readLater).toHaveLength(1)
    const buttons = header.findAll('button').map(button => button.element)
    expect(buttons.indexOf(refresh[0]!.element)).toBeLessThan(buttons.indexOf(readLater[0]!.element))
  })

  it('更新ボタンを押すとUIDと強制更新フラグをAIニュースstoreに渡す', async () => {
    const wrapper = mount(NewsView)
    await flushPromises()
    expect(actions.load).toHaveBeenCalledWith(demoUid)
    actions.load.mockClear()
    const refresh = buttonsNamed(wrapper, 'ニュースを更新')
    expect(refresh).toHaveLength(1)
    await refresh[0]!.trigger('click')
    await flushPromises()
    expect(actions.load).toHaveBeenCalledExactlyOnceWith(demoUid, true)
  })

  it('閲覧ユーザーの更新ボタンはヘッダー内でログアウトより前にある', async () => {
    auth.accessMode = 'newsViewer'
    aiState.canManage = false
    const wrapper = mount(NewsView)
    await flushPromises()
    const header = wrapper.get('header')
    const refresh = buttonsNamed(header, 'ニュースを更新')
    expect(refresh).toHaveLength(1)
    const logout = buttonsNamed(header, 'ログアウト')
    expect(logout).toHaveLength(1)
    const buttons = header.findAll('button').map(button => button.element)
    expect(buttons.indexOf(refresh[0]!.element)).toBeLessThan(buttons.indexOf(logout[0]!.element))
  })

  it('エラーも未確認操作もなければ一覧上部の行とヘッダー外の更新表示を描かない', async () => {
    const wrapper = mount(NewsView)
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(buttonsNamed(wrapper, '操作結果が未確認・再試行')).toHaveLength(0)
    const outsideHeader = wrapper.findAll('*').filter(({ element }) =>
      !element.closest('header') && !element.querySelector('header'))
    expect.soft(outsideHeader.filter(element => element.text().includes('ニュースを更新'))).toHaveLength(0)
    const list = wrapper.get('header').element.nextElementSibling
    expect(list).not.toBeNull()
    expect(list!.querySelector(':scope > div.px-3.py-2')).toBeNull()
  })

  it('storeにエラーがあればヘッダー外の記事一覧に警告を表示する', async () => {
    aiState.error = 'ニュースの更新に失敗しました'
    const wrapper = mount(NewsView)
    await flushPromises()
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toBe(aiState.error)
    expect(alert.element.closest('header')).toBeNull()
    expect(wrapper.get('header').element.nextElementSibling!.contains(alert.element)).toBe(true)
    expect(wrapper.text()).toContain(makeFeed().articles[0]!.title)
  })

  it('管理ユーザーに未確認操作があれば一覧に再試行ボタンを表示する', async () => {
    aiState.pendingArticles = ['demo-first']
    const wrapper = mount(NewsView)
    await flushPromises()
    const retry = buttonsNamed(wrapper, '操作結果が未確認・再試行')
    expect(retry).toHaveLength(1)
    expect(retry[0]!.element.closest('header')).toBeNull()
    expect(wrapper.get('header').element.nextElementSibling!.contains(retry[0]!.element)).toBe(true)
    await retry[0]!.trigger('click')
    expect(actions.retryPending).toHaveBeenCalledExactlyOnceWith('demo-first')
  })

  it('モバイルトピックではニュース更新ボタンを表示しない', async () => {
    route.name = 'news-mobile'
    const wrapper = mount(NewsView)
    await flushPromises()
    expect(buttonsNamed(wrapper, 'ニュースを更新')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('ニュースを更新')
    expect(actions.load).not.toHaveBeenCalled()
  })
})
