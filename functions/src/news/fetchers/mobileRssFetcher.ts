import Parser from 'rss-parser'
import { classifyMobileArticle } from '../mobileClassifier'
import { MOBILE_SOURCES } from './mobileSources'
import type { RawArticle } from '../types'

const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
    ],
  },
})

function extractImgFromHtml(html: string): string | null {
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/)
  return match ? match[1] : null
}

function extractThumbnail(item: Record<string, unknown>): string | null {
  const mediaContent = item.mediaContent as { $?: { url?: string } } | undefined
  if (mediaContent?.$?.url) return mediaContent.$.url

  const mediaThumbnail = item.mediaThumbnail as { $?: { url?: string } } | undefined
  if (mediaThumbnail?.$?.url) return mediaThumbnail.$.url

  const enclosure = item.enclosure as { url?: string } | undefined
  if (enclosure?.url) return enclosure.url

  const htmlContent = (item['content:encoded'] || item.content || '') as string
  return htmlContent ? extractImgFromHtml(htmlContent) : null
}

export async function fetchMobileRssArticles(): Promise<RawArticle[]> {
  const sources = MOBILE_SOURCES.filter((source) => source.kind === 'rss' || source.kind === 'atom')
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const parsed = await parser.parseURL(source.url)
        const limit = source.limit ?? 10

        return parsed.items.slice(0, limit).flatMap((item) => {
          if (!item.link) return []

          const title = item.title || ''
          const description = item.contentSnippet || item.content || ''
          const thumbnailUrl = extractThumbnail(item as unknown as Record<string, unknown>)
          const { actionRequired, actionType, importantLevel, requiredByDate } = classifyMobileArticle({ title, description })

          return [{
            title,
            url: item.link,
            description,
            thumbnailUrl,
            topic: 'mobile',
            source: source.isOfficial ? 'official' : 'rss',
            sourceName: source.name,
            sourceTier: source.sourceTier,
            platform: source.platform,
            isOfficial: source.isOfficial,
            actionRequired,
            actionType,
            importantLevel,
            ...(requiredByDate ? { requiredByDate } : {}),
            score: null,
            publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
          }] satisfies RawArticle[]
        })
      } catch (err) {
        console.error(`[mobile-rss] Failed to fetch ${source.name}:`, err)
        return [] as RawArticle[]
      }
    })
  )

  return results.flat()
}
