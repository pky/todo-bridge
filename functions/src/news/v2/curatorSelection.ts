import { calcAiBaseScore, isAiFeedCandidate, selectAiFeed, type AiScoreLimits } from '../aiSelection'
import { calcAiStoryScore, pickStoryRepresentative } from '../aiStories'
import { buildEventSignals, buildInteractionSignals, calcPreferenceMultiplier, learnKeywordPreferences } from '../interactionLearning'
import type { NewsArticle, NewsPreferences } from '../types'
import type { PersonalFit } from './curatorPersonalFit'

export type NewsArticleWithId = NewsArticle & { id: string }
export interface RankedFeedItem {
  article: NewsArticleWithId
  displayScore: number
  members: NewsArticleWithId[]
}

interface CuratorSelectionBase {
  articles: NewsArticleWithId[]
  preferences: NewsPreferences
  learningCutoffMs: number
  scoreLimits: AiScoreLimits
  personalFit?: Map<string, PersonalFit>
  storyGroups?: string[][]
}

export type CuratorSelectionInput = CuratorSelectionBase & (
  | { events: Record<string, unknown>[]; interactions?: never }
  | { events?: undefined; interactions: Record<string, unknown>[] }
)

export function excludeActedArticles(
  articles: NewsArticleWithId[], events: Record<string, unknown>[]
): NewsArticleWithId[] {
  const excludedUrls = new Set<string>()
  const excludedIds = new Set<string>()
  for (const event of events) {
    if (event.action !== 'readLater' && event.action !== 'dismiss') continue
    if (typeof event.url === 'string' && event.url.length > 0) excludedUrls.add(event.url)
    if (typeof event.articleId === 'string' && event.articleId.length > 0) excludedIds.add(event.articleId)
  }
  return articles.filter(article => !excludedUrls.has(article.url) && !excludedIds.has(article.id))
}

export function selectCuratorAiFeed(input: CuratorSelectionInput): RankedFeedItem[] {
  // 旧呼び出しの互換を保つが、events指定時は旧履歴を混ぜない。
  const sourceSignals = input.events !== undefined
    ? input.events.flatMap(buildEventSignals)
    : input.interactions.filter(data => !data.topic || data.topic === 'ai').flatMap(buildInteractionSignals)
  const signals = sourceSignals
    .filter(signal => signal.atMs <= input.learningCutoffMs)
  const learned = input.personalFit ? { positive: [], negative: [] } : learnKeywordPreferences(signals, input.learningCutoffMs)
  const now = Date.now()
  const groupedMembers = new Map<string, NewsArticleWithId[]>()
  const memberIds = new Set<string>()
  for (const group of input.storyGroups ?? []) {
    const ids = new Set(group)
    const articles = input.articles.filter(article =>
      ids.has(article.id) && !memberIds.has(article.id) && isAiFeedCandidate(article, now)
    )
    if (articles.length < 2) continue
    const representative = pickStoryRepresentative(articles)
    if (!representative) continue
    groupedMembers.set(representative.id, articles.filter(article => article.id !== representative.id))
    for (const article of articles) memberIds.add(article.id)
  }

  return selectAiFeed(input.articles.flatMap(article => {
    const members = groupedMembers.get(article.id)
    if (members === undefined && memberIds.has(article.id)) return []
    const score = members ? calcAiStoryScore(article, members, input.scoreLimits) : calcAiBaseScore(article, input.scoreLimits)
    const fit = input.personalFit?.get(article.id)
    return [{
      article,
      members: members ?? [],
      displayScore: score * calcPreferenceMultiplier(article, input.preferences, learned)
        * (fit === 'high' ? 1.3 : fit === 'low' ? 0.7 : 1),
    }]
  }), now)
}
