import type { AiReaction, NewsArticle } from './types'
import { normalizeUrl } from './normalizeUrl'

export const AI_REACTION_WEIGHT = 60
export const AI_REACTION_NEUTRAL = 0.5

export type AiReactionSource = 'hn' | 'github' | 'reddit' | 'zenn' | 'qiita'

export interface AiScoreLimits {
  maxHnScore: number
  maxGithubScore: number
  maxRedditScore?: number
  maxZennScore?: number
  maxQiitaScore?: number
}

export const AI_REACTION_LIMIT_KEYS = {
  hn: 'maxHnScore',
  github: 'maxGithubScore',
  reddit: 'maxRedditScore',
  zenn: 'maxZennScore',
  qiita: 'maxQiitaScore',
} as const satisfies Record<AiReactionSource, keyof AiScoreLimits>

export const AI_OFFICIAL_DOMAINS = [
  'anthropic.com', 'claude.com', 'openai.com', 'deepmind.google', 'blog.google', 'ai.google.dev',
  'ai.meta.com', 'mistral.ai', 'x.ai', 'huggingface.co', 'github.blog', 'blogs.nvidia.com',
  'developer.nvidia.com', 'aws.amazon.com', 'devblogs.microsoft.com',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isAiReactionSource(source: unknown): source is AiReactionSource {
  return typeof source === 'string' && Object.prototype.hasOwnProperty.call(AI_REACTION_LIMIT_KEYS, source)
}

export function getAiReactionSource({ source, sourceName }: { source?: unknown; sourceName?: unknown }): AiReactionSource | null {
  if (source === 'hn' || source === 'github' || source === 'reddit') return source
  if (typeof sourceName === 'string') {
    if (sourceName.startsWith('Zenn')) return 'zenn'
    if (sourceName.startsWith('Qiita')) return 'qiita'
  }
  return null
}

function isReactionCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isAiReaction(value: unknown): value is AiReaction {
  return isRecord(value) && isAiReactionSource(value.source) && isReactionCount(value.count)
    && typeof value.sourceName === 'string' && typeof value.url === 'string'
}

export function getOwnArticleReaction(article: unknown): AiReaction | null {
  if (!isRecord(article)) return null
  const source = getAiReactionSource(article)
  const { score, sourceName } = article
  const url = article.discussionUrl ?? article.url
  return source !== null && isReactionCount(score) && typeof url === 'string' && typeof sourceName === 'string'
    ? { source, sourceName, count: score, url }
    : null
}

function getExtraReactions(value: unknown): AiReaction[] {
  return Array.isArray(value) ? value.filter(isAiReaction) : []
}

export function getArticleReactions(article: unknown): AiReaction[] {
  return getUniqueArticleReactions([article])
}

export function getUniqueArticleReactions(articles: unknown[]): AiReaction[] {
  const unique = new Map<string, AiReaction>()
  for (const article of articles) {
    if (!isRecord(article)) continue
    const own = getOwnArticleReaction(article)
    const reactions = getExtraReactions(article.extraReactions)
    if (own) reactions.unshift(own)
    for (const reaction of reactions) {
      const key = `${reaction.source}:${normalizeUrl(reaction.url)}`
      const previous = unique.get(key)
      if (!previous || reaction.count > previous.count) unique.set(key, reaction)
    }
  }
  return [...unique.values()]
}

type ReactionFields = Pick<NewsArticle, 'source' | 'sourceName' | 'score' | 'extraReactions'>
type ArticleValueFields = Pick<NewsArticle, 'developerValue' | 'importance'>

export function collectAiScoreLimits(articles: ReactionFields[]): AiScoreLimits {
  const limits: Required<AiScoreLimits> = {
    maxHnScore: 0, maxGithubScore: 0, maxRedditScore: 0, maxZennScore: 0, maxQiitaScore: 0,
  }
  for (const article of articles) {
    const source = getAiReactionSource(article)
    if (source !== null && isReactionCount(article.score)) {
      const key = AI_REACTION_LIMIT_KEYS[source]
      limits[key] = Math.max(limits[key], article.score)
    }
    for (const reaction of getExtraReactions(article.extraReactions)) {
      const key = AI_REACTION_LIMIT_KEYS[reaction.source]
      limits[key] = Math.max(limits[key], reaction.count)
    }
  }
  return limits
}

export function calcReactionStrengthSum(reactions: AiReaction[], limits: AiScoreLimits): number | null {
  let sum: number | null = null
  for (const { source, count } of reactions) {
    const max = limits[AI_REACTION_LIMIT_KEYS[source]] ?? 0
    if (max > 0) sum = (sum ?? 0) + Math.min(Math.log1p(count) / Math.log1p(max), 1)
  }
  return sum
}

function developerValueScore(value: NewsArticle['developerValue']): number {
  return value === 'high' ? 100 : value === 'normal' ? 60 : 0
}

export function calcAiArticleValue(article: Partial<ArticleValueFields>): number {
  const importance = article.importance === 'high' ? 20 : article.importance === 'low' ? -10 : 0
  return developerValueScore(article.developerValue) + importance
}

export function calcAiStoryScore(representative: Partial<ArticleValueFields>, members: unknown[], limits: AiScoreLimits): number {
  const reactions = getUniqueArticleReactions([representative, ...members])
  const strength = calcReactionStrengthSum(reactions, limits) ?? AI_REACTION_NEUTRAL
  return calcAiArticleValue(representative) + AI_REACTION_WEIGHT * strength
}

type OfficialSourceFields = Pick<NewsArticle, 'publisherDomain' | 'url'>

export function isOfficialAiSource(article: OfficialSourceFields): boolean {
  try {
    const domain = (article.publisherDomain ?? new URL(article.url).hostname).toLowerCase().replace(/^www\./, '')
    return AI_OFFICIAL_DOMAINS.some(official => domain === official || domain.endsWith(`.${official}`))
  } catch {
    return false
  }
}

export function pickStoryRepresentative<T extends ReactionFields & OfficialSourceFields & Pick<NewsArticle, 'developerValue'>>(
  articles: T[]
): T | undefined {
  const limits = collectAiScoreLimits(articles)
  const ranked = articles.map(article => ({
    article,
    official: Number(isOfficialAiSource(article)),
    value: developerValueScore(article.developerValue),
    strength: calcReactionStrengthSum(getArticleReactions(article), limits) ?? 0,
  }))
  ranked.sort((a, b) => b.official - a.official || b.value - a.value || b.strength - a.strength)
  return ranked[0]?.article
}
