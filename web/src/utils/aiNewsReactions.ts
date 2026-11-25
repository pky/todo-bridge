import type { AiNewsReaction } from '@/types/news'

export function formatReactionCount(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

export function formatAiReaction(reaction: AiNewsReaction): string {
  const count = formatReactionCount(reaction.count)
  switch (reaction.source) {
    case 'hn': return `HN ${count}pt`
    case 'github': return `GitHub +${count} stars today`
    case 'reddit': return `Reddit ${count} upvotes`
    case 'zenn': return `Zenn ${count} いいね`
    case 'qiita': return `Qiita ${count} いいね`
  }
}
