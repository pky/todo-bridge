import type { MobileActionItem, MobileActionItemState, NewsPreferences } from '@/types'

export function matchesMobileActionItemPreferences(item: MobileActionItem, preferences: NewsPreferences): boolean {
  const platforms = preferences.platforms ?? ['ios', 'android']
  if (item.platform != null && item.platform !== 'cross' && !platforms.includes(item.platform)) return false
  if (preferences.officialOnly === true && item.isOfficial !== true) return false
  // sourceTier を持たない既存の集約では、非公式の項目をコミュニティ記事として扱う。
  const isCommunity = item.sourceTier === 'community-rss'
    || (item.sourceTier == null && item.isOfficial === false)
  if (preferences.includeCommunity === false && isCommunity) return false
  if (preferences.actionRequiredOnly === true && item.actionRequired !== true) return false
  return true
}

function getImportanceRank(item: MobileActionItem): number {
  let rank = 0
  if (item.importantLevel === 'urgent') rank += 12
  if (item.importantLevel === 'review') rank += 6
  if (item.isOfficial) rank += 4
  if (item.actionRequired) rank += 8
  if (item.requiredByDate) rank += 4

  switch (item.actionType) {
    case 'sdk_requirement': rank += 5; break
    case 'policy':
    case 'play_policy':
    case 'security': rank += 4; break
    case 'store_review': rank += 3; break
    case 'beta': rank += 2; break
    case 'release': rank += 1; break
  }
  return rank
}

export function selectUnresolvedActionItems(
  items: Record<string, MobileActionItem>,
  resolved: Record<string, MobileActionItemState>,
): MobileActionItem[] {
  return Object.values(items)
    .filter(item => !resolved[item.key])
    .sort((left, right) => getImportanceRank(right) - getImportanceRank(left)
      || (left.requiredByDate ?? '9999-12-31').localeCompare(right.requiredByDate ?? '9999-12-31')
      || right.publishedAt - left.publishedAt)
}

export function selectResolvedActionItems(
  items: Record<string, MobileActionItem>,
  resolved: Record<string, MobileActionItemState>,
): MobileActionItem[] {
  return Object.values(items)
    .filter(item => resolved[item.key])
    .sort((left, right) => resolved[right.key]!.at - resolved[left.key]!.at)
}

export function isActionItemOverdue(item: MobileActionItem, today: string): boolean {
  return Boolean(item.requiredByDate && item.requiredByDate < today)
}

export function pruneResolvedState(
  items: Record<string, MobileActionItem>,
  resolved: Record<string, MobileActionItemState>,
): Record<string, MobileActionItemState> {
  return Object.fromEntries(Object.entries(resolved).filter(([key]) => items[key]))
}
