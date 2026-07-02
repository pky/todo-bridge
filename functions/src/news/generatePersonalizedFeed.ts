// functions/src/news/generatePersonalizedFeed.ts
import * as admin from 'firebase-admin'
import { summarizeArticle } from './geminiService'
import type { NewsArticle, NewsPreferences, NewsTopic } from './types'

type NewsArticleWithId = NewsArticle & { id: string }

interface RankedFeedItem {
  article: NewsArticleWithId
  displayScore: number
}

export function collectSummaryCandidateArticles(
  rankedFeeds: RankedFeedItem[][]
): NewsArticleWithId[] {
  const candidates = new Map<string, NewsArticleWithId>()

  for (const ranked of rankedFeeds) {
    for (const item of ranked) {
      candidates.set(item.article.id, item.article)
    }
  }

  return Array.from(candidates.values())
}

// ひらがな・カタカナを含む場合のみ日本語と判定（漢字のみはCJK全般に含まれるため除外）
function isJapanese(text: string): boolean {
  return /[\u3040-\u30FF]/.test(text)
}

const db = admin.firestore()
const DEFAULT_GEMINI_DAILY_MAX_REQUESTS = 20
const DEFAULT_GEMINI_DAILY_MAX_ARTICLES = 20
let geminiUsageDate = ''
let geminiUsageCount = 0

// 日本語テキストに混在する英語技術用語も含めて抽出（3文字以上、ストップワード除外）
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her',
  'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how',
  'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'did',
  'let', 'put', 'say', 'she', 'too', 'use',
  'this', 'that', 'with', 'from', 'have', 'will', 'your', 'more', 'also',
  'into', 'they', 'been', 'were', 'what', 'when', 'which', 'about', 'their',
  'than', 'then', 'them', 'some', 'just', 'like', 'other', 'over', 'only',
  'news', 'said', 'says', 'show', 'shows', 'using', 'used', 'make', 'made',
  'http', 'https', 'year', 'week', 'time', 'data', 'model', 'models',
])

function extractKeywords(text: string): string[] {
  // 小文字化して英字シーケンスを正規表現で直接抽出
  // 日本語テキスト内の "Claude" "LLM" "RAG" なども拾える
  const words = text.toLowerCase().match(/[a-z]{3,}/g) ?? []
  return words.filter(w => !STOP_WORDS.has(w))
}

interface ClickData {
  titleEn?: string
  summaryJa?: string
  tags?: string[]
}

function learnKeywordsFromClicks(clicks: ClickData[]): string[] {
  const freq = new Map<string, number>()
  for (const click of clicks) {
    // 1. Geminiが抽出したタグがあればそれを最優先で学習
    if (click.tags && click.tags.length > 0) {
      for (const tag of click.tags) {
        const kw = tag.toLowerCase()
        freq.set(kw, (freq.get(kw) ?? 0) + 1)
      }
    }
    // 2. 従来通り、タイトルと要約からも補完的にキーワードを抽出
    const text = [click.titleEn, click.summaryJa].filter(Boolean).join(' ')
    for (const kw of extractKeywords(text)) {
      freq.set(kw, (freq.get(kw) ?? 0) + 1)
    }
  }
  // 2回以上出現したキーワードを嗜好として採用
  return Array.from(freq.entries())
    .filter(([, count]) => count >= 2)
    .map(([word]) => word)
}

function calcDisplayScore(
  article: NewsArticle,
  preferences: NewsPreferences,
  maxHnScore: number,
  maxGithubScore: number,
  learnedKeywords: string[]
): number {
  // 1. 人気スコア (0-100)
  let popularityScore: number
  if (article.source === 'hn' && article.score !== null && maxHnScore > 0) {
    popularityScore = Math.min((article.score / maxHnScore) * 100, 100)
  } else if (article.source === 'github' && article.score !== null && maxGithubScore > 0) {
    // GitHub: 本日のスター獲得数をバッチ内最大値で正規化、50-100 の範囲に
    popularityScore = 50 + Math.min((article.score / maxGithubScore) * 50, 50)
  } else {
    popularityScore = 40 // RSSベースライン
  }

  // 2. 嗜好マルチプライヤー (1.0 - 2.5)
  // titleJa/summaryJaはGemini翻訳後に設定されるため、未翻訳時はtitle/descriptionで代用
  const text = `${article.titleJa ?? ''} ${article.summaryJa ?? ''} ${article.title} ${article.description ?? ''}`.toLowerCase()
  let preferenceMultiplier = 1.0

  // 手動設定キーワード
  for (const kw of preferences.keywords) {
    if (text.includes(kw.word.toLowerCase())) {
      preferenceMultiplier = Math.max(preferenceMultiplier, kw.weight)
    }
  }

  // クリック履歴から学習したキーワード
  for (const kw of learnedKeywords) {
    if (text.includes(kw)) {
      preferenceMultiplier = Math.max(preferenceMultiplier, 1.5)
    }
  }

  return popularityScore * preferenceMultiplier
}

