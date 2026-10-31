// 集約の要対応記事にも利用者設定と画面の絞り込みを適用し、当日記事の重複を防ぐ。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { Timestamp } from 'firebase/firestore'
import NewsView from '@/views/NewsView.vue'
import type { MobileActionItem, MobileActionItemState, NewsArticle } from '@/types'

const NOW = new Date('2026-10-31T12:00:00+09:00').getTime()

function actionItem(key: string, overrides: Partial<MobileActionItem> = {}): MobileActionItem {
  return {
    key,
    url: `https://example.com/${key}`,
    title: `Action item ${key}`,
    titleJa: `要対応 ${key}`,
    platform: 'ios',
    sourceName: 'Example Security',
    isOfficial: true,
    importantLevel: 'urgent',
    actionRequired: true,
    actionType: 'security',
    publishedAt: NOW,
    firstSeenDate: '2026-10-31',
    ...overrides,
  }
}

function feedArticle(id: string, overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id,
    title: `通常記事 ${id}`,
    url: `https://example.com/feed/${id}`,
    thumbnailUrl: null,
    topic: 'mobile',
    platform: 'ios',
    source: 'rss',
    sourceName: 'Example',
    isOfficial: true,
    importantLevel: 'reference',
    score: null,
    publishedAt: Timestamp.fromMillis(NOW),
    fetchedAt: Timestamp.fromMillis(NOW),
    date: '2026-10-31',
    ...overrides,
  }
}

const storeState = reactive({
  articles: [] as NewsArticle[],
  loading: false,
  error: null as string | null,
  latestFeedDateByTopic: { ai: '2026-10-31', mobile: '2026-10-31' },
  feedDiagnosticsByTopic: {
    ai: { state: 'showing', message: 'ニュースを表示しています' },
    mobile: { state: 'showing', message: 'ニュースを表示しています' },
  },
  preferences: {
    keywords: [] as string[],
    platforms: ['ios', 'android'] as Array<'ios' | 'android'>,
    officialOnly: false,
    includeCommunity: true,
    actionRequiredOnly: false,
  },
  mobileActionItems: {} as Record<string, MobileActionItem>,
  mobileActionItemStates: {} as Record<string, MobileActionItemState>,
  loadPreferences: vi.fn(),
  loadTodayFeed: vi.fn(),
  loadMobileActionItems: vi.fn(),
  dismissArticle: vi.fn(),
  trackClick: vi.fn(),
  bookmarkArticle: vi.fn(),
  resolveMobileActionItem: vi.fn(),
  restoreMobileActionItem: vi.fn(),
})

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useRoute: () => ({ name: 'news-mobile' }),
}))

vi.mock('@/stores/news', () => ({
  useNewsStore: () => storeState,
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { uid: 'user-1' }, loading: false }),
}))

vi.mock('@/components/NewsCard.vue', () => ({
  default: {
    props: ['article'],
    template: '<p data-testid="card-title">{{ article.title }}</p>',
  },
}))

enableAutoUnmount(afterEach)

const mountView = () => mount(NewsView, { global: { stubs: { Transition: false } } })
const flush = async () => {
  await nextTick()
  await nextTick()
}
const buttonsWithText = (wrapper: ReturnType<typeof mountView>, text: string) =>
  wrapper.findAll('button').filter((node) => node.text().trim() === text)
const importantTitles = (wrapper: ReturnType<typeof mountView>) =>
  wrapper.findAll('[data-testid="important-title"]').map((node) => node.text())
const resolvedTitles = (wrapper: ReturnType<typeof mountView>) =>
  wrapper.findAll('article')
    .filter((node) => node.findAll('button').some((button) => button.text().trim() === '戻す'))
    .map((node) => node.find('a').text())
const cardTitles = (wrapper: ReturnType<typeof mountView>) =>
  wrapper.findAll('[data-testid="card-title"]').map((node) => node.text())
const toRecord = (items: MobileActionItem[]) => Object.fromEntries(items.map((item) => [item.key, item]))

async function openResolvedItems(wrapper: ReturnType<typeof mountView>) {
  const toggle = wrapper.find('button[aria-expanded]')
  expect(toggle.exists()).toBe(true)
  await toggle.trigger('click')
  await flush()
}

