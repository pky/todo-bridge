import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import NewsView from '@/views/NewsView.vue'
import { makeFeed } from '../fixtures/aiNewsV2'

const actions = vi.hoisted(() => ({
  aiLoad: vi.fn(), dismiss: vi.fn(), readLater: vi.fn(), retryPending: vi.fn(), reset: vi.fn(),
  loadTodayFeed: vi.fn(), loadPreferences: vi.fn(), trackDisplayedArticles: vi.fn(), bookmarkArticle: vi.fn(),
  dismissArticle: vi.fn(), trackClick: vi.fn(), loadMobileActionItems: vi.fn(),
  resolveMobileActionItem: vi.fn(), restoreMobileActionItem: vi.fn(),
}))
const route = reactive({ name: 'news-ai' })
const auth = reactive({ user: { uid: 'ai-news-demo-user' }, loading: false, newsRole: 'curator' })
const aiState = reactive({
  visibleArticles: makeFeed().articles, loading: false, error: null, feedDate: '2026-11-03',
  feed: makeFeed(), canManage: true,
})
const mobileState = reactive({
  articles: [], loading: false, error: null, mobileActionItems: {}, mobileActionItemStates: {},
  latestFeedDateByTopic: { ai: null, mobile: null },
  feedDiagnosticsByTopic: { ai: { state: 'showing', message: '' }, mobile: { state: 'showing', message: '' } },
  preferences: { keywords: [], platforms: ['ios', 'android'], officialOnly: false, includeCommunity: true, actionRequiredOnly: false },
})
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('@/stores/aiNews', () => ({ useAiNewsStore: () => ({ ...aiState,
  load: actions.aiLoad, dismiss: actions.dismiss, readLater: actions.readLater,
  retryPending: actions.retryPending, reset: actions.reset,
}) }))
vi.mock('@/stores/news', () => ({ useNewsStore: () => ({ ...mobileState,
  loadTodayFeed: actions.loadTodayFeed, loadPreferences: actions.loadPreferences,
  trackDisplayedArticles: actions.trackDisplayedArticles, bookmarkArticle: actions.bookmarkArticle,
  dismissArticle: actions.dismissArticle, trackClick: actions.trackClick,
  loadMobileActionItems: actions.loadMobileActionItems, resolveMobileActionItem: actions.resolveMobileActionItem,
  restoreMobileActionItem: actions.restoreMobileActionItem,
}) }))
enableAutoUnmount(afterEach)

const publishedAt = '2026-11-02T06:00:00Z'
const expectedDate = new Date(publishedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
const datePattern = /\d{1,2}\/\d{1,2}/

// NewsCardは実物を使い、タイトルを含むカード単位の表示文字列を取り出す。
function cardText(wrapper: ReturnType<typeof mount>, title: string): string {
  const card = wrapper.findAll('div.cursor-pointer').find(candidate => candidate.text().includes(title))
  expect(card, `${title}のカードが描画されていること`).toBeDefined()
  return card!.text()
}

describe('AIニュースカードの公開日表示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const action of Object.values(actions)) action.mockResolvedValue(undefined)
    route.name = 'news-ai'
    const [first, second] = makeFeed().articles
    aiState.visibleArticles = [
      { ...first!, publishedAt: null },
      { ...second!, publishedAt },
    ]
  })

  it('publishedAtがnullの記事は公開日を表示しない', async () => {
    const wrapper = mount(NewsView)
    await flushPromises()
    const text = cardText(wrapper, '架空の推論モデル更新')
    expect(text).not.toContain('1/1')
    expect(text).not.toMatch(datePattern)
  })

  it('有効なpublishedAtの記事は公開日を表示する', async () => {
    const wrapper = mount(NewsView)
    await flushPromises()
    expect(cardText(wrapper, '架空の評価ツール公開')).toContain(expectedDate)
  })
})
