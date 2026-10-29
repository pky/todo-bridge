export type WidgetTopic = 'ai' | 'mobile'
export type FeedDoc = { id: string } & Record<string, unknown>

export interface WidgetFeedInput {
  topic: WidgetTopic
  personalDate: string | null
  personalDocs: FeedDoc[]
  sharedDate: string | null
  sharedDocs: FeedDoc[]
  interactions: FeedDoc[]
}

export interface WidgetFeedResult {
  feedDate: string | null
  isSharedFallback: boolean
  articles: FeedDoc[]
}

function numericScore(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function publishedMillis(value: unknown): number {
  if (value && typeof value === 'object' && 'toMillis' in value && typeof value.toMillis === 'function') {
    return numericScore(value.toMillis())
  }
  return 0
}

function eligibleArticles(articles: FeedDoc[], topic: WidgetTopic, shared: boolean): FeedDoc[] {
  if (topic === 'ai') {
    const eligible = articles.filter((article) =>
      typeof article.summaryJa === 'string' && article.summaryJa.trim() !== '' &&
      (!shared || article.feedEligible === true))
    if (shared) eligible.sort((a, b) => numericScore(b.sharedScore) - numericScore(a.sharedScore))
    return eligible
  }
  return shared
    ? articles.filter((article) => article.inScope === true && article.classificationStatus === 'done')
    : articles
}

export function selectWidgetFeed(input: WidgetFeedInput): WidgetFeedResult {
  const { topic } = input
  const excludedUrls = new Set<string>()
  const dismissedArticleIds = new Set<unknown>()
  for (const interaction of input.interactions) {
    if (interaction.topic !== topic && !(!interaction.topic && topic === 'ai')) continue
    const url = interaction.url
    if (interaction.dismissed === true) dismissedArticleIds.add(interaction.articleId ?? interaction.id)
    if (typeof url === 'string' && url && (
      (typeof interaction.shownCount === 'number' && interaction.shownCount >= 2) ||
      interaction.dismissed === true || interaction.clickedAt
    )) excludedUrls.add(url)
  }

  const personalDocs = [...input.personalDocs].sort((a, b) =>
    numericScore(b.displayScore) - numericScore(a.displayScore))
  const sortedSharedDocs = [...input.sharedDocs].sort((a, b) => {
    const aPublished = publishedMillis(a.publishedAt)
    const bPublished = publishedMillis(b.publishedAt)
    return bPublished !== aPublished ? bPublished - aPublished : numericScore(b.score) - numericScore(a.score)
  })
  const sharedDocs = eligibleArticles(sortedSharedDocs, topic, true)
  const sharedDate = sharedDocs.length > 0 ? input.sharedDate : null
  let isSharedFallback = !!sharedDate && (!input.personalDate || sharedDate > input.personalDate)

  const isExcluded = (article: FeedDoc): boolean =>
    dismissedArticleIds.has(article.id) || (typeof article.url === 'string' && excludedUrls.has(article.url))
  const resolveVisible = (docs: FeedDoc[], shared: boolean): FeedDoc[] => {
    const remaining = docs.filter((article) =>
      !dismissedArticleIds.has(article.id) && typeof article.title === 'string' &&
      (!(typeof article.url === 'string' && excludedUrls.has(article.url)) ||
        (topic === 'mobile' && article.importantLevel === 'urgent')))
    const eligible = eligibleArticles(remaining, topic, shared)
    return topic === 'ai' ? eligible.slice(0, 20) : shared ? eligible.slice(0, 15) : eligible
  }

  // 切り戻し判定では、共有記事の緊急指定より先に利用者の除外条件を確認する。
  if (isSharedFallback && input.personalDate && sharedDocs.filter((article) => !isExcluded(article)).length === 0) {
    if (resolveVisible(personalDocs, false).length > 0) isSharedFallback = false
  }

  const feedDate = isSharedFallback ? sharedDate : input.personalDate
  return {
    feedDate,
    isSharedFallback,
    articles: feedDate ? resolveVisible(isSharedFallback ? sharedDocs : personalDocs, isSharedFallback) : [],
  }
}
