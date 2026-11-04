import { calcAiBaseScore, selectAiFeed } from '../aiSelection'
import { buildEventSignals, buildInteractionSignals, calcPreferenceMultiplier, learnKeywordPreferences } from '../interactionLearning'
import type { NewsArticle, NewsPreferences } from '../types'

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
}

export type CuratorSelectionInput = CuratorSelectionBase & (
  | { events: Record<string, unknown>[]; interactions?: never }
  | { events?: undefined; interactions: Record<string, unknown>[] }
)

export function selectCuratorAiFeed(input: CuratorSelectionInput): RankedFeedItem[] {
  // 旧呼び出しの互換を保つが、events指定時は旧履歴を混ぜない。
  const sourceSignals = input.events !== undefined
    ? input.events.flatMap(buildEventSignals)
    : input.interactions.filter(data => !data.topic || data.topic === 'ai').flatMap(buildInteractionSignals)
  const signals = sourceSignals
    .filter(signal => signal.atMs <= input.learningCutoffMs)
  const learned = learnKeywordPreferences(signals, input.learningCutoffMs)
  return selectAiFeed(input.articles.map(article => ({
    article,
    displayScore: calcAiBaseScore(article, input.scoreLimits)
      * calcPreferenceMultiplier(article, input.preferences, learned),
  })))
}
