import { createHash } from 'crypto'

export type NewsAction = 'dismiss' | 'readLater' | 'open'
export type NewsActionRequest = NewsAction | 'undismiss'

export function newsActionEventId(uid: string, topic: string, articleId: string, action: NewsAction): string {
  return createHash('sha256').update(`${uid}:${topic}:${articleId}:${action}`).digest('hex').slice(0, 32)
}
