import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { selectWidgetFeed } from './widgetFeed'
import type { WidgetTopic } from './widgetFeed'
import { loadWidgetFeedInputs } from './widgetNewsLoader'
import { addReadLaterTask, isReadLaterAdded } from './widgetReadLaterStore'
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
export function createWidgetReadLaterHandler(deps: WidgetReadLaterDeps): (
  req: functions.https.Request, res: functions.Response
) => Promise<void> {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method-not-allowed' })
      return
    }

    const authorization = req.headers.authorization
    const match = typeof authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(authorization) : null
    if (!match) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }

    let uid: string
    try {
      uid = (await deps.verifyIdToken(match[1])).uid
    } catch {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }

    const body: unknown = req.body
    const { topic, articleId } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    if (
      (topic !== 'ai' && topic !== 'mobile') ||
      typeof articleId !== 'string' || articleId.length === 0 || articleId.length > 200 || articleId.includes('/')
    ) {
      res.status(400).json({ error: 'invalid-argument' })
      return
    }

    try {
      if (await deps.isAdded(uid, topic, articleId)) {
        res.status(200).json({ status: 'already' })
        return
      }
      const article = await deps.findArticle(uid, topic, articleId)
      if (!article) {
        res.status(404).json({ error: 'not-found' })
        return
      }
      const status = await deps.add(uid, topic, article)
      res.status(200).json({ status })
    } catch {
      console.error('あとで読むの追加に失敗しました')
      res.status(500).json({ error: 'internal' })
    }
  }
}

async function findVisibleArticle(uid: string, topic: WidgetTopic, articleId: string): Promise<ReadLaterArticle | null> {
  const input = await loadWidgetFeedInputs(admin.firestore(), uid, topic)
  const doc = selectWidgetFeed(input).articles.find((article) => article.id === articleId)
  if (!doc) return null
  const titleJa = doc.titleJa
  const title = doc.title
  const summaryJa = doc.summaryJa
  return {
    id: doc.id,
    title: typeof titleJa === 'string' && titleJa !== '' ? titleJa : typeof title === 'string' ? title : '',
    summary: typeof summaryJa === 'string' ? summaryJa.trim() : '',
    url: typeof doc.url === 'string' ? doc.url : null,
  }
}

const storeDeps = (): { db: FirebaseFirestore.Firestore; serverTimestamp(): unknown } => ({
  db: admin.firestore(),
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
})

export const widgetReadLater = functions.region('asia-northeast1').https.onRequest(createWidgetReadLaterHandler({
  verifyIdToken: (token) => admin.auth().verifyIdToken(token, true),
  findArticle: findVisibleArticle,
  isAdded: (uid, topic, articleId) => isReadLaterAdded(storeDeps(), uid, topic, articleId),
  add: (uid, topic, article) => addReadLaterTask(storeDeps(), uid, topic, article),
}))
