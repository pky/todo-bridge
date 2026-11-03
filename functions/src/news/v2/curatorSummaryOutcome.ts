export type CuratorSummarySkipReason = 'no-evidence' | 'summary-unavailable'

export function evaluateCuratorSummaryOutcome(input: {
  selectedIds: string[]
  skipped: Map<string, CuratorSummarySkipReason>
}): { ok: boolean } {
  return { ok: !input.selectedIds.some(id => input.skipped.get(id) === 'summary-unavailable') }
}
