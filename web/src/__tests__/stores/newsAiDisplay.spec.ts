import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useNewsStore } from '@/stores/news'

const getDocsMock = vi.hoisted(() => vi.fn())
const getDocsFromServerMock = vi.hoisted(() => vi.fn())
const getDocMock = vi.hoisted(() => vi.fn())
const setDocMock = vi.hoisted(() => vi.fn())
const batchSetMock = vi.hoisted(() => vi.fn())
const batchCommitMock = vi.hoisted(() => vi.fn())

vi.mock('@/services/firebase', () => ({
  db: {},
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db: unknown, path: string) => ({ type: 'collection', path })),
  doc: vi.fn((_db: unknown, path: string) => ({ type: 'doc', path })),
  getDocs: getDocsMock,
  getDocsFromServer: getDocsFromServerMock,
  getDoc: getDocMock,
  setDoc: setDocMock,
  writeBatch: vi.fn(() => ({
    set: batchSetMock,
    commit: batchCommitMock,
  })),
  increment: vi.fn((value: number) => ({ __increment: value })),
  query: vi.fn((target: unknown, ...clauses: unknown[]) => ({ type: 'query', target, clauses })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ type: 'where', field, op, value })),
  orderBy: vi.fn((field: string, direction: string) => ({ type: 'orderBy', field, direction })),
  limit: vi.fn((value: number) => ({ type: 'limit', value })),
  serverTimestamp: vi.fn(() => ({ seconds: Date.now() / 1000 })),
}))

interface DocFixture { id: string; data: Record<string, unknown> }
interface QueryTarget {
  type: string
  target?: { path: string }
  path?: string
  clauses?: Array<{ type: string }>
}

function createDocs(items: DocFixture[]) {
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
  title: 'Fictional development article',
  titleJa: '架空の開発記事',
  summaryJa: '架空の概要です',
  url: 'https://example.com/article',
  thumbnailUrl: null,
  source: 'rss',
  sourceName: '架空の技術フィード',
  score: null,
  publishedAt: {} as unknown,
  fetchedAt: {} as unknown,
  date: '2026-03-14',
}

// 個別フィード由来の記事（displayScore あり）。
function personal(id: string, overrides: Record<string, unknown> = {}): DocFixture {
  return { id, data: { ...articleData, url: `https://example.com/${id}`, displayScore: 50, ...overrides } }
}
// 共有記事（displayScore なし）。feedEligible と sharedScore は必要なときだけ付ける。
function shared(id: string, overrides: Record<string, unknown> = {}): DocFixture {
  return { id, data: { ...articleData, url: `https://example.com/${id}`, ...overrides } }
}
const eligible = (id: string, sharedScore: number, overrides: Record<string, unknown> = {}) =>
  shared(id, { feedEligible: true, sharedScore, ...overrides })

function installServer(options: {
  topic?: 'ai' | 'mobile'
  personal?: DocFixture[]
  personalDate?: string
  shared?: DocFixture[]
  sharedDate?: string
  interactions?: DocFixture[]
}) {
  const topic = options.topic ?? 'ai'
  const personalDocs = options.personal ?? []
  const sharedDocs = options.shared ?? []
  getDocsFromServerMock.mockImplementation(async (target: QueryTarget) => {
    const path = target.type === 'query' ? target.target?.path : target.path
    const clauses = target.type === 'query' ? target.clauses ?? [] : []
    const hasLimit = clauses.some((clause) => clause.type === 'limit')
    if (path === 'users/user-1/newsInteractions') return createDocs(options.interactions ?? [])
    if (path === `users/user-1/newsFeed/${topic}/articles`) {
      if (personalDocs.length === 0) return createDocs([])
      return hasLimit
        ? createDocs([{ id: 'latest', data: { date: options.personalDate ?? '2026-03-14', displayScore: 1 } }])
        : createDocs(personalDocs)
    }
    if (path === `topics/${topic}/articles`) {
      if (sharedDocs.length === 0) return createDocs([])
      return hasLimit
        ? createDocs([{ id: 'latest', data: { date: options.sharedDate ?? '2026-03-14', score: 1 } }])
        : createDocs(sharedDocs)
    }
    return createDocs([])
  })
}

