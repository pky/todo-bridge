import type { MobileActionItem, MobileActionItemState } from '@/types'

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
