import { createHash } from 'node:crypto'
import { getMobileMatchKey } from './collectArticles'
import type { NewsArticle } from './types'

export const MOBILE_ACTION_ITEM_MAX_AGE_DAYS = 180
const MAX_AGE_MS = MOBILE_ACTION_ITEM_MAX_AGE_DAYS * 24 * 60 * 60 * 1000

export type MobileActionItem = Pick<NewsArticle,
  'url' | 'titleJa' | 'title' | 'summaryJa' | 'mobileSummary' | 'platform' |
  'sourceName' | 'isOfficial' | 'importantLevel' | 'actionRequired' |
  'actionType' | 'requiredByDate'
> & {
  key: string
  publishedAt: number
  firstSeenDate: string
}

export function isMobileActionItemArticle(article: NewsArticle): boolean {
  return article.inScope === true && article.classificationStatus === 'done' && (
    article.importantLevel === 'urgent' || article.actionRequired === true || article.actionType === 'security'
  )
}

export function getMobileActionItemKey(url: string): string {
  return createHash('sha256').update(getMobileMatchKey(url)).digest('hex').slice(0, 20)
}

export function buildMobileActionItem(article: NewsArticle, today: string): MobileActionItem {
  return {
    key: getMobileActionItemKey(article.url),
    url: article.url,
    title: article.title,
    sourceName: article.sourceName,
    ...(article.titleJa !== undefined ? { titleJa: article.titleJa } : {}),
    ...(article.summaryJa !== undefined ? { summaryJa: article.summaryJa } : {}),
    ...(article.mobileSummary ? { mobileSummary: article.mobileSummary } : {}),
    ...(article.platform ? { platform: article.platform } : {}),
    ...(typeof article.isOfficial === 'boolean' ? { isOfficial: article.isOfficial } : {}),
    ...(article.importantLevel ? { importantLevel: article.importantLevel } : {}),
    ...(typeof article.actionRequired === 'boolean' ? { actionRequired: article.actionRequired } : {}),
    ...(article.actionType ? { actionType: article.actionType } : {}),
    ...(article.requiredByDate ? { requiredByDate: article.requiredByDate } : {}),
    publishedAt: article.publishedAt.toMillis(),
    firstSeenDate: today,
  }
}

export function mergeMobileActionItems(
  current: Record<string, MobileActionItem>, articles: NewsArticle[], now: number, today: string
): { items: Record<string, MobileActionItem>; changed: boolean } {
  const cutoff = now - MAX_AGE_MS
  const items = { ...current }
  let changed = false
  for (const [key, item] of Object.entries(items)) {
    if (item.publishedAt < cutoff) {
      delete items[key]
      changed = true
    }
  }
  for (const article of articles) {
    if (!isMobileActionItemArticle(article) || article.publishedAt.toMillis() < cutoff) continue
    const key = getMobileActionItemKey(article.url)
    if (items[key]) continue
    items[key] = buildMobileActionItem(article, today)
    changed = true
  }
  return { items, changed }
}

export async function syncMobileActionItems(
  store: {
    load(): Promise<Record<string, MobileActionItem> | null>
    save(items: Record<string, MobileActionItem>): Promise<void>
  },
  articles: NewsArticle[], now: number, today: string
): Promise<{ changed: boolean; count: number }> {
  const current = await store.load() ?? {}
  const { items, changed } = mergeMobileActionItems(current, articles, now, today)
  if (changed) await store.save(items)
  return { changed, count: Object.keys(items).length }
}