function calcMobileDisplayScore(
  article: NewsArticle,
  preferences: NewsPreferences,
  learnedKeywords: string[]
): number {
  const text = `${article.titleJa ?? ''} ${article.summaryJa ?? ''} ${article.title} ${article.description ?? ''}`.toLowerCase()
  const preferredPlatforms = preferences.platforms ?? ['ios', 'android']

  if (article.platform && article.platform !== 'cross' && !preferredPlatforms.includes(article.platform)) {
    return -1
  }

  if (preferences.officialOnly === true && article.isOfficial !== true) {
    return -1
  }

  if (preferences.includeCommunity === false && article.sourceTier === 'community-rss') {
    return -1
  }

  if (preferences.actionRequiredOnly === true && article.actionRequired !== true) {
    return -1
  }

  let score = 0

  switch (article.sourceTier) {
    case 'official':
      score += 60
      break
    case 'official-rss':
      score += 50
      break
    case 'community-rss':
      score += 20
      break
    default:
      score += article.isOfficial ? 50 : 20
      break
  }

  if (article.actionRequired) {
    score += 40
  }

  switch (article.importantLevel) {
    case 'urgent':
      score += 35
      break
    case 'review':
      score += 18
      break
    case 'reference':
      score += 0
      break
  }

  if (article.requiredByDate) {
    score += 20
  }

  switch (article.actionType) {
    case 'sdk_requirement':
      score += 30
      break
    case 'policy':
    case 'play_policy':
      score += 30
      break
    case 'security':
      score += 25
      break
    case 'beta':
      score += 15
      break
    case 'release':
      score += 10
      break
    default:
      break
  }

  for (const kw of preferences.keywords) {
    if (text.includes(kw.word.toLowerCase())) {
      score *= Math.max(kw.weight, 1)
    }
  }

  for (const kw of learnedKeywords) {
    if (text.includes(kw)) {
      score += 15
    }
  }

  const ageMs = Date.now() - article.publishedAt.toDate().getTime()
  const ageDays = Math.max(ageMs / (24 * 60 * 60 * 1000), 0)
  score -= Math.min(ageDays * 5, 20)

  return score
}

function isInteractionForTopic(topic: NewsTopic, data: FirebaseFirestore.DocumentData): boolean {
  const interactionTopic = data.topic as NewsTopic | undefined
  return !interactionTopic ? topic === 'ai' : interactionTopic === topic
}

function needsSharedSummary(article: NewsArticle): boolean {
  if (!article.titleJa || !article.summaryJa || !article.tags || article.tags.length === 0) {
    return true
  }

  return !isJapanese(article.title) && !isJapanese(article.titleJa)
}

export function shouldSkipGeminiForJapaneseArticle(article: Pick<NewsArticle, 'title' | 'description' | 'content'>): boolean {
  return isJapanese([
    article.title,
    article.description,
    article.content ?? '',
  ].join(' '))
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback

  return parsed
}

function getGeminiDailyLimit(): number {
  const maxRequests = parseNonNegativeInteger(
    process.env.GEMINI_DAILY_MAX_REQUESTS,
    DEFAULT_GEMINI_DAILY_MAX_REQUESTS
  )
  const maxArticles = parseNonNegativeInteger(
    process.env.GEMINI_DAILY_MAX_ARTICLES,
    DEFAULT_GEMINI_DAILY_MAX_ARTICLES
  )

  return Math.min(maxRequests, maxArticles)
}

function isGeminiEnabled(): boolean {
  return process.env.GEMINI_ENABLED !== 'false'
}

