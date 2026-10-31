// AI ニュースの共有記事は、表示対象（feedEligible == true）だけを問い合わせで読むことの検証。
// 捨てるだけの記事の読み取り課金をなくす。最新日を決める1本目の問い合わせには条件を付けない。
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
interface Clause { type: string; field?: string; op?: string; value?: unknown; direction?: string }
interface QueryTarget {
  type: string
  target?: { path: string }
  path?: string
  clauses?: Clause[]
}
interface Read { path: string; clauses: Clause[]; served: string[] }

const LATEST = '2026-03-14'
const OLDER = '2026-03-13'
const reads: Read[] = []

function createDocs(items: DocFixture[]) {
  return {
    empty: items.length === 0,
    docs: items.map((item) => ({ id: item.id, data: () => item.data, exists: () => true })),
  }
}

const article = (id: string, date: string, overrides: Record<string, unknown> = {}): DocFixture => ({
  id,
  data: {
    title: 'Fictional article',
    titleJa: '架空の記事',
    summaryJa: '架空の概要です',
    url: `https://example.com/${id}`,
    thumbnailUrl: null,
    source: 'rss',
    sourceName: '架空のフィード',
    score: null,
    publishedAt: {} as unknown,
    fetchedAt: {} as unknown,
    date,
    ...overrides,
  },
})
const eligible = (id: string, sharedScore: number, date = LATEST, overrides: Record<string, unknown> = {}) =>
  article(id, date, { feedEligible: true, sharedScore, ...overrides })

// 実物の Firestore と同じく、where の == 条件を結果に反映する偽サーバー。
// 条件なしの orderBy + limit(1) は、全記事の中で最も新しい日の1件を返す。
function installServer(options: { topic?: 'ai' | 'mobile'; personal?: DocFixture[]; shared?: DocFixture[] }) {
  const topic = options.topic ?? 'ai'
  const personalDocs = options.personal ?? []
  const sharedDocs = options.shared ?? []
  getDocsFromServerMock.mockImplementation(async (target: QueryTarget) => {
    const path = (target.type === 'query' ? target.target?.path : target.path) as string
    const clauses = target.type === 'query' ? target.clauses ?? [] : []
    const hasLimit = clauses.some((clause) => clause.type === 'limit')
    const serve = (items: DocFixture[]) => {
      reads.push({ path, clauses, served: items.map((item) => item.id) })
      return createDocs(items)
    }
    const source = path === `topics/${topic}/articles` ? sharedDocs
      : path === `users/user-1/newsFeed/${topic}/articles` ? personalDocs
      : null
    if (!source) return serve([])
    if (hasLimit) {
      const sorted = [...source].sort((a, b) => String(b.data.date).localeCompare(String(a.data.date)))
      return serve(sorted.slice(0, 1))
    }
    let docs = source
    for (const clause of clauses.filter((c) => c.type === 'where' && c.op === '==')) {
      docs = docs.filter((item) => item.data[clause.field as string] === clause.value)
    }
    return serve(docs)
  })
}

const readsOf = (path: string) => reads.filter((read) => read.path === path)
const wheresOf = (read: Read) => read.clauses.filter((clause) => clause.type === 'where')
const isEligibleWhere = (clause: Clause) =>
  clause.type === 'where' && clause.field === 'feedEligible' && clause.op === '==' && clause.value === true
const ids = (list: Array<{ id: string }>) => list.map((item) => item.id)

