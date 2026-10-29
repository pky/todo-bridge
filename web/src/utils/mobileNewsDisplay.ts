// web/src/utils/mobileNewsDisplay.ts
// モバイルトピックの共有記事の表示条件。サーバー側の個別フィード（isEligibleMobileFeedArticle と15件上限）と揃える。
import type { NewsArticle } from '@/types'

export const MOBILE_NEWS_MAX_ARTICLES = 15

export function selectDisplayableMobileNews(articles: NewsArticle[]): NewsArticle[] {
  return articles
    .filter((article) => article.inScope === true && article.classificationStatus === 'done')
    .slice(0, MOBILE_NEWS_MAX_ARTICLES)
}
