// functions/src/news/generatePersonalizedFeed.ts
import * as admin from 'firebase-admin'
import { summarizeAiArticles, getAiSummaryConfig, type SummaryInput } from './aiClaudeSummary'
import {
  AI_REUSE_MAX_AGE_MS,
  AI_SUMMARY_VERSION,
  calcAiBaseScore,
  isAiFeedCandidate,
  isDisplayableAiArticle,
  isSyntheticGithubDescription,
  needsAiSummary,
  selectAiFeed,
} from './aiSelection'
import { normalizeTitle, normalizeUrl } from './collectArticles'
import { createClaudeMessagesClient } from './claudeClient'
import { createClaudeDailyRequestReservation } from './claudeDailyBudget'
import type { NewsArticle, NewsPreferences, NewsTopic } from './types'

type NewsArticleWithId = NewsArticle & { id: string }

interface RankedFeedItem {
  article: NewsArticleWithId
  displayScore: number
}

export const MOBILE_FEED_MAX_ARTICLES = 15
export const AI_SUMMARY_DEADLINE_MS = 60000
const AI_SUMMARY_MAX_ROUNDS = 3
const AI_SUMMARY_DAILY_LIMIT = 40
const AI_SUMMARY_TEXT_LIMIT = 2000
const WRITE_BATCH_LIMIT = 400

export function isEligibleAiFeedArticle(article: Parameters<typeof isAiFeedCandidate>[0]): boolean {
  return isAiFeedCandidate(article)
}

export function getImportanceMultiplier(importance: NewsArticle['importance']): number {
  return importance === 'high' ? 1.3 : importance === 'low' ? 0.6 : 1
}

export function getDeveloperValueMultiplier(value: NewsArticle['developerValue']): number {
  return value === 'high' ? 1.5 : value === 'low' ? 0.7 : 1
}

export function isEligibleMobileFeedArticle(
  article: Pick<NewsArticle, 'inScope' | 'classificationStatus'>
): boolean {
  return article.inScope === true && article.classificationStatus === 'done'
}

export function collectSummaryCandidateArticles(
  rankedFeeds: RankedFeedItem[][]
): NewsArticleWithId[] {
  const candidates = new Map<string, {
    article: NewsArticleWithId
    displayScore: number
  }>()

  for (const ranked of rankedFeeds) {
    for (const item of ranked) {
      const existing = candidates.get(item.article.id)
      if (!existing || item.displayScore > existing.displayScore) {
        candidates.set(item.article.id, {
          article: item.article,
          displayScore: item.displayScore,
        })
      }
    }
  }

  return Array.from(candidates.values())
    .sort((a, b) => {
      const aNeedsEnglishSummary = needsSharedSummary(a.article) && (a.article.developerValue !== undefined || !shouldSkipGeminiForJapaneseArticle(a.article))
      const bNeedsEnglishSummary = needsSharedSummary(b.article) && (b.article.developerValue !== undefined || !shouldSkipGeminiForJapaneseArticle(b.article))

      if (aNeedsEnglishSummary !== bNeedsEnglishSummary) {
        return aNeedsEnglishSummary ? -1 : 1
      }

      return b.displayScore - a.displayScore
    })
    .map(candidate => candidate.article)
}

// ひらがな・カタカナを含む場合のみ日本語と判定（漢字のみはCJK全般に含まれるため除外）
function isJapanese(text: string): boolean {
  return /[\u3040-\u30FF]/.test(text)
}

const db = admin.firestore()
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
    // 1. 判定時に抽出したタグがあればそれを最優先で学習
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

