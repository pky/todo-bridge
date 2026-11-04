import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { Timestamp } from 'firebase/firestore'
import NewsCard from '@/components/NewsCard.vue'
import type { NewsArticle } from '@/types'

enableAutoUnmount(afterEach)
const article: NewsArticle = {
  id: 'demo-card', title: '架空のAI開発ツール更新', summaryJa: '検証用の架空記事です',
  source: 'rss', sourceName: '架空技術通信', url: 'https://example.test/card',
  thumbnailUrl: null, score: null, publishedAt: Timestamp.fromMillis(0), fetchedAt: Timestamp.fromMillis(0), date: '2026-11-03',
}

describe('NewsCardのAI管理状態', () => {
  it.each([
    ['idle', 'あとで読む', false], ['sending', '追加中…', true],
    ['added', '追加済み', true], ['unknown', '未確認・再試行', false],
  ] as const)('%sは「%s」でdisabled=%s', (readLaterState, label, disabled) => {
    const wrapper = mount(NewsCard, { props: { article, readLaterState } })
    const button = wrapper.findAll('button').find(node => node.text().includes(label) || node.attributes('title') === label || node.attributes('aria-label') === label)
    expect(button, `「${label}」で操作を識別できる`).toBeDefined()
    expect(button?.element.disabled).toBe(disabled)
    if (readLaterState !== 'idle') expect(button?.text()).toContain(label)
  })

  it.each(['hero', 'featured', 'default'] as const)('canManage=falseなら%sの管理ボタンを出さない', variant => {
    const wrapper = mount(NewsCard, { props: { article, variant, canManage: false } })
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.text()).toContain(article.title)
  })

  it('props省略時は既存のあとで読む・興味なし操作を維持する', async () => {
    const wrapper = mount(NewsCard, { props: { article } })
    const bookmark = wrapper.get('button[title="あとで読む"]')
    const dismiss = wrapper.get('button[title="興味なし"]')
    expect(bookmark.element.disabled).toBe(false)
    expect(dismiss.element.disabled).toBe(false)
    await bookmark.trigger('click')
    await dismiss.trigger('click')
    expect(wrapper.emitted('bookmark')).toEqual([[article]])
    expect(wrapper.emitted('dismiss')).toEqual([[article]])
  })

  it.each(['sending', 'added'] as const)('%sの無効ボタンから二重送信しない', async readLaterState => {
    const wrapper = mount(NewsCard, { props: { article, readLaterState } })
    const button = wrapper.findAll('button').find(node => /追加中|追加済み/.test(node.text()))
    expect(button).toBeDefined()
    await button?.trigger('click')
    expect(wrapper.emitted('bookmark')).toBeUndefined()
  })
})
