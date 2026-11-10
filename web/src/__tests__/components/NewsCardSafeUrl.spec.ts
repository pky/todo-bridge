import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { Timestamp } from 'firebase/firestore'
import NewsCard from '@/components/NewsCard.vue'
import type { NewsArticle } from '@/types'

enableAutoUnmount(afterEach)
afterEach(() => vi.restoreAllMocks())

function article(url: string): NewsArticle {
  return {
    id: 'article-1', title: '架空記事', summaryJa: '架空の概要', url,
    thumbnailUrl: null, source: 'rss', sourceName: '架空の配信元', score: null,
    publishedAt: Timestamp.fromMillis(0), fetchedAt: Timestamp.fromMillis(0), date: '2026-01-01',
  }
}

describe('ニュースカードの外部URL', () => {
  for (const url of ['javascript:alert(1)', 'ftp://example.com/article']) {
    it(`${url}の記事をクリックしても開かない`, async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      const wrapper = mount(NewsCard, { props: { article: article(url) } })
      await wrapper.trigger('click')
      expect(open).not.toHaveBeenCalled()
    })
  }

  for (const protocol of ['http', 'https']) {
    it(`${protocol}の記事は安全な別タブで開く`, async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      const url = `${protocol}://example.com/article`
      const wrapper = mount(NewsCard, { props: { article: article(url) } })
      await wrapper.trigger('click')
      expect(open).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener,noreferrer')
    })
  }
})
