import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useNewsStore } from '@/stores/news'

const getDocsMock = vi.hoisted(() => vi.fn())
const getDocsFromServerMock = vi.hoisted(() => vi.fn())
const getDocMock = vi.hoisted(() => vi.fn())
const getDocFromServerMock = vi.hoisted(() => vi.fn())
const setDocMock = vi.hoisted(() => vi.fn())
const batchSetMock = vi.hoisted(() => vi.fn())
const batchCommitMock = vi.hoisted(() => vi.fn())
const incrementMock = vi.hoisted(() => vi.fn((value: number) => ({ __increment: value })))

vi.mock('@/services/firebase', () => ({
  db: {},
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db: unknown, path: string) => ({ type: 'collection', path })),
  doc: vi.fn((_db: unknown, path: string) => ({ type: 'doc', path })),
  getDocs: getDocsMock,
  getDocsFromServer: getDocsFromServerMock,
  getDoc: getDocMock,
  getDocFromServer: getDocFromServerMock,
  setDoc: setDocMock,
  writeBatch: vi.fn(() => ({
    set: batchSetMock,
    commit: batchCommitMock,
  })),
  increment: incrementMock,
  query: vi.fn((target: unknown, ...clauses: unknown[]) => ({ type: 'query', target, clauses })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ type: 'where', field, op, value })),
  orderBy: vi.fn((field: string, direction: string) => ({ type: 'orderBy', field, direction })),
  limit: vi.fn((value: number) => ({ type: 'limit', value })),
  serverTimestamp: vi.fn(() => ({ seconds: Date.now() / 1000 })),
}))

function createDocs(items: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    empty: items.length === 0,
    docs: items.map((item) => ({
      id: item.id,
      data: () => item.data,
      exists: () => true,
    })),
  }
}

const articleData = {
  title: 'OpenAI releases update',
  titleJa: 'OpenAIが更新を公開',
  summaryJa: '要約',
  url: 'https://example.com/article-1',
  thumbnailUrl: null,
  source: 'rss',
  sourceName: 'Example',
  score: null,
  publishedAt: {} as any,
  fetchedAt: {} as any,
  date: '2026-03-14',
  displayScore: 10,
}

