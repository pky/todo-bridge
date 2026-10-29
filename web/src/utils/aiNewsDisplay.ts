// web/src/utils/aiNewsDisplay.ts
// AI トピックの表示条件。個別フィード・共有記事・キャッシュのすべてでこの関数を通す。
import type { NewsArticle } from '@/types'

export const AI_NEWS_MAX_ARTICLES = 20

// 上限は掛けない。共有記事は利用者の除外条件を当てた後に selectDisplayableAiNews で上限を掛ける。
export function filterEligibleAiNews(
  articles: NewsArticle[],
  { shared }: { shared: boolean }
): NewsArticle[] {
  const displayable = articles.filter(
    (article) => (article.summaryJa ?? '').trim() !== '' && (!shared || article.feedEligible === true)
  )
  if (shared) displayable.sort((a, b) => (b.sharedScore ?? 0) - (a.sharedScore ?? 0))
  return displayable
}

export function selectDisplayableAiNews(
  articles: NewsArticle[],
  { shared }: { shared: boolean }
): NewsArticle[] {
  return filterEligibleAiNews(articles, { shared }).slice(0, AI_NEWS_MAX_ARTICLES)
}
