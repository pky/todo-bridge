// functions/src/news/collectArticles.ts
import * as admin from 'firebase-admin'
import axios from 'axios'
import { fetchHNArticles } from './fetchers/hnFetcher'
import { fetchRSSArticles } from './fetchers/rssFetcher'
import { fetchGitHubTrending } from './fetchers/githubTrendingFetcher'
import { fetchOfficialMobileHtmlArticles } from './fetchers/mobileOfficialFetcher'
import { fetchMobileRssArticles } from './fetchers/mobileRssFetcher'
import { scrapeArticle } from './scraper'
import {
  classifyMobileArticles,
  createClaudeMessagesClient,
  getClaudeNewsConfig,
  type ClassificationInput,
  type ClassificationResult,
} from './mobileClaudeClassifier'
import { createClaudeMessagesClient as createAiClaudeMessagesClient } from './claudeClient'
import { createClaudeDailyRequestReservation } from './claudeDailyBudget'
import { triageAiArticles, getAiTriageConfig, type TriageInput, type TriageResult } from './aiClaudeTriage'
import { AI_REUSE_MAX_AGE_MS, AI_TRIAGE_VERSION, isSyntheticGithubDescription } from './aiSelection'
import type { RawArticle, NewsArticle, NewsTopic, SourceTier } from './types'

const db = admin.firestore()
export const MOBILE_CLASSIFICATION_DEADLINE_MS = 240000
export const AI_TRIAGE_DEADLINE_MS = 120000
export const AI_SCRAPE_DEADLINE_MS = 60000
const AI_README_MAX_LENGTH = 5000
const CLEANUP_BATCH_SIZE = 500
const CLEANUP_MAX_ROUNDS = 20
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

export function planAiArticleProcessing(
  raws: RawArticle[],
  existing: NewsArticle[],
  now: number = Date.now()
): { reuse: Array<{ raw: RawArticle; source: NewsArticle }>; fresh: RawArticle[] } {
  const doneByUrl = new Map<string, NewsArticle[]>()
  for (const article of existing) {
    if (article.triageStatus !== 'done' || article.triageVersion !== AI_TRIAGE_VERSION) continue
    if (typeof article.triagedAt !== 'number' || now - article.triagedAt > AI_REUSE_MAX_AGE_MS) continue
    const key = normalizeUrl(article.url)
    const list = doneByUrl.get(key)
    if (list) list.push(article)
    else doneByUrl.set(key, [article])
  }
  const reuse: Array<{ raw: RawArticle; source: NewsArticle }> = []
  const fresh: RawArticle[] = []
  for (const raw of raws) {
    const title = normalizeTitle(raw.title)
    const source = doneByUrl.get(normalizeUrl(raw.url))?.find(candidate => normalizeTitle(candidate.title) === title)
    if (source) reuse.push({ raw, source })
    else fresh.push(raw)
  }
  return { reuse, fresh }
}

export function buildTriageInput(id: string, raw: RawArticle): TriageInput {
  let domain = ''
  try { domain = new URL(raw.url).hostname } catch { /* 不正なURLではドメインを送らない。 */ }
  const description = raw.source === 'github' && isSyntheticGithubDescription(raw.description) ? '' : raw.description.slice(0, 300)
  return { id, title: raw.title, sourceName: raw.sourceName, description, domain }
}

function buildAiBase(raw: RawArticle, today: string, fetchedAt: admin.firestore.Timestamp): NewsArticle {
  return {
    title: raw.title,
    description: raw.description,
    url: raw.url,
    normalizedUrl: normalizeUrl(raw.url),
    thumbnailUrl: raw.thumbnailUrl,
    topic: 'ai',
    source: raw.source,
    sourceName: raw.sourceName,
    ...(raw.publisherDomain ? { publisherDomain: raw.publisherDomain } : {}),
    ...(typeof raw.generalSource === 'boolean' ? { generalSource: raw.generalSource } : {}),
    score: raw.score,
    publishedAt: admin.firestore.Timestamp.fromDate(raw.publishedAt),
    fetchedAt,
    date: today,
  }
}