describe('News Store', () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()

    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'user-1', email: 'test@example.com', displayName: 'Test', photoURL: null },
      loading: false,
    })

    getDocMock.mockResolvedValue({
      exists: () => false,
      data: () => ({}),
    })
    getDocFromServerMock.mockResolvedValue({
      exists: () => false,
      data: () => ({}),
    })
    setDocMock.mockResolvedValue(undefined)
    batchCommitMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('同じURLが過去に2回表示済みなら今回のフィードでは除外する', async () => {
    getDocsFromServerMock.mockImplementation(async (target: any) => {
      const path = target.type === 'query' ? target.target.path : target.path
      const clauses = target.type === 'query' ? target.clauses : []

      if (path === 'users/user-1/newsInteractions') {
        return createDocs([
          {
            id: 'old-article',
            data: {
              articleId: 'old-article',
              url: articleData.url,
              shownCount: 2,
              lastShownDate: '2026-03-13',
            },
          },
        ])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'limit')) {
        return createDocs([{ id: 'article-1', data: { date: '2026-03-14', displayScore: 10 } }])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'where')) {
        return createDocs([{ id: 'article-1', data: articleData }])
      }

      return createDocs([])
    })

    const store = useNewsStore()
    await store.loadTodayFeed()

    expect(store.articles).toEqual([])
    expect(batchSetMock).not.toHaveBeenCalled()
    expect(batchCommitMock).not.toHaveBeenCalled()
  })

  it('同じ記事は同じ日には表示回数を二重加算しない', async () => {
    getDocsFromServerMock.mockImplementation(async (target: any) => {
      const path = target.type === 'query' ? target.target.path : target.path
      const clauses = target.type === 'query' ? target.clauses : []

      if (path === 'users/user-1/newsInteractions') {
        return createDocs([
          {
            id: 'article-1',
            data: {
              articleId: 'article-1',
              url: articleData.url,
              shownCount: 1,
              lastShownDate: '2026-03-14',
            },
          },
        ])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'limit')) {
        return createDocs([{ id: 'article-1', data: { date: '2026-03-14', displayScore: 10 } }])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'where')) {
        return createDocs([{ id: 'article-1', data: articleData }])
      }

      return createDocs([])
    })

    const store = useNewsStore()
    await store.loadTodayFeed()

    expect(store.articles).toHaveLength(1)
    expect(store.articles[0]?.id).toBe('article-1')
    expect(batchSetMock).not.toHaveBeenCalled()
    expect(batchCommitMock).not.toHaveBeenCalled()
  })

  it('mobile の通知件数は urgent と review を分けて数える', async () => {
    getDocsFromServerMock.mockImplementation(async (target: any) => {
      const path = target.type === 'query' ? target.target.path : target.path
      const clauses = target.type === 'query' ? target.clauses : []

      if (path === 'users/user-1/newsInteractions') {
        return createDocs([
          {
            id: 'mobile-dismissed',
            data: {
              topic: 'mobile',
              articleId: 'mobile-dismissed',
              url: 'https://example.com/mobile-dismissed',
              dismissed: true,
            },
          },
        ])
      }

      if (path === 'users/user-1/newsFeed/mobile/articles' && clauses.some((clause: any) => clause.type === 'limit')) {
        return createDocs([{ id: 'mobile-1', data: { date: '2026-03-14', displayScore: 20 } }])
      }

      if (path === 'users/user-1/newsFeed/mobile/articles' && clauses.some((clause: any) => clause.type === 'where')) {
        return createDocs([
          {
            id: 'mobile-1',
            data: {
              ...articleData,
              topic: 'mobile',
              url: 'https://example.com/mobile-1',
              sourceName: 'Apple Developer News',
              source: 'official',
              isOfficial: true,
              actionRequired: true,
              importantLevel: 'urgent',
            },
          },
          {
            id: 'mobile-2',
            data: {
              ...articleData,
              topic: 'mobile',
              url: 'https://example.com/mobile-2',
              sourceName: 'Taisyo',
              source: 'rss',
              isOfficial: false,
              actionRequired: true,
              importantLevel: 'urgent',
            },
          },
          {
            id: 'mobile-review',
            data: {
              ...articleData,
              topic: 'mobile',
              url: 'https://example.com/mobile-review',
              sourceName: 'Google Developers Japan',
              source: 'official',
              isOfficial: true,
              actionRequired: false,
              importantLevel: 'review',
            },
          },
          {
            id: 'mobile-dismissed',
            data: {
              ...articleData,
              topic: 'mobile',
              url: 'https://example.com/mobile-dismissed',
              sourceName: 'Google Developers Japan',
              source: 'official',
              isOfficial: true,
              actionRequired: true,
              importantLevel: 'urgent',
            },
          },
        ])
      }

      return createDocs([])
    })

    const store = useNewsStore()
    await store.loadMobileAlertCount()

    expect(store.mobileAlertCount).toBe(1)
    expect(store.mobileAlertSummary).toEqual({ urgent: 1, review: 1 })
  })

  it('mobile の urgent 記事はクリック済みでも重要事項として残す', async () => {
    getDocsFromServerMock.mockImplementation(async (target: any) => {
      const path = target.type === 'query' ? target.target.path : target.path
      const clauses = target.type === 'query' ? target.clauses : []

      if (path === 'users/user-1/newsInteractions') {
        return createDocs([
          {
            id: 'mobile-urgent',
            data: {
              topic: 'mobile',
              articleId: 'mobile-urgent',
              url: 'https://example.com/mobile-urgent',
              clickedAt: { seconds: Date.now() / 1000 },
            },
          },
        ])
      }

      if (path === 'users/user-1/newsFeed/mobile/articles' && clauses.some((clause: any) => clause.type === 'limit')) {
        return createDocs([{ id: 'mobile-urgent', data: { date: '2026-03-14', displayScore: 20 } }])
      }

      if (path === 'users/user-1/newsFeed/mobile/articles' && clauses.some((clause: any) => clause.type === 'where')) {
        return createDocs([
          {
            id: 'mobile-urgent',
            data: {
              ...articleData,
              topic: 'mobile',
              url: 'https://example.com/mobile-urgent',
              sourceName: 'Apple Developer News',
              source: 'official',
              isOfficial: true,
              actionRequired: true,
              importantLevel: 'urgent',
            },
          },
        ])
      }

      return createDocs([])
    })

    const store = useNewsStore()
    await store.loadTodayFeed('mobile')
    await store.loadMobileAlertCount()

    expect(store.articles).toHaveLength(1)
    expect(store.articles[0]?.id).toBe('mobile-urgent')
    expect(store.mobileAlertCount).toBe(1)
    expect(store.mobileAlertSummary).toEqual({ urgent: 1, review: 0 })
  })

  it('AI フィードのサーバー取得失敗時はキャッシュ取得へフォールバックする', async () => {
    getDocsFromServerMock.mockRejectedValue(new Error('offline'))
    getDocsMock.mockImplementation(async (target: any) => {
      const path = target.type === 'query' ? target.target.path : target.path
      const clauses = target.type === 'query' ? target.clauses : []

      if (path === 'users/user-1/newsInteractions') {
        return createDocs([])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'limit')) {
        return createDocs([{ id: 'article-1', data: { date: '2026-03-14', displayScore: 10 } }])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'where')) {
        return createDocs([{ id: 'article-1', data: articleData }])
      }

      return createDocs([])
    })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(getDocsFromServerMock).toHaveBeenCalled()
    expect(getDocsMock).toHaveBeenCalled()
    expect(store.articles).toHaveLength(1)
    expect(store.articles[0]?.id).toBe('article-1')
  })

  it('前日分しかなくてもキャッシュ済みフィードと更新日を先に表示する', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-15T09:00:00+09:00'))

    localStorage.setItem(
      'rertm-news-cache-user-1-ai',
      JSON.stringify({
        date: '2026-03-14',
        articles: [{ id: 'article-1', ...articleData }],
      })
    )

    let resolveServerFetch: (() => void) | null = null
    getDocsFromServerMock.mockImplementation(async (target: any) => {
      const path = target.type === 'query' ? target.target.path : target.path
      const clauses = target.type === 'query' ? target.clauses : []

      if (path === 'users/user-1/newsInteractions') {
        return createDocs([])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'limit')) {
        await new Promise<void>((resolve) => {
          resolveServerFetch = resolve
        })
        return createDocs([{ id: 'article-1', data: { date: '2026-03-14', displayScore: 10 } }])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'where')) {
        return createDocs([{ id: 'article-1', data: articleData }])
      }

      return createDocs([])
    })

    const store = useNewsStore()
    const loadPromise = store.loadTodayFeed('ai')

    expect(store.articles).toHaveLength(1)
    expect(store.articles[0]?.id).toBe('article-1')
    expect(store.latestFeedDateByTopic.ai).toBe('2026-03-14')

    resolveServerFetch?.()
    await loadPromise

    expect(store.articles).toHaveLength(1)
    expect(store.latestFeedDateByTopic.ai).toBe('2026-03-14')
  })

  it('今日分の記事キャッシュがあればサーバー取得をスキップする', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-14T10:00:00+09:00'))

    localStorage.setItem(
      'rertm-news-cache-user-1-ai',
      JSON.stringify({
        date: '2026-03-14',
        articles: [{ id: 'article-1', ...articleData }],
      })
    )

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(getDocsFromServerMock).not.toHaveBeenCalled()
    expect(getDocsMock).not.toHaveBeenCalled()
    expect(store.loading).toBe(false)
    expect(store.articles).toHaveLength(1)
    expect(store.articles[0]?.id).toBe('article-1')
    expect(store.latestFeedDateByTopic.ai).toBe('2026-03-14')
    expect(store.feedDiagnosticsByTopic.ai).toEqual({
      state: 'showing',
      message: 'ニュースを表示しています',
    })
  })

  it('空キャッシュしかなくてもサーバー取得を開始する', async () => {
    localStorage.setItem(
      'rertm-news-cache-user-1-ai',
      JSON.stringify({
        date: '2026-03-14',
        articles: [],
      })
    )

    getDocsFromServerMock.mockImplementation(async (target: any) => {
      const path = target.type === 'query' ? target.target.path : target.path
      const clauses = target.type === 'query' ? target.clauses : []

      if (path === 'users/user-1/newsInteractions') {
        return createDocs([])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'limit')) {
        return createDocs([{ id: 'article-1', data: { date: '2026-03-14', displayScore: 10 } }])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'where')) {
        return createDocs([{ id: 'article-1', data: articleData }])
      }

      return createDocs([])
    })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(getDocsFromServerMock).toHaveBeenCalled()
    expect(store.articles).toHaveLength(1)
    expect(store.feedDiagnosticsByTopic.ai.state).toBe('showing')
  })

  it('個別フィードが未生成なら共有記事をフォールバック表示する', async () => {
    getDocsFromServerMock.mockImplementation(async (target: any) => {
      const path = target.type === 'query' ? target.target.path : target.path
      const clauses = target.type === 'query' ? target.clauses : []

      if (path === 'users/user-1/newsInteractions') {
        return createDocs([])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'limit')) {
        return createDocs([])
      }

      if (path === 'topics/ai/articles' && clauses.some((clause: any) => clause.type === 'limit')) {
        return createDocs([{ id: 'shared-article-1', data: { date: '2026-03-14', score: 20 } }])
      }

      if (path === 'topics/ai/articles' && clauses.some((clause: any) => clause.type === 'where')) {
        return createDocs([{ id: 'shared-article-1', data: articleData }])
      }

      return createDocs([])
    })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(store.articles).toHaveLength(1)
    expect(store.articles[0]?.id).toBe('shared-article-1')
    expect(store.latestFeedDateByTopic.ai).toBe('2026-03-14')
    expect(store.feedDiagnosticsByTopic.ai.message).toBe('個別フィード生成前のため、共有記事を表示しています')
  })

  it('個別フィード取得が遅くても共有記事を先に表示する', async () => {
    let resolveInteractions: (() => void) | null = null
    let resolvePersonalizedFeed: (() => void) | null = null

    getDocsFromServerMock.mockImplementation(async (target: any) => {
      const path = target.type === 'query' ? target.target.path : target.path
      const clauses = target.type === 'query' ? target.clauses : []

      if (path === 'users/user-1/newsInteractions') {
        await new Promise<void>((resolve) => {
          resolveInteractions = resolve
        })
        return createDocs([])
      }

      if (path === 'users/user-1/newsFeed/ai/articles' && clauses.some((clause: any) => clause.type === 'limit')) {
        await new Promise<void>((resolve) => {
          resolvePersonalizedFeed = resolve
        })
        return createDocs([])
      }

      if (path === 'topics/ai/articles' && clauses.some((clause: any) => clause.type === 'limit')) {
        return createDocs([{ id: 'shared-article-1', data: { date: '2026-03-14', score: 20 } }])
      }

      if (path === 'topics/ai/articles' && clauses.some((clause: any) => clause.type === 'where')) {
        return createDocs([{ id: 'shared-article-1', data: articleData }])
      }

      return createDocs([])
    })

    const store = useNewsStore()
    const loadPromise = store.loadTodayFeed('ai')

    await vi.waitFor(() => {
      expect(store.articles).toHaveLength(1)
    })
    expect(store.articles[0]?.id).toBe('shared-article-1')
    expect(store.feedDiagnosticsByTopic.ai.message).toBe('個別フィード生成前のため、共有記事を表示しています')

    resolveInteractions?.()
    resolvePersonalizedFeed?.()
    await loadPromise

    expect(store.articles).toHaveLength(1)
    expect(store.articles[0]?.id).toBe('shared-article-1')
  })
})
