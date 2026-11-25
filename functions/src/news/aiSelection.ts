// functions/src/news/aiSelection.ts
// AI ニュースの選別規則。Firestore に依存しない純粋関数だけを置く。
import type { NewsArticle } from './types'

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
export const AI_REACTION_WEIGHT = 60
export const AI_REACTION_NEUTRAL = 0.5

export type AiSourceBucket = keyof typeof AI_FEED_SOURCE_LIMITS
export type AiReactionSource = 'hn' | 'github' | 'reddit' | 'zenn' | 'qiita'

export interface AiScoreLimits {
  maxHnScore: number
  maxGithubScore: number
  maxRedditScore?: number
  maxZennScore?: number
  maxQiitaScore?: number
}

const AI_REACTION_LIMIT_KEYS = {
  hn: 'maxHnScore',
  github: 'maxGithubScore',
  reddit: 'maxRedditScore',
  zenn: 'maxZennScore',
  qiita: 'maxQiitaScore',
} as const satisfies Record<AiReactionSource, keyof AiScoreLimits>

type TriageFields = Pick<NewsArticle, 'triageStatus' | 'triageVersion' | 'triageDecision' | 'developerValue' | 'summaryVersion' | 'summaryStatus' | 'summarizedAt'>
type SummaryFields = TriageFields & Pick<NewsArticle, 'summaryJa'>
type ReactionSourceFields = Pick<NewsArticle, 'source' | 'sourceName'>
type ReactionFields = ReactionSourceFields & Pick<NewsArticle, 'score'>
type ScoreFields = ReactionFields & Pick<NewsArticle, 'developerValue' | 'importance'>

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

export function getAiReactionSource({ source, sourceName }: ReactionSourceFields): AiReactionSource | null {
  if (source === 'hn' || source === 'github' || source === 'reddit') return source
  if (sourceName.startsWith('Zenn')) return 'zenn'
  if (sourceName.startsWith('Qiita')) return 'qiita'
  return null
}

export function getAiSourceBucket(article: ReactionSourceFields): AiSourceBucket {
  const source = getAiReactionSource(article)
  if (source === null) return 'otherRss'
  if (source === 'zenn' || source === 'qiita') return 'japanese'
  return source
}

export function collectAiScoreLimits(articles: ReactionFields[]): AiScoreLimits {
  const limits: Required<AiScoreLimits> = {
    maxHnScore: 0, maxGithubScore: 0, maxRedditScore: 0, maxZennScore: 0, maxQiitaScore: 0,
  }
  for (const article of articles) {
    const source = getAiReactionSource(article)
    const { score } = article
    if (source === null || typeof score !== 'number' || !Number.isFinite(score)) continue
    const key = AI_REACTION_LIMIT_KEYS[source]
    limits[key] = Math.max(limits[key], score)
  }
  return limits
}

export function calcAiBaseScore(
  article: Partial<ScoreFields>,
  limits: AiScoreLimits
): number {
  let score = article.developerValue === 'high' ? 100 : article.developerValue === 'normal' ? 60 : 0
  if (article.importance === 'high') score += 20
  else if (article.importance === 'low') score -= 10

  const source = getAiReactionSource({ source: article.source ?? 'rss', sourceName: article.sourceName ?? '' })
  if (source === null) return score + AI_REACTION_WEIGHT * AI_REACTION_NEUTRAL

  const max = limits[AI_REACTION_LIMIT_KEYS[source]] ?? 0
  const reactions = article.score
  const fallback = source === 'zenn' || source === 'qiita' ? AI_REACTION_NEUTRAL : 0
  const strength = typeof reactions === 'number' && Number.isFinite(reactions) && max > 0
    ? Math.min(Math.log1p(Math.max(reactions, 0)) / Math.log1p(max), 1)
    : fallback
  return score + AI_REACTION_WEIGHT * strength
}

export function selectAiFeed<T extends { article: Pick<NewsArticle, 'source' | 'sourceName'> & Partial<TriageFields>; displayScore: number }>(
  ranked: T[],
  now: number = Date.now()
): T[] {
  const counts: Record<AiSourceBucket, number> = { hn: 0, github: 0, reddit: 0, japanese: 0, otherRss: 0 }
  const selected: T[] = []
  for (const item of [...ranked].sort((a, b) => b.displayScore - a.displayScore)) {
    if (selected.length >= AI_FEED_MAX_ARTICLES) break
    if (!isAiFeedCandidate(item.article, now)) continue
    const bucket = getAiSourceBucket(item.article)
    if (counts[bucket] >= AI_FEED_SOURCE_LIMITS[bucket]) continue
    counts[bucket]++
    selected.push(item)
  }
  return selected
}
