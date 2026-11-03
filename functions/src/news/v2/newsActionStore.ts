import { createHash } from 'crypto'
import { readLaterTaskId, type ReadLaterStoreDeps } from '../widgetReadLaterStore'
import type { AiFeedDaily } from './publishAiFeed'

export type NewsAction = 'dismiss' | 'readLater'
export interface NewsActionResult {
  operationId: string
  articleId: string
  action: NewsAction
  status: 'applied' | 'created' | 'already'
  taskId?: string
}
export interface StoredReceipt { fingerprint: string; result: NewsActionResult; createdAt?: unknown }
export interface NewsActionInput {
  uid: string
  operationId: string
  fingerprint: string
  action: NewsAction
  topic: 'ai'
  feedDate: string
  revision: string
  article: AiFeedDaily['actionArticles'][number]
}
export class NewsActionConflictError extends Error {}
export function newsActionEventId(uid: string, topic: string, articleId: string, action: NewsAction): string {
  return createHash('sha256').update(`${uid}:${topic}:${articleId}:${action}`).digest('hex').slice(0, 32)
}

export function createNewsActionStore({ db, serverTimestamp }: ReadLaterStoreDeps): {
  findReceipt(uid: string, operationId: string): Promise<StoredReceipt | null>
  apply(input: NewsActionInput): Promise<NewsActionResult>
} {
  const receiptRef = (uid: string, operationId: string) => db.doc(`users/${uid}/newsActionReceipts/${operationId}`)
  return {
    async findReceipt(uid, operationId) {
      const snapshot = await receiptRef(uid, operationId).get()
      return snapshot.exists ? snapshot.data() as StoredReceipt : null
    },
    async apply(input) {
      return db.runTransaction(async tx => {
        const { uid, operationId, fingerprint, action, topic, feedDate, revision, article } = input
        const receipt = receiptRef(uid, operationId)
        const saved = await tx.get(receipt)
        if (saved.exists) {
          const data = saved.data() as StoredReceipt
          if (data.fingerprint !== fingerprint) throw new NewsActionConflictError('操作の内容が一致しません')
          return data.result
        }
        const event = db.doc(`users/${uid}/newsActionEvents/${newsActionEventId(uid, topic, article.id, action)}`)
        const existingEvent = await tx.get(event)
        const result: NewsActionResult = { operationId, articleId: article.id, action, status: 'applied' }
        let task: FirebaseFirestore.DocumentReference | undefined
        let taskData: FirebaseFirestore.DocumentData | undefined
        let list: FirebaseFirestore.DocumentReference | undefined
        let listData: FirebaseFirestore.DocumentData | undefined
        if (action === 'readLater') {
          const memberships = await tx.get(db.collection(`users/${uid}/memberships`).limit(1))
          const base = memberships.empty ? `users/${uid}` : `spaces/personal_${uid}`
          const spaceId = `personal_${uid}`
          result.taskId = readLaterTaskId(topic, article.id)
          task = db.doc(`${base}/tasks/${result.taskId}`)
          const existingTask = await tx.get(task)
          result.status = existingTask.exists ? 'already' : 'created'
          if (!existingTask.exists) {
            const found = await tx.get(db.collection(`${base}/lists`).where('name', '==', 'あとで読む').limit(1))
            let listId = found.docs[0]?.id
            if (!listId) {
              listId = 'readlater_list'
              list = db.doc(`${base}/lists/${listId}`)
              // v1との同時作成も検出し、Firestoreのtransaction再試行に任せる。
              const fixedList = await tx.get(list)
              if (fixedList.exists) throw new Error('あとで読むリストの名前が一致しません')
              const latest = await tx.get(db.collection(`${base}/lists`).orderBy('position', 'desc').limit(1))
              const lastPosition: unknown = latest.docs[0]?.data().position
              listData = {
                name: 'あとで読む', position: typeof lastPosition === 'number' ? lastPosition + 1 : 1,
                spaceId, visibleToMemberIds: [uid], editableByMemberIds: [uid],
                dateCreated: serverTimestamp(), dateModified: serverTimestamp(),
              }
            }
            taskData = {
              name: article.title, listId, parentId: null, priority: 4, tags: ['ai-news'],
              dueDate: null, startDate: null, repeat: null, notes: [article.summary], url: article.url ?? null,
              completed: false, dateCompleted: null, deleted: false, spaceId,
              visibleToMemberIds: [uid], editableByMemberIds: [uid], allDay: false,
              addToCalendar: false, calendarEventId: null,
              dateCreated: serverTimestamp(), dateModified: serverTimestamp(),
            }
          }
        }
        // すべての読み取りを終えてから、イベント・タスク・確定結果を原子的に保存する。
        if (!existingEvent.exists) tx.create(event, {
          topic, articleId: article.id, action, receivedAt: serverTimestamp(), feedDate, revision,
          title: article.title, summary: article.summary,
          ...(article.url !== undefined ? { url: article.url } : {}),
          ...(article.titleEn !== undefined ? { titleEn: article.titleEn } : {}),
          ...(article.tags !== undefined ? { tags: article.tags } : {}),
        })
        if (list && listData) tx.create(list, listData)
        if (task && taskData) tx.create(task, taskData)
        tx.create(receipt, { fingerprint, result, createdAt: serverTimestamp() })
        return result
      })
    },
  }
}
