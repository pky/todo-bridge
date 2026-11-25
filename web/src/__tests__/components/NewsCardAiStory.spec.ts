import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { Timestamp } from 'firebase/firestore'
import NewsCard from '@/components/NewsCard.vue'
import type { NewsArticle } from '@/types'

enableAutoUnmount(afterEach)

const article: NewsArticle = {
  id: 'fictional-card', title: '架空のAI開発ツール更新', summaryJa: '架空の記事の概要です', topic: 'ai',
  source: 'rss', sourceName: '架空技術通信', url: 'https://example.test/card',
  thumbnailUrl: null, score: null, publishedAt: Timestamp.fromMillis(0), fetchedAt: Timestamp.fromMillis(0), date: '2026-11-25',
}

const discussion = 'https://example.test/hn-discussion'
const relatedUrl = 'https://example.test/related'
const toolUrl = 'https://example.test/tool'

describe('NewsCardのAIニュースの話題', () => {
  it.each(['hero', 'featured', 'default'] as const)('%sで概要の下に反応を1行にまとめ、関連リンクを並べる', variant => {
    const story = {
      ...article,
      reactions: [{ source: 'hn' as const, count: 825, url: discussion }, { source: 'github' as const, count: 3200 }],
      related: [
        { sourceName: '架空技術誌', title: '同じ更新の報道', url: relatedUrl },
        { sourceName: '架空ツール集', title: '更新内容の解説', url: toolUrl },
      ],
    }
    const wrapper = mount(NewsCard, { props: { article: story, variant } })
    const reaction = wrapper.get(`a[href="${discussion}"]`)
    expect(reaction.text()).toBe('HN 825pt')
    const reactionLine = wrapper.findAll('*').find(node =>
      node.element.contains(reaction.element) && node.text().replace(/\s+/g, '') === 'HN825pt・GitHub+3.2kstarstoday',
    )
    expect(reactionLine).toBeDefined()
    const firstRelated = wrapper.get(`a[href="${relatedUrl}"]`)
    const secondRelated = wrapper.get(`a[href="${toolUrl}"]`)
    expect(firstRelated.text().replace(/\s+/g, ' ')).toBe('架空技術誌: 同じ更新の報道')
    expect(secondRelated.text().replace(/\s+/g, ' ')).toBe('架空ツール集: 更新内容の解説')
    for (const link of [reaction, firstRelated, secondRelated]) {
      expect(link.attributes('target')).toBe('_blank')
      expect(link.attributes('rel')?.split(/\s+/).sort()).toEqual(['noopener', 'noreferrer'])
    }
    expect(wrapper.findAll('a').some(link => link.text().includes('GitHub'))).toBe(false)
    expect(wrapper.text()).toMatch(/架空の記事の概要です[\s\S]*HN 825pt[\s\S]*関連[\s\S]*同じ更新の報道[\s\S]*更新内容の解説/)
  })

  it('反応と関連がない従来の記事は記事名と概要を表示し、話題のリンクや見出しを追加しない', () => {
    const wrapper = mount(NewsCard, { props: { article } })
    expect(wrapper.text()).toContain(article.title)
    expect(wrapper.text()).toContain(article.summaryJa)
    expect(wrapper.text()).not.toContain('関連')
    expect(wrapper.findAll('a[target="_blank"]')).toHaveLength(0)
    expect(wrapper.get('button[title="あとで読む"]').exists()).toBe(true)
  })
})
