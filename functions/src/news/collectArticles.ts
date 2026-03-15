// functions/src/news/collectArticles.ts
import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { fetchHNArticles } from './fetchers/hnFetcher'
import { fetchRSSArticles } from './fetchers/rssFetcher'
import { fetchGitHubTrending } from './fetchers/githubTrendingFetcher'
import { fetchOfficialMobileHtmlArticles } from './fetchers/mobileOfficialFetcher'
import { fetchMobileRssArticles } from './fetchers/mobileRssFetcher'
import { scrapeArticle } from './scraper'
import type { RawArticle, NewsArticle, NewsTopic, SourceTier } from './types'

const db = admin.firestore()
const OFFICIAL_MOBILE_MAX_AGE_DAYS = 14
const COMMUNITY_MOBILE_MAX_AGE_DAYS = 30

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    const params = new URLSearchParams(u.search)
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
    ]

    for (const key of trackingParams) {
      params.delete(key)
    }

    const normalizedPath = `${u.hostname}${u.pathname}`.replace(/\/$/, '')
    const normalizedSearch = params.toString()

    return normalizedSearch
      ? `${normalizedPath}?${normalizedSearch}`
      : normalizedPath
  } catch {
    return url
  }
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~]/g, '')
}

function getArticleIdentityKey(article: RawArticle): string {
  const normalizedUrl = normalizeUrl(article.url)
  const publishedDate = article.publishedAt.toISOString().slice(0, 10)

  return [
    article.platform ?? 'unknown',
    normalizedUrl,
    publishedDate,
  ].join('::')
}

function getApproximateIdentityKey(article: RawArticle): string {
  const normalizedTitle = normalizeTitle(article.title)
  const publishedDate = article.publishedAt.toISOString().slice(0, 10)

  return [
    article.platform ?? 'unknown',
    normalizedTitle,
    publishedDate,
  ].join('::')
}

