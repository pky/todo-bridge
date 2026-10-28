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

  it('mobileSummary があれば4行表示を使い summaryJa の段落を出さない', () => {
    const wrapper = mount(NewsCard, {
      props: {
        article: {
          ...article,
          mobileSummary: {
            overview: '概要文',
            target: 'iOS 27',
            deadline: '2026-11-30',
            action: '更新する',
          },
        },
      },
    })

    const text = wrapper.text()
    expect(text).toContain('概要: 概要文')
    expect(text).toContain('対象: iOS 27')
    expect(text).toContain('期限: 2026-11-30')
    expect(text).toContain('やること: 更新する')
    const summary = wrapper.findAll('p').find((node) => node.text() === article.summaryJa)
    expect(summary).toBeUndefined()
  })

  it('mobileSummary がなければ従来どおり summaryJa を表示する', () => {
    const wrapper = mount(NewsCard, {
      props: {
        article,
      },
    })

    const summary = wrapper.findAll('p').find((node) => node.text() === article.summaryJa)
    expect(summary).toBeTruthy()
    expect(wrapper.text()).not.toContain('概要: ')
  })
})

import { afterEach } from 'vitest'
import { enableAutoUnmount } from '@vue/test-utils'
import { Timestamp } from 'firebase/firestore'

enableAutoUnmount(afterEach)

const baseArticle: NewsArticle = {
  id: 'fictional-article', title: '架空の開発手法の記事', summaryJa: '評価の手順を解説する概要です',
  url: 'https://example.com/article', thumbnailUrl: null, source: 'rss', sourceName: '架空の技術フィード',
  topic: 'ai', score: null, publishedAt: Timestamp.fromMillis(0), fetchedAt: Timestamp.fromMillis(0),
  date: '2026-01-01',
}
const readReason = 'モデル評価を開発時の比較に取り入れられる'

describe('ニュースカードの読む理由', () => {
  for (const variant of ['default', 'hero', 'featured'] as const) {
    it(`${variant}表示のAI記事に読む理由を表示する`, () => {
      const article = { ...baseArticle, developerValue: 'high' as const, readReason }
      const wrapper = mount(NewsCard, { props: { article, variant } })
      expect(wrapper.text()).toContain(readReason)
      expect(wrapper.text()).toContain(baseArticle.summaryJa)
    })
  }

  it('読む理由がない旧記事には理由のラベルを表示しない', () => {
    const wrapper = mount(NewsCard, { props: { article: baseArticle } })
    expect(wrapper.text()).not.toContain('読む理由')
    expect(wrapper.text()).toContain(baseArticle.summaryJa)
  })

  it('モバイル記事にはAI向けの読む理由を表示しない', () => {
    const article = { ...baseArticle, topic: 'mobile' as const, readReason }
    const wrapper = mount(NewsCard, { props: { article } })
    expect(wrapper.text()).not.toContain(readReason)
  })
})

describe('ニュース概要の根拠表示', () => {
  for (const variant of ['default', 'hero', 'featured'] as const) {
    it(`${variant}表示では説明文だけを根拠にした概要を明示する`, () => {
      const article = {
        ...baseArticle, developerValue: 'high' as const,
        summaryStatus: 'generated' as const, summarySource: 'description' as const,
      }
      const wrapper = mount(NewsCard, { props: { article, variant } })
      expect(wrapper.text()).toContain('説明文をもとに作成')
    })

    it(`${variant}表示では失敗時の代替が元の説明文であると明示する`, () => {
      const article = { ...baseArticle, developerValue: 'high' as const, summaryStatus: 'fallback' as const }
      const wrapper = mount(NewsCard, { props: { article, variant } })
      expect(wrapper.text()).toContain('元の説明文')
    })
  }
})
