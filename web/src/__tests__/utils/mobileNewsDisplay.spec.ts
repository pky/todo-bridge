import { describe, expect, it } from 'vitest'
import type { NewsArticle } from '@/types'

// 未実装のモジュールでファイル全体が落ちないよう、読み込みは各テスト内で行う。
type DisplayModule = {
  selectDisplayableMobileNews: (articles: NewsArticle[]) => NewsArticle[]
}
async function loadModule(): Promise<DisplayModule> {
  const specifier = '@/utils/mobileNewsDisplay'
  return await import(/* @vite-ignore */ specifier) as DisplayModule
}

function article(id: string, overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id, title: `Fictional article ${id}`, titleJa: `架空の記事 ${id}`, summaryJa: `架空の概要 ${id}`,
    url: `https://example.com/${id}`, thumbnailUrl: null, source: 'rss', sourceName: '架空の技術フィード',
    topic: 'mobile', score: null, publishedAt: {} as NewsArticle['publishedAt'], fetchedAt: {} as NewsArticle['fetchedAt'],
    date: '2026-10-28', inScope: true, classificationStatus: 'done',
    ...overrides,
  }
}
const ids = (articles: NewsArticle[]) => articles.map(item => item.id)

describe('selectDisplayableMobileNews', () => {
  it('inScope が true で分類済みの記事を渡された順のまま返す', async () => {
    const { selectDisplayableMobileNews } = await loadModule()
    const result = selectDisplayableMobileNews([article('b'), article('a'), article('c')])
    expect(ids(result)).toEqual(['b', 'a', 'c'])
  })

  it('inScope が false の記事を除外する', async () => {
    const { selectDisplayableMobileNews } = await loadModule()
    const result = selectDisplayableMobileNews([article('keep'), article('out', { inScope: false })])
    expect(ids(result)).toEqual(['keep'])
  })

  it('分類待ち（pending）の記事を除外する', async () => {
    const { selectDisplayableMobileNews } = await loadModule()
    const result = selectDisplayableMobileNews([article('keep'), article('wait', { classificationStatus: 'pending' })])
    expect(ids(result)).toEqual(['keep'])
  })

  it('inScope や classificationStatus が未定義の記事を除外する', async () => {
    const { selectDisplayableMobileNews } = await loadModule()
    const result = selectDisplayableMobileNews([
      article('keep'),
      article('no-scope', { inScope: undefined }),
      article('no-status', { classificationStatus: undefined }),
    ])
    expect(ids(result)).toEqual(['keep'])
  })

  it('15件を超える場合は先頭15件で切る', async () => {
    const { selectDisplayableMobileNews } = await loadModule()
    const many = Array.from({ length: 20 }, (_, index) => article(`m${index}`))
    const result = selectDisplayableMobileNews(many)
    expect(result).toHaveLength(15)
    expect(ids(result)).toEqual(many.slice(0, 15).map(item => item.id))
  })

  it('除外した後の記事から15件を数える', async () => {
    const { selectDisplayableMobileNews } = await loadModule()
    const input = [
      ...Array.from({ length: 5 }, (_, index) => article(`out${index}`, { inScope: false })),
      ...Array.from({ length: 16 }, (_, index) => article(`ok${index}`)),
    ]
    const result = selectDisplayableMobileNews(input)
    expect(ids(result)).toEqual(Array.from({ length: 15 }, (_, index) => `ok${index}`))
  })

  it('入力の配列を変更せず、空の入力には空配列を返す', async () => {
    const { selectDisplayableMobileNews } = await loadModule()
    const input = [article('a', { inScope: false }), article('b')]
    selectDisplayableMobileNews(input)
    expect(ids(input)).toEqual(['a', 'b'])
    expect(selectDisplayableMobileNews([])).toEqual([])
  })
})