export function deduplicateArticles(articles: RawArticle[]): RawArticle[] {
  const seen = new Set<string>()
  return articles.filter(a => {
    const key = normalizeUrl(a.url)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function getSourceTierRank(sourceTier?: SourceTier): number {
  switch (sourceTier) {
    case 'official':
      return 3
    case 'official-rss':
      return 2
    case 'community-rss':
      return 1
    default:
      return 0
  }
}

export function deduplicateArticlesByPriority(articles: RawArticle[]): RawArticle[] {
  const pickedByIdentity = new Map<string, RawArticle>()

  for (const article of articles) {
    const identityKey = getArticleIdentityKey(article)
    const existing = pickedByIdentity.get(identityKey)

    if (!existing || getSourceTierRank(article.sourceTier) > getSourceTierRank(existing.sourceTier)) {
      pickedByIdentity.set(identityKey, article)
    }
  }

  const pickedByApproximateIdentity = new Map<string, RawArticle>()

  for (const article of pickedByIdentity.values()) {
    const approximateKey = getApproximateIdentityKey(article)
    const existing = pickedByApproximateIdentity.get(approximateKey)

    if (!existing || getSourceTierRank(article.sourceTier) > getSourceTierRank(existing.sourceTier)) {
      pickedByApproximateIdentity.set(approximateKey, article)
    }
  }

  return Array.from(pickedByApproximateIdentity.values())
}

export function filterMobileArticlesByFreshness(
  articles: RawArticle[],
  now: Date = new Date()
): RawArticle[] {
  return articles.filter((article) => {
    const ageMs = now.getTime() - article.publishedAt.getTime()
    if (ageMs < 0) return true

    const ageDays = ageMs / (24 * 60 * 60 * 1000)
    if (article.sourceTier === 'community-rss') {
      return ageDays <= COMMUNITY_MOBILE_MAX_AGE_DAYS
    }

    return ageDays <= OFFICIAL_MOBILE_MAX_AGE_DAYS
  })
}

async function saveArticlesForTopic(topic: NewsTopic, rawArticles: RawArticle[]): Promise<void> {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const collectionRef = db.collection(`topics/${topic}/articles`)

  const existingSnap = await collectionRef.where('date', '==', today).get()
  const processedUrls = new Set(existingSnap.docs.map(d => (d.data() as NewsArticle).url))
  console.log(`[collectArticles:${topic}] Already saved: ${processedUrls.size} articles today`)

  const articlesToProcess = rawArticles.filter(raw => !processedUrls.has(raw.url))
  const skippedCount = rawArticles.length - articlesToProcess.length
  let newCount = 0
  const CONCURRENCY = 5

  for (let i = 0; i < articlesToProcess.length; i += CONCURRENCY) {
    const chunk = articlesToProcess.slice(i, i + CONCURRENCY)
    const batch = db.batch()

    const promises = chunk.map(async (raw) => {
      try {
        const { ogImage, content } = await scrapeArticle(raw.url).catch(err => {
          console.warn(`[collectArticles:${topic}] Scrape warning for ${raw.url}:`, err.message)
          return { ogImage: null, content: '' }
        })
        const thumbnailUrl = raw.thumbnailUrl ?? ogImage

        const article: NewsArticle = {
          title: raw.title,
          description: raw.description,
          ...(content ? { content } : {}),
          url: raw.url,
          thumbnailUrl,
          topic,
          source: raw.source,
          sourceName: raw.sourceName,
          ...(raw.sourceTier ? { sourceTier: raw.sourceTier } : {}),
          ...(raw.platform ? { platform: raw.platform } : {}),
          ...(typeof raw.isOfficial === 'boolean' ? { isOfficial: raw.isOfficial } : {}),
          ...(typeof raw.actionRequired === 'boolean' ? { actionRequired: raw.actionRequired } : {}),
          ...(raw.actionType ? { actionType: raw.actionType } : {}),
          ...(raw.importantLevel ? { importantLevel: raw.importantLevel } : {}),
          ...(raw.requiredByDate ? { requiredByDate: raw.requiredByDate } : {}),
          score: raw.score,
          publishedAt: admin.firestore.Timestamp.fromDate(raw.publishedAt),
          fetchedAt: admin.firestore.Timestamp.now(),
          date: today,
        }

        const docRef = collectionRef.doc()
        batch.set(docRef, article)
        return true
      } catch (err) {
        console.error(`[collectArticles:${topic}] Failed to process ${raw.url}:`, err)
        return false
      }
    })

    const results = await Promise.all(promises)
    newCount += results.filter(success => success).length
    await batch.commit()
  }

  console.log(`[collectArticles:${topic}] Saved ${newCount} new articles, skipped ${skippedCount} already saved`)

  try {
    const retentionDays = 14
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const cutoffDateString = new Date(cutoffDate.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)

    console.log(`[collectArticles:${topic}] Cleaning up articles older than ${cutoffDateString}...`)
    const oldArticlesSnap = await collectionRef.where('date', '<', cutoffDateString).get()

    if (!oldArticlesSnap.empty) {
      const deleteBatch = db.batch()
      let deleteCount = 0

      oldArticlesSnap.docs.forEach(doc => {
        if (deleteCount < 500) {
          deleteBatch.delete(doc.ref)
          deleteCount++
        }
      })

      if (deleteCount > 0) {
        await deleteBatch.commit()
        console.log(`[collectArticles:${topic}] Deleted ${deleteCount} old articles.`)
      }
    } else {
      console.log(`[collectArticles:${topic}] No old articles to delete.`)
    }
  } catch (err) {
    console.error(`[collectArticles:${topic}] Failed to cleanup old articles:`, err)
  }
}

export const collectArticles = functions
  .region('asia-northeast1')
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub.schedule('0 6 * * *').timeZone('Asia/Tokyo')  // 毎朝6時 JST
  .onRun(async () => {
    console.log('[collectArticles] Starting...')

    // 1. 各ソースから記事を収集
    const [hnArticles, rssArticles, githubArticles] = await Promise.all([
      fetchHNArticles(50).catch(e => { console.error('[hn]', e); return [] as RawArticle[] }),
      fetchRSSArticles(10).catch(e => { console.error('[rss]', e); return [] as RawArticle[] }),
      fetchGitHubTrending(10).catch(e => { console.error('[github]', e); return [] as RawArticle[] }),
    ])

    console.log(`[collectArticles] Sources: hn=${hnArticles.length}, rss=${rssArticles.length}, github=${githubArticles.length}`)
    const allRaw = deduplicateArticles([...hnArticles, ...rssArticles, ...githubArticles])
    console.log(`[collectArticles] Collected ${allRaw.length} articles after dedup`)
    await saveArticlesForTopic('ai', allRaw)
  })

export const collectMobileArticles = functions
  .region('asia-northeast1')
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub.schedule('10 6 * * *').timeZone('Asia/Tokyo')
  .onRun(async () => {
    console.log('[collectMobileArticles] Starting...')

    const [officialHtmlArticles, rssArticles] = await Promise.all([
      fetchOfficialMobileHtmlArticles().catch(e => { console.error('[mobile-official]', e); return [] as RawArticle[] }),
      fetchMobileRssArticles().catch(e => { console.error('[mobile-rss]', e); return [] as RawArticle[] }),
    ])

    console.log(`[collectMobileArticles] Sources: officialHtml=${officialHtmlArticles.length}, rss=${rssArticles.length}`)
    const freshArticles = filterMobileArticlesByFreshness([...officialHtmlArticles, ...rssArticles])
    const allRaw = deduplicateArticlesByPriority(freshArticles)
    console.log(`[collectMobileArticles] Collected ${allRaw.length} articles after freshness filter + dedup`)

    await saveArticlesForTopic('mobile', allRaw)
  })
