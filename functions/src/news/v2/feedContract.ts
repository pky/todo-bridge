import { createHash } from 'crypto'
import { toWidgetArticleDto } from '../widgetDto'
import type { FeedDoc } from '../widgetFeed'

export const AI_FEED_V2_SCHEMA_VERSION = 2
export const AI_FEED_V2_MAX_ARTICLES = 20

export const AI_FEED_V2_MAX_BYTES = 1048576

export interface AiFeedV2Article {
  id: string
  title: string
  sourceName: string
  summary: string
  publishedAt: string | null
  url?: string
  imageUrl?: string
  readReason?: string
  publisherDomain?: string
  tags?: string[]
}

export interface AiFeedV2 {
  schemaVersion: 2
  topic: 'ai'
  feedDate: string
  generatedAt: string
  revision: string
  totalCount: number
  articles: AiFeedV2Article[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFeedDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!parts || !isFeedDate(parts[1])) return false
  if (Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) return false
  const zone = parts[5]!
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return false
  return Number.isFinite(Date.parse(value))
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\p{White_Space}\p{Cc}]/u.test(value)) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isArticle(value: unknown): value is AiFeedV2Article {
  if (!isRecord(value)) return false
  if (!['id', 'title', 'sourceName', 'summary'].every((key) => isNonemptyString(value[key]))) return false
  if (value.publishedAt !== null && !isIsoTimestamp(value.publishedAt)) return false
  for (const key of ['url', 'imageUrl']) {
    if (key in value && !isHttpsUrl(value[key])) return false
  }
  for (const key of ['readReason', 'publisherDomain']) {
    if (key in value && !isNonemptyString(value[key])) return false
  }
  if ('tags' in value && (!Array.isArray(value.tags) || !value.tags.every(isNonemptyString))) return false
  return true
}

function isAiFeedV2(value: unknown): value is AiFeedV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.topic !== 'ai') return false
  if (!isFeedDate(value.feedDate) || !isIsoTimestamp(value.generatedAt) || !value.generatedAt.endsWith('Z')) return false
  if (typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)) return false
  if (typeof value.totalCount !== 'number' || !Number.isInteger(value.totalCount) || value.totalCount < 0 || value.totalCount > 20) return false
  if (!Array.isArray(value.articles) || value.articles.length !== value.totalCount || !value.articles.every(isArticle)) return false
  return new Set(value.articles.map((article) => article.id)).size === value.articles.length
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') {
    // JCSでは孤立したサロゲートを許容しない。
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i)
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++i)
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('不正なUnicode文字列です')
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new Error('不正なUnicode文字列です')
      }
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${Array.from(value, canonicalizeJson).join(',')}]`
  if (isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map((key) => `${canonicalizeJson(key)}:${canonicalizeJson(value[key])}`).join(',')}}`
  }
  throw new Error('JSON契約に含まれない値です')
}

type FeedContent = Pick<AiFeedV2, 'schemaVersion' | 'topic' | 'feedDate' | 'totalCount' | 'articles'>

export function computeFeedRevision(value: FeedContent): string {
  const { schemaVersion, topic, feedDate, totalCount, articles } = value
  return createHash('sha256').update(canonicalizeJson({ schemaVersion, topic, feedDate, totalCount, articles }), 'utf8').digest('hex')
}

export function toAiFeedV2Article(doc: FeedDoc): AiFeedV2Article | null {
  // 掲載時刻だけはv2の境界で変換し、不正なTimestampを公開しない。
  const widget = toWidgetArticleDto({ ...doc, publishedAt: null }, 'ai')
  if (!widget.summary) return null
  const article: AiFeedV2Article = { ...widget, summary: widget.summary }
  if (isIsoTimestamp(doc.publishedAt)) {
    article.publishedAt = doc.publishedAt
  } else if (isRecord(doc.publishedAt) && typeof doc.publishedAt.toDate === 'function') {
    try {
      const date: unknown = doc.publishedAt.toDate()
      if (date instanceof Date && Number.isFinite(date.getTime())) article.publishedAt = date.toISOString()
    } catch {
      // 変換できない掲載時刻は未設定として扱う。
    }
  }
  if (article.imageUrl !== undefined && !isHttpsUrl(article.imageUrl)) delete article.imageUrl
  if (typeof doc.publisherDomain === 'string' && doc.publisherDomain.trim()) article.publisherDomain = doc.publisherDomain.trim()
  if (Array.isArray(doc.tags)) {
    const tags = doc.tags.filter(isNonemptyString)
    if (tags.length) article.tags = tags
  }
  return isArticle(article) ? article : null
}

export function validateAiFeedV2(value: unknown): { ok: true; feed: AiFeedV2 } | { ok: false; reason: string } {
  return isAiFeedV2(value) ? { ok: true, feed: value } : { ok: false, reason: 'invalid-feed' }
}

export function buildAiFeedV2(input: Pick<AiFeedV2, 'feedDate' | 'generatedAt' | 'articles'>): AiFeedV2 {
  const content: FeedContent = {
    schemaVersion: AI_FEED_V2_SCHEMA_VERSION,
    topic: 'ai',
    feedDate: input.feedDate,
    totalCount: input.articles.length,
    articles: input.articles,
  }
  const feed: AiFeedV2 = { ...content, generatedAt: input.generatedAt, revision: computeFeedRevision(content) }
  if (!isAiFeedV2(feed)) throw new Error('配信契約を満たさないフィードです')
  if (Buffer.byteLength(JSON.stringify(feed), 'utf8') > AI_FEED_V2_MAX_BYTES) throw new Error('配信サイズ上限を超えています')
  return feed
}
