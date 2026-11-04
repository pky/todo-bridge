import { Timestamp } from 'firebase-admin/firestore'
import { LEARNING_WINDOW_DAYS } from '../interactionLearning'
import { newsActionEventId, type NewsAction } from './newsActionStore'

interface MigrationEvent {
  eventId: string
  data: {
    topic: 'ai'
    articleId: string
    action: NewsAction
    receivedAt: Date | Timestamp
    title: string
    summary: string
    tags: string[]
    url?: string
    source: 'migration'
  }
}

export function planNewsActionEventMigration(input: {
  uid: string
  interactions: Array<{ id: string; data: Record<string, unknown> }>
  nowMs: number
}): MigrationEvent[] {
  const plan: MigrationEvent[] = []
  const oldestMs = input.nowMs - LEARNING_WINDOW_DAYS * 86400000
  for (const { id, data } of input.interactions) {
    // topicなしは従来のAI履歴として扱い、明示された別topicは移行しない。
    if (data.topic && data.topic !== 'ai') continue
    const action = data.readLaterAt ? 'readLater' : data.dismissed === true ? 'dismiss' : null
    if (action === null) continue
    const receivedAt = action === 'readLater' ? data.readLaterAt : data.dismissedAt
    if (!(receivedAt instanceof Date) && !(receivedAt instanceof Timestamp)) continue
    const atMs = receivedAt instanceof Date ? receivedAt.getTime() : receivedAt.toMillis()
    if (!Number.isFinite(atMs) || atMs < oldestMs || atMs > input.nowMs) continue
    const articleId = typeof data.articleId === 'string' && data.articleId !== ''
      ? data.articleId : id.startsWith('ai_') ? id.slice(3) : id
    if (!articleId) continue
    plan.push({
      eventId: newsActionEventId(input.uid, 'ai', articleId, action),
      data: {
        topic: 'ai', articleId, action, receivedAt,
        title: typeof data.titleEn === 'string' && data.titleEn !== ''
          ? data.titleEn : typeof data.title === 'string' ? data.title : '',
        summary: typeof data.summaryJa === 'string' ? data.summaryJa : '',
        tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        ...(typeof data.url === 'string' ? { url: data.url } : {}),
        source: 'migration',
      },
    })
  }
  return plan
}

export async function applyNewsActionEventMigration(input: {
  db: FirebaseFirestore.Firestore
  uid: string
  plan: MigrationEvent[]
  dryRun: boolean
}): Promise<{ planned: number; created: number; skippedExisting: number }> {
  const result = { planned: input.plan.length, created: 0, skippedExisting: 0 }
  if (input.dryRun) return result
  for (const event of input.plan) {
    try {
      // createの存在条件で、通常操作との競合時も元のイベントを上書きしない。
      await input.db.doc(`users/${input.uid}/newsActionEvents/${event.eventId}`).create(event.data)
      result.created++
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error
        && (error.code === 6 || error.code === 'already-exists')) {
        result.skippedExisting++
      } else {
        throw error
      }
    }
  }
  return result
}
