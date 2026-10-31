// 後で読む・興味なしの記録に、好みの学習に使うタイトル・要約・タグと readLaterAt を残すことの検証。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useNewsStore } from '@/stores/news'
import type { NewsArticle } from '@/types/news'

const SERVER_TS = vi.hoisted(() => ({ __serverTimestamp: true }))
const setDocMock = vi.hoisted(() => vi.fn())
const getDocsMock = vi.hoisted(() => vi.fn())
const createTaskMock = vi.hoisted(() => vi.fn())
const createListMock = vi.hoisted(() => vi.fn())
const listsState = vi.hoisted(() => ({ lists: [] as Array<{ id: string; name: string; spaceId: string }> }))

vi.mock('@/services/firebase', () => ({
  db: {},
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db: unknown, path: string) => ({ type: 'collection', path })),
  doc: vi.fn((base: { path?: string }, ...segments: string[]) => ({
    type: 'doc',
    path: typeof base?.path === 'string' ? `${base.path}/${segments.join('/')}` : segments.join('/'),
  })),
  documentId: vi.fn(() => '__name__'),
  getDocs: getDocsMock,
  getDocsFromServer: vi.fn(),
  getDoc: vi.fn(),
  getDocFromServer: vi.fn(),
  setDoc: setDocMock,
  writeBatch: vi.fn(() => ({ set: vi.fn(), commit: vi.fn() })),
  increment: vi.fn((value: number) => ({ __increment: value })),
  query: vi.fn((target: unknown, ...clauses: unknown[]) => ({ type: 'query', target, clauses })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ type: 'where', field, op, value })),
  orderBy: vi.fn((field: string, direction: string) => ({ type: 'orderBy', field, direction })),
  limit: vi.fn((value: number) => ({ type: 'limit', value })),
  serverTimestamp: vi.fn(() => SERVER_TS),
}))

vi.mock('@/stores/lists', () => ({
  useListsStore: () => ({
    get lists() { return listsState.lists },
    createList: createListMock,
  }),
}))

vi.mock('@/stores/tasks', () => ({
  useTasksStore: () => ({ createTask: createTaskMock }),
}))

vi.mock('@/stores/space', () => ({
  buildPersonalSpaceId: (uid: string) => `personal_${uid}`,
  useSpaceStore: () => ({
    getCollectionRefForSpace: vi.fn((name: string, spaceId: string) => ({ type: 'collection', path: `spaces/${spaceId}/${name}` })),
  }),
}))

const UID = 'user-1'
const INTERACTIONS = `users/${UID}/newsInteractions`

function makeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: 'article-1',
    title: 'Fictional Claude agents release',
    titleJa: '架空のリリース',
    summaryJa: '架空の日本語要約です',
    tags: ['claude', 'agents'],
    url: 'https://example.com/article-1',
    thumbnailUrl: null,
    topic: 'ai',
    source: 'rss',
    sourceName: 'Example',
    score: null,
    publishedAt: {} as NewsArticle['publishedAt'],
    fetchedAt: {} as NewsArticle['fetchedAt'],
    date: '2026-10-31',
    ...overrides,
  }
}

type SetDocCall = { path: string; data: Record<string, unknown>; options: unknown }

function setDocCallsAt(path: string): SetDocCall[] {
  return setDocMock.mock.calls
    .filter((call) => (call[0] as { path: string }).path === path)
    .map((call) => ({
      path,
      data: call[1] as Record<string, unknown>,
      options: call[2],
    }))
}

// merge で書かれた内容を順に重ねた最終形
function mergedAt(path: string): Record<string, unknown> {
  return Object.assign({}, ...setDocCallsAt(path).map((call) => call.data))
}

function expectNoUndefinedValues(calls: SetDocCall[]) {
  for (const call of calls) {
    for (const [key, value] of Object.entries(call.data)) {
      expect(value, `${key} が undefined で書かれている`).not.toBeUndefined()
    }
  }
}

