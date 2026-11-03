export interface AiNewsFetchState {
  periodKey: string
  attemptsInPeriod: number
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  feedDate: string | null
  generationPending: boolean
  nextAutoAttemptAt: number | null
  lastManualAt?: number | null
}
const DAY = 86_400_000
export function refreshPeriodKey(nowMs: number): string {
  return new Date(nowMs + 3_600_000).toISOString().slice(0, 10)
}
export function decideAutoFetch(state: AiNewsFetchState, nowMs: number): { fetch: boolean; nextAttemptAt: number | null } {
  const period = refreshPeriodKey(nowMs)
  const nextPeriod = Date.parse(`${period}T08:00:00+09:00`) + DAY
  if (state.lastSuccessAt === null || state.feedDate === null) return { fetch: true, nextAttemptAt: null }
  if (state.feedDate >= period && !state.generationPending) return { fetch: false, nextAttemptAt: nextPeriod }
  if (state.periodKey !== period || state.attemptsInPeriod === 0) return { fetch: true, nextAttemptAt: null }
  if (state.attemptsInPeriod >= 3) return { fetch: false, nextAttemptAt: nextPeriod }
  const delay = state.attemptsInPeriod === 1 ? 30 * 60_000 : 120 * 60_000
  const next = Math.min(nextPeriod, Math.max(state.nextAutoAttemptAt ?? 0, (state.lastAttemptAt ?? nowMs) + delay))
  return nowMs >= next ? { fetch: true, nextAttemptAt: null } : { fetch: false, nextAttemptAt: next }
}
export function canManualRefresh(lastManualAt: number | null, nowMs: number): boolean {
  return lastManualAt === null || nowMs - lastManualAt >= 60_000
}