function seedCache(articles: DocFixture[], date = '2026-03-14', isSharedFallback?: boolean) {
  localStorage.setItem('rertm-news-cache-user-1-ai', JSON.stringify({
    date,
    articles: articles.map((item) => ({ id: item.id, ...item.data })),
    ...(isSharedFallback === undefined ? {} : { isSharedFallback }),
  }))
}

const ids = (articles: Array<{ id: string }>) => articles.map((article) => article.id)

describe('AI ニュースの表示条件', () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
    useAuthStore().$patch({
      user: { uid: 'user-1', email: 'test@example.com', displayName: 'Test', photoURL: null },
      loading: false,
    })
    getDocMock.mockResolvedValue({ exists: () => false, data: () => ({}) })
    setDocMock.mockResolvedValue(undefined)
    batchCommitMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('個別フィードは summaryJa が空の記事を出さず、displayScore 順で20件までにする', async () => {
    const docs = Array.from({ length: 25 }, (_, index) => personal(`p${index}`, {
      displayScore: 100 - index,
      ...(index === 3 || index === 7 || index === 11 ? { summaryJa: '' } : {}),
    }))
    installServer({ personal: docs })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    const expected = docs.filter((item) => item.data.summaryJa !== '').slice(0, 20).map((item) => item.id)
    expect(store.articles).toHaveLength(20)
    expect(ids(store.articles)).toEqual(expected)
    expect(store.articles.every((article) => (article.summaryJa ?? '').trim() !== '')).toBe(true)
  })

  it('個別フィードを読み込んだ後に保存するキャッシュも20件までになる', async () => {
    installServer({ personal: Array.from({ length: 30 }, (_, index) => personal(`p${index}`, { displayScore: 100 - index })) })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    const cached = JSON.parse(localStorage.getItem('rertm-news-cache-user-1-ai') ?? '{}')
    expect(cached.articles).toHaveLength(20)
  })

  it('共有記事の代替表示は feedEligible の記事だけを sharedScore 降順で20件までにする', async () => {
    const docs = [
      ...Array.from({ length: 22 }, (_, index) => eligible(`e${index}`, index)),
      shared('plain-high', { sharedScore: 999 }),
      shared('flag-false', { feedEligible: false, sharedScore: 998 }),
      eligible('empty-summary', 500, { summaryJa: '' }),
      shared('legacy-1'),
    ]
    installServer({ shared: docs })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(store.articles).toHaveLength(20)
    expect(ids(store.articles)).toEqual(Array.from({ length: 20 }, (_, index) => `e${21 - index}`))
    expect(store.feedDiagnosticsByTopic.ai.message).toBe('個別フィード生成前のため、共有記事を表示しています')
  })

  it('共有記事の早期表示でも feedEligible でない記事と概要のない記事を出さない', async () => {
    let releasePersonal: (() => void) | null = null
    getDocsFromServerMock.mockImplementation(async (target: QueryTarget) => {
      const path = target.type === 'query' ? target.target?.path : target.path
      const clauses = target.type === 'query' ? target.clauses ?? [] : []
      const hasLimit = clauses.some((clause) => clause.type === 'limit')
      if (path === 'users/user-1/newsInteractions') return createDocs([])
      if (path === 'users/user-1/newsFeed/ai/articles') {
        await new Promise<void>((resolve) => { releasePersonal = resolve })
        return createDocs([])
      }
      if (path === 'topics/ai/articles') {
        return hasLimit
          ? createDocs([{ id: 'latest', data: { date: '2026-03-14', score: 1 } }])
          : createDocs([
            eligible('low', 60), shared('plain', { sharedScore: 500 }), eligible('high', 90),
            eligible('empty', 99, { summaryJa: '  ' }),
          ])
      }
      return createDocs([])
    })

    const store = useNewsStore()
    const loadPromise = store.loadTodayFeed('ai')
    await vi.waitFor(() => {
      expect(store.articles.length).toBeGreaterThan(0)
    })
    expect(ids(store.articles)).toEqual(['high', 'low'])

    releasePersonal?.()
    await loadPromise
    expect(ids(store.articles)).toEqual(['high', 'low'])
  })

  it('共有記事の最新日に表示できる記事がなければ、前日の個別フィードを空で上書きしない', async () => {
    installServer({
      personal: [personal('personal-1', { displayScore: 20 }), personal('personal-2', { displayScore: 10 })],
      personalDate: '2026-03-14',
      shared: [shared('plain-1'), shared('plain-2', { feedEligible: false, sharedScore: 80 }), eligible('blank', 70, { summaryJa: '' })],
      sharedDate: '2026-03-15',
    })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(ids(store.articles)).toEqual(['personal-1', 'personal-2'])
    expect(store.latestFeedDateByTopic.ai).toBe('2026-03-14')
    expect(JSON.parse(localStorage.getItem('rertm-news-cache-user-1-ai') ?? '{}').isSharedFallback).toBe(false)
  })

  it.each([
    ['dismissed の記事ID', (id: string) => ({ id, data: { articleId: id, url: `https://example.com/${id}`, dismissed: true } })],
    ['表示回数2回のURL', (id: string) => ({ id: `i-${id}`, data: { articleId: `i-${id}`, url: `https://example.com/${id}`, shownCount: 2 } })],
    ['クリック済みのURL', (id: string) => ({ id: `i-${id}`, data: { articleId: `i-${id}`, url: `https://example.com/${id}`, clickedAt: { seconds: 1 } } })],
  ])('共有記事が新しい日付でも、%sで除外した結果0件なら前日の個別フィードを表示し空のキャッシュを書かない', async (_label, exclude) => {
    const sharedDocs = [eligible('s1', 90), eligible('s2', 80), eligible('s3', 70)]
    installServer({
      personal: [personal('personal-1', { displayScore: 20 }), personal('personal-2', { displayScore: 10 })],
      personalDate: '2026-03-14',
      shared: sharedDocs,
      sharedDate: '2026-03-15',
      interactions: sharedDocs.map((item) => exclude(item.id)),
    })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(ids(store.articles)).toEqual(['personal-1', 'personal-2'])
    expect(store.latestFeedDateByTopic.ai).toBe('2026-03-14')
    const cached = JSON.parse(localStorage.getItem('rertm-news-cache-user-1-ai') ?? '{}')
    expect(cached.articles?.length ?? 0).toBeGreaterThan(0)
    expect(cached.date).toBe('2026-03-14')
    expect(cached.isSharedFallback).toBe(false)
  })

  it('共有記事に除外後も表示できるものが残るなら、新しい日付の共有記事を表示する', async () => {
    installServer({
      personal: [personal('personal-1')],
      personalDate: '2026-03-14',
      shared: [eligible('s1', 90), eligible('s2', 80)],
      sharedDate: '2026-03-15',
      interactions: [{ id: 's1', data: { articleId: 's1', url: 'https://example.com/s1', dismissed: true } }],
    })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(ids(store.articles)).toEqual(['s2'])
    expect(store.latestFeedDateByTopic.ai).toBe('2026-03-15')
  })

  it('共有記事の最新日に表示できる記事がなく個別フィードもなければ、配信データなしとして扱う', async () => {
    installServer({
      shared: [shared('plain-1'), shared('plain-2', { feedEligible: false })],
      sharedDate: '2026-03-15',
    })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(store.articles).toEqual([])
    expect(store.latestFeedDateByTopic.ai).toBeNull()
    expect(store.feedDiagnosticsByTopic.ai.state).toBe('no-feed')
  })

  it('今日の旧形式キャッシュ（155件）は読み出し時に概要ありの20件へ絞り、サーバー取得を省く', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-14T10:00:00+09:00'))
    const docs = Array.from({ length: 155 }, (_, index) => personal(`c${index}`, {
      displayScore: 200 - index,
      ...(index % 10 === 0 ? { summaryJa: '' } : {}),
    }))
    seedCache(docs)

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(getDocsFromServerMock).not.toHaveBeenCalled()
    expect(store.articles).toHaveLength(20)
    expect(ids(store.articles)).toEqual(docs.filter((item) => item.data.summaryJa !== '').slice(0, 20).map((item) => item.id))
  })

  it('旧形式の共有記事キャッシュは feedEligible のない記事を表示せず、sharedScore 降順で絞る', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-15T09:00:00+09:00'))
    seedCache([
      ...Array.from({ length: 150 }, (_, index) => shared(`legacy-${index}`, { sharedScore: index })),
      eligible('keep-low', 10),
      eligible('keep-high', 40),
    ], '2026-03-14', true)
    installServer({})

    const store = useNewsStore()
    const loadPromise = store.loadTodayFeed('ai')

    expect(ids(store.articles)).toEqual(['keep-high', 'keep-low'])
    await loadPromise
  })

  it('isSharedFallback の印がない旧キャッシュも共有記事として判別し、表示条件を満たさない記事を出さない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-15T09:00:00+09:00'))
    seedCache(Array.from({ length: 155 }, (_, index) => shared(`legacy-${index}`)), '2026-03-14')
    installServer({})

    const store = useNewsStore()
    const loadPromise = store.loadTodayFeed('ai')

    expect(store.articles).toEqual([])
    await loadPromise
  })

  it('取得失敗時のキャッシュ表示でも概要のない記事を出さず20件に絞る', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-15T09:00:00+09:00'))
    const docs = Array.from({ length: 155 }, (_, index) => personal(`c${index}`, {
      displayScore: 200 - index,
      ...(index < 5 ? { summaryJa: '' } : {}),
    }))
    seedCache(docs)
    getDocsFromServerMock.mockRejectedValue(new Error('offline'))
    getDocsMock.mockRejectedValue(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(store.feedDiagnosticsByTopic.ai.state).toBe('fetch-failed')
    expect(store.articles).toHaveLength(20)
    expect(ids(store.articles)).toEqual(docs.slice(5, 25).map((item) => item.id))
  })

  it('取得失敗時の共有記事キャッシュは feedEligible の記事だけを sharedScore 降順で表示する', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-15T09:00:00+09:00'))
    seedCache([
      ...Array.from({ length: 30 }, (_, index) => shared(`legacy-${index}`, { sharedScore: 1000 + index })),
      eligible('keep-1', 20),
      eligible('keep-2', 30),
    ], '2026-03-14', true)
    getDocsFromServerMock.mockRejectedValue(new Error('offline'))
    getDocsMock.mockRejectedValue(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(ids(store.articles)).toEqual(['keep-2', 'keep-1'])
  })

  it('モバイルトピックは20件制限も概要の有無による絞り込みも受けない', async () => {
    installServer({
      topic: 'mobile',
      personal: Array.from({ length: 25 }, (_, index) => personal(`m${index}`, {
        topic: 'mobile', displayScore: 100 - index, ...(index % 2 === 0 ? { summaryJa: '' } : {}),
      })),
    })

    const store = useNewsStore()
    await store.loadTodayFeed('mobile')

    expect(store.articles).toHaveLength(25)
    expect(ids(store.articles)).toEqual(Array.from({ length: 25 }, (_, index) => `m${index}`))
  })

  it('モバイルの共有記事代替表示は feedEligible を要求しない', async () => {
    installServer({
      topic: 'mobile',
      shared: Array.from({ length: 3 }, (_, index) => shared(`ms${index}`, { topic: 'mobile' })),
    })

    const store = useNewsStore()
    await store.loadTodayFeed('mobile')

    expect(ids(store.articles).sort()).toEqual(['ms0', 'ms1', 'ms2'])
  })
})
