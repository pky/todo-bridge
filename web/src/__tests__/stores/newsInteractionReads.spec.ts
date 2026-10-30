// newsInteractions の読み取りを、今日の候補記事に関係する分だけに絞ることの検証。
// 履歴は増え続けるため、コレクション全体への読み取り（条件なしの getDocs / getDocsFromServer）を発行しない。
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
  doc: vi.fn((base: { path?: string }, ...segments: string[]) => ({
    type: 'doc',
    path: typeof base?.path === 'string' ? `${base.path}/${segments.join('/')}` : segments.join('/'),
  })),
  documentId: vi.fn(() => '__name__'),
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

const INTERACTIONS = 'users/user-1/newsInteractions'
const TODAY = '2026-03-14'
const YESTERDAY = '2026-03-13'

type Fixture = { id: string; data: Record<string, unknown> }
type Clause = { type: string; field?: string; op?: string; value?: unknown }
type Target = { type: 'collection' | 'query'; path?: string; target?: { path: string }; clauses?: Clause[] }
type Read = { fn: string; kind: 'doc' | 'query'; path: string; wheres: Clause[] }

const reads: Read[] = []

function createDocs(items: Fixture[]) {
  return {
    empty: items.length === 0,
    docs: items.map((item) => ({ id: item.id, data: () => item.data, exists: () => true })),
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
  date: TODAY,
}

const urlOf = (id: string) => `https://example.com/${id}`
const personal = (id: string, displayScore = 50, overrides: Record<string, unknown> = {}): Fixture => ({
  id,
  data: { ...articleData, url: urlOf(id), displayScore, ...overrides },
})
const sharedEligible = (id: string, sharedScore: number, overrides: Record<string, unknown> = {}): Fixture => ({
  id,
  data: { ...articleData, url: urlOf(id), feedEligible: true, sharedScore, ...overrides },
})
const interaction = (docId: string, data: Record<string, unknown>): Fixture => ({ id: docId, data })

const lastSegment = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// newsInteractions に対する問い合わせを、全件・ID・url のどの形でも答えられる偽 Firestore。
// 'in' は実物と同じく31件以上で失敗させる。
function serveInteractions(fixtures: Fixture[], target: Target, fn: string) {
  const path = (target.type === 'query' ? target.target?.path : target.path) as string
  const wheres = (target.type === 'query' ? target.clauses ?? [] : []).filter((c) => c.type === 'where')
  reads.push({ fn, kind: 'query', path, wheres })
  let docs = fixtures
  for (const clause of wheres) {
    if (clause.op === 'in') {
      const values = clause.value as unknown[]
      if (!Array.isArray(values) || values.length === 0 || values.length > 30) {
        throw new Error(`invalid in clause size: ${Array.isArray(values) ? values.length : 'not-array'}`)
      }
      docs = docs.filter((item) => clause.field === '__name__'
        ? values.some((value) => lastSegment(String(value)) === item.id)
        : values.includes(item.data[clause.field as string]))
    } else if (clause.op === '==') {
      docs = docs.filter((item) => item.data[clause.field as string] === clause.value)
    }
  }
  return createDocs(docs)
}

function installServer(options: {
  topic?: 'ai' | 'mobile'
  personal?: Fixture[]
  shared?: Fixture[]
  interactions?: Fixture[]
}) {
  const topic = options.topic ?? 'ai'
  const personalDocs = options.personal ?? []
  const sharedDocs = options.shared ?? []
  const interactions = options.interactions ?? []

  const serve = (fn: string) => async (target: Target) => {
    const path = (target.type === 'query' ? target.target?.path : target.path) as string
    const clauses = target.type === 'query' ? target.clauses ?? [] : []
    const hasLimit = clauses.some((clause) => clause.type === 'limit')
    if (path === INTERACTIONS) return serveInteractions(interactions, target, fn)
    if (path === `users/user-1/newsFeed/${topic}/articles`) {
      if (personalDocs.length === 0) return createDocs([])
      return hasLimit
        ? createDocs([{ id: 'latest', data: { date: TODAY, displayScore: 1 } }])
        : createDocs(personalDocs)
    }
    if (path === `topics/${topic}/articles`) {
      if (sharedDocs.length === 0) return createDocs([])
      return hasLimit
        ? createDocs([{ id: 'latest', data: { date: TODAY, score: 1 } }])
        : createDocs(sharedDocs)
    }
    return createDocs([])
  }
  getDocsFromServerMock.mockImplementation(serve('getDocsFromServer'))
  getDocsMock.mockImplementation(serve('getDocs'))

  const serveDoc = (fn: string) => async (ref: { path: string }) => {
    if (ref.path.startsWith(`${INTERACTIONS}/`)) {
      reads.push({ fn, kind: 'doc', path: ref.path, wheres: [] })
      const found = interactions.find((item) => item.id === lastSegment(ref.path))
      return { id: lastSegment(ref.path), exists: () => found !== undefined, data: () => found?.data }
    }
    return { exists: () => false, data: () => ({}) }
  }
  getDocMock.mockImplementation(serveDoc('getDoc'))
  getDocFromServerMock.mockImplementation(serveDoc('getDocFromServer'))
}

// 条件なしで newsInteractions 全体を読む問い合わせ
const unboundedReads = () => reads.filter((r) => r.kind === 'query' && r.path === INTERACTIONS && r.wheres.length === 0)
const allInteractionReads = () => reads.filter((r) => r.path === INTERACTIONS || r.path.startsWith(`${INTERACTIONS}/`))
// ID 参照（getDoc 系）または documentId の where で引き当てているドキュメントのパス
const idCoveredPaths = (): string[] => [
  ...reads.filter((r) => r.kind === 'doc').map((r) => r.path),
  ...reads
    .filter((r) => r.kind === 'query' && r.path === INTERACTIONS)
    .flatMap((r) => r.wheres.filter((w) => w.field === '__name__' && w.op === 'in'))
    .flatMap((w) => (w.value as unknown[]).map((value) => {
      const text = String(value)
      return text.startsWith(`${INTERACTIONS}/`) ? text : `${INTERACTIONS}/${text}`
    })),
]
const urlInClauses = () => reads
  .filter((r) => r.kind === 'query' && r.path === INTERACTIONS)
  .flatMap((r) => r.wheres.filter((w) => w.field === 'url' && w.op === 'in'))
const coveredUrls = () => urlInClauses().flatMap((w) => w.value as string[])

const ids = (articles: Array<{ id: string }>) => articles.map((article) => article.id)
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('newsInteractions の読み取りを候補記事に絞る', () => {
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
    setDocMock.mockResolvedValue(undefined)
    batchCommitMock.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('仕様1: 全件読みをしない', () => {
    it('ニュース読み込みでコレクション全体を読まない', async () => {
      installServer({
        personal: [personal('a1', 90), personal('a2', 80)],
        interactions: [interaction('ai_old-1', { topic: 'ai', articleId: 'old-1', url: urlOf('old-1'), shownCount: 5 })],
      })
      await useNewsStore().loadTodayFeed('ai')
      await settle()

      expect(unboundedReads()).toEqual([])
    })

    it('履歴が多くても、読み取る履歴は候補記事に関係する分だけになる', async () => {
      const history = Array.from({ length: 200 }, (_, i) =>
        interaction(`ai_old-${i}`, { topic: 'ai', articleId: `old-${i}`, url: urlOf(`old-${i}`), shownCount: 1, lastShownDate: YESTERDAY }))
      installServer({ personal: [personal('a1', 90), personal('a2', 80)], interactions: history })
      await useNewsStore().loadTodayFeed('ai')
      await settle()

      // 全件読みでは200件を返す問い合わせが出る。候補に関係する履歴はこの入力には存在しない。
      expect(unboundedReads()).toEqual([])
      expect(allInteractionReads().length).toBeGreaterThan(0)
    })

    it('個別フィードと共有記事の両方の記事IDを ${topic}_${id} と裸のIDの2形式で引く', async () => {
      installServer({
        personal: [personal('p1', 90)],
        shared: [sharedEligible('s1', 10)],
      })
      await useNewsStore().loadTodayFeed('ai')
      await settle()

      const covered = idCoveredPaths()
      expect(unboundedReads()).toEqual([])
      expect(covered).toEqual(expect.arrayContaining([
        `${INTERACTIONS}/ai_p1`, `${INTERACTIONS}/p1`,
        `${INTERACTIONS}/ai_s1`, `${INTERACTIONS}/s1`,
      ]))
    })

    it('mobile は mobile_${id} 形式のドキュメントIDで引く', async () => {
      installServer({
        topic: 'mobile',
        personal: [personal('m1', 90, { topic: 'mobile' })],
      })
      await useNewsStore().loadTodayFeed('mobile')
      await settle()

      expect(unboundedReads()).toEqual([])
      expect(idCoveredPaths()).toContain(`${INTERACTIONS}/mobile_m1`)
    })

    it('候補記事の url を where(url, in, [...]) で引く', async () => {
      installServer({ personal: [personal('a1', 90), personal('a2', 80)] })
      await useNewsStore().loadTodayFeed('ai')
      await settle()

      expect(unboundedReads()).toEqual([])
      expect(coveredUrls()).toEqual(expect.arrayContaining([urlOf('a1'), urlOf('a2')]))
    })

    it('url の in 条件は30件ずつに分け、全 url を取りこぼさない', async () => {
      const docs = Array.from({ length: 65 }, (_, i) => personal(`b${i}`, 100 - i))
      installServer({ personal: docs })
      await useNewsStore().loadTodayFeed('ai')
      await settle()

      const clauses = urlInClauses()
      expect(unboundedReads()).toEqual([])
      expect(clauses.length).toBe(3)
      for (const clause of clauses) {
        expect((clause.value as unknown[]).length).toBeLessThanOrEqual(30)
      }
      expect(new Set(coveredUrls())).toEqual(new Set(docs.map((item) => item.data.url as string)))
    })

    it('候補が0件なら履歴を読まない', async () => {
      installServer({
        interactions: [interaction('ai_old-1', { topic: 'ai', articleId: 'old-1', url: urlOf('old-1'), shownCount: 5 })],
      })
      const store = useNewsStore()
      await store.loadTodayFeed('ai')
      await settle()

      expect(store.articles).toEqual([])
      expect(allInteractionReads()).toEqual([])
    })

    it('記事IDが空文字や "/" を含む場合は参照を作らず、失敗せず url 参照だけに残す', async () => {
      installServer({
        personal: [
          personal('ok-1', 90),
          personal('', 80, { url: urlOf('empty-id') }),
          personal('bad/id', 70, { url: urlOf('slash-id') }),
        ],
      })
      const store = useNewsStore()
      await store.loadTodayFeed('ai')
      await settle()

      expect(store.error).toBeNull()
      expect(unboundedReads()).toEqual([])
      const covered = idCoveredPaths()
      expect(covered).toEqual(expect.arrayContaining([`${INTERACTIONS}/ai_ok-1`, `${INTERACTIONS}/ok-1`]))
      for (const path of covered) {
        expect(path).toMatch(/^users\/user-1\/newsInteractions\/[^/]+$/)
        expect(path).not.toBe(`${INTERACTIONS}/ai_`)
      }
      expect(coveredUrls()).toEqual(expect.arrayContaining([urlOf('empty-id'), urlOf('slash-id')]))
    })

    it('記事IDが文字列でない場合は参照を作らず、失敗せず url 参照だけに残す', async () => {
      installServer({
        personal: [
          personal('ok-1', 90),
          personal('numeric-doc', 80, { id: 12345, url: urlOf('numeric-id') }),
        ],
      })
      const store = useNewsStore()
      await store.loadTodayFeed('ai')
      await settle()

      expect(store.error).toBeNull()
      expect(unboundedReads()).toEqual([])
      for (const path of idCoveredPaths()) {
        expect(path).not.toMatch(/12345|undefined|null|\[object/)
      }
      expect(coveredUrls()).toContain(urlOf('numeric-id'))
    })

    it('loadMobileAlertCount でもコレクション全体を読まない', async () => {
      installServer({
        topic: 'mobile',
        personal: [personal('m1', 90, { topic: 'mobile', isOfficial: true, importantLevel: 'urgent' })],
        interactions: [interaction('mobile_old', { topic: 'mobile', articleId: 'old', url: urlOf('old'), dismissed: true })],
      })
      await useNewsStore().loadMobileAlertCount()
      await settle()

      expect(unboundedReads()).toEqual([])
    })
  })

  describe('仕様2: 表示結果は全件読みの時と変わらない', () => {
    it('個別フィード: 既読・非表示・クリック済み・同URL別ID・旧形式の記録を除外し、表示順を保つ', async () => {
      installServer({
        personal: [
          personal('p-keep1', 90),
          personal('p-shown1', 80),
          personal('p-keep2', 70),
          personal('p-read', 69),
          personal('p-dismissed', 68),
          personal('p-clicked', 67),
          personal('p-sameurl', 66),
          personal('p-legacy', 65),
        ],
        interactions: [
          interaction('ai_p-read', { topic: 'ai', articleId: 'p-read', url: urlOf('p-read'), shownCount: 2 }),
          interaction('ai_p-dismissed', { topic: 'ai', articleId: 'p-dismissed', url: urlOf('p-dismissed'), dismissed: true }),
          interaction('ai_p-clicked', { topic: 'ai', articleId: 'p-clicked', url: urlOf('p-clicked'), clickedAt: { seconds: 1 } }),
          interaction('ai_p-shown1', { topic: 'ai', articleId: 'p-shown1', url: urlOf('p-shown1'), shownCount: 1, lastShownDate: YESTERDAY }),
          // 別IDで保存された同URLの記録
          interaction('ai_old-id', { topic: 'ai', articleId: 'old-id', url: urlOf('p-sameurl'), shownCount: 2 }),
          // 旧形式: topic なし、裸の記事ID
          interaction('p-legacy', { url: urlOf('p-legacy'), shownCount: 3 }),
          // 無関係な履歴
          interaction('ai_unrelated', { topic: 'ai', articleId: 'unrelated', url: urlOf('unrelated'), shownCount: 9 }),
        ],
      })
      const store = useNewsStore()
      await store.loadTodayFeed('ai')
      await settle()

      expect(store.error).toBeNull()
      expect(ids(store.articles)).toEqual(['p-keep1', 'p-shown1', 'p-keep2'])
      expect(store.dismissedIds.has('p-dismissed')).toBe(true)
    })

    it('共有記事: 記録のある記事と同URLの記事を除外し、sharedScore 降順を保つ', async () => {
      installServer({
        shared: [
          sharedEligible('s-low', 10),
          sharedEligible('s-high', 90),
          sharedEligible('s-read', 80),
          sharedEligible('s-dismissed', 70),
          sharedEligible('s-sameurl', 60),
          sharedEligible('s-mid', 50),
        ],
        interactions: [
          interaction('ai_s-read', { topic: 'ai', articleId: 's-read', url: urlOf('s-read'), shownCount: 2 }),
          interaction('s-dismissed', { articleId: 's-dismissed', url: urlOf('s-dismissed'), dismissed: true }),
          interaction('ai_other', { topic: 'ai', articleId: 'other', url: urlOf('s-sameurl'), clickedAt: { seconds: 1 } }),
        ],
      })
      const store = useNewsStore()
      await store.loadTodayFeed('ai')
      await settle()

      expect(ids(store.articles)).toEqual(['s-high', 's-mid', 's-low'])
      expect(store.feedDiagnosticsByTopic.ai.message).toBe('個別フィード生成前のため、共有記事を表示しています')
    })

    it('mobile: topic なしの旧形式の記録は ai 専用で、mobile の表示を除外しない', async () => {
      installServer({
        topic: 'mobile',
        personal: [
          personal('m-keep', 90, { topic: 'mobile' }),
          personal('m-dismissed', 80, { topic: 'mobile' }),
          personal('m-legacy', 70, { topic: 'mobile' }),
        ],
        interactions: [
          interaction('mobile_m-dismissed', { topic: 'mobile', articleId: 'm-dismissed', url: urlOf('m-dismissed'), dismissed: true }),
          interaction('m-legacy', { url: urlOf('m-legacy'), dismissed: true }),
        ],
      })
      const store = useNewsStore()
      await store.loadTodayFeed('mobile')
      await settle()

      expect(ids(store.articles)).toEqual(['m-keep', 'm-legacy'])
    })

    it('mobile の通知件数は記録で除外した後の urgent と review を数える', async () => {
      const mobile = (id: string, level: string, score: number) =>
        personal(id, score, { topic: 'mobile', isOfficial: true, importantLevel: level })
      installServer({
        topic: 'mobile',
        personal: [
          mobile('m-urgent', 'urgent', 90),
          mobile('m-urgent-dismissed', 'urgent', 80),
          mobile('m-urgent-clicked', 'urgent', 70),
          mobile('m-review', 'review', 60),
        ],
        interactions: [
          interaction('mobile_m-urgent-dismissed', { topic: 'mobile', articleId: 'm-urgent-dismissed', url: urlOf('m-urgent-dismissed'), dismissed: true }),
          interaction('mobile_old', { topic: 'mobile', articleId: 'old', url: urlOf('m-urgent-clicked'), clickedAt: { seconds: 1 } }),
        ],
      })
      const store = useNewsStore()
      await store.loadMobileAlertCount()

      // urgent は未クリックのものだけ表示を維持し、クリック済みでも urgent は残る（現行の挙動）
      expect(store.mobileAlertSummary).toEqual({ urgent: 2, review: 1 })
      expect(store.mobileAlertCount).toBe(2)
    })
  })

  describe('仕様3: 表示回数の加算は今日表示した記事の履歴だけで判定する', () => {
    it('lastShownDate が今日の記事は加算せず、昨日以前の記事だけ加算する。全件は読まない', async () => {
      const history = Array.from({ length: 100 }, (_, i) =>
        interaction(`ai_old-${i}`, { topic: 'ai', articleId: `old-${i}`, url: urlOf(`old-${i}`), shownCount: 1, lastShownDate: YESTERDAY }))
      installServer({
        personal: [personal('t-today', 90), personal('t-yesterday', 80), personal('t-new', 70)],
        interactions: [
          ...history,
          interaction('ai_t-today', { topic: 'ai', articleId: 't-today', url: urlOf('t-today'), shownCount: 1, lastShownDate: TODAY }),
          interaction('ai_t-yesterday', { topic: 'ai', articleId: 't-yesterday', url: urlOf('t-yesterday'), shownCount: 1, lastShownDate: YESTERDAY }),
        ],
      })
      await useNewsStore().loadTodayFeed('ai')
      await vi.waitFor(() => {
        expect(batchCommitMock).toHaveBeenCalledTimes(1)
      })

      expect(unboundedReads()).toEqual([])
      const written = batchSetMock.mock.calls.map((call) => (call[0] as { path: string }).path).sort()
      expect(written).toEqual([`${INTERACTIONS}/ai_t-new`, `${INTERACTIONS}/ai_t-yesterday`])
      const yesterdayCall = batchSetMock.mock.calls.find((call) => (call[0] as { path: string }).path.endsWith('ai_t-yesterday'))
      expect(yesterdayCall?.[1]).toEqual(expect.objectContaining({
        topic: 'ai',
        articleId: 't-yesterday',
        url: urlOf('t-yesterday'),
        shownCount: { __increment: 1 },
        lastShownDate: TODAY,
      }))
      expect(yesterdayCall?.[2]).toEqual({ merge: true })
    })

    it('旧形式（裸のID、articleId なし）の記録が今日表示済みなら加算しない', async () => {
      installServer({
        personal: [personal('t-legacy', 90)],
        interactions: [interaction('t-legacy', { url: urlOf('t-legacy'), shownCount: 1, lastShownDate: TODAY })],
      })
      await useNewsStore().loadTodayFeed('ai')
      await settle()

      expect(unboundedReads()).toEqual([])
      expect(batchSetMock).not.toHaveBeenCalled()
      expect(batchCommitMock).not.toHaveBeenCalled()
    })

    it('履歴のない記事は ${topic}_${id} のドキュメントに shownCount 1 で記録する', async () => {
      installServer({ personal: [personal('t-fresh', 90)] })
      await useNewsStore().loadTodayFeed('ai')
      await vi.waitFor(() => {
        expect(batchCommitMock).toHaveBeenCalledTimes(1)
      })

      expect(unboundedReads()).toEqual([])
      expect(batchSetMock).toHaveBeenCalledTimes(1)
      expect((batchSetMock.mock.calls[0]?.[0] as { path: string }).path).toBe(`${INTERACTIONS}/ai_t-fresh`)
      expect(batchSetMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ shownCount: { __increment: 1 }, lastShownDate: TODAY }))
    })

    it('表示する記事がなければトラッキングは何も書かない', async () => {
      installServer({
        personal: [personal('t-read', 90)],
        interactions: [interaction('ai_t-read', { topic: 'ai', articleId: 't-read', url: urlOf('t-read'), shownCount: 2 })],
      })
      const store = useNewsStore()
      await store.loadTodayFeed('ai')
      await settle()

      expect(store.articles).toEqual([])
      expect(unboundedReads()).toEqual([])
      expect(batchSetMock).not.toHaveBeenCalled()
    })
  })
})