export function buildTriagedAiArticle(
  raw: RawArticle, content: string, result: TriageResult | null,
  today: string, fetchedAt: admin.firestore.Timestamp
): NewsArticle {
  const base = buildAiBase(raw, today, fetchedAt)
  if (!result) return { ...base, triageStatus: 'pending' }
  return {
    ...base,
    triageStatus: 'done',
    triageVersion: AI_TRIAGE_VERSION,
    ...(result.decision ? { triageDecision: result.decision } : {}),
    ...(result.category ? { category: result.category } : {}),
    relevant: result.relevant,
    importance: result.importance,
    ...(result.developerValue ? { developerValue: result.developerValue, readReason: result.readReason ?? '' } : {}),
    tags: result.tags,
    triagedAt: fetchedAt.toMillis(),
    ...(result.relevant && content ? { content } : {}),
  }
}

export function buildReusedAiArticle(
  raw: RawArticle, source: NewsArticle,
  today: string, fetchedAt: admin.firestore.Timestamp
): NewsArticle {
  return {
    ...buildAiBase(raw, today, fetchedAt),
    thumbnailUrl: raw.thumbnailUrl ?? source.thumbnailUrl,
    triageStatus: 'done',
    ...(source.triageVersion ? { triageVersion: source.triageVersion } : {}),
    ...(source.triageDecision ? { triageDecision: source.triageDecision } : {}),
    ...(source.category ? { category: source.category } : {}),
    ...(typeof source.triagedAt === 'number' ? { triagedAt: source.triagedAt } : {}),
    ...(typeof source.relevant === 'boolean' ? { relevant: source.relevant } : {}),
    ...(source.developerValue ? { developerValue: source.developerValue, readReason: source.readReason ?? '' } : {}),
    ...(source.importance ? { importance: source.importance } : {}),
    ...(source.tags ? { tags: source.tags } : {}),
    ...(source.content !== undefined ? { content: source.content } : {}),
    ...(source.titleJa !== undefined ? { titleJa: source.titleJa } : {}),
    ...(source.summaryJa !== undefined ? { summaryJa: source.summaryJa } : {}),
    ...(source.summaryVersion ? { summaryVersion: source.summaryVersion } : {}),
    ...(source.summaryStatus ? { summaryStatus: source.summaryStatus } : {}),
    ...(source.summarySource ? { summarySource: source.summarySource } : {}),
    ...(typeof source.summarizedAt === 'number' ? { summarizedAt: source.summarizedAt } : {}),
  }
}

export function cleanReadmeText(markdown: string): string {
  return markdown
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseGithubRepoPath(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null
    const [owner, repo] = u.pathname.split('/').filter(Boolean)
    return owner && repo ? `${owner}/${repo}` : null
  } catch {
    return null
  }
}

