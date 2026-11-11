import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { addReadLaterUrlTask } from './widgetReadLaterStore'
import type { ReadLaterUrlEntry } from './widgetReadLaterStore'

export interface WidgetReadLaterUrlDeps {
  verifyIdToken(token: string): Promise<{ uid: string }>
  add(uid: string, entry: ReadLaterUrlEntry): Promise<'created' | 'already'>
}

/** UTF-16 単位で上限を守り、サロゲートペアの途中で切らない。 */
function truncateUtf16(value: string, limit: number): string {
  if (value.length <= limit) return value
  const lastCodeUnit = value.charCodeAt(limit - 1)
  return value.slice(0, lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF ? limit - 1 : limit)
}

/** URL の表記を保ったまま検証し、端末から届いたプレビュー情報を整形する。 */
function parseEntry(body: unknown): ReadLaterUrlEntry | null {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('url' in body)) return null
  if (typeof body.url !== 'string') return null
  const url = body.url.trim()
  if (url.length === 0 || url.length > 2048) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null
  } catch {
    return null
  }

  if ('title' in body && typeof body.title !== 'string') return null
  if ('description' in body && typeof body.description !== 'string') return null
  const title = 'title' in body && typeof body.title === 'string' ? body.title.trim() : ''
  const description = 'description' in body && typeof body.description === 'string' ? body.description.trim() : ''
  return {
    url,
    ...(title ? { title: truncateUtf16(title, 300) } : {}),
    ...(description ? { description: truncateUtf16(description, 1000) } : {}),
  }
}

/** 認証済みの共有 URL を受け取り、全応答のキャッシュを禁止する。 */
export function createWidgetReadLaterUrlHandler(deps: WidgetReadLaterUrlDeps): (
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

    const entry = parseEntry(req.body)
    if (!entry) {
      res.status(400).json({ error: 'invalid-argument' })
      return
    }

    try {
      const status = await deps.add(uid, entry)
      res.status(200).json({ status })
    } catch {
      console.error('あとで読むの追加に失敗しました')
      res.status(500).json({ error: 'internal' })
    }
  }
}

export const widgetReadLaterUrl = functions.region('asia-northeast1').https.onRequest(createWidgetReadLaterUrlHandler({
  verifyIdToken: (token) => admin.auth().verifyIdToken(token, true),
  add: (uid, entry) => addReadLaterUrlTask({
    db: admin.firestore(),
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  }, uid, entry),
}))
