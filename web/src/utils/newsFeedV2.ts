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

export type AiFeedV2ParseResult =
  | { ok: true; feed: AiFeedV2 }
  | { ok: false; reason: 'too-large' | 'invalid-json' | 'unsupported-version' | 'invalid-feed' }

export function parseAiFeedV2(bytes: ArrayBuffer | Uint8Array): AiFeedV2ParseResult {
  if (bytes.byteLength > AI_FEED_V2_MAX_BYTES) return { ok: false, reason: 'too-large' }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  if (!isRecord(value)) return { ok: false, reason: 'invalid-feed' }
  if (value.schemaVersion !== 2) return { ok: false, reason: 'unsupported-version' }
  return isAiFeedV2(value) ? { ok: true, feed: value } : { ok: false, reason: 'invalid-feed' }
}
