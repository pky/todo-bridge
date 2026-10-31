// モバイルの確認優先欄を、集約ドキュメントの要対応項目のうち利用者が未処理のものから作ることの検証。
// 3件上限は無く、対応済みボタンで消え、折りたたみの一覧から戻せる。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import NewsView from '@/views/NewsView.vue'
import type { MobileActionItem, MobileActionItemState, NewsArticle } from '@/types'

const loadTodayFeedMock = vi.hoisted(() => vi.fn())
const loadPreferencesMock = vi.hoisted(() => vi.fn())
const dismissArticleMock = vi.hoisted(() => vi.fn())
const trackClickMock = vi.hoisted(() => vi.fn())
const bookmarkArticleMock = vi.hoisted(() => vi.fn())
const loadMobileActionItemsMock = vi.hoisted(() => vi.fn())
const resolveMobileActionItemMock = vi.hoisted(() => vi.fn())
const restoreMobileActionItemMock = vi.hoisted(() => vi.fn())
const routeState = vi.hoisted(() => ({ name: 'news-mobile' as string }))
const pushMock = vi.hoisted(() => vi.fn())
const authStoreState = reactive({
  user: { uid: 'user-1' } as { uid: string } | null,
  loading: false,
})

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-31T12:00:00+09:00').getTime()

function actionItem(key: string, overrides: Partial<MobileActionItem> = {}): MobileActionItem {
  return {
    key,
    url: `https://example.com/${key}`,
    titleJa: `要対応タイトル ${key}`,
    title: `Action item ${key}`,
    platform: 'ios',
    sourceName: 'Example Security',
    isOfficial: true,
    importantLevel: 'urgent',
    actionRequired: true,
    actionType: 'security',
    publishedAt: NOW - 3 * DAY_MS,
    firstSeenDate: '2026-10-28',
    ...overrides,
  } as MobileActionItem
}

function feedArticle(id: string, overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id,
    title: `Feed title ${id}`,
    titleJa: `フィード ${id}`,
    summaryJa: '要約',
    url: `https://example.com/feed/${id}`,
    thumbnailUrl: null,
    topic: 'mobile',
    platform: 'ios',
    source: 'rss',
    sourceName: 'Example',
    isOfficial: true,
    importantLevel: 'reference',
    score: null,
    publishedAt: {} as NewsArticle['publishedAt'],
    fetchedAt: {} as NewsArticle['fetchedAt'],
    date: '2026-10-31',
    ...overrides,
  }
}

const storeState = reactive({
  articles: [] as NewsArticle[],
  loading: false,
  error: null as string | null,
  latestFeedDateByTopic: { ai: '2026-10-31', mobile: '2026-10-31' } as Record<'ai' | 'mobile', string | null>,
  feedDiagnosticsByTopic: {
    ai: { state: 'showing', message: 'ニュースを表示しています' },
    mobile: { state: 'showing', message: 'ニュースを表示しています' },
  } as Record<'ai' | 'mobile', { state: string; message: string }>,
  preferences: {
    keywords: [] as string[],
    platforms: ['ios', 'android'] as Array<'ios' | 'android'>,
    officialOnly: false,
    includeCommunity: true,
    actionRequiredOnly: false,
  },
  mobileActionItems: {} as Record<string, MobileActionItem>,
  mobileActionItemStates: {} as Record<string, MobileActionItemState>,
  loadPreferences: loadPreferencesMock,
  loadTodayFeed: loadTodayFeedMock,
  dismissArticle: dismissArticleMock,
  trackClick: trackClickMock,
  bookmarkArticle: bookmarkArticleMock,
  loadMobileActionItems: loadMobileActionItemsMock,
  resolveMobileActionItem: resolveMobileActionItemMock,
  restoreMobileActionItem: restoreMobileActionItemMock,
})

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock, back: vi.fn() }),
  useRoute: () => routeState,
}))

vi.mock('@/stores/news', () => ({
  useNewsStore: () => storeState,
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => authStoreState,
}))