describe('NewsView 要対応記事の絞り込みと重複除外', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    vi.clearAllMocks()
    storeState.articles = [feedArticle('base')]
    storeState.loading = false
    storeState.error = null
    storeState.preferences.platforms = ['ios', 'android']
    storeState.preferences.officialOnly = false
    storeState.preferences.includeCommunity = true
    storeState.preferences.actionRequiredOnly = false
    storeState.mobileActionItems = {}
    storeState.mobileActionItemStates = {}
    storeState.loadPreferences.mockResolvedValue(undefined)
    storeState.loadTodayFeed.mockResolvedValue(undefined)
    storeState.loadMobileActionItems.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('確認優先欄に platforms 設定を適用し、選択外の Android 項目を出さない', async () => {
    storeState.preferences.platforms = ['ios']
    storeState.mobileActionItems = toRecord([
      actionItem('ios'),
      actionItem('android', { platform: 'android' }),
    ])
    const wrapper = mountView()
    await flush()

    expect(importantTitles(wrapper)).toEqual(['要対応 ios'])
  })

  it('対応済み一覧と件数に platforms 設定を適用し、選択外の Android 項目を出さない', async () => {
    storeState.preferences.platforms = ['ios']
    storeState.mobileActionItems = toRecord([
      actionItem('ios'),
      actionItem('android', { platform: 'android' }),
    ])
    storeState.mobileActionItemStates = {
      ios: { state: 'done', at: NOW },
      android: { state: 'dismissed', at: NOW - 1 },
    }
    const wrapper = mountView()
    await flush()
    await openResolvedItems(wrapper)

    expect(resolvedTitles(wrapper)).toEqual(['要対応 ios'])
    expect(buttonsWithText(wrapper, '対応済み 1件')).toHaveLength(1)
  })

  it.each([
    { platform: 'ios', label: 'iOS' },
    { platform: 'android', label: 'Android' },
  ] as const)('画面の $label 切り替えを確認優先欄と対応済み一覧の両方に適用する', async ({ platform, label }) => {
    storeState.mobileActionItems = toRecord([
      actionItem('ios-open'),
      actionItem('android-open', { platform: 'android' }),
      actionItem('ios-done'),
      actionItem('android-done', { platform: 'android' }),
    ])
    storeState.mobileActionItemStates = {
      'ios-done': { state: 'done', at: NOW },
      'android-done': { state: 'dismissed', at: NOW - 1 },
    }
    const wrapper = mountView()
    await flush()
    await openResolvedItems(wrapper)
    expect(importantTitles(wrapper)).toHaveLength(2)
    expect(resolvedTitles(wrapper)).toHaveLength(2)

    await buttonsWithText(wrapper, label)[0]!.trigger('click')
    await flush()

    expect(importantTitles(wrapper)).toEqual([`要対応 ${platform}-open`])
    expect(resolvedTitles(wrapper)).toEqual([`要対応 ${platform}-done`])
    expect(buttonsWithText(wrapper, '対応済み 1件')).toHaveLength(1)
  })

  it.each(['未処理', '対応済み'] as const)('actionItemKey が無い当日記事も %s の集約項目と URL が完全一致すれば通常欄に出さない', async (state) => {
    const item = actionItem('duplicate')
    storeState.mobileActionItems = { [item.key]: item }
    if (state === '対応済み') {
      storeState.mobileActionItemStates = { [item.key]: { state: 'done', at: NOW } }
    }
    storeState.articles = [
      feedArticle('duplicate', { url: item.url, title: '集約と同じ URL の当日記事' }),
      feedArticle('different-query', { url: `${item.url}?variant=1`, title: 'URL が完全一致しない記事' }),
      feedArticle('normal'),
    ]
    const wrapper = mountView()
    await flush()

    expect(cardTitles(wrapper)).toContain('URL が完全一致しない記事')
    expect(cardTitles(wrapper)).toContain('通常記事 normal')
    expect(cardTitles(wrapper)).not.toContain('集約と同じ URL の当日記事')
  })
})
