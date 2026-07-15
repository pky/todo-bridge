import { createHash } from 'node:crypto'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import * as functions from 'firebase-functions/v1'
import type { FamilyDocument } from './types'

const db = admin.firestore()
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

interface TaskLinkInput {
  spaceId: string
  taskId: string
  documentId: string
}

interface LinkableTask {
  editableByMemberIds?: string[]
  deleted?: boolean
}

function parseInput(data: unknown): TaskLinkInput {
  if (typeof data !== 'object' || data === null) {
    throw new functions.https.HttpsError('invalid-argument', 'タスクと書類の指定が不正です')
  }
  const input = data as Record<string, unknown>
  const values = [input.spaceId, input.taskId, input.documentId]
  if (!values.every((value) => typeof value === 'string' && IDENTIFIER_PATTERN.test(value))) {
    throw new functions.https.HttpsError('invalid-argument', 'タスクと書類の指定が不正です')
  }
  return {
    spaceId: input.spaceId as string,
    taskId: input.taskId as string,
    documentId: input.documentId as string,
  }
}

export function buildDocumentTaskLinkId(taskId: string, documentId: string): string {
  return createHash('sha256').update(`${taskId}/${documentId}`).digest('hex')
}

async function requireWritableResources(
  input: TaskLinkInput,
  userId: string,
  allowTrashedDocument: boolean = false
): Promise<{ task: LinkableTask; document: FamilyDocument }> {
  const [memberSnapshot, spaceSnapshot, taskSnapshot, documentSnapshot] = await Promise.all([
    db.doc(`spaces/${input.spaceId}/members/${userId}`).get(),
    db.doc(`spaces/${input.spaceId}`).get(),
    db.doc(`spaces/${input.spaceId}/tasks/${input.taskId}`).get(),
    db.doc(`spaces/${input.spaceId}/documents/${input.documentId}`).get(),
  ])
  if (!memberSnapshot.exists || memberSnapshot.data()?.status !== 'active') {
    throw new functions.https.HttpsError('permission-denied', '家族スペースへのアクセス権がありません')
  }
  if (!taskSnapshot.exists || !documentSnapshot.exists) {
    throw new functions.https.HttpsError('not-found', 'タスクまたは書類が見つかりません')
  }
  const task = taskSnapshot.data() as LinkableTask
  const document = documentSnapshot.data() as FamilyDocument
  const isPersonalSpace = spaceSnapshot.data()?.type === 'personal'
  if ((!isPersonalSpace && !task.editableByMemberIds?.includes(userId)) || task.deleted) {
    throw new functions.https.HttpsError('permission-denied', 'タスクを変更する権限がありません')
  }
  if (!allowTrashedDocument && document.status === 'trashed') {
    throw new functions.https.HttpsError('failed-precondition', 'ごみ箱の書類は紐づけられません')
  }
  return { task, document }
}

export const linkDocumentToTask = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }
    const input = parseInput(data)
    await requireWritableResources(input, context.auth.uid)
    const linkId = buildDocumentTaskLinkId(input.taskId, input.documentId)
    const linkRef = db.doc(`spaces/${input.spaceId}/documentTaskLinks/${linkId}`)
    const created = await db.runTransaction(async (transaction) => {
      if ((await transaction.get(linkRef)).exists) return false
      transaction.create(linkRef, {
        id: linkId,
        spaceId: input.spaceId,
        documentId: input.documentId,
        taskId: input.taskId,
        relation: 'attachment',
        pageNumber: null,
        suggestionId: null,
        sourceExcerpt: null,
        createdBy: context.auth!.uid,
        createdAt: Timestamp.now(),
      })
      return true
    })
    return { success: true, linkId, created }
  })

export const unlinkDocumentFromTask = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }
    const input = parseInput(data)
    await requireWritableResources(input, context.auth.uid, true)
    const linkId = buildDocumentTaskLinkId(input.taskId, input.documentId)
    await db.doc(`spaces/${input.spaceId}/documentTaskLinks/${linkId}`).delete()
    return { success: true }
  })

export async function removeDocumentTaskLinksForTask(
  spaceId: string,
  taskId: string
): Promise<void> {
  const snapshot = await db.collection(`spaces/${spaceId}/documentTaskLinks`)
    .where('taskId', '==', taskId)
    .get()
  if (snapshot.empty) return
  const batch = db.batch()
  snapshot.docs.forEach((link) => batch.delete(link.ref))
  await batch.commit()
}