vi.mock('@/components/NewsCard.vue', () => ({
  default: {
    props: ['article'],
    template: '<div><p data-testid="card-title">{{ article.title }}</p><button data-testid="dismiss" @click="$emit(\'dismiss\', article)">dismiss</button></div>',
  },
}))

enableAutoUnmount(afterEach)

const toRecord = (items: MobileActionItem[]) => Object.fromEntries(items.map((entry) => [entry.key, entry]))
const mountView = () => mount(NewsView, { global: { stubs: { Transition: false } } })
const flush = async () => {
  await nextTick()
  await nextTick()
}
const buttonsWithText = (wrapper: ReturnType<typeof mountView>, text: string) =>
  wrapper.findAll('button').filter((node) => node.text().trim() === text)
const cardTitles = (wrapper: ReturnType<typeof mountView>) =>
  wrapper.findAll('[data-testid="card-title"]').map((node) => node.text())

describe('NewsView 要対応記事の確認優先欄', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    vi.clearAllMocks()
    routeState.name = 'news-mobile'
    authStoreState.user = { uid: 'user-1' }
    authStoreState.loading = false
    // 当日フィードが空の日の扱いは仕様に無いため、通常記事を1件置いて一覧が描画される状態にする
    storeState.articles = [feedArticle('base', { title: 'Base feed article' })]
    storeState.loading = false
    storeState.error = null
    storeState.mobileActionItems = {}
    storeState.mobileActionItemStates = {}
    loadTodayFeedMock.mockResolvedValue(undefined)
    loadPreferencesMock.mockResolvedValue(undefined)
    dismissArticleMock.mockResolvedValue(undefined)
    trackClickMock.mockResolvedValue(undefined)
    bookmarkArticleMock.mockResolvedValue(undefined)
    loadMobileActionItemsMock.mockResolvedValue(undefined)
    resolveMobileActionItemMock.mockImplementation(async (key: string, state: 'done' | 'dismissed') => {
      storeState.mobileActionItemStates = { ...storeState.mobileActionItemStates, [key]: { state, at: Date.now() } }
    })
    restoreMobileActionItemMock.mockImplementation(async (key: string) => {
      const next = { ...storeState.mobileActionItemStates }
      delete next[key]
      storeState.mobileActionItemStates = next
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('モバイルタブを開くと loadMobileActionItems を呼ぶ', async () => {
    mountView()
    await flush()

    expect(loadMobileActionItemsMock).toHaveBeenCalled()
  })

  it('未処理の要対応が4件以上でも全件表示し、当日の収集に無い15日以上前の項目も出す', async () => {
    storeState.mobileActionItems = toRecord([
      actionItem('a1'),
      actionItem('a2'),
      actionItem('a3'),
      actionItem('a4'),
      actionItem('old', { titleJa: '20日前の要対応', publishedAt: NOW - 20 * DAY_MS, firstSeenDate: '2026-10-11' }),
    ])
    const wrapper = mountView()
    await flush()

    const text = wrapper.text()
    for (const key of ['a1', 'a2', 'a3', 'a4']) {
      expect(text).toContain(`要対応タイトル ${key}`)
    }
    expect(text).toContain('20日前の要対応')
    expect(buttonsWithText(wrapper, '対応済み')).toHaveLength(5)
  })

  it('対応済みボタンで resolveMobileActionItem(key, done) を呼び、欄から消える', async () => {
    storeState.mobileActionItems = toRecord([actionItem('only', { titleJa: '一件だけの要対応' })])
    const wrapper = mountView()
    await flush()

    const buttons = buttonsWithText(wrapper, '対応済み')
    expect(buttons).toHaveLength(1)
    await buttons[0].trigger('click')
    await flush()

    expect(resolveMobileActionItemMock).toHaveBeenCalledTimes(1)
    expect(resolveMobileActionItemMock).toHaveBeenCalledWith('only', 'done')
    expect(buttonsWithText(wrapper, '対応済み')).toHaveLength(0)
  })

  it('処理済みの項目は確認優先欄に出ない（対応済みボタンは未処理の分だけ）', async () => {
    storeState.mobileActionItems = toRecord([actionItem('open'), actionItem('done'), actionItem('dismissed')])
    storeState.mobileActionItemStates = {
      done: { state: 'done', at: NOW - DAY_MS },
      dismissed: { state: 'dismissed', at: NOW - DAY_MS },
    }
    const wrapper = mountView()
    await flush()

    expect(buttonsWithText(wrapper, '対応済み')).toHaveLength(1)
    expect(wrapper.text()).toContain('要対応タイトル open')
  })

  it('requiredByDate を過ぎた未処理の項目に「期限切れ・未対応」を表示する', async () => {
    storeState.mobileActionItems = toRecord([
      actionItem('overdue', { requiredByDate: '2026-10-25' }),
      actionItem('future', { requiredByDate: '2026-11-30' }),
    ])
    const wrapper = mountView()
    await flush()

    const text = wrapper.text()
    expect(text.split('期限切れ・未対応').length - 1).toBe(1)
    expect(text).toContain('要対応タイトル overdue')
    expect(text).toContain('要対応タイトル future')
  })

  it('期限が今日以降なら「期限切れ・未対応」を表示しない', async () => {
    storeState.mobileActionItems = toRecord([actionItem('today', { requiredByDate: '2026-10-31' })])
    const wrapper = mountView()
    await flush()

    expect(wrapper.text()).toContain('要対応タイトル today')
    expect(wrapper.text()).not.toContain('期限切れ・未対応')
  })

  it('当日フィードの記事で actionItemKey が集約にあるものは通常欄に出さない', async () => {
    storeState.mobileActionItems = toRecord([actionItem('k1', { titleJa: '集約側の要対応' })])
    storeState.articles = [
      feedArticle('dup', { title: 'Duplicated feed copy', actionItemKey: 'k1', actionType: 'security' }),
      feedArticle('normal', { title: 'Normal feed article' }),
    ]
    const wrapper = mountView()
    await flush()

    const titles = cardTitles(wrapper)
    expect(titles).toContain('Normal feed article')
    expect(titles).not.toContain('Duplicated feed copy')
    expect(wrapper.text()).toContain('集約側の要対応')
  })

  it('actionItemKey が集約に無い記事は通常欄に残す', async () => {
    storeState.mobileActionItems = toRecord([actionItem('k1')])
    storeState.articles = [feedArticle('other', { title: 'Unknown key article', actionItemKey: 'not-in-aggregate' })]
    const wrapper = mountView()
    await flush()

    expect(cardTitles(wrapper)).toContain('Unknown key article')
    expect(wrapper.text()).toContain('要対応タイトル k1')
  })

  it('処理済みの件数を「対応済み n件」で出し、開いて「戻す」で restoreMobileActionItem を呼ぶ', async () => {
    storeState.mobileActionItems = toRecord([
      actionItem('open'),
      actionItem('done', { titleJa: '対応済みにした項目' }),
      actionItem('dismissed', { titleJa: '興味なしにした項目' }),
    ])
    storeState.mobileActionItemStates = {
      done: { state: 'done', at: NOW - 2 * DAY_MS },
      dismissed: { state: 'dismissed', at: NOW - DAY_MS },
    }
    const wrapper = mountView()
    await flush()

    expect(wrapper.text()).toContain('対応済み 2件')

    const toggle = wrapper.findAll('button, summary').find((node) => node.text().includes('対応済み 2件'))
    expect(toggle).toBeTruthy()
    await toggle!.trigger('click')
    await flush()

    expect(wrapper.text()).toContain('対応済みにした項目')
    expect(wrapper.text()).toContain('興味なしにした項目')
    const restoreButtons = buttonsWithText(wrapper, '戻す')
    expect(restoreButtons).toHaveLength(2)

    await restoreButtons[0].trigger('click')
    await flush()

    expect(restoreMobileActionItemMock).toHaveBeenCalledTimes(1)
    expect(['done', 'dismissed']).toContain(restoreMobileActionItemMock.mock.calls[0][0])
    expect(buttonsWithText(wrapper, '対応済み')).toHaveLength(2)
  })
})
