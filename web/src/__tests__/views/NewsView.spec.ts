import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import NewsView from '@/views/NewsView.vue'
import type { NewsArticle } from '@/types'

const dismissArticleMock = vi.hoisted(() => vi.fn())
const loadTodayFeedMock = vi.hoisted(() => vi.fn())
const loadPreferencesMock = vi.hoisted(() => vi.fn())
const trackClickMock = vi.hoisted(() => vi.fn())
const bookmarkArticleMock = vi.hoisted(() => vi.fn())
const routeState = vi.hoisted(() => ({ name: 'news-ai' as string }))
const pushMock = vi.hoisted(() => vi.fn())

const article: NewsArticle = {
  id: 'article-1',
  title: 'OpenAI releases update',
  titleJa: 'OpenAIが更新を公開',
  summaryJa: '要約',
  url: 'https://example.com/article-1',
  thumbnailUrl: null,
  source: 'rss',
  sourceName: 'Example',
  score: null,
  publishedAt: {} as NewsArticle['publishedAt'],
  fetchedAt: {} as NewsArticle['fetchedAt'],
  date: '2026-03-14',
}

const mobileArticleIos: NewsArticle = {
  ...article,
  id: 'mobile-ios',
  title: 'iOS SDK update',
  titleJa: 'iOS SDK更新',
  url: 'https://example.com/ios',
  topic: 'mobile',
  platform: 'ios',
  isOfficial: true,
  actionRequired: true,
  actionType: 'sdk_requirement',
  importantLevel: 'urgent',
  requiredByDate: '2026-05-31',
}

const mobileArticleAndroid: NewsArticle = {
  ...article,
  id: 'mobile-android',
  title: 'Android policy update',
  titleJa: 'Androidポリシー更新',
  url: 'https://example.com/android',
  topic: 'mobile',
  platform: 'android',
  isOfficial: false,
  actionRequired: true,
  actionType: 'policy',
  importantLevel: 'urgent',
}

const newsStoreState = reactive({
  articles: [article],
  loading: false,
  error: null as string | null,
  preferences: {
    keywords: [],
    platforms: ['ios', 'android'] as Array<'ios' | 'android'>,
    officialOnly: false,
    includeCommunity: true,
    actionRequiredOnly: false,
  },
})

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
    back: vi.fn(),
  }),
  useRoute: () => routeState,
}))

vi.mock('@/stores/news', () => ({
  useNewsStore: () => ({
    ...newsStoreState,
    loadPreferences: loadPreferencesMock,
    loadTodayFeed: loadTodayFeedMock,
    dismissArticle: dismissArticleMock,
    trackClick: trackClickMock,
    bookmarkArticle: bookmarkArticleMock,
  }),
}))

vi.mock('@/components/NewsCard.vue', () => ({
  default: {
    props: ['article'],
    template: '<div><p data-testid="card-title">{{ article.title }}</p><button data-testid="dismiss" @click="$emit(\'dismiss\', article)">dismiss</button></div>',
  },
}))

