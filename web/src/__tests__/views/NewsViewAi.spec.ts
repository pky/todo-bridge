import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { Timestamp } from 'firebase/firestore'
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
const mobileArticle = {
  id: 'demo-mobile', title: '架空のモバイル開発更新', topic: 'mobile', platform: 'ios',
  url: 'https://example.test/mobile', source: 'rss', sourceName: '架空モバイル通信',
  thumbnailUrl: null, score: null, publishedAt: Timestamp.fromMillis(0), fetchedAt: Timestamp.fromMillis(0), date: '2026-11-03',
}
const aiState = reactive({
  visibleArticles: makeFeed().articles, loading: false, error: null, feedDate: '2026-11-03',
  feed: makeFeed(), canManage: true,
})
const mobileState = reactive({
  articles: [mobileArticle], loading: false, error: null, mobileActionItems: {}, mobileActionItemStates: {},
  latestFeedDateByTopic: { ai: null, mobile: '2026-11-03' },
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
vi.mock('@/components/NewsCard.vue', () => ({ default: {
  props: ['article', 'readLaterState', 'canManage'],
  emits: ['bookmark', 'dismiss', 'articleClick'],
  template: `<div data-testid="news-card"><p>{{ article.title }}</p>
    <button data-testid="bookmark" @click="$emit('bookmark', article)">あとで読む</button>
    <button data-testid="dismiss" @click="$emit('dismiss', article)">興味なし</button></div>`,
} }))
enableAutoUnmount(afterEach)

describe('NewsViewのAI専用storeへの配線', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const action of Object.values(actions)) action.mockResolvedValue(undefined)
    route.name = 'news-ai'
    aiState.visibleArticles = makeFeed().articles
  })

  it('AIルートはUIDでaiNewsをloadし、旧Firestore取得・表示回数追跡を使わない', async () => {
    const wrapper = mount(NewsView)
    await flushPromises()
    expect(actions.aiLoad).toHaveBeenCalledWith('ai-news-demo-user')
    expect(wrapper.text()).toContain('架空の推論モデル更新')
    expect(wrapper.text()).not.toContain(mobileArticle.title)
    for (const action of [actions.loadTodayFeed, actions.trackDisplayedArticles, actions.loadPreferences, actions.loadMobileActionItems]) {
      expect(action).not.toHaveBeenCalled()
    }
  })

  it('AIカードの興味なし・あとで読むをarticleIdで専用storeへ送る', async () => {
    const wrapper = mount(NewsView)
    await flushPromises()
    await wrapper.findAll('[data-testid="bookmark"]')[0]!.trigger('click')
    await wrapper.findAll('[data-testid="dismiss"]')[0]!.trigger('click')
    await flushPromises()
    expect(actions.readLater).toHaveBeenCalledWith('demo-first')
    expect(actions.dismiss).toHaveBeenCalledWith('demo-first')
    for (const action of [actions.bookmarkArticle, actions.dismissArticle, actions.trackDisplayedArticles]) expect(action).not.toHaveBeenCalled()
  })

  it('mobileルートでは従来の取得・カード操作を維持する', async () => {
    route.name = 'news-mobile'
    const wrapper = mount(NewsView)
    await flushPromises()
    expect(actions.loadPreferences).toHaveBeenCalledWith('mobile')
    expect(actions.loadTodayFeed).toHaveBeenCalledWith('mobile')
    expect(actions.loadMobileActionItems).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain(mobileArticle.title)
    expect(actions.aiLoad).not.toHaveBeenCalled()
    await wrapper.findAll('[data-testid="bookmark"]')[0]!.trigger('click')
    await wrapper.findAll('[data-testid="dismiss"]')[0]!.trigger('click')
    await flushPromises()
    expect(actions.bookmarkArticle).toHaveBeenCalledWith(mobileArticle)
    expect(actions.dismissArticle).toHaveBeenCalledWith(mobileArticle.id, mobileArticle.url, 'mobile')
    expect(actions.readLater).not.toHaveBeenCalled()
    expect(actions.dismiss).not.toHaveBeenCalled()
  })
})
