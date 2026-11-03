import { isSyntheticGithubDescription } from '../aiSelection'
import type { NewsArticle } from '../types'

export type CuratorSummarySkipReason = 'no-evidence' | 'evidence-unavailable' | 'summary-unavailable'

type SummaryEvidenceArticle = Pick<NewsArticle, 'content' | 'source' | 'description' | 'contentFetchFailed'>
const AI_SUMMARY_TEXT_LIMIT = 2000

export function getSummaryEvidence(article: SummaryEvidenceArticle): { text: string; basis: 'content' | 'description' } | null {
  const content = article.content ?? ''
  if (content.trim()) return { text: content.slice(0, AI_SUMMARY_TEXT_LIMIT), basis: 'content' }
  // GitHub は README 本文が根拠で、合成説明文や短い説明だけでは要約しない。
  if (article.source === 'github') return null
  const description = article.description ?? ''
  if (!description.trim() || isSyntheticGithubDescription(description)) return null
  return { text: description.slice(0, AI_SUMMARY_TEXT_LIMIT), basis: 'description' }
}

export function getCuratorSummarySkipReason(article: SummaryEvidenceArticle): CuratorSummarySkipReason | null {
  if (getSummaryEvidence(article)) return null
  return article.contentFetchFailed ? 'evidence-unavailable' : 'no-evidence'
}

export function evaluateCuratorSummaryOutcome(input: {
  selectedIds: string[]
  skipped: Map<string, CuratorSummarySkipReason>
}): { ok: boolean } {
  return { ok: !input.selectedIds.some(id => {
    const reason = input.skipped.get(id)
    return reason === 'summary-unavailable' || reason === 'evidence-unavailable'
  }) }
}
