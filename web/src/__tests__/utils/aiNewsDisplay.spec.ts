import { describe, expect, it } from 'vitest'
import type { NewsArticle } from '@/types'

// 未実装のモジュールでファイル全体が落ちないよう、読み込みは各テスト内で行う。
type DisplayModule = {
  AI_NEWS_MAX_ARTICLES: number
  selectDisplayableAiNews: (articles: NewsArticle[], options: { shared: boolean }) => NewsArticle[]
}
async function loadModule(): Promise<DisplayModule> {
  const specifier = '@/utils/aiNewsDisplay'
  return await import(/* @vite-ignore */ specifier) as DisplayModule
}

function article(id: string, overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id, title: `Fictional article ${id}`, titleJa: `架空の記事 ${id}`, summaryJa: `架空の概要 ${id}`,
    url: `https://example.com/${id}`, thumbnailUrl: null, source: 'rss', sourceName: '架空の技術フィード',
    topic: 'ai', score: null, publishedAt: {} as NewsArticle['publishedAt'], fetchedAt: {} as NewsArticle['fetchedAt'],
    date: '2026-10-28',
    ...overrides,
  }
}
const ids = (articles: NewsArticle[]) => articles.map(item => item.id)

describe('selectDisplayableAiNews', () => {
  it('表示上限は20件', async () => {
    const { AI_NEWS_MAX_ARTICLES } = await loadModule()
    expect(AI_NEWS_MAX_ARTICLES).toBe(20)
  })

  it('個別フィードは summaryJa が空でない記事だけを入力の順に返す', async () => {
    const { selectDisplayableAiNews } = await loadModule()
    const result = selectDisplayableAiNews([
      article('first'),
      article('empty', { summaryJa: '' }),
      article('blank', { summaryJa: ' \n  ' }),
      article('missing', { summaryJa: undefined }),
      article('second'),
    ], { shared: false })
    expect(ids(result)).toEqual(['first', 'second'])
  })

  it('個別フィードは feedEligible がなくても表示でき、20件で切る', async () => {
    const { selectDisplayableAiNews } = await loadModule()
    const many = Array.from({ length: 35 }, (_, index) => article(`personal-${index}`))
    const result = selectDisplayableAiNews(many, { shared: false })
    expect(result).toHaveLength(20)
    expect(ids(result)).toEqual(many.slice(0, 20).map(item => item.id))
  })

  it('共有記事は feedEligible===true の記事だけを sharedScore の降順で返す', async () => {
    const { selectDisplayableAiNews } = await loadModule()
    const result = selectDisplayableAiNews([
      article('low-score', { feedEligible: true, sharedScore: 70 }),
      article('not-eligible', { sharedScore: 999 }),
      article('eligible-false', { feedEligible: false, sharedScore: 998 }),
      article('top', { feedEligible: true, sharedScore: 130 }),
      article('no-summary', { feedEligible: true, sharedScore: 120, summaryJa: '' }),
      article('middle', { feedEligible: true, sharedScore: 100 }),
    ], { shared: true })
    expect(ids(result)).toEqual(['top', 'middle', 'low-score'])
  })

  it('共有記事も先頭20件で切る', async () => {
    const { selectDisplayableAiNews } = await loadModule()
    const many = Array.from({ length: 25 }, (_, index) => article(`shared-${index}`, { feedEligible: true, sharedScore: index }))
    const result = selectDisplayableAiNews(many, { shared: true })
    expect(result).toHaveLength(20)
    expect(ids(result)[0]).toBe('shared-24')
    expect(ids(result)[19]).toBe('shared-5')
  })

  it('入力の配列を並べ替えず、空の入力には空配列を返す', async () => {
    const { selectDisplayableAiNews } = await loadModule()
    const input = [
      article('a', { feedEligible: true, sharedScore: 1 }),
      article('b', { feedEligible: true, sharedScore: 2 }),
    ]
    selectDisplayableAiNews(input, { shared: true })
    expect(ids(input)).toEqual(['a', 'b'])
    expect(selectDisplayableAiNews([], { shared: true })).toEqual([])
    expect(selectDisplayableAiNews([], { shared: false })).toEqual([])
  })
})
