import { createHash } from 'crypto'
import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { validateAiFeedV2, computeFeedRevision } from './feedContract'
import { aiFeedDailyPath, type AiFeedDaily, type FeedBucket } from './publishAiFeed'
import { createStorageFeedBucket } from './storageFeedBucket'
import { createNewsActionStore, NewsActionConflictError, type NewsActionRequest, type NewsActionInput, type NewsActionResult, type StoredReceipt } from './newsActionStore'

interface NewsActionBody {
  schemaVersion: 2
  topic: 'ai'
  feedDate: string
  revision: string
  articleId: string
  action: NewsActionRequest
  operationId: string
}
interface NewsActionDeps {
  verifyIdToken(token: string): Promise<{ uid: string; newsRole?: unknown }>
  curatorUid: string | undefined
  allowedOrigins: string[]
  now(): Date
  loadDaily(feedDate: string): Promise<AiFeedDaily | null>
  store: {
    findReceipt(uid: string, operationId: string): Promise<StoredReceipt | null>
    apply(input: NewsActionInput): Promise<NewsActionResult>
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isFeedDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
function isBody(value: unknown): value is NewsActionBody {
  if (!isRecord(value)) return false
  const keys = ['schemaVersion', 'topic', 'feedDate', 'revision', 'articleId', 'action', 'operationId']
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
    && value.schemaVersion === 2 && value.topic === 'ai' && isFeedDate(value.feedDate)
    && typeof value.revision === 'string' && /^[0-9a-f]{64}$/.test(value.revision)
    && typeof value.articleId === 'string' && value.articleId.length > 0 && value.articleId.length <= 200 && !value.articleId.includes('/')
    && (value.action === 'dismiss' || value.action === 'readLater' || value.action === 'open' || value.action === 'undismiss')
    && typeof value.operationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.operationId)
}
export function newsActionFingerprint(body: Omit<NewsActionBody, 'operationId'>): string {
  const { schemaVersion, topic, feedDate, revision, articleId, action } = body
  return createHash('sha256').update(JSON.stringify({ schemaVersion, topic, feedDate, revision, articleId, action })).digest('hex')
}

export function createNewsActionHandler(deps: NewsActionDeps): (
  req: functions.https.Request, res: functions.Response
) => Promise<void> {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const origin = req.headers.origin
    const allowed = typeof origin === 'string' && deps.allowedOrigins.includes(origin)
    if (allowed) {
      res.set('Access-Control-Allow-Origin', origin)
      res.set('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      if (!allowed) { res.status(403).json({ error: 'permission-denied' }); return }
      res.set('Access-Control-Allow-Methods', 'POST')
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      res.status(204).end()
      return
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return }
    const authorization = req.headers.authorization
    const match = typeof authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(authorization) : null
    if (!match) { res.status(401).json({ error: 'unauthenticated' }); return }
    let identity: { uid: string; newsRole?: unknown }
    try { identity = await deps.verifyIdToken(match[1]) } catch {
      res.status(401).json({ error: 'unauthenticated' }); return
    }
    if (!deps.curatorUid?.trim() || identity.newsRole !== 'curator' || identity.uid !== deps.curatorUid) {
      res.status(403).json({ error: 'permission-denied' }); return
    }
    const body: unknown = req.body
    if (!isBody(body)) { res.status(400).json({ error: 'invalid-argument' }); return }
    try {
      const fingerprint = newsActionFingerprint(body)
      const receipt = await deps.store.findReceipt(identity.uid, body.operationId)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) { res.status(409).json({ error: 'conflict' }); return }
        res.status(200).json(receipt.result); return
      }
      const todayJst = new Date(deps.now().getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
      if (Date.parse(`${body.feedDate}T00:00:00Z`) < Date.parse(`${todayJst}T00:00:00Z`) - 30 * 86400000) {
        res.status(410).json({ error: 'gone' }); return
      }
      const daily = await deps.loadDaily(body.feedDate)
      if (!daily || daily.feed.revision !== body.revision) { res.status(404).json({ error: 'not-found' }); return }
      const article = daily.actionArticles.find(value => value.id === body.articleId)
      if (!article) { res.status(404).json({ error: 'not-found' }); return }
      const result = await deps.store.apply({
        uid: identity.uid, operationId: body.operationId, fingerprint,
        action: body.action, topic: 'ai', feedDate: body.feedDate, revision: body.revision, article,
      })
      res.status(200).json(result)
    } catch (error) {
      if (error instanceof NewsActionConflictError) { res.status(409).json({ error: 'conflict' }); return }
      console.error('ニュース管理操作に失敗しました')
      res.status(500).json({ error: 'internal' })
    }
  }
}

