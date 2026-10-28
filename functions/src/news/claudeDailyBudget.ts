import type { Firestore } from 'firebase-admin/firestore'

export function createClaudeDailyRequestReservation(
  db: Pick<Firestore, 'doc' | 'runTransaction'>,
  stage: 'ai-triage' | 'ai-summary',
  dailyMaxRequests: number,
  now: () => Date = () => new Date()
): () => Promise<boolean> {
  return async () => {
    if (!Number.isSafeInteger(dailyMaxRequests) || dailyMaxRequests <= 0) return false
    try {
      const day = new Date(now().getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const ref = db.doc(`newsApiUsage/${stage}-${day}`)
      return await db.runTransaction(async transaction => {
        const snap = await transaction.get(ref)
        const count: unknown = snap.exists ? snap.data()?.requestCount : 0
        // 不正な台帳をゼロとして扱うと上限を超えるため、予約を拒否する。
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count >= dailyMaxRequests) {
          return false
        }
        transaction.set(ref, { requestCount: count + 1 }, { merge: true })
        return true
      })
    } catch (err) {
      console.warn(`[claudeDailyBudget] reservation failed name=${err instanceof Error ? err.name : 'unknown'}`)
      return false
    }
  }
}
