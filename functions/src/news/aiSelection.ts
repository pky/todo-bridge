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
export const AI_FEED_SOURCE_LIMITS = { hn: 5, github: 4, japanese: 8, otherRss: 6 }

export type AiSourceBucket = keyof typeof AI_FEED_SOURCE_LIMITS

type TriageFields = Pick<NewsArticle, 'triageStatus' | 'triageVersion' | 'triageDecision' | 'developerValue' | 'summaryVersion' | 'summaryStatus' | 'summarizedAt'>
type SummaryFields = TriageFields & Pick<NewsArticle, 'summaryJa'>
type ScoreFields = Pick<NewsArticle, 'source' | 'score' | 'developerValue' | 'importance'>

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

export function getAiSourceBucket(article: Pick<NewsArticle, 'source' | 'sourceName'>): AiSourceBucket {
  if (article.source === 'hn') return 'hn'
  if (article.source === 'github') return 'github'
  if (article.sourceName.startsWith('Zenn') || article.sourceName.startsWith('Qiita')) return 'japanese'
  return 'otherRss'
}

export function calcAiBaseScore(
  article: Partial<ScoreFields>,
  { maxHnScore, maxGithubScore }: { maxHnScore: number; maxGithubScore: number }
): number {
  let score = article.developerValue === 'high' ? 100 : article.developerValue === 'normal' ? 60 : 0
  if (article.importance === 'high') score += 20
  else if (article.importance === 'low') score -= 10

  if (article.source === 'hn' || article.source === 'github') {
    const max = article.source === 'hn' ? maxHnScore : maxGithubScore
    if (typeof article.score === 'number' && max > 0) score += Math.min(article.score / max, 1) * 20
  } else {
    score += 10
  }
  return score
}

export function selectAiFeed<T extends { article: Pick<NewsArticle, 'source' | 'sourceName'> & Partial<TriageFields>; displayScore: number }>(
  ranked: T[],
  now: number = Date.now()
): T[] {
  const counts: Record<AiSourceBucket, number> = { hn: 0, github: 0, japanese: 0, otherRss: 0 }
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
