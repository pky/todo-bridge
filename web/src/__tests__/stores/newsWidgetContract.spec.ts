import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useNewsStore } from '@/stores/news'

// widget API（functions の selectWidgetFeed）と共有する契約フィクスチャを、Web の実 store に流して期待値を裏付ける。
const getDocsFromServerMock = vi.hoisted(() => vi.fn())
const getDocsMock = vi.hoisted(() => vi.fn())
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

type FixtureDoc = { id: string } & Record<string, unknown>

interface Scenario {
  name: string
  topic: 'ai' | 'mobile'
  personalDate: string | null
  personalDocs: FixtureDoc[]
  sharedDate: string | null
  sharedDocs: FixtureDoc[]
  interactions: FixtureDoc[]
  expected: { feedDate: string | null; isSharedFallback: boolean; articleIds: string[] }
}

interface QueryTarget {
  type: string
  target?: { path: string }
  path?: string
  clauses?: Array<{ type: string }>
}

// jsdom 環境では import.meta.url が file: スキームにならないため、web/ を cwd とする vitest の起点から解決する。
const contract = JSON.parse(
  readFileSync(resolve(process.cwd(), '../functions/test/fixtures/widgetFeedContract.json'), 'utf-8')
) as { scenarios: Scenario[] }

function createDocs(items: FixtureDoc[]) {
  return {
    empty: items.length === 0,
    docs: items.map(({ id, ...data }) => ({
      id,
      data: () => data,
      exists: () => true,
    })),
  }
}

function installServer(scenario: Scenario) {
  const { topic, personalDocs, sharedDocs } = scenario
  getDocsFromServerMock.mockImplementation(async (target: QueryTarget) => {
    const path = target.type === 'query' ? target.target?.path : target.path
    const clauses = target.type === 'query' ? target.clauses ?? [] : []
    const hasLimit = clauses.some((clause) => clause.type === 'limit')
    if (path === 'users/user-1/newsInteractions') return createDocs(scenario.interactions)
    if (path === `users/user-1/newsFeed/${topic}/articles`) {
      if (personalDocs.length === 0) return createDocs([])
      return hasLimit
        ? createDocs([{ id: 'latest', date: scenario.personalDate, displayScore: 1 }])
        : createDocs(personalDocs)
    }
    if (path === `topics/${topic}/articles`) {
      if (sharedDocs.length === 0) return createDocs([])
      return hasLimit
        ? createDocs([{ id: 'latest', date: scenario.sharedDate, score: 1 }])
        : createDocs(sharedDocs)
    }
    return createDocs([])
  })
}

describe('widget ニュース判定の契約フィクスチャ（Web の実挙動との一致）', () => {
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

  it('フィクスチャにシナリオが含まれ、名前が重複しない', () => {
    expect(contract.scenarios.length).toBeGreaterThanOrEqual(10)
    const names = contract.scenarios.map((scenario) => scenario.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(contract.scenarios.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    installServer(scenario)

    const store = useNewsStore()
    await store.loadTodayFeed(scenario.topic)

    expect(store.articles.map((article) => article.id)).toEqual(scenario.expected.articleIds)
    expect(store.latestFeedDateByTopic[scenario.topic]).toBe(scenario.expected.feedDate)
    const cached = JSON.parse(localStorage.getItem(`rertm-news-cache-user-1-${scenario.topic}`) ?? '{}') as {
      isSharedFallback?: boolean
    }
    expect(cached.isSharedFallback ?? false).toBe(scenario.expected.isSharedFallback)
  })
})
