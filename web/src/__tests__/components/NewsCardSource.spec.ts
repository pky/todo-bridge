import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import NewsCard from '@/components/NewsCard.vue'
import type { NewsArticle } from '@/types'

enableAutoUnmount(afterEach)

const baseArticle: NewsArticle = {
  id: 'fictional-source-article', title: 'Fictional development article', titleJa: '架空の開発記事',
  summaryJa: '架空の概要です', url: 'https://www.publisher.example.com/posts/1', thumbnailUrl: null,
  source: 'rss', sourceName: '架空の技術フィード', topic: 'ai', score: null,
  publishedAt: {} as NewsArticle['publishedAt'], fetchedAt: {} as NewsArticle['fetchedAt'], date: '2026-10-28',
}
const variants = ['default', 'hero', 'featured'] as const

function metaSpans(wrapper: { findAll(selector: string): Array<{ text(): string }> }): string[] {
  return wrapper.findAll('span').map((span) => span.text())
}

describe('ニュースカードの掲載元表示', () => {
  for (const variant of variants) {
    it(`${variant}表示は publisherDomain を主表示にし、異なる sourceName を「紹介元:」で併記する`, () => {
      const article = { ...baseArticle, sourceName: 'はてなブックマーク IT', publisherDomain: 'publisher.example.com' }
      const wrapper = mount(NewsCard, { props: { article, variant } })
      expect(metaSpans(wrapper)).toContain('publisher.example.com')
      expect(metaSpans(wrapper)).toContain('紹介元: はてなブックマーク IT')
    })

    it(`${variant}表示は publisherDomain と sourceName が同じなら紹介元を出さない`, () => {
      const article = { ...baseArticle, sourceName: 'publisher.example.com', publisherDomain: 'publisher.example.com' }
      const wrapper = mount(NewsCard, { props: { article, variant } })
      expect(wrapper.text()).not.toContain('紹介元')
    })

    it(`${variant}表示は通常フィードでは sourceName を主表示にして紹介元を出さない`, () => {
      const wrapper = mount(NewsCard, { props: { article: baseArticle, variant } })
      expect(metaSpans(wrapper)).toContain('架空の技術フィード')
      expect(wrapper.text()).not.toContain('紹介元')
    })
  }

  for (const sourceName of ['はてなブックマーク IT', 'Menthas', 'Hacker News']) {
    it(`publisherDomain のない旧記事で集約元「${sourceName}」なら URL のホストを主表示にして紹介元を併記する`, () => {
      const article = { ...baseArticle, sourceName, source: sourceName === 'Hacker News' ? 'hn' as const : 'rss' as const }
      const wrapper = mount(NewsCard, { props: { article } })
      expect(metaSpans(wrapper)).toContain('publisher.example.com')
      expect(metaSpans(wrapper)).toContain(`紹介元: ${sourceName}`)
      expect(metaSpans(wrapper)).not.toContain('www.publisher.example.com')
    })
  }

  it('publisherDomain のない旧記事でも集約元以外なら sourceName を主表示にして紹介元を出さない', () => {
    const article = { ...baseArticle, sourceName: 'Zenn ai' }
    const wrapper = mount(NewsCard, { props: { article } })
    expect(metaSpans(wrapper)).toContain('Zenn ai')
    expect(wrapper.text()).not.toContain('紹介元')
    expect(wrapper.text()).not.toContain('publisher.example.com')
  })

  it('publisherDomain があれば URL のホストより publisherDomain を優先する', () => {
    const article = { ...baseArticle, sourceName: 'Menthas', publisherDomain: 'declared.example.com' }
    const wrapper = mount(NewsCard, { props: { article } })
    expect(metaSpans(wrapper)).toContain('declared.example.com')
    expect(metaSpans(wrapper)).not.toContain('publisher.example.com')
  })
})