describe('NewsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    newsStoreState.articles = [article]
    newsStoreState.loading = false
    newsStoreState.error = null
    loadTodayFeedMock.mockResolvedValue(undefined)
    loadPreferencesMock.mockResolvedValue(undefined)
    dismissArticleMock.mockResolvedValue(undefined)
    trackClickMock.mockResolvedValue(undefined)
    bookmarkArticleMock.mockResolvedValue(undefined)
    routeState.name = 'news-ai'
    newsStoreState.preferences = {
      keywords: [],
      platforms: ['ios', 'android'],
      officialOnly: false,
      includeCommunity: true,
      actionRequiredOnly: false,
    }
  })

  it('あとで読むを開くボタンからTodo画面へ遷移できる', async () => {
    const wrapper = mount(NewsView, {
      global: {
        stubs: {
          Transition: false,
        },
      },
    })

    await wrapper.get('button.ml-auto').trigger('click')

    expect(pushMock).toHaveBeenCalledWith({
      name: 'home',
      query: { target: 'read-later' },
    })
  })

  it('興味なし押下時にURL付きで dismissArticle を呼ぶ', async () => {
    const wrapper = mount(NewsView, {
      global: {
        stubs: {
          Transition: false,
        },
      },
    })

    await wrapper.get('[data-testid="dismiss"]').trigger('click')

    expect(dismissArticleMock).toHaveBeenCalledWith(article.id, article.url, 'ai')
  })

  it('mobile ではフィルタで iOS のみ表示できる', async () => {
    routeState.name = 'news-mobile'
    newsStoreState.articles = [mobileArticleIos, mobileArticleAndroid]

    const wrapper = mount(NewsView, {
      global: {
        stubs: {
          Transition: false,
        },
      },
    })

    await nextTick()

    expect(wrapper.text()).toContain('iOS')
    expect(loadPreferencesMock).toHaveBeenCalledWith('mobile')
    expect(loadTodayFeedMock).toHaveBeenCalledWith('mobile')

    const buttons = wrapper.findAll('button')
    const iosButton = buttons.find((button) => button.text() === 'iOS')
    expect(iosButton).toBeTruthy()

    await iosButton.trigger('click')

    const titles = [
      ...wrapper.findAll('[data-testid="card-title"]').map((node) => node.text()),
      ...wrapper.findAll('[data-testid="important-title"]').map((node) => node.text()),
    ]
    expect(titles).toContain('iOS SDK更新')
    expect(titles).not.toContain('Androidポリシー更新')
  })

  it('mobile では重要事項サマリーを先頭に表示する', async () => {
    routeState.name = 'news-mobile'
    newsStoreState.articles = [
      mobileArticleIos,
      mobileArticleAndroid,
      {
        ...mobileArticleAndroid,
        id: 'mobile-official-policy',
        url: 'https://example.com/mobile-official-policy',
        isOfficial: true,
      },
    ]

    const wrapper = mount(NewsView, {
      global: {
        stubs: {
          Transition: false,
        },
      },
    })

    await nextTick()

    expect(wrapper.text()).toContain('今日の重要事項')
    expect(wrapper.text()).toContain('期限あり: 2026-05-31 までに確認')
    expect(wrapper.text()).toContain('ポリシー変更の確認対象')
    expect(wrapper.text()).not.toContain('要対応 2 件')
    expect(wrapper.text()).not.toContain('確認推奨 0 件')
  })

  it('mobile の重要事項に確認するリンクを出す', async () => {
    routeState.name = 'news-mobile'
    newsStoreState.articles = [mobileArticleIos]

    const wrapper = mount(NewsView, {
      global: {
        stubs: {
          Transition: false,
        },
      },
    })

    await nextTick()

    const link = wrapper.find(`a[href="${mobileArticleIos.url}"]`)
    expect(link.exists()).toBe(true)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
    expect(link.text()).toContain('確認する')
  })

  it('mobile の重要事項は urgent の記事だけ表示する', async () => {
    routeState.name = 'news-mobile'
    newsStoreState.articles = [
      mobileArticleIos,
      {
        ...mobileArticleAndroid,
        id: 'mobile-review-only',
        url: 'https://example.com/mobile-review-only',
        title: 'Android review only',
        titleJa: 'Android確認推奨のみ',
        actionRequired: false,
        importantLevel: 'review',
      },
    ]

    const wrapper = mount(NewsView, {
      global: {
        stubs: {
          Transition: false,
        },
      },
    })

    await nextTick()

    const importantTitles = wrapper.findAll('[data-testid="important-title"]').map((node) => node.text())
    expect(importantTitles).toContain('iOS SDK更新')
    expect(importantTitles).not.toContain('Android確認推奨のみ')

    const buttons = wrapper.findAll('button')
    const allButton = buttons.find((button) => button.text() === 'すべて')
    expect(allButton).toBeTruthy()

    await allButton?.trigger('click')

    const allTitles = wrapper.findAll('[data-testid="card-title"]').map((node) => node.text())
    expect(allTitles).toContain('Android review only')
  })
})
