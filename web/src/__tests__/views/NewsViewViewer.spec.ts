import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import NewsView from '@/views/NewsView.vue'
import NewsCard from '@/components/NewsCard.vue'

const navigation = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }))
const auth = reactive({ user: { uid: 'viewer-demo' }, loading: false, accessMode: 'newsViewer' })
const load = vi.hoisted(() => vi.fn())
vi.mock('vue-router', () => ({ useRoute: () => ({ name: 'news-ai' }), useRouter: () => navigation }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('@/stores/news', () => ({ useNewsStore: () => ({ loadPreferences: vi.fn(), loadTodayFeed: vi.fn() }) }))
vi.mock('@/stores/aiNews', () => ({ useAiNewsStore: () => ({
  visibleArticles: [{ id: 'viewer-article', title: '架空の閲覧用ニュース', summary: '架空の記事概要',
    sourceName: '架空技術通信', url: 'https://example.test/viewer', publishedAt: null }],
  loading: false, error: null, feedDate: '2026-11-03', feed: {}, canManage: false,
  load, reset: vi.fn(), pendingArticles: [], readLaterState: () => 'idle',
}) }))
enableAutoUnmount(afterEach)
describe('viewerのAIニュース画面', () => {
  it('記事を表示し、実NewsCardの管理操作とTodo遷移を出さない', async () => {
    const wrapper = mount(NewsView)
    await flushPromises()
    expect(wrapper.text()).toContain('架空の閲覧用ニュース')
    expect(load).toHaveBeenCalledWith('viewer-demo')
    const cards = wrapper.findAllComponents(NewsCard)
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) expect(card.props('canManage')).toBe(false)
    const buttons = wrapper.findAll('button').map(button => button.text())
    expect(buttons).not.toContain('あとで読む')
    expect(buttons).not.toContain('興味なし')
    expect(buttons).not.toContain('あとで読むを開く')
  })
  it.each([null, { back: '/settings' }])('履歴%sで戻る操作が存在してもHomeや前の画面へ離脱しない', async (historyState) => {
    window.history.replaceState(historyState, '')
    vi.clearAllMocks()
    const wrapper = mount(NewsView)
    const back = wrapper.find('button[aria-label="戻る"]')
    if (back.exists()) await back.trigger('click')
    expect(navigation.back).not.toHaveBeenCalled()
    for (const [target] of navigation.push.mock.calls) expect(target).toEqual({ name: 'news-ai' })
  })
})