function isActionArticle(value: unknown): value is AiFeedDaily['actionArticles'][number] {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || !value.id.length || value.id.length > 200 || value.id.includes('/')) return false
  if (typeof value.title !== 'string' || !value.title.trim() || typeof value.summary !== 'string' || !value.summary.trim()) return false
  if ('titleEn' in value && typeof value.titleEn !== 'string') return false
  if ('tags' in value && (!Array.isArray(value.tags) || !value.tags.every(tag => typeof tag === 'string' && tag.trim()))) return false
  if ('url' in value) {
    if (typeof value.url !== 'string' || /[\s\p{White_Space}\p{Cc}]/u.test(value.url)) return false
    try { if (new URL(value.url).protocol !== 'https:') return false } catch { return false }
  }
  return true
}

/** 不在と破損を区別し、破損した原本を404として扱わない。 */
export async function loadNewsActionDaily(bucket: FeedBucket, feedDate: string): Promise<AiFeedDaily | null> {
  const object = await bucket.read(aiFeedDailyPath(feedDate))
  if (!object) return null
  const value: unknown = JSON.parse(object.data.toString('utf8'))
  const invalid = () => new Error('ニュース操作用の日次原本が不正です')
  if (!isRecord(value) || value.schemaVersion !== 2 || value.topic !== 'ai' || value.feedDate !== feedDate
    || typeof value.learningCutoffAt !== 'string' || !Number.isFinite(Date.parse(value.learningCutoffAt))) throw invalid()
  const validated = validateAiFeedV2(value.feed)
  if (!validated.ok || validated.feed.feedDate !== feedDate || computeFeedRevision(validated.feed) !== validated.feed.revision
    || !Array.isArray(value.actionArticles) || !value.actionArticles.every(isActionArticle)) throw invalid()
  const actionArticles = value.actionArticles
  if (actionArticles.length !== validated.feed.articles.length
    || new Set(actionArticles.map(article => article.id)).size !== actionArticles.length
    || validated.feed.articles.some((article, index) => {
      const action = actionArticles[index]
      return action.id !== article.id || action.title !== article.title || action.summary !== article.summary
        || action.url !== article.url || JSON.stringify(action.tags) !== JSON.stringify(article.tags)
    })) throw invalid()
  return {
    schemaVersion: 2, topic: 'ai', feedDate, learningCutoffAt: value.learningCutoffAt,
    feed: validated.feed, actionArticles,
  }
}

const store = () => createNewsActionStore({
  db: admin.firestore(), serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
})
export const newsAction = functions.region('asia-northeast1').https.onRequest(createNewsActionHandler({
  verifyIdToken: token => admin.auth().verifyIdToken(token, true),
  curatorUid: process.env.NEWS_CURATOR_UID,
  allowedOrigins: (process.env.NEWS_ACTION_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean),
  now: () => new Date(),
  loadDaily: feedDate => loadNewsActionDaily(createStorageFeedBucket(), feedDate),
  store: {
    findReceipt: (uid, operationId) => store().findReceipt(uid, operationId),
    apply: input => store().apply(input),
  },
}))
