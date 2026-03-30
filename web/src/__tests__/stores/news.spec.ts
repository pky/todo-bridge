import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useNewsStore } from '@/stores/news'

const getDocsMock = vi.hoisted(() => vi.fn())
const getDocMock = vi.hoisted(() => vi.fn())
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
  getDoc: getDocMock,
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
    setActivePinia(createPinia())
    vi.clearAllMocks()

    const authStore = useAuthStore()
    authStore.$patch({
      user: { uid: 'user-1', email: 'test@example.com', displayName: 'Test', photoURL: null },
      loading: false,
    })

    getDocMock.mockResolvedValue({
      exists: () => false,
      data: () => ({}),
    })
    setDocMock.mockResolvedValue(undefined)
    batchCommitMock.mockResolvedValue(undefined)
  })

  it('同じURLが過去に2回表示済みなら今回のフィードでは除外する', async () => {
    getDocsMock.mockImplementation(async (target: any) => {
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
    getDocsMock.mockImplementation(async (target: any) => {
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
    getDocsMock.mockImplementation(async (target: any) => {
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
    getDocsMock.mockImplementation(async (target: any) => {
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
})
