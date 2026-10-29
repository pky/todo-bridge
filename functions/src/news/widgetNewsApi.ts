import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { selectWidgetFeed } from './widgetFeed'
import type { WidgetFeedInput, WidgetTopic } from './widgetFeed'
import { buildWidgetNewsResponse } from './widgetDto'
import { loadWidgetFeedInputs } from './widgetNewsLoader'

export interface WidgetNewsDeps {
  verifyIdToken(token: string): Promise<{ uid: string }>
  loadInputs(uid: string, topic: WidgetTopic): Promise<WidgetFeedInput>
  now(): Date
}

export function createWidgetNewsHandler(deps: WidgetNewsDeps): (
  req: functions.https.Request, res: functions.Response
) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
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

    const topic = req.query.topic
    if (topic !== 'ai' && topic !== 'mobile') {
      res.status(400).json({ error: 'invalid-argument' })
      return
    }

    try {
      const input = await deps.loadInputs(uid, topic)
      const result = selectWidgetFeed(input)
      const response = buildWidgetNewsResponse(topic, result, deps.now())
      res.status(200).set('Cache-Control', 'private, no-store').json(response)
    } catch {
      console.error('ニュースウィジェットの応答生成に失敗しました')
      res.status(500).json({ error: 'internal' })
    }
  }
}

export const widgetNews = functions.region('asia-northeast1').https.onRequest(createWidgetNewsHandler({
  verifyIdToken: (token) => admin.auth().verifyIdToken(token, true),
  loadInputs: (uid, topic) => loadWidgetFeedInputs(admin.firestore(), uid, topic),
  now: () => new Date(),
}))