function getJstDateString(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function reserveGeminiRequest(dailyLimit: number): boolean {
  const today = getJstDateString()
  if (geminiUsageDate !== today) {
    geminiUsageDate = today
    geminiUsageCount = 0
  }

  if (geminiUsageCount >= dailyLimit) return false

  geminiUsageCount++
  return true
}

function applySummaryFallback(article: NewsArticleWithId): {
  titleJa: string
  summaryJa: string
  tags: string[]
} {
  const titleJa = article.titleJa ?? article.title
  const summaryJa = article.summaryJa ?? (article.description ?? '').slice(0, 300)
  const tags = article.tags ?? []

  article.titleJa = titleJa
  article.summaryJa = summaryJa
  article.tags = tags

  return { titleJa, summaryJa, tags }
}

async function enrichSharedArticles(
  topic: NewsTopic,
  articles: NewsArticleWithId[],
  logPrefix: string
): Promise<void> {
  const batch = db.batch()
  let translatedCount = 0
  let skippedCount = 0
  let fallbackCount = 0
  let hasUpdates = false
  let geminiRequestCount = 0
  const geminiEnabled = isGeminiEnabled()
  const dailyLimit = getGeminiDailyLimit()

  for (const article of articles) {
    if (!needsSharedSummary(article)) {
      skippedCount++
      continue
    }

    const articleRef = db.doc(`topics/${topic}/articles/${article.id}`)

    if (shouldSkipGeminiForJapaneseArticle(article) || !geminiEnabled || !reserveGeminiRequest(dailyLimit)) {
      const fallback = applySummaryFallback(article)
      batch.update(articleRef, fallback)
      fallbackCount++
      hasUpdates = true
      continue
    }

    try {
      geminiRequestCount++
      const { titleJa, summaryJa, tags } = await summarizeArticle(
        article.title,
        article.content ?? article.description ?? ''
      )
      const nextTitleJa = titleJa || article.title
      const nextSummaryJa = summaryJa || (article.description ?? '').slice(0, 300)
      const nextTags = tags ?? []

      batch.update(articleRef, {
        titleJa: nextTitleJa,
        summaryJa: nextSummaryJa,
        tags: nextTags,
      })
      article.titleJa = nextTitleJa
      article.summaryJa = nextSummaryJa
      article.tags = nextTags
      translatedCount++
      hasUpdates = true
    } catch (err) {
      console.error(`[${logPrefix}] Shared summary failed for ${article.url}:`, err)
      batch.update(articleRef, applySummaryFallback(article))
      fallbackCount++
      hasUpdates = true
    }
  }

  if (hasUpdates) {
    await batch.commit()
  }

  console.log(
    `[${logPrefix}] Shared summaries translated=${translatedCount}, ` +
    `fallback=${fallbackCount}, skipped=${skippedCount}, geminiRequests=${geminiRequestCount}`
  )
}

async function saveRankedFeed(
  topic: NewsTopic,
  uid: string,
  today: string,
  ranked: RankedFeedItem[]
): Promise<void> {
  const feedRef = db.collection(`users/${uid}/newsFeed/${topic}/articles`)
  const batch = db.batch()

  const existingSnap = await feedRef.where('date', '==', today).get()
  existingSnap.docs.forEach(doc => batch.delete(doc.ref))

  ranked.forEach(item => {
    const docRef = feedRef.doc(item.article.id)
    batch.set(docRef, {
      ...item.article,
      displayScore: item.displayScore,
    })
  })

  await batch.commit()
}

async function enrichSummaryCandidatesWithoutBlockingFeedSave(
  topic: NewsTopic,
  candidates: NewsArticleWithId[],
  logPrefix: string
): Promise<void> {
  try {
    await enrichSharedArticles(topic, candidates, logPrefix)
  } catch (err) {
    console.error(`[${logPrefix}] Summary enrichment failed. Saving feeds with existing article data:`, err)
  }
}

export async function runGeneratePersonalizedFeed(): Promise<void> {
    console.log('[generatePersonalizedFeed] Starting...')
    const topic: NewsTopic = 'ai'

    // JST日付を使用（UTC 21:xx は JST 翌朝6:xx）
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)

    // 1. 今日の記事を共有プールから取得
    const articlesSnap = await db.collection(`topics/${topic}/articles`)
      .where('date', '==', today)
      .get()

    if (articlesSnap.empty) {
      console.log('[generatePersonalizedFeed] No articles for today')
      return
    }

    // URL重複を排除
    const seenUrls = new Set<string>()
    const articles = articlesSnap.docs
      .map(doc => ({ id: doc.id, ...(doc.data() as NewsArticle) }))
      .filter(a => {
        if (seenUrls.has(a.url)) return false
        seenUrls.add(a.url)
        return true
      })

    // HN・GitHubの最大スコアを算出（人気スコア正規化用）
    const maxHnScore = articles
      .filter(a => a.source === 'hn' && a.score !== null)
      .reduce((max, a) => Math.max(max, a.score!), 1)
    const maxGithubScore = articles
      .filter(a => a.source === 'github' && a.score !== null)
      .reduce((max, a) => Math.max(max, a.score!), 1)

    // 2. 全ユーザーのnewsPreferencesを取得
    const usersSnap = await db.collection('users').get()
    const pendingFeeds: Array<{
      uid: string
      ranked: RankedFeedItem[]
      dismissedCount: number
      learnedCount: number
    }> = []

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id

      try {
        const [prefDoc, interactionsSnap] = await Promise.all([
          db.doc(`users/${uid}/newsPreferences/${topic}`).get(),
          db.collection(`users/${uid}/newsInteractions`).get(),
        ])

        const preferences: NewsPreferences = prefDoc.exists
          ? (prefDoc.data() as NewsPreferences)
          : { keywords: [] }

        // 除外済み記事IDと除外済みURL、クリック済み記事データを収集
        const dismissedIds = new Set<string>()
        const excludedUrls = new Set<string>()  // dismissed + clicked のURL（翌日再収集対策）
        const shownCountByUrl = new Map<string, number>()
        const clicks: ClickData[] = []

        for (const intDoc of interactionsSnap.docs) {
          const data = intDoc.data()
          if (!isInteractionForTopic(topic, data)) continue

          const interactionArticleId = typeof data.articleId === 'string' ? data.articleId : intDoc.id
          if (data.dismissed === true) {
            dismissedIds.add(interactionArticleId)
            if (data.url) excludedUrls.add(data.url as string)
          }
          if (data.clickedAt) {
            // クリック済みURLも翌日以降は除外（同URLが再収集された場合もブロック）
            if (data.url) excludedUrls.add(data.url as string)
            clicks.push({
              titleEn: data.titleEn as string | undefined,
              summaryJa: data.summaryJa as string | undefined,
              tags: data.tags as string[] | undefined,
            })
          }
          if (data.url && typeof data.shownCount === 'number') {
            shownCountByUrl.set(
              data.url as string,
              (shownCountByUrl.get(data.url as string) ?? 0) + data.shownCount
            )
          }
        }

        for (const [url, shownCount] of shownCountByUrl.entries()) {
          if (shownCount >= 2) {
            excludedUrls.add(url)
          }
        }

        // クリック履歴からキーワードを学習
        const learnedKeywords = learnKeywordsFromClicks(clicks)
        if (learnedKeywords.length > 0) {
          console.log(`[generatePersonalizedFeed] Learned keywords for ${uid}:`, learnedKeywords.slice(0, 10))
        }

        // 3. 除外済みを取り除いてスコア計算（IDベース + URLベースの両方でフィルタ）
        const scored = articles
          .filter(a => !dismissedIds.has(a.id) && !excludedUrls.has(a.url))
          .map(article => ({
            article, // 記事オブジェクト全体を保持
            displayScore: calcDisplayScore(article, preferences, maxHnScore, maxGithubScore, learnedKeywords),
            source: article.source,
            sourceName: article.sourceName,
          }))

        // B案: HN(10) + GitHub(8) + Zenn/Qiita(12) + その他RSS(10) = 40件
        const sort = (arr: typeof scored) => arr.sort((a, b) => b.displayScore - a.displayScore)

        const hnTop = sort(scored.filter(a => a.source === 'hn')).slice(0, 10)
        const githubTop = sort(scored.filter(a => a.source === 'github')).slice(0, 8)
        const japaneseTop = sort(
          scored.filter(a => a.sourceName.startsWith('Zenn') || a.sourceName.startsWith('Qiita'))
        ).slice(0, 12)
        const otherRssTop = sort(
          scored.filter(a => a.source !== 'hn' && a.source !== 'github'
            && !a.sourceName.startsWith('Zenn') && !a.sourceName.startsWith('Qiita'))
        ).slice(0, 10)

        // 合算して再ソート（計40件）
        const ranked = [...hnTop, ...githubTop, ...japaneseTop, ...otherRssTop]
          .sort((a, b) => b.displayScore - a.displayScore)
          .slice(0, 40)

        pendingFeeds.push({
          uid,
          ranked,
          dismissedCount: dismissedIds.size,
          learnedCount: learnedKeywords.length,
        })
      } catch (err) {
        console.error(`[generatePersonalizedFeed] Failed for user ${uid}:`, err)
      }
    }

    // Gemini要約は、ユーザー別フィード候補に残った共有記事だけに限定する。
    // 要約に失敗してもフィード保存は止めない。
    await enrichSummaryCandidatesWithoutBlockingFeedSave(
      topic,
      collectSummaryCandidateArticles(pendingFeeds.map(feed => feed.ranked)),
      'generatePersonalizedFeed'
    )

    for (const pendingFeed of pendingFeeds) {
      try {
        await saveRankedFeed(topic, pendingFeed.uid, today, pendingFeed.ranked)
        console.log(
          `[generatePersonalizedFeed] Saved feed for user ${pendingFeed.uid} ` +
          `(dismissed: ${pendingFeed.dismissedCount}, learned: ${pendingFeed.learnedCount})`
        )
      } catch (err) {
        console.error(`[generatePersonalizedFeed] Failed to save feed for user ${pendingFeed.uid}:`, err)
      }
    }
}

