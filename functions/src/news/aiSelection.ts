// functions/src/news/aiSelection.ts
// AI ニュースの選別規則。Firestore に依存しない純粋関数だけを置く。
import type { NewsArticle } from './types'
import {
  AI_REACTION_LIMIT_KEYS, AI_REACTION_NEUTRAL, AI_REACTION_WEIGHT, calcAiArticleValue,
  calcReactionStrengthSum, getAiReactionSource, getArticleReactions, type AiScoreLimits,
} from './aiStories'

export { AI_REACTION_NEUTRAL, AI_REACTION_WEIGHT, collectAiScoreLimits, getAiReactionSource } from './aiStories'
export type { AiReactionSource, AiScoreLimits } from './aiStories'

export const AI_TRIAGE_VERSION = 'ai-v2'
export const AI_SUMMARY_VERSION = 'ai-v2'
export const AI_REUSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export const AI_INCLUDE_CATEGORIES = [
  'coding_agent', 'llm_engineering', 'ai_security', 'model_capability', 'ml_engineering', 'ai_dev_tool',
] as const
export const AI_EXCLUDE_CATEGORIES = [
  'business_policy', 'promotion', 'end_user_usage', 'incidental_ai', 'general_commentary', 'not_ai',
] as const

export const AI_FEED_MAX_ARTICLES = 20
export const AI_FEED_SOURCE_LIMITS = { hn: 5, github: 4, reddit: 3, japanese: 8, otherRss: 6 }
export type AiSourceBucket = keyof typeof AI_FEED_SOURCE_LIMITS

type TriageFields = Pick<NewsArticle, 'triageStatus' | 'triageVersion' | 'triageDecision' | 'developerValue' | 'summaryVersion' | 'summaryStatus' | 'summarizedAt'>
type SummaryFields = TriageFields & Pick<NewsArticle, 'summaryJa'>
type ReactionSourceFields = Pick<NewsArticle, 'source' | 'sourceName'>
type ScoreFields = ReactionSourceFields & Pick<NewsArticle, 'score' | 'developerValue' | 'importance' | 'url' | 'discussionUrl' | 'extraReactions'>

export function isSyntheticGithubDescription(description: string): boolean {
  return description.startsWith('GitHub trending repository:')
}

// 2段目の結果が現行版で、かつ summarizedAt から7日以内のときだけ有効
function hasCurrentSummary(article: Partial<TriageFields>, now: number): boolean {
  if (article.summaryVersion !== AI_SUMMARY_VERSION) return false
  return typeof article.summarizedAt === 'number' && now - article.summarizedAt <= AI_REUSE_MAX_AGE_MS
}

export function isAiFeedCandidate(article: Partial<TriageFields>, now: number = Date.now()): boolean {
  if (article.triageStatus !== 'done' || article.triageVersion !== AI_TRIAGE_VERSION) return false
  if (article.triageDecision !== 'include' && article.triageDecision !== 'hold') return false
  if (article.developerValue !== 'high' && article.developerValue !== 'normal') return false
  return !(hasCurrentSummary(article, now) && article.summaryStatus === 'rejected')
}

export function isDisplayableAiArticle(article: Partial<SummaryFields>, now: number = Date.now()): boolean {
  return isAiFeedCandidate(article, now)
    && hasCurrentSummary(article, now)
    && article.summaryStatus === 'generated'
    && typeof article.summaryJa === 'string'
    && article.summaryJa.trim() !== ''
}

export function needsAiSummary(article: Partial<TriageFields>, now: number = Date.now()): boolean {
  return isAiFeedCandidate(article, now)
    && (!hasCurrentSummary(article, now)
      || (article.summaryStatus !== 'generated' && article.summaryStatus !== 'rejected'))
}

export function getAiSourceBucket(article: ReactionSourceFields): AiSourceBucket {
  const source = getAiReactionSource(article)
  if (source === null) return 'otherRss'
  if (source === 'zenn' || source === 'qiita') return 'japanese'
  return source
}

export function calcAiBaseScore(
  article: Partial<ScoreFields>,
  limits: AiScoreLimits
): number {
  const score = calcAiArticleValue(article)
  if (Array.isArray(article.extraReactions) && article.extraReactions.length > 0) {
    const strength = calcReactionStrengthSum(getArticleReactions(article), limits)
    if (strength !== null) return score + AI_REACTION_WEIGHT * strength
  }

  const source = getAiReactionSource(article)
  if (source === null) return score + AI_REACTION_WEIGHT * AI_REACTION_NEUTRAL

  const max = limits[AI_REACTION_LIMIT_KEYS[source]] ?? 0
  const reactions = article.score
  const fallback = source === 'zenn' || source === 'qiita' ? AI_REACTION_NEUTRAL : 0
  const strength = typeof reactions === 'number' && Number.isFinite(reactions) && max > 0
    ? Math.min(Math.log1p(Math.max(reactions, 0)) / Math.log1p(max), 1)
    : fallback
  return score + AI_REACTION_WEIGHT * strength
}

function getPublishedAtMillis(value: unknown): number | null {
  if (typeof value === 'string') {
    const parts = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
    if (!parts) return null
    const millis = Date.parse(value)
    if (!Number.isFinite(millis)) return null

    const day = new Date(`${parts[1]}T00:00:00Z`)
    return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === parts[1] ? millis : null
  }

  if (value === null || typeof value !== 'object') return null
  try {
    if (!('toMillis' in value) || typeof value.toMillis !== 'function') return null
    const millis: unknown = value.toMillis()
    return typeof millis === 'number' && Number.isFinite(millis) ? millis : null
  } catch {
    return null
  }
}

export function selectAiFeed<T extends {
  article: Pick<NewsArticle, 'source' | 'sourceName'> & Partial<TriageFields> & Partial<Pick<NewsArticle, 'publishedAt'>>
  displayScore: number
}>(
  ranked: T[],
  now: number = Date.now()
): T[] {
  const sorted = ranked
    .map(item => ({ item, publishedAtMillis: getPublishedAtMillis(item.article.publishedAt) }))
    .sort((a, b) => {
      if (a.item.displayScore !== b.item.displayScore) return b.item.displayScore - a.item.displayScore
      if (a.publishedAtMillis === null) return b.publishedAtMillis === null ? 0 : 1
      if (b.publishedAtMillis === null) return -1
      return b.publishedAtMillis - a.publishedAtMillis
    })
  const counts: Record<AiSourceBucket, number> = { hn: 0, github: 0, reddit: 0, japanese: 0, otherRss: 0 }
  const selected: T[] = []
  for (const { item } of sorted) {
    if (selected.length >= AI_FEED_MAX_ARTICLES) break
    if (!isAiFeedCandidate(item.article, now)) continue
    const bucket = getAiSourceBucket(item.article)
    if (counts[bucket] >= AI_FEED_SOURCE_LIMITS[bucket]) continue
    counts[bucket]++
    selected.push(item)
  }
  return selected
}
