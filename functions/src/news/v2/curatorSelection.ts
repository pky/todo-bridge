import { calcAiBaseScore, selectAiFeed } from '../aiSelection'
import { buildInteractionSignals, calcPreferenceMultiplier, learnKeywordPreferences } from '../interactionLearning'
import type { NewsArticle, NewsPreferences } from '../types'

export type NewsArticleWithId = NewsArticle & { id: string }
export interface RankedFeedItem {
  article: NewsArticleWithId
  displayScore: number
}

export interface CuratorSelectionInput {
  articles: NewsArticleWithId[]
  preferences: NewsPreferences
  interactions: Record<string, unknown>[]
  learningCutoffMs: number
  scoreLimits: { maxHnScore: number; maxGithubScore: number }
}

export function selectCuratorAiFeed(input: CuratorSelectionInput): RankedFeedItem[] {
  const signals = input.interactions
    .filter(data => !data.topic || data.topic === 'ai')
    .flatMap(buildInteractionSignals)
    .filter(signal => signal.atMs <= input.learningCutoffMs)
  const learned = learnKeywordPreferences(signals, input.learningCutoffMs)
  return selectAiFeed(input.articles.map(article => ({
    article,
    displayScore: calcAiBaseScore(article, input.scoreLimits)
      * calcPreferenceMultiplier(article, input.preferences, learned),
  })))
}
