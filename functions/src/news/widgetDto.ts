import { createHash } from 'crypto'
import type { FeedDoc, WidgetFeedResult, WidgetTopic } from './widgetFeed'

export const WIDGET_DTO_VERSION = 1

export interface WidgetArticleDto {
  id: string
  title: string
  sourceName: string
  publishedAt: string | null
  summary?: string
  imageUrl?: string
  url?: string
}

export interface WidgetNewsResponse {
  dtoVersion: 1
  topic: WidgetTopic
  generatedAt: string
  feedDate: string | null
  isSharedFallback: boolean
  revision: string
  totalCount: number
  articles: WidgetArticleDto[]
}

export function toWidgetArticleDto(doc: FeedDoc): WidgetArticleDto {
  const publishedAt = doc.publishedAt
  const article: WidgetArticleDto = {
    id: doc.id,
    title: typeof doc.titleJa === 'string' && doc.titleJa ? doc.titleJa : typeof doc.title === 'string' ? doc.title : '',
    sourceName: typeof doc.sourceName === 'string' ? doc.sourceName : '',
    publishedAt: null,
  }
  if (publishedAt && typeof publishedAt === 'object' && 'toDate' in publishedAt && typeof publishedAt.toDate === 'function') {
    const date: unknown = publishedAt.toDate()
    if (date instanceof Date) article.publishedAt = date.toISOString()
  }
  const summary = typeof doc.summaryJa === 'string' ? doc.summaryJa.trim() : ''
  if (summary) article.summary = summary
  if (typeof doc.url === 'string') {
    try {
      const url = new URL(doc.url)
      if (url.protocol === 'https:') article.url = doc.url
    } catch {
      // 不正な原文URLは返さない。
    }
  }
  if (doc.source !== 'github' && typeof doc.thumbnailUrl === 'string') {
    try {
      const url = new URL(doc.thumbnailUrl)
      if (url.protocol === 'https:' && url.hostname !== 'opengraph.githubassets.com') article.imageUrl = doc.thumbnailUrl
    } catch {
      // 不正な画像URLは返さず、クライアントの代替画像に任せる。
    }
  }
  return article
}

export function computeRevision(feedDate: string | null, articleIds: string[]): string {
  return createHash('sha256').update((feedDate ?? '') + '\n' + articleIds.join('\n')).digest('hex')
}

export function buildWidgetNewsResponse(topic: WidgetTopic, result: WidgetFeedResult, now: Date): WidgetNewsResponse {
  const articles = result.articles.map(toWidgetArticleDto)
  return {
    dtoVersion: WIDGET_DTO_VERSION,
    topic,
    generatedAt: now.toISOString(),
    feedDate: result.feedDate,
    isSharedFallback: result.isSharedFallback,
    revision: computeRevision(result.feedDate, articles.map((article) => article.id)),
    totalCount: articles.length,
    articles,
  }
}