async function fetchGithubReadme(repoPath: string, options: { signal?: AbortSignal }): Promise<string> {
  const { data } = await axios.get<string>(`https://raw.githubusercontent.com/${repoPath}/HEAD/README.md`, {
    timeout: 8000,
    responseType: 'text',
    maxContentLength: 500_000,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return typeof data === 'string' ? data : ''
}

export async function scrapeAiArticles(
  raws: RawArticle[],
  deps: {
    deadlineAt?: number; now?: () => number; scrape?: typeof scrapeArticle
    fetchReadme?: (repoPath: string, options: { signal?: AbortSignal }) => Promise<string>
  } = {}
): Promise<Array<{ raw: RawArticle; content: string }>> {
  const now = deps.now ?? Date.now
  const deadlineAt = deps.deadlineAt ?? now() + AI_SCRAPE_DEADLINE_MS
  const scrape = deps.scrape ?? scrapeArticle
  const fetchReadme = deps.fetchReadme ?? fetchGithubReadme
  const results: Array<{ raw: RawArticle; content: string }> = []
  for (let i = 0; i < raws.length; i += 5) {
    const batch = raws.slice(i, i + 5)
    const scraped = await Promise.all(batch.map(async (raw) => {
      const remaining = deadlineAt - now()
      if (remaining <= 0) return { raw, content: '' }
      const signal = AbortSignal.timeout(Math.max(remaining, 1))
      try {
        const { content, ogImage } = await scrape(raw.url, { signal })
        const scrapedRaw = { raw: { ...raw, thumbnailUrl: raw.thumbnailUrl ?? ogImage } }
        if (content || raw.source !== 'github') return { ...scrapedRaw, content }
        const repoPath = parseGithubRepoPath(raw.url)
        const readmeRemaining = deadlineAt - now()
        if (!repoPath || readmeRemaining <= 0) return { ...scrapedRaw, content }
        try {
          const readme = await fetchReadme(repoPath, { signal: AbortSignal.timeout(Math.max(readmeRemaining, 1)) })
          return { ...scrapedRaw, content: cleanReadmeText(readme).slice(0, AI_README_MAX_LENGTH) }
        } catch {
          return { ...scrapedRaw, content }
        }
      } catch {
        return { raw, content: '' }
      }
    }))
    results.push(...scraped)
  }
  return results
}

async function fetchExistingAiArticles(): Promise<NewsArticle[]> {
  // 生URLの完全一致では追跡パラメーター違いを取りこぼすため、判定済み記事を正規化して照合する。
  const snap = await db.collection('topics/ai/articles').where('triageVersion', '==', AI_TRIAGE_VERSION).get()
  return snap.docs.map(doc => doc.data() as NewsArticle)
}

export async function cleanupOldArticles(topic: NewsTopic): Promise<void> {
  const collectionRef = db.collection(`topics/${topic}/articles`)
  try {
    const retentionDays = 14
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const cutoffDateString = new Date(cutoffDate.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)

    console.log(`[collectArticles:${topic}] Cleaning up articles older than ${cutoffDateString}...`)
    let deleted = 0
    for (let round = 0; round < CLEANUP_MAX_ROUNDS; round++) {
      const oldArticlesSnap = await collectionRef.where('date', '<', cutoffDateString).limit(CLEANUP_BATCH_SIZE).get()
      if (oldArticlesSnap.empty) break
      const deleteBatch = db.batch()
      oldArticlesSnap.docs.forEach(doc => deleteBatch.delete(doc.ref))
      await deleteBatch.commit()
      deleted += oldArticlesSnap.docs.length
    }
    console.log(`[collectArticles:${topic}] Deleted ${deleted} old articles.`)
  } catch (err) {
    console.error(`[collectArticles:${topic}] Failed to cleanup old articles:`, err)
  }
}

export async function runCollectArticles(): Promise<void> {
  console.log('[collectArticles] Starting...')

  // 1. 各ソースから記事を収集
  const [hnArticles, rssArticles, githubArticles] = await Promise.all([
    fetchHNArticles().catch(e => { console.error('[hn]', e); return [] as RawArticle[] }),
    fetchRSSArticles(10).catch(e => { console.error('[rss]', e); return [] as RawArticle[] }),
    fetchGitHubTrending().catch(e => { console.error('[github]', e); return [] as RawArticle[] }),
  ])

  console.log(`[collectArticles] Sources: hn=${hnArticles.length}, rss=${rssArticles.length}, github=${githubArticles.length}`)
  const allRaw = deduplicateArticles([...hnArticles, ...rssArticles, ...githubArticles])
  console.log(`[collectArticles] Collected ${allRaw.length} articles after dedup`)
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const collectionRef = db.collection('topics/ai/articles')
  const todaySnap = await collectionRef.where('date', '==', today).get()
  const processedUrls = new Set(todaySnap.docs.map(doc => (doc.data() as NewsArticle).url))
  const toProcess = allRaw.filter(raw => !processedUrls.has(raw.url))
  const existing = toProcess.length > 0 ? await fetchExistingAiArticles() : []
  const { reuse, fresh } = planAiArticleProcessing(toProcess, existing)
  const fetchedAt = admin.firestore.Timestamp.now()
  await commitInBatches(reuse.map(({ raw, source }) => ({
    ref: collectionRef.doc(), data: buildReusedAiArticle(raw, source, today, fetchedAt),
  })))

  const items = fresh.map(raw => ({ raw, ref: collectionRef.doc() }))
  const triageConfig = getAiTriageConfig(process.env)
  const { results, pendingIds, requestCount } = items.length > 0
    ? await triageAiArticles(items.map(({ raw, ref }) => buildTriageInput(ref.id, raw)), {
      client: createAiClaudeMessagesClient(process.env.ANTHROPIC_API_KEY),
      config: triageConfig,
      autonomous: true,
      reserveRequest: createClaudeDailyRequestReservation(db, 'ai-triage', triageConfig.dailyMaxRequests),
      deadlineAt: Date.now() + AI_TRIAGE_DEADLINE_MS,
    })
    : { results: new Map<string, TriageResult>(), pendingIds: [], requestCount: 0 }
  const relevantItems = items.filter(({ ref }) => results.get(ref.id)?.relevant === true)
  const scraped = await scrapeAiArticles(relevantItems.map(({ raw }) => raw))
  const scrapedById = new Map(relevantItems.map(({ ref }, index) => [ref.id, scraped[index]]))
  await commitInBatches(items.map(({ raw, ref }) => {
    const fetched = scrapedById.get(ref.id)
    return {
      ref,
      data: buildTriagedAiArticle(fetched?.raw ?? raw, fetched?.content ?? '', results.get(ref.id) ?? null, today, fetchedAt),
    }
  }))
  const relevant = relevantItems.length
  console.log(`[collectArticles:ai] reused=${reuse.length} fresh=${fresh.length} relevant=${relevant} irrelevant=${results.size - relevant} pending=${pendingIds.length} requestCount=${requestCount}`)
  if (pendingIds.length > 0) console.error(`[collectArticles:ai] triage pending count=${pendingIds.length}`)
  await cleanupOldArticles('ai')
}

const APPLE_NEWS_HOST = 'developer.apple.com'
const CLASSIFICATION_TEXT_LIMIT = 5000
const FIRESTORE_IN_LIMIT = 30
const BATCH_LIMIT = 500

function parseAppleNewsUrl(url: string): { id: string; isJapanese: boolean } | null {
  try {
    const u = new URL(url)
    if (u.hostname !== APPLE_NEWS_HOST) return null
    const isJapanese = u.pathname.startsWith('/jp/news')
    if (!isJapanese && !u.pathname.startsWith('/news')) return null
    const id = u.searchParams.get('id')
    return id ? { id, isJapanese } : null
  } catch {
    return null
  }
}

export function getAppleNewsId(url: string): string | null {
  return parseAppleNewsUrl(url)?.id ?? null
}

export function getAppleNewsAlternateUrls(url: string): string[] {
  const id = getAppleNewsId(url)
  if (!id) return [url]
  const query = `?id=${encodeURIComponent(id)}`
  return [
    `https://${APPLE_NEWS_HOST}/jp/news/${query}`,
    `https://${APPLE_NEWS_HOST}/news/${query}`,
  ]
}

export function preferJapaneseAppleNews(articles: RawArticle[]): RawArticle[] {
  const japaneseIds = new Set<string>()
  for (const a of articles) {
    const parsed = parseAppleNewsUrl(a.url)
    if (parsed?.isJapanese) japaneseIds.add(parsed.id)
  }
  return articles.filter((a) => {
    const parsed = parseAppleNewsUrl(a.url)
    return !(parsed && !parsed.isJapanese && japaneseIds.has(parsed.id))
  })
}

function getMobileMatchKey(url: string): string {
  const id = getAppleNewsId(url)
  return id ? `apple:${id}` : normalizeUrl(url)
}

export function planMobileArticleProcessing(
  raws: RawArticle[],
  existing: NewsArticle[]
): { reuse: Array<{ raw: RawArticle; source: NewsArticle }>; fresh: RawArticle[] } {
  const doneByKey = new Map<string, NewsArticle>()
  for (const a of existing) {
    if (a.classificationStatus !== 'done') continue
    const key = getMobileMatchKey(a.url)
    if (!doneByKey.has(key)) doneByKey.set(key, a)
  }
  const reuse: Array<{ raw: RawArticle; source: NewsArticle }> = []
  const fresh: RawArticle[] = []
  for (const raw of raws) {
    const source = doneByKey.get(getMobileMatchKey(raw.url))
    if (source) reuse.push({ raw, source })
    else fresh.push(raw)
  }
  return { reuse, fresh }
}

export function buildClassificationInput(id: string, raw: RawArticle, content: string): ClassificationInput {
  return {
    id,
    title: raw.title,
    sourceName: raw.sourceName,
    publishedDate: raw.publishedAt.toISOString().slice(0, 10),
    text: (content || raw.description).slice(0, CLASSIFICATION_TEXT_LIMIT),
  }
}

function buildMobileBase(raw: RawArticle, today: string, fetchedAt: admin.firestore.Timestamp) {
  return {
    title: raw.title,
    description: raw.description,
    url: raw.url,
    thumbnailUrl: raw.thumbnailUrl,
    topic: 'mobile' as const,
    source: raw.source,
    sourceName: raw.sourceName,
    ...(raw.sourceTier ? { sourceTier: raw.sourceTier } : {}),
    ...(typeof raw.isOfficial === 'boolean' ? { isOfficial: raw.isOfficial } : {}),
    score: raw.score,
    publishedAt: admin.firestore.Timestamp.fromDate(raw.publishedAt),
    fetchedAt,
    date: today,
  }
}

export function buildClassifiedMobileArticle(
  raw: RawArticle,
  content: string,
  result: ClassificationResult | null,
  today: string,
  fetchedAt: admin.firestore.Timestamp
): NewsArticle {
  const base = buildMobileBase(raw, today, fetchedAt)
  const contentField = content ? { content } : {}
  const platform = result?.platform ?? raw.platform
  const platformField = platform ? { platform } : {}
  if (!result) {
    return { ...base, ...contentField, ...platformField, tags: [], classificationStatus: 'pending' }
  }
  const inScope = result.category !== 'out_of_scope'
  return {
    ...base,
    ...contentField,
    ...platformField,
    titleJa: result.titleJa,
    summaryJa: result.summary.overview,
    tags: [],
    actionRequired: result.actionRequired,
    actionType: result.category === 'out_of_scope' ? 'other' : result.category,
    importantLevel: result.importantLevel,
    ...(result.requiredByDate ? { requiredByDate: result.requiredByDate } : {}),
    classificationStatus: 'done',
    inScope,
    mobileSummary: result.summary,
  }
}

export function buildReusedMobileArticle(
  raw: RawArticle,
  source: NewsArticle,
  today: string,
  fetchedAt: admin.firestore.Timestamp
): NewsArticle {
  const base = buildMobileBase(raw, today, fetchedAt)
  return {
    ...base,
    thumbnailUrl: raw.thumbnailUrl ?? source.thumbnailUrl,
    ...(source.content ? { content: source.content } : {}),
    ...(source.titleJa !== undefined ? { titleJa: source.titleJa } : {}),
    ...(source.summaryJa !== undefined ? { summaryJa: source.summaryJa } : {}),
    tags: source.tags ?? [],
    ...(source.platform ? { platform: source.platform } : {}),
    ...(typeof source.actionRequired === 'boolean' ? { actionRequired: source.actionRequired } : {}),
    ...(source.actionType ? { actionType: source.actionType } : {}),
    ...(source.importantLevel ? { importantLevel: source.importantLevel } : {}),
    ...(source.requiredByDate ? { requiredByDate: source.requiredByDate } : {}),
    classificationStatus: 'done',
    ...(typeof source.inScope === 'boolean' ? { inScope: source.inScope } : {}),
    ...(source.mobileSummary ? { mobileSummary: source.mobileSummary } : {}),
  }
}

async function fetchExistingMobileArticles(urls: string[]): Promise<NewsArticle[]> {
  const collectionRef = db.collection('topics/mobile/articles')
  const unique = Array.from(new Set(urls))
  const found: NewsArticle[] = []
  for (let i = 0; i < unique.length; i += FIRESTORE_IN_LIMIT) {
    const chunk = unique.slice(i, i + FIRESTORE_IN_LIMIT)
    const snap = await collectionRef.where('url', 'in', chunk).get()
    for (const d of snap.docs) found.push(d.data() as NewsArticle)
  }
  return found
}

async function commitInBatches(
  items: Array<{ ref: admin.firestore.DocumentReference; data: NewsArticle }>
): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH_LIMIT) {
    const batch = db.batch()
    for (const { ref, data } of items.slice(i, i + BATCH_LIMIT)) batch.set(ref, data)
    await batch.commit()
  }
}