function calcPreferenceMultiplier(
  article: NewsArticle,
  preferences: NewsPreferences,
  learnedKeywords: string[]
): number {
  // titleJa/summaryJa は要約後に設定されるため、未設定時は title/description で代用
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

  return preferenceMultiplier
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
  if (article.developerValue && article.summaryStatus !== 'generated') return true
  if (!article.titleJa || !article.summaryJa) {
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

type ReusableSummary =
  | { status: 'generated'; titleJa: string; summaryJa: string; summarySource: 'content' | 'description'; summarizedAt: number }
  | { status: 'rejected'; summarizedAt: number }

async function findReusableSummary(
  topic: NewsTopic,
  article: NewsArticleWithId,
  now: number
): Promise<ReusableSummary | null> {
  const snap = await db.collection(`topics/${topic}/articles`)
    .where('normalizedUrl', '==', article.normalizedUrl ?? normalizeUrl(article.url))
    .get()

  // 現行版かつ7日以内の結果のうち、summarizedAt が最も新しいものを使う
  // 選別の再利用と同じく、タイトルが変わった記事は判定し直す
  const title = normalizeTitle(article.title)
  let best: ReusableSummary | null = null
  for (const doc of snap.docs) {
    if (doc.id === article.id) continue
    const data = doc.data() as Partial<NewsArticle>
    if (typeof data.title !== 'string' || normalizeTitle(data.title) !== title) continue
    if (data.summaryVersion !== AI_SUMMARY_VERSION) continue
    if (typeof data.summarizedAt !== 'number' || now - data.summarizedAt > AI_REUSE_MAX_AGE_MS) continue
    if (best && best.summarizedAt >= data.summarizedAt) continue
    if (data.summaryStatus === 'rejected') {
      best = { status: 'rejected', summarizedAt: data.summarizedAt }
    } else if (
      data.summaryStatus === 'generated'
      && (data.summarySource === 'content' || data.summarySource === 'description')
      && typeof data.titleJa === 'string' && data.titleJa.trim() !== ''
      && typeof data.summaryJa === 'string' && data.summaryJa.trim() !== ''
    ) {
      best = {
        status: 'generated', titleJa: data.titleJa, summaryJa: data.summaryJa,
        summarySource: data.summarySource, summarizedAt: data.summarizedAt,
      }
    }
  }
  return best
}

function getSummaryEvidence(article: NewsArticle): { text: string; basis: 'content' | 'description' } | null {
  const content = article.content ?? ''
  if (content.trim()) return { text: content.slice(0, AI_SUMMARY_TEXT_LIMIT), basis: 'content' }
  // GitHub は README 本文が根拠で、合成説明文や短い説明だけでは要約しない。
  if (article.source === 'github') return null
  const description = article.description ?? ''
  if (!description.trim() || isSyntheticGithubDescription(description)) return null
  return { text: description.slice(0, AI_SUMMARY_TEXT_LIMIT), basis: 'description' }
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

async function commitArticleUpdates(topic: NewsTopic, updates: Map<string, Partial<NewsArticle>>): Promise<void> {
  const entries = Array.from(updates.entries())
  for (let i = 0; i < entries.length; i += WRITE_BATCH_LIMIT) {
    const batch = db.batch()
    for (const [id, value] of entries.slice(i, i + WRITE_BATCH_LIMIT)) {
      batch.update(db.doc(`topics/${topic}/articles/${id}`), value)
    }
    await batch.commit()
  }
}

interface FeedUser {
  uid: string
  preferences: NewsPreferences
  learnedKeywords: string[]
  dismissedCount: number
  articles: NewsArticleWithId[]
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
      .filter(isEligibleAiFeedArticle)
      .filter(a => {
        if (seenUrls.has(a.url)) return false
        seenUrls.add(a.url)
        return true
      })

    // HN・GitHubの最大スコアを算出（人気スコア正規化用）
    const maxScore = (source: NewsArticle['source']) => articles
      .filter(a => a.source === source && a.score !== null)
      .reduce((max, a) => Math.max(max, a.score ?? 0), 0)
    const scoreLimits = { maxHnScore: maxScore('hn'), maxGithubScore: maxScore('github') }

    // 2. 全ユーザーのnewsPreferencesを取得
    const usersSnap = await db.collection('users').get()
    const feedUsers: FeedUser[] = []

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

        // 3. 除外済みを取り除く（IDベース + URLベースの両方でフィルタ）
        feedUsers.push({
          uid,
          preferences,
          learnedKeywords,
          dismissedCount: dismissedIds.size,
          articles: articles.filter(a => !dismissedIds.has(a.id) && !excludedUrls.has(a.url)),
        })
      } catch (err) {
        console.error(`[generatePersonalizedFeed] Failed for user ${uid}:`, err)
      }
    }

    // 要約が得られず今日は再送しない記事。保存はせず、翌日に再試行する。
    const skippedIds = new Set<string>()
    const rank = (user: FeedUser): RankedFeedItem[] => user.articles
      .filter(article => !skippedIds.has(article.id))
      .map(article => ({
        article,
        displayScore: calcAiBaseScore(article, scoreLimits)
          * calcPreferenceMultiplier(article, user.preferences, user.learnedKeywords),
      }))
    const select = (user: FeedUser) => selectAiFeed(rank(user))

    // 4. 選ばれた記事のうち未確認のものを確認（2段目）し、不採用が出たら選び直して補充する。
    // 要約に失敗してもフィード保存は止めない。
    const updates = new Map<string, Partial<NewsArticle>>()
    const applyUpdate = (article: NewsArticleWithId, value: Partial<NewsArticle>) => {
      Object.assign(article, value)
      updates.set(article.id, { ...updates.get(article.id), ...value })
    }
    let sentCount = 0
    let requestCount = 0
    try {
      const summaryConfig = getAiSummaryConfig(process.env)
      const client = createClaudeMessagesClient(process.env.ANTHROPIC_API_KEY)
      const reserveRequest = createClaudeDailyRequestReservation(db, 'ai-summary', summaryConfig.dailyMaxRequests)
      const deadlineAt = Date.now() + AI_SUMMARY_DEADLINE_MS

      for (let round = 0; round < AI_SUMMARY_MAX_ROUNDS; round++) {
        const wanted = new Map<string, RankedFeedItem>()
        for (const user of feedUsers) {
          for (const item of select(user)) {
            const existing = wanted.get(item.article.id)
            if (needsAiSummary(item.article) && (!existing || item.displayScore > existing.displayScore)) {
              wanted.set(item.article.id, item)
            }
          }
        }
        if (wanted.size === 0) break

        const inputs: SummaryInput[] = []
        const inputArticles = new Map<string, NewsArticleWithId>()
        const ordered = Array.from(wanted.values()).sort((a, b) => b.displayScore - a.displayScore)
        for (const { article } of ordered) {
          const now = Date.now()
          const reusable = await findReusableSummary(topic, article, now)
          if (reusable?.status === 'generated') {
            applyUpdate(article, {
              titleJa: reusable.titleJa, summaryJa: reusable.summaryJa, summaryVersion: AI_SUMMARY_VERSION,
              summaryStatus: 'generated', summarySource: reusable.summarySource, summarizedAt: reusable.summarizedAt,
            })
            continue
          }
          if (reusable?.status === 'rejected') {
            applyUpdate(article, { summaryVersion: AI_SUMMARY_VERSION, summaryStatus: 'rejected', summarizedAt: reusable.summarizedAt })
            continue
          }
          const evidence = getSummaryEvidence(article)
          if (!evidence) {
            // 取得失敗と根拠なしを区別できないため rejected で固定せず、今回だけ飛ばす
            skippedIds.add(article.id)
            continue
          }
          inputs.push({ id: article.id, title: article.title, sourceName: article.sourceName, text: evidence.text, basis: evidence.basis })
          inputArticles.set(article.id, article)
        }

        const sendable = inputs.slice(0, Math.max(AI_SUMMARY_DAILY_LIMIT - sentCount, 0))
        if (sendable.length === 0) {
          if (inputs.length === 0) continue
          break
        }
        sentCount += sendable.length
        const outcome = await summarizeAiArticles(sendable, {
          client, config: summaryConfig, verify: true, reserveRequest, deadlineAt,
        })
        requestCount += outcome.requestCount
        for (const input of sendable) {
          const article = inputArticles.get(input.id)
          const summary = outcome.results.get(input.id)
          if (!article) continue
          if (summary?.include === false) {
            applyUpdate(article, { summaryVersion: AI_SUMMARY_VERSION, summaryStatus: 'rejected', summarizedAt: Date.now() })
          } else if (summary && summary.summaryJa.trim() !== '') {
            applyUpdate(article, {
              titleJa: summary.titleJa, summaryJa: summary.summaryJa, summaryVersion: AI_SUMMARY_VERSION,
              summaryStatus: 'generated', summarySource: input.basis ?? 'description', summarizedAt: Date.now(),
            })
          } else {
            skippedIds.add(article.id)
          }
        }
      }
    } catch (err) {
      console.error('[generatePersonalizedFeed] Summary verification failed. Saving feeds with existing article data:', err)
    }
    try {
      await commitArticleUpdates(topic, updates)
    } catch (err) {
      console.error('[generatePersonalizedFeed] Failed to save summary results:', err)
    }
    console.log(`[generatePersonalizedFeed] Summaries sent=${sentCount}, updated=${updates.size}, skipped=${skippedIds.size}, claudeRequests=${requestCount}`)

    // 5. 利用者ごとに、表示できる記事だけを保存する
    const savedArticles = new Map<string, NewsArticleWithId>()
    for (const user of feedUsers) {
      try {
        const displayable = select(user).filter(item => isDisplayableAiArticle(item.article))
        await saveRankedFeed(topic, user.uid, today, displayable)
        for (const item of displayable) savedArticles.set(item.article.id, item.article)
        console.log(
          `[generatePersonalizedFeed] Saved feed for user ${user.uid} ` +
          `(${displayable.length} articles, dismissed: ${user.dismissedCount}, ` +
          `learned: ${user.learnedKeywords.length})`
        )
      } catch (err) {
        console.error(`[generatePersonalizedFeed] Failed to save feed for user ${user.uid}:`, err)
      }
    }

    // 共有記事側に、表示対象であること（feedEligible）と嗜好倍率なしの点数を書く
    try {
      const eligibility = new Map<string, Partial<NewsArticle>>()
      for (const article of savedArticles.values()) {
        eligibility.set(article.id, { feedEligible: true, sharedScore: calcAiBaseScore(article, scoreLimits) })
      }
      await commitArticleUpdates(topic, eligibility)
    } catch (err) {
      console.error('[generatePersonalizedFeed] Failed to mark shared articles as feed eligible:', err)
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
      .filter(a => isEligibleMobileFeedArticle(a))
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
          .slice(0, MOBILE_FEED_MAX_ARTICLES)

        pendingFeeds.push({ uid, scored })
      } catch (err) {
        console.error(`[generateMobilePersonalizedFeed] Failed for user ${uid}:`, err)
      }
    }

    for (const pendingFeed of pendingFeeds) {
      try {
        await saveRankedFeed(topic, pendingFeed.uid, today, pendingFeed.scored)
        console.log(`[generateMobilePersonalizedFeed] Saved feed for user ${pendingFeed.uid} (${pendingFeed.scored.length} articles)`)
      } catch (err) {
        console.error(`[generateMobilePersonalizedFeed] Failed to save feed for user ${pendingFeed.uid}:`, err)
      }
    }
}
