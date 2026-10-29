// web/src/utils/mobileNewsDisplay.ts
// モバイルトピックの共有記事の表示条件。サーバー側の個別フィード（isEligibleMobileFeedArticle と15件上限）と揃える。
import type { NewsArticle } from '@/types'

export const MOBILE_NEWS_MAX_ARTICLES = 15

// 上限は掛けない。共有記事は利用者の除外条件を当てた後に selectDisplayableMobileNews で上限を掛ける。
export function filterEligibleMobileNews(articles: NewsArticle[]): NewsArticle[] {
  return articles.filter((article) => article.inScope === true && article.classificationStatus === 'done')
}

export function selectDisplayableMobileNews(articles: NewsArticle[]): NewsArticle[] {
  return filterEligibleMobileNews(articles).slice(0, MOBILE_NEWS_MAX_ARTICLES)
}
