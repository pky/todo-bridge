import { calcAiBaseScore, selectAiFeed } from '../aiSelection'
import { buildEventSignals, buildInteractionSignals, calcPreferenceMultiplier, learnKeywordPreferences } from '../interactionLearning'
import type { NewsArticle, NewsPreferences } from '../types'
import type { PersonalFit } from './curatorPersonalFit'

export type NewsArticleWithId = NewsArticle & { id: string }
export interface RankedFeedItem {
  article: NewsArticleWithId
  displayScore: number
}

interface CuratorSelectionBase {
  articles: NewsArticleWithId[]
  preferences: NewsPreferences
  learningCutoffMs: number
  scoreLimits: { maxHnScore: number; maxGithubScore: number }
  personalFit?: Map<string, PersonalFit>
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
  return selectAiFeed(input.articles.map(article => ({
    article,
    displayScore: calcAiBaseScore(article, input.scoreLimits)
      * calcPreferenceMultiplier(article, input.preferences, learned)
      * (input.personalFit?.get(article.id) === 'high' ? 1.3 : input.personalFit?.get(article.id) === 'low' ? 0.7 : 1),
  })))
}
