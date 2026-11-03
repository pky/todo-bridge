import { AI_FEED_V2_MAX_BYTES, validateAiFeedV2, type AiFeedV2 } from './feedContract'

export interface FeedObject { data: Buffer; generation: string }
export interface FeedBucket {
  read(path: string): Promise<FeedObject | null>
  write(path: string, data: Buffer, opts: {
    ifGenerationMatch: string | number; contentType: string; cacheControl: string
  }): Promise<{ generation: string }>
}
export class PreconditionFailedError extends Error {}
export const AI_FEED_LATEST_PATH = 'news/v2/ai/latest.json'
export const aiFeedDailyPath = (feedDate: string): string => `news-private/v2/ai/daily/${feedDate}.json`
export const aiFeedPublishedPath = (feedDate: string): string => `news-private/v2/ai/published/${feedDate}.json`

export interface AiFeedDaily {
  schemaVersion: 2
  topic: 'ai'
  feedDate: string
  learningCutoffAt: string
  feed: AiFeedV2
  actionArticles: Array<{ id: string; title: string; summary: string; url?: string; titleEn?: string; tags?: string[] }>
}
export type PublishResult = { status: 'published' | 'already' | 'skipped-newer' | 'skipped-same-day-conflict' }
const metadata = { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' }
const feedKeys = new Set(['schemaVersion', 'topic', 'feedDate', 'generatedAt', 'revision', 'totalCount', 'articles'])
const articleKeys = new Set(['id', 'title', 'sourceName', 'publishedAt', 'summary', 'url', 'imageUrl', 'readReason', 'publisherDomain', 'tags'])

function feedBytes(feed: AiFeedV2): Buffer {
  if (!validateAiFeedV2(feed).ok
    || Object.keys(feed).some(key => !feedKeys.has(key))
    || feed.articles.some(article => Object.keys(article).some(key => !articleKeys.has(key)))) {
    throw new Error('配信契約を満たさないフィードです')
  }
  const bytes = Buffer.from(JSON.stringify(feed), 'utf8')
  if (bytes.length > AI_FEED_V2_MAX_BYTES) throw new Error('配信サイズ上限を超えています')
  return bytes
}

function validateDaily(daily: AiFeedDaily): void {
  feedBytes(daily.feed)
  if (daily.schemaVersion !== 2 || daily.topic !== 'ai' || daily.feedDate !== daily.feed.feedDate) {
    throw new Error('日次原本の識別情報が不正です')
  }
}

export async function saveDailyIfAbsent(bucket: FeedBucket, daily: AiFeedDaily): Promise<AiFeedDaily> {
  validateDaily(daily)
  try {
    await bucket.write(aiFeedDailyPath(daily.feedDate), Buffer.from(JSON.stringify(daily)), { ...metadata, ifGenerationMatch: 0 })
    return daily
  } catch (err) {
    if (!(err instanceof PreconditionFailedError)) throw err
    const existing = await bucket.read(aiFeedDailyPath(daily.feedDate))
    if (!existing) throw new Error('競合した日次原本がありません')
    const saved: AiFeedDaily = JSON.parse(existing.data.toString('utf8'))
    validateDaily(saved)
    return saved
  }
}

async function recordPublished(bucket: FeedBucket, feed: AiFeedV2, generation: string, nowIso: string): Promise<void> {
  try {
    await bucket.write(aiFeedPublishedPath(feed.feedDate), Buffer.from(JSON.stringify({
      feedDate: feed.feedDate, revision: feed.revision, publishedAt: nowIso, latestGeneration: generation,
    })), { ...metadata, ifGenerationMatch: 0 })
  } catch (err) {
    if (!(err instanceof PreconditionFailedError)) throw err
  }
}

export async function publishDaily(bucket: FeedBucket, daily: AiFeedDaily, nowIso: string): Promise<PublishResult> {
  validateDaily(daily)
  const bytes = feedBytes(daily.feed)
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.read(AI_FEED_LATEST_PATH)
    if (object) {
      const latest: AiFeedV2 = JSON.parse(object.data.toString('utf8'))
      feedBytes(latest)
      if (latest.feedDate > daily.feedDate) return { status: 'skipped-newer' }
      if (latest.feedDate === daily.feedDate) {
        if (latest.revision !== daily.feed.revision) return { status: 'skipped-same-day-conflict' }
        await recordPublished(bucket, latest, object.generation, nowIso)
        return { status: 'already' }
      }
      if (!await bucket.read(aiFeedPublishedPath(latest.feedDate))) {
        const old = await bucket.read(aiFeedDailyPath(latest.feedDate))
        if (old) {
          const previous: AiFeedDaily = JSON.parse(old.data.toString('utf8'))
          validateDaily(previous)
          if (previous.feedDate === latest.feedDate && previous.feed.revision === latest.revision) {
            await recordPublished(bucket, latest, object.generation, nowIso)
          }
        }
      }
    }
    let written: { generation: string }
    try {
      written = await bucket.write(AI_FEED_LATEST_PATH, bytes, { ...metadata, ifGenerationMatch: object?.generation ?? 0 })
    } catch (err) {
      if (err instanceof PreconditionFailedError) continue
      throw err
    }
    await recordPublished(bucket, daily.feed, written.generation, nowIso)
    return { status: 'published' }
  }
  throw new Error('公開の世代競合が再試行上限に達しました')
}
