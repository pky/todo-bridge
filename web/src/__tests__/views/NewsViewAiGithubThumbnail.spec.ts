import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import NewsCard from '@/components/NewsCard.vue'
import NewsView from '@/views/NewsView.vue'
import { demoUid, makeFeed } from '../fixtures/aiNewsV2'

const githubArticle = {
  id: 'demo-github-repository',
  title: '架空の GitHub リポジトリ',
  sourceName: 'GitHub',
  summary: '検証用のリポジトリの概要です',
  publishedAt: null,
  url: 'https://github.com/Fictional-Owner7/Fixture_2.js',
}
const feed = makeFeed({ articles: [githubArticle], totalCount: 1 })

vi.mock('vue-router', () => ({ useRoute: () => ({ name: 'news-ai' }), useRouter: () => ({}) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { uid: demoUid }, loading: false }) }))
vi.mock('@/stores/news', () => ({ useNewsStore: () => ({}) }))
vi.mock('@/stores/aiNews', () => ({
  useAiNewsStore: () => ({
    visibleArticles: feed.articles,
    feed,
    feedDate: feed.feedDate,
    loading: false,
    error: null,
    canManage: false,
    load: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  }),
}))

enableAutoUnmount(afterEach)

describe('AI ニュース画面の GitHub サムネイル', () => {
  it('配信記事が GitHub リポジトリ URL を持ち画像が未指定ならカードに OGP を表示する', async () => {
    const wrapper = mount(NewsView)
    await flushPromises()

    const card = wrapper.getComponent(NewsCard)
    expect(card.text()).toContain(githubArticle.title)
    expect(card.findAll('img').map((img) => img.attributes('src'))).toContain(
      'https://opengraph.githubassets.com/1/Fictional-Owner7/Fixture_2.js',
    )
  })
})
