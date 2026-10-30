import * as functions from 'firebase-functions/v1'
import type { WidgetTopic } from './widgetFeed'
import type { ReadLaterArticle } from './widgetReadLaterStore'

export interface WidgetReadLaterDeps {
  verifyIdToken(token: string): Promise<{ uid: string }>
  /** ユーザー自身のフィードから記事を探す。見つからなければ null。 */
  findArticle(uid: string, topic: WidgetTopic, articleId: string): Promise<ReadLaterArticle | null>
  isAdded(uid: string, topic: WidgetTopic, articleId: string): Promise<boolean>
  add(uid: string, topic: WidgetTopic, article: ReadLaterArticle): Promise<'created' | 'already'>
}

/**
 * POST のみ。Authorization: Bearer <ID トークン>、本文 {"topic":"ai"|"mobile","articleId":"<記事ID>"}。
 * 200 {"status":"created"|"already"}、401 unauthenticated、400 invalid-argument、404 not-found、405 method-not-allowed、500 internal。
 * 全応答に Cache-Control: private, no-store を付ける。
 */
export function createWidgetReadLaterHandler(_deps: WidgetReadLaterDeps): (
  req: functions.https.Request, res: functions.Response
) => Promise<void> {
  return async (_req, res) => {
    res.status(500).json({ error: 'internal' })
  }
}