describe('後で読む・興味なしの記録に学習用のデータを残す', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
    useAuthStore().$patch({
      user: { uid: UID, email: 'test@example.com', displayName: 'Test', photoURL: null },
      loading: false,
    })
    listsState.lists = [{ id: 'list-readlater', name: 'あとで読む', spaceId: `personal_${UID}` }]
    setDocMock.mockResolvedValue(undefined)
    createTaskMock.mockResolvedValue(undefined)
    createListMock.mockResolvedValue(undefined)
    getDocsMock.mockResolvedValue({ empty: true, docs: [] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('bookmarkArticle（後で読む）', () => {
    it('newsInteractions に readLaterAt、titleEn(=title)、summaryJa、tags を書き、dismissed も残す', async () => {
      const article = makeArticle()
      const store = useNewsStore()
      // articles に無い状態で呼び、bookmark の書き込み自体にメタが入ることを確かめる
      store.articles = []
      await store.bookmarkArticle(article)

      expect(createTaskMock).toHaveBeenCalledTimes(1)
      const path = `${INTERACTIONS}/ai_${article.id}`
      const calls = setDocCallsAt(path)
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.options).toEqual({ merge: true })
      }
      expect(mergedAt(path)).toEqual(expect.objectContaining({
        topic: 'ai',
        articleId: article.id,
        url: article.url,
        dismissed: true,
        dismissedAt: SERVER_TS,
        readLaterAt: SERVER_TS,
        titleEn: article.title,
        summaryJa: article.summaryJa,
        tags: article.tags,
      }))
      expectNoUndefinedValues(calls)
    })

    it('summaryJa と tags が無い記事では、それらのキーを書かず undefined も書かない', async () => {
      const article = makeArticle({ summaryJa: undefined, tags: undefined })
      const store = useNewsStore()
      store.articles = []
      await store.bookmarkArticle(article)

      const path = `${INTERACTIONS}/ai_${article.id}`
      const calls = setDocCallsAt(path)
      const merged = mergedAt(path)
      expect(merged.readLaterAt).toBe(SERVER_TS)
      expect(merged.titleEn).toBe(article.title)
      expect(merged.dismissed).toBe(true)
      expect(merged).not.toHaveProperty('summaryJa')
      expect(merged).not.toHaveProperty('tags')
      expectNoUndefinedValues(calls)
    })
  })

  describe('dismissArticle（興味なし）', () => {
    it('articles に同じ id の記事があれば titleEn、summaryJa、tags も書く', async () => {
      const article = makeArticle()
      const store = useNewsStore()
      store.articles = [article]
      await store.dismissArticle(article.id, article.url, 'ai')

      const path = `${INTERACTIONS}/ai_${article.id}`
      const calls = setDocCallsAt(path)
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.options).toEqual({ merge: true })
      }
      expect(mergedAt(path)).toEqual(expect.objectContaining({
        topic: 'ai',
        articleId: article.id,
        url: article.url,
        dismissed: true,
        dismissedAt: SERVER_TS,
        titleEn: article.title,
        summaryJa: article.summaryJa,
        tags: article.tags,
      }))
      expectNoUndefinedValues(calls)
    })

    it('記事に summaryJa と tags が無ければ titleEn だけ足し、undefined を書かない', async () => {
      const article = makeArticle({ summaryJa: undefined, tags: undefined })
      const store = useNewsStore()
      store.articles = [article]
      await store.dismissArticle(article.id, article.url, 'ai')

      const path = `${INTERACTIONS}/ai_${article.id}`
      const calls = setDocCallsAt(path)
      const merged = mergedAt(path)
      expect(merged.titleEn).toBe(article.title)
      expect(merged).not.toHaveProperty('summaryJa')
      expect(merged).not.toHaveProperty('tags')
      expectNoUndefinedValues(calls)
    })

    it('articles に同じ id の記事が無ければ titleEn、summaryJa、tags は書かない', async () => {
      const store = useNewsStore()
      store.articles = [makeArticle({ id: 'other-article', url: 'https://example.com/other-article' })]
      await store.dismissArticle('article-1', 'https://example.com/article-1', 'ai')

      const path = `${INTERACTIONS}/ai_article-1`
      const calls = setDocCallsAt(path)
      const merged = mergedAt(path)
      expect(merged).toEqual(expect.objectContaining({ topic: 'ai', articleId: 'article-1', dismissed: true, dismissedAt: SERVER_TS }))
      for (const key of ['titleEn', 'summaryJa', 'tags', 'readLaterAt']) {
        expect(merged).not.toHaveProperty(key)
      }
      expectNoUndefinedValues(calls)
    })
  })
})