describe('AI ニュースの共有記事は feedEligible の記事だけを問い合わせで読む', () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    reads.length = 0
    localStorage.clear()
    useAuthStore().$patch({
      user: { uid: 'user-1', email: 'test@example.com', displayName: 'Test', photoURL: null },
      loading: false,
    })
    getDocMock.mockResolvedValue({ exists: () => false, data: () => ({}) })
    getDocsMock.mockResolvedValue(createDocs([]))
    setDocMock.mockResolvedValue(undefined)
    batchCommitMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('topic が ai のとき、日付で絞る2本目の問い合わせに feedEligible == true を加える', async () => {
    installServer({ shared: [eligible('e1', 10), article('x1', LATEST, { feedEligible: false, sharedScore: 99 })] })

    await useNewsStore().loadTodayFeed('ai')

    const dated = readsOf('topics/ai/articles').filter((read) =>
      wheresOf(read).some((c) => c.field === 'date' && c.op === '==' && c.value === LATEST))
    expect(dated).toHaveLength(1)
    expect(wheresOf(dated[0]!).some(isEligibleWhere)).toBe(true)
  })

  it('表示対象外の共有記事は Firestore から返されず、読み取り対象は表示対象のみになる', async () => {
    installServer({
      shared: [
        eligible('e1', 10),
        eligible('e2', 20),
        article('x-false', LATEST, { feedEligible: false, sharedScore: 99 }),
        article('x-none', LATEST, { sharedScore: 98 }),
        article('x-legacy', LATEST),
      ],
    })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    const servedByDate = readsOf('topics/ai/articles').find((read) =>
      !read.clauses.some((c) => c.type === 'limit'))
    expect([...(servedByDate?.served ?? [])].sort()).toEqual(['e1', 'e2'])
    expect(ids(store.articles)).toEqual(['e2', 'e1'])
  })

  it('最新日を決める1本目の問い合わせ（orderBy date desc, limit 1）には feedEligible 条件を付けない', async () => {
    installServer({ shared: [eligible('e1', 10)] })

    await useNewsStore().loadTodayFeed('ai')

    const latest = readsOf('topics/ai/articles').filter((read) => read.clauses.some((c) => c.type === 'limit'))
    expect(latest).toHaveLength(1)
    expect(latest[0]!.clauses.some((c) => c.type === 'orderBy' && c.field === 'date' && c.direction === 'desc')).toBe(true)
    expect(latest[0]!.clauses.find((c) => c.type === 'limit')?.value).toBe(1)
    expect(wheresOf(latest[0]!).some((c) => c.field === 'feedEligible')).toBe(false)
  })

  it('最新日に feedEligible な記事が無ければ、古い日の表示対象へ広げず共有記事なしとして扱う', async () => {
    installServer({
      shared: [
        article('x-latest', LATEST, { feedEligible: false, sharedScore: 50 }),
        eligible('e-old', 80, OLDER),
      ],
    })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(store.articles).toEqual([])
    // 2本目は最新日で読んでいる（古い日に切り替えていない）。
    const dated = readsOf('topics/ai/articles').filter((read) => !read.clauses.some((c) => c.type === 'limit'))
    expect(dated).toHaveLength(1)
    expect(wheresOf(dated[0]!).some((c) => c.field === 'date' && c.value === LATEST)).toBe(true)
  })

  it('既存の絞り込みと並べ替えは残る: summaryJa が空の記事を除き、sharedScore 降順で並べる', async () => {
    installServer({
      shared: [
        eligible('low', 1),
        eligible('high', 30),
        eligible('empty-summary', 500, LATEST, { summaryJa: '' }),
        eligible('mid', 10),
      ],
    })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    expect(ids(store.articles)).toEqual(['high', 'mid', 'low'])
  })

  it('個別フィード（users/{uid}/newsFeed/ai/articles）の問い合わせには feedEligible 条件を付けない', async () => {
    installServer({
      personal: [article('p1', LATEST, { displayScore: 50 })],
      shared: [eligible('e1', 10)],
    })

    const store = useNewsStore()
    await store.loadTodayFeed('ai')

    const personalReads = readsOf('users/user-1/newsFeed/ai/articles')
    expect(personalReads.length).toBeGreaterThan(0)
    for (const read of personalReads) expect(wheresOf(read).some((c) => c.field === 'feedEligible')).toBe(false)
    expect(ids(store.articles)).toEqual(['p1'])
  })

  it('topic が mobile の共有記事の問い合わせには feedEligible 条件を付けない', async () => {
    installServer({
      topic: 'mobile',
      shared: [article('m1', LATEST, { inScope: true, classificationStatus: 'done' })],
    })

    await useNewsStore().loadTodayFeed('mobile')

    const mobileReads = readsOf('topics/mobile/articles')
    expect(mobileReads.length).toBeGreaterThan(0)
    for (const read of mobileReads) expect(wheresOf(read).some((c) => c.field === 'feedEligible')).toBe(false)
  })
})
