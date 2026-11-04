import type { AiFeedV2 } from '@/utils/newsFeedV2'

export const demoUid = 'ai-news-demo-user'
export const feedDate = '2026-11-03'
export const nowMs = Date.parse('2026-11-03T09:00:00+09:00')
export const cacheKey = `todobridge:aiNewsV2:v1:${demoUid}:ai`
export const operationId = '00000000-0000-4000-8000-000000000001'

export function makeFeed(overrides: Partial<AiFeedV2> = {}): AiFeedV2 {
  return {
    schemaVersion: 2, topic: 'ai', feedDate, generatedAt: '2026-11-03T00:00:00Z',
    revision: 'a'.repeat(64), totalCount: 2,
    articles: [
      { id: 'demo-first', title: '架空の推論モデル更新', sourceName: '架空技術通信', summary: '検証用の記事概要です', publishedAt: null, url: 'https://example.test/first' },
      { id: 'demo-second', title: '架空の評価ツール公開', sourceName: '架空技術通信', summary: 'もう一つの検証記事です', publishedAt: null, url: 'https://example.test/second' },
    ],
    ...overrides,
  }
}

export function feedBytes(feed: unknown = makeFeed()): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(feed)).buffer
}

export function makeAction(action: 'dismiss' | 'readLater' = 'dismiss') {
  return { schemaVersion: 2 as const, topic: 'ai' as const, feedDate,
    revision: 'a'.repeat(64), articleId: 'demo-first', action, operationId }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
