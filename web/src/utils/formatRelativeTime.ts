const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export function formatRelativeTime(target: Date, now: Date): string {
  const elapsedMs = now.getTime() - target.getTime()

  if (elapsedMs < MINUTE_MS) {
    return 'たった今'
  }
  if (elapsedMs < HOUR_MS) {
    return `${Math.floor(elapsedMs / MINUTE_MS)}分前`
  }
  if (elapsedMs < DAY_MS) {
    return `${Math.floor(elapsedMs / HOUR_MS)}時間前`
  }
  if (elapsedMs < 7 * DAY_MS) {
    return `${Math.floor(elapsedMs / DAY_MS)}日前`
  }

  const year = String(target.getFullYear()).padStart(4, '0')
  const month = String(target.getMonth() + 1).padStart(2, '0')
  const day = String(target.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}