export async function runCollectMobileArticles(): Promise<void> {
  console.log('[collectMobileArticles] Starting...')

  const [officialHtmlArticles, rssArticles] = await Promise.all([
    fetchOfficialMobileHtmlArticles().catch(e => { console.error('[mobile-official]', e); return [] as RawArticle[] }),
    fetchMobileRssArticles().catch(e => { console.error('[mobile-rss]', e); return [] as RawArticle[] }),
  ])

  console.log(`[collectMobileArticles] Sources: officialHtml=${officialHtmlArticles.length}, rss=${rssArticles.length}`)
  const sourceCounts: Record<string, number> = {}
  for (const a of [...officialHtmlArticles, ...rssArticles]) {
    sourceCounts[a.sourceName] = (sourceCounts[a.sourceName] ?? 0) + 1
  }
  console.log('[collectMobileArticles] source counts', sourceCounts)
  const freshArticles = filterMobileArticlesByFreshness([...officialHtmlArticles, ...rssArticles])
  const allRaw = preferJapaneseAppleNews(deduplicateArticlesByPriority(freshArticles))
  console.log(`[collectMobileArticles] Collected ${allRaw.length} articles after freshness filter + dedup`)

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const collectionRef = db.collection('topics/mobile/articles')
  const todaySnap = await collectionRef.where('date', '==', today).get()
  const processedUrls = new Set(todaySnap.docs.map(d => (d.data() as NewsArticle).url))
  const toProcess = allRaw.filter(raw => !processedUrls.has(raw.url))

  const lookupUrls = toProcess.flatMap(raw => [raw.url, ...getAppleNewsAlternateUrls(raw.url)])
  const existing = await fetchExistingMobileArticles(lookupUrls)
  const { reuse, fresh } = planMobileArticleProcessing(toProcess, existing)

  const fetchedAt = admin.firestore.Timestamp.now()
  const reusedToSave: Array<{ ref: admin.firestore.DocumentReference; data: NewsArticle }> = []
  for (const { raw, source } of reuse) {
    reusedToSave.push({ ref: collectionRef.doc(), data: buildReusedMobileArticle(raw, source, today, fetchedAt) })
  }
  await commitInBatches(reusedToSave)

  const CONCURRENCY = 5
  const scraped: Array<{ id: string; raw: RawArticle; content: string }> = []
  for (let i = 0; i < fresh.length; i += CONCURRENCY) {
    const chunk = fresh.slice(i, i + CONCURRENCY)
    const done = await Promise.all(chunk.map(async (raw) => {
      const { ogImage, content } = await scrapeArticle(raw.url).catch(err => {
        console.warn(`[collectArticles:mobile] Scrape warning for ${raw.url}:`, err.message)
        return { ogImage: null, content: '' }
      })
      return {
        id: collectionRef.doc().id,
        raw: { ...raw, thumbnailUrl: raw.thumbnailUrl ?? ogImage },
        content,
      }
    }))
    scraped.push(...done)
  }

  const client = createClaudeMessagesClient(process.env.ANTHROPIC_API_KEY)
  if (!client) console.error('[collectMobileArticles] ANTHROPIC_API_KEY is not set')
  const config = getClaudeNewsConfig(process.env)
  const inputs = scraped.map(s => buildClassificationInput(s.id, s.raw, s.content))
  const { results, pendingIds, requestCount } = await classifyMobileArticles(inputs, {
    client,
    config,
    deadlineAt: Date.now() + MOBILE_CLASSIFICATION_DEADLINE_MS,
  })
  if (pendingIds.length > 0) {
    console.error(`[collectMobileArticles] classification pending count=${pendingIds.length}`)
  }

  const toSave: Array<{ ref: admin.firestore.DocumentReference; data: NewsArticle }> = []
  for (const s of scraped) {
    toSave.push({
      ref: collectionRef.doc(s.id),
      data: buildClassifiedMobileArticle(s.raw, s.content, results.get(s.id) ?? null, today, fetchedAt),
    })
  }
  await commitInBatches(toSave)

  console.log(
    `[collectMobileArticles] reused=${reuse.length} fresh=${fresh.length} classified=${results.size} pending=${fresh.length - results.size} requestCount=${requestCount}`
  )

  await cleanupOldArticles('mobile')
}
