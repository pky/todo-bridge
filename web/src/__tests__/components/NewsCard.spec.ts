import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NewsCard from '@/components/NewsCard.vue'
import type { NewsArticle } from '@/types'

const article: NewsArticle = {
  id: 'article-1',
  title: 'OpenAI releases update',
  titleJa: 'OpenAIが更新を公開',
  summaryJa: 'これはスマホでは省略されずに全文表示したい要約です。',
  url: 'https://example.com/article-1',
  thumbnailUrl: null,
  source: 'rss',
  sourceName: 'Example',
  score: null,
  publishedAt: {} as NewsArticle['publishedAt'],
  fetchedAt: {} as NewsArticle['fetchedAt'],
  date: '2026-03-14',
}

describe('NewsCard', () => {
  it('要約は全文表示で line-clamp しない', () => {
    const wrapper = mount(NewsCard, {
      props: {
        article,
      },
    })

    const summary = wrapper.findAll('p').find((node) => node.text() === article.summaryJa)
    expect(summary).toBeTruthy()
    expect(summary?.classes()).not.toContain('line-clamp-3')
    expect(summary?.classes()).not.toContain('xl:line-clamp-3')
    expect(summary?.classes()).not.toContain('xl:line-clamp-4')
  })
})
