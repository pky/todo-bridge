import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import NewsView from '@/views/NewsView.vue'
import NewsCard from '@/components/NewsCard.vue'

const deps = vi.hoisted(() => ({ open: vi.fn(), track: vi.fn(), route: { name: 'news-ai' } }))
const article = vi.hoisted(() => ({ id: 'fable-open', title: '架空の評価装置', summary: '架空概要', summaryJa: '架空概要', sourceName: '架空通信', source: 'rss', url: 'https://example.invalid/fable-open', publishedAt: null }))
vi.mock('vue-router', () => ({ useRoute: () => deps.route, useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { uid: 'fiction-curator' }, loading: false }) }))
vi.mock('@/stores/aiNews', () => ({ useAiNewsStore: () => ({ visibleArticles: [article], feed: {}, feedDate: '2026-11-08', loading: false, error: null, canManage: true, load: vi.fn(), dismiss: vi.fn(), readLater: vi.fn(), reset: vi.fn(), readLaterState: () => 'idle', open: deps.open }) }))
vi.mock('@/stores/news', () => ({ useNewsStore: () => ({ articles: [article], loading: false, error: null, mobileActionItems: {}, mobileActionItemStates: {}, latestFeedDateByTopic: { mobile: '2026-11-08' }, feedDiagnosticsByTopic: { mobile: { state: 'showing', message: '' } }, preferences: { keywords: [], platforms: ['ios', 'android'], includeCommunity: true }, loadPreferences: vi.fn(), loadTodayFeed: vi.fn(), loadMobileActionItems: vi.fn(), trackClick: deps.track }) }))
enableAutoUnmount(afterEach)
beforeEach(() => { vi.clearAllMocks(); deps.route.name = 'news-ai' })
afterEach(() => { vi.restoreAllMocks() })

it('AI記事の実カードをクリックするとopenを一度呼び従来どおり別タブを開く', async () => {
  const external = vi.spyOn(window, 'open').mockReturnValue(null)
  const wrapper = mount(NewsView)
  await wrapper.findComponent(NewsCard).trigger('click')
  expect(external).toHaveBeenCalledExactlyOnceWith(article.url, '_blank', 'noopener,noreferrer')
  expect(deps.open).toHaveBeenCalledExactlyOnceWith(article.id)
  expect(deps.track).not.toHaveBeenCalled()
})
it('mobile記事は従来どおりtrackClickと別タブを使う', async () => {
  deps.route.name = 'news-mobile'
  const external = vi.spyOn(window, 'open').mockReturnValue(null)
  const wrapper = mount(NewsView)
  await wrapper.findComponent(NewsCard).trigger('click')
  expect(external).toHaveBeenCalledExactlyOnceWith(article.url, '_blank', 'noopener,noreferrer')
  expect(deps.track).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: article.id }), 'mobile')
  expect(deps.open).not.toHaveBeenCalled()
})
