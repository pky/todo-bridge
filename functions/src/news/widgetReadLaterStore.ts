import { createHash, randomUUID } from 'crypto'
import type { WidgetTopic } from './widgetFeed'

/** 「あとで読む」に入れる記事。タイトルと概要と原文URLは、サーバーが記事のデータから決める。 */
export interface ReadLaterArticle {
  id: string
  title: string
  summary: string
  url: string | null
}

export interface ReadLaterStoreDeps {
  db: FirebaseFirestore.Firestore
  /** Firestore のサーバー時刻を表す値を返す。 */
  serverTimestamp(): unknown
}

const LIST_NAME = 'あとで読む'
const ALREADY_EXISTS = 6

async function resolveBasePath(db: FirebaseFirestore.Firestore, uid: string): Promise<string> {
  const memberships = await db.collection(`users/${uid}/memberships`).limit(1).get()
  return memberships.empty ? `users/${uid}` : `spaces/personal_${uid}`
}

function readLaterTaskId(topic: WidgetTopic, articleId: string): string {
  const digest = createHash('sha256').update(`${topic}:${articleId}`).digest('hex')
  return `readlater_${digest.slice(0, 32)}`
}

/**
 * Web の bookmarkArticle と同じタスクを、個人スペースの「あとで読む」リストに作り、記事をフィードから外す。
 * 保存先: users/{uid}/memberships が空なら users/{uid}、あれば spaces/personal_{uid}。
 * すでに同じ記事を入れていたら 'already'。
 */
export async function addReadLaterTask(
  deps: ReadLaterStoreDeps,
  uid: string,
  topic: WidgetTopic,
  article: ReadLaterArticle
): Promise<'created' | 'already'> {
  const { db, serverTimestamp } = deps
  const base = await resolveBasePath(db, uid)
  const spaceId = `personal_${uid}`
  const batch = db.batch()

  const found = await db.collection(`${base}/lists`).where('name', '==', LIST_NAME).limit(1).get()
  let listId: string
  if (!found.empty) {
    listId = found.docs[0].id
  } else {
    const latest = await db.collection(`${base}/lists`).orderBy('position', 'desc').limit(1).get()
    const lastPosition: unknown = latest.docs[0]?.data().position
    const position = typeof lastPosition === 'number' ? lastPosition + 1 : 1
    listId = randomUUID()
    batch.create(db.doc(`${base}/lists/${listId}`), {
      name: LIST_NAME,
      position,
      spaceId,
      visibleToMemberIds: [uid],
      editableByMemberIds: [uid],
      dateCreated: serverTimestamp(),
      dateModified: serverTimestamp(),
    })
  }

  batch.create(db.doc(`${base}/tasks/${readLaterTaskId(topic, article.id)}`), {
    name: article.title,
    listId,
    parentId: null,
    priority: 4,
    tags: ['ai-news'],
    dueDate: null,
    startDate: null,
    repeat: null,
    notes: [article.summary],
    url: article.url,
    completed: false,
    dateCompleted: null,
    deleted: false,
    spaceId,
    visibleToMemberIds: [uid],
    editableByMemberIds: [uid],
    allDay: false,
    addToCalendar: false,
    calendarEventId: null,
    dateCreated: serverTimestamp(),
    dateModified: serverTimestamp(),
  })

  batch.set(db.doc(`users/${uid}/newsInteractions/${topic}_${article.id}`), {
    topic,
    articleId: article.id,
    dismissed: true,
    dismissedAt: serverTimestamp(),
    ...(article.url ? { url: article.url } : {}),
  }, { merge: true })

  try {
    await batch.commit()
    return 'created'
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === ALREADY_EXISTS) return 'already'
    throw error
  }
}

/** 同じ topic と記事IDで、すでに「あとで読む」に入れているか。 */
export async function isReadLaterAdded(
  deps: ReadLaterStoreDeps,
  uid: string,
  topic: WidgetTopic,
  articleId: string
): Promise<boolean> {
  const base = await resolveBasePath(deps.db, uid)
  const snapshot = await deps.db.doc(`${base}/tasks/${readLaterTaskId(topic, articleId)}`).get()
  return snapshot.exists
}