export async function runGenerateMobilePersonalizedFeed(): Promise<void> {
    console.log('[generateMobilePersonalizedFeed] Starting...')
    const topic: NewsTopic = 'mobile'
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)

    const articlesSnap = await db.collection(`topics/${topic}/articles`)
      .where('date', '==', today)
      .get()

    if (articlesSnap.empty) {
      console.log('[generateMobilePersonalizedFeed] No articles for today')
      return
    }

    const seenUrls = new Set<string>()
    const articles = articlesSnap.docs
      .map(doc => ({ id: doc.id, ...(doc.data() as NewsArticle) }))
      .filter(a => {
        if (seenUrls.has(a.url)) return false
        seenUrls.add(a.url)
        return true
      })

    const usersSnap = await db.collection('users').get()
    const pendingFeeds: Array<{
      uid: string
      scored: RankedFeedItem[]
    }> = []

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id

      try {
        const [prefDoc, interactionsSnap] = await Promise.all([
          db.doc(`users/${uid}/newsPreferences/${topic}`).get(),
          db.collection(`users/${uid}/newsInteractions`).get(),
        ])

        const preferences: NewsPreferences = prefDoc.exists
          ? (prefDoc.data() as NewsPreferences)
          : { keywords: [], platforms: ['ios', 'android'], officialOnly: false, includeCommunity: true }

        const dismissedIds = new Set<string>()
        const excludedUrls = new Set<string>()
        const shownCountByUrl = new Map<string, number>()
        const clicks: ClickData[] = []

        for (const intDoc of interactionsSnap.docs) {
          const data = intDoc.data()
          if (!isInteractionForTopic(topic, data)) continue

          const interactionArticleId = typeof data.articleId === 'string' ? data.articleId : intDoc.id
          if (data.dismissed === true) {
            dismissedIds.add(interactionArticleId)
            if (data.url) excludedUrls.add(data.url as string)
          }
          if (data.clickedAt) {
            if (data.url) excludedUrls.add(data.url as string)
            clicks.push({
              titleEn: data.titleEn as string | undefined,
              summaryJa: data.summaryJa as string | undefined,
              tags: data.tags as string[] | undefined,
            })
          }
          if (data.url && typeof data.shownCount === 'number') {
            shownCountByUrl.set(
              data.url as string,
              (shownCountByUrl.get(data.url as string) ?? 0) + data.shownCount
            )
          }
        }

        for (const [url, shownCount] of shownCountByUrl.entries()) {
          if (shownCount >= 2) {
            excludedUrls.add(url)
          }
        }

        const learnedKeywords = learnKeywordsFromClicks(clicks)
        const scored = articles
          .filter(a => !dismissedIds.has(a.id) && !excludedUrls.has(a.url))
          .map(article => ({
            article,
            displayScore: calcMobileDisplayScore(article, preferences, learnedKeywords),
          }))
          .filter(item => item.displayScore >= 0)
          .sort((a, b) => b.displayScore - a.displayScore)
          .slice(0, 40)

        pendingFeeds.push({ uid, scored })
      } catch (err) {
        console.error(`[generateMobilePersonalizedFeed] Failed for user ${uid}:`, err)
      }
    }

    // Gemini要約は、ユーザー別フィード候補に残った共有記事だけに限定する。
    // 要約に失敗してもフィード保存は止めない。
    await enrichSummaryCandidatesWithoutBlockingFeedSave(
      topic,
      collectSummaryCandidateArticles(pendingFeeds.map(feed => feed.scored)),
      'generateMobilePersonalizedFeed'
    )

    for (const pendingFeed of pendingFeeds) {
      try {
        await saveRankedFeed(topic, pendingFeed.uid, today, pendingFeed.scored)
        console.log(`[generateMobilePersonalizedFeed] Saved feed for user ${pendingFeed.uid} (${pendingFeed.scored.length} articles)`)
      } catch (err) {
        console.error(`[generateMobilePersonalizedFeed] Failed to save feed for user ${pendingFeed.uid}:`, err)
      }
    }
}
