import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount, type DOMWrapper } from '@vue/test-utils'
import { Timestamp } from 'firebase/firestore'
import NewsCard from '@/components/NewsCard.vue'
import type { NewsArticle } from '@/types'

enableAutoUnmount(afterEach)

const githubArticle: NewsArticle = {
  id: 'fictional-github-article',
  title: '架空のリポジトリ',
  titleJa: '架空のリポジトリ',
  summaryJa: '架空のリポジトリの概要です',
  url: 'https://github.com/Fictional-Owner7/Fixture_2.js',
  thumbnailUrl: null,
  source: 'github',
  sourceName: '架空の配信元',
  score: null,
  publishedAt: Timestamp.fromMillis(0),
  fetchedAt: Timestamp.fromMillis(0),
  date: '2026-01-01',
}

const generatedImage = 'https://opengraph.githubassets.com/1/Fictional-Owner7/Fixture_2.js'
const ownerAvatar = 'https://avatars.githubusercontent.com/Fictional-Owner7'
const suppliedImage = 'https://images.example.com/news/thumbnail.png'

const layouts = [
  { name: 'デスクトップの横長枠', variant: 'hero', selector: 'div.bg-surface-alt[class~="lg:block"]' },
  { name: 'スマホの正方形枠', variant: 'hero', selector: 'div.bg-surface-alt[class~="lg:hidden"]' },
  { name: '通常カードの画像枠', variant: 'default', selector: 'div.bg-surface-alt.overflow-hidden' },
] as const

const repositoryUrls = [
  { name: 'リポジトリURL', url: githubArticle.url },
  { name: 'www 付きで末尾にスラッシュがあるURL', url: 'https://www.github.com/Fictional-Owner7/Fixture_2.js/' },
  { name: '後続パスがあるURL', url: `${githubArticle.url}/issues/123` },
]

const invalidRepositoryUrls = [
  { name: 'owner に不正な文字があるURL', url: 'https://github.com/Fictional@Owner7/Fixture_2.js' },
  { name: 'repo に不正な文字があるURL', url: 'https://github.com/Fictional-Owner7/Fixture%202.js' },
  { name: 'github.com で始まる別ホストのURL', url: 'https://github.com.example.com/Fictional-Owner7/Fixture_2.js' },
]

function mountThumbnail(article: NewsArticle, { variant, selector }: (typeof layouts)[number]) {
  const wrapper = mount(NewsCard, { props: { article, variant } })
  return () => wrapper.get(selector)
}

function expectImage(thumbnail: DOMWrapper<Element>, src: string) {
  expect(thumbnail.findAll('img').map((img) => img.attributes('src'))).toEqual([src])
}

function expectTextFallback(thumbnail: DOMWrapper<Element>) {
  expect(thumbnail.find('img').exists()).toBe(false)
  expect(thumbnail.text()).toBe(githubArticle.sourceName)
}

describe('ニュースカードの GitHub サムネイル', () => {
  for (const layout of layouts) {
    describe(layout.name, () => {
      it.each(repositoryUrls)('$name では生成したOGP、アイコン、配信元名の順に表示する', async ({ url }) => {
        const thumbnail = mountThumbnail({ ...githubArticle, url }, layout)

        expectImage(thumbnail(), generatedImage)
        await thumbnail().get('img').trigger('error')
        expectImage(thumbnail(), ownerAvatar)
        await thumbnail().get('img').trigger('error')
        expectTextFallback(thumbnail())
      })

      it('保存済み画像を優先し、失敗したらアイコン、配信元名の順に表示する', async () => {
        const thumbnail = mountThumbnail({ ...githubArticle, thumbnailUrl: suppliedImage }, layout)

        expectImage(thumbnail(), suppliedImage)
        await thumbnail().get('img').trigger('error')
        expectImage(thumbnail(), ownerAvatar)
        await thumbnail().get('img').trigger('error')
        expectTextFallback(thumbnail())
      })

      it.each(invalidRepositoryUrls)('$name で保存済み画像がなければ配信元名を表示する', ({ url }) => {
        const thumbnail = mountThumbnail({ ...githubArticle, url }, layout)

        expectTextFallback(thumbnail())
      })

      it.each(invalidRepositoryUrls)('$name では保存済み画像を表示し、失敗したら配信元名を表示する', async ({ url }) => {
        const thumbnail = mountThumbnail({ ...githubArticle, url, thumbnailUrl: suppliedImage }, layout)

        expectImage(thumbnail(), suppliedImage)
        await thumbnail().get('img').trigger('error')
        expectTextFallback(thumbnail())
      })

      it('RSS 記事の GitHub OGP を表示し、失敗したら配信元名を表示する', async () => {
        const thumbnailUrl = 'https://opengraph.githubassets.com/1/fictional-feed/supplied-image'
        const thumbnail = mountThumbnail({ ...githubArticle, source: 'rss', thumbnailUrl }, layout)

        expectImage(thumbnail(), thumbnailUrl)
        await thumbnail().get('img').trigger('error')
        expectTextFallback(thumbnail())
      })

      it('RSS 記事に保存済み画像がなければ GitHub のリポジトリURLでも配信元名を表示する', () => {
        const thumbnail = mountThumbnail({ ...githubArticle, source: 'rss' }, layout)

        expectTextFallback(thumbnail())
      })
    })
  }
})
