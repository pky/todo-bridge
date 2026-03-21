import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'

admin.initializeApp()

// マイグレーション関数をエクスポート
export {
  migrateTaskCounts,
  migrateUserToPersonalSpace,
  migrateCurrentUserToPersonalSpace,
  checkPersonalSpaceMigration,
} from './migrate'

// AIニュース収集・パーソナライズ関数をエクスポート
export {
  saveMobileNotificationPreferences,
  collectArticles,
  collectMobileArticles,
  generatePersonalizedFeed,
  generateMobilePersonalizedFeed,
  sendMobileDiscordUrgentNotifications,
  sendMobileDiscordDailyDigest,
} from './news'

// 自動バックアップ関数をエクスポート
export { dailyBackup, manualBackup, listBackups, restoreFromBackup } from './scheduledBackup'

// スマートリスト集計関数をエクスポート
export {
  updateSmartListCounts,
  updateSpaceSmartListCounts,
  recalculateAllSmartLists,
  getSmartListTasks,
  refreshSmartListCounts,
} from './smartLists'

// 検索API関数をエクスポート
export { searchTasks, getTasksByFilter } from './searchApi'

// 共有スペース管理関数をエクスポート
export {
  createFamilySpace,
  ensureCurrentUserSpaceAccess,
  updateFamilySpaceName,
  validateCurrentUserAccess,
} from './spaces'

// TODO: カレンダー自動登録機能を一時無効化
// export { connectGoogleCalendar, disconnectGoogleCalendar } from './calendar'

// 孤立したサブタスクを復旧（親タスクを再作成）
export const recoverOrphanedSubtasks = functions
  .region('asia-northeast1')
  .https.onCall(async (data) => {
    const { userId, oldParentId, newTaskName, listId } = data
    if (!userId || !oldParentId || !newTaskName || !listId) {
      throw new functions.https.HttpsError('invalid-argument', 'userId, oldParentId, newTaskName, listId are required')
    }

    const tasksRef = db.collection(`users/${userId}/tasks`)

    // 1. 新しい親タスクを作成
    const now = admin.firestore.Timestamp.now()
    const newTaskRef = await tasksRef.add({
      name: newTaskName,
      listId: listId,
      parentId: null,
      priority: 4,
      tags: [],
      dueDate: null,
      startDate: null,
      repeat: null,
      notes: [],
      url: null,
      completed: false,
      dateCompleted: null,
      dateCreated: now,
      dateModified: now,
    })

    // 2. 孤立したサブタスクのparentIdを更新
    const orphanedSnapshot = await tasksRef.where('parentId', '==', oldParentId).get()
    const batch = db.batch()
    let count = 0

    orphanedSnapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { parentId: newTaskRef.id })
      count++
    })

    await batch.commit()

    return {
      success: true,
      newTaskId: newTaskRef.id,
      subtasksUpdated: count,
    }
  })

// タスクにメモを追加（名前で検索）
export const addNotesToTaskByName = functions
  .region('asia-northeast1')
  .https.onCall(async (data) => {
    const { userId, listId, taskName, notes } = data
    if (!userId || !listId || !taskName || !notes) {
      throw new functions.https.HttpsError('invalid-argument', 'userId, listId, taskName, notes are required')
    }

    const tasksRef = db.collection(`users/${userId}/tasks`)
    const snapshot = await tasksRef
      .where('listId', '==', listId)
      .where('name', '==', taskName)
      .where('parentId', '==', null)
      .limit(1)
      .get()

    if (snapshot.empty) {
      throw new functions.https.HttpsError('not-found', 'タスクが見つかりません')
    }

    const taskDoc = snapshot.docs[0]
    await taskDoc.ref.update({ notes })

    return { success: true, taskId: taskDoc.id }
  })

// デバッグ用: タスク検索関数
export const searchTask = functions
  .region('asia-northeast1')
  .https.onCall(async (data) => {
    const { userId, listId, taskName } = data
    if (!userId) {
      throw new functions.https.HttpsError('invalid-argument', 'userId is required')
    }

    const tasksRef = db.collection(`users/${userId}/tasks`)
    let q: FirebaseFirestore.Query = tasksRef

    if (listId) {
      q = q.where('listId', '==', listId)
    }

    const snapshot = await q.get()
    const results: { id: string; name: string; listId: string; completed: boolean; parentId: string | null }[] = []

    snapshot.docs.forEach((doc) => {
      const data = doc.data()
      if (!taskName || data.name.toLowerCase().includes(taskName.toLowerCase())) {
        results.push({
          id: doc.id,
          name: data.name,
          listId: data.listId,
          completed: data.completed,
          parentId: data.parentId || null,
        })
      }
    })

    return { count: results.length, tasks: results.slice(0, 50) }
  })
// TODO: カレンダー自動登録機能を一時無効化
// import {
//   createCalendarEvent,
//   updateCalendarEvent,
//   deleteCalendarEvent,
// } from './calendar'

const db = admin.firestore()

interface Task {
  spaceId?: string
  visibleToMemberIds?: string[]
  editableByMemberIds?: string[]
  listId: string
  completed: boolean
  deleted?: boolean
  parentId?: string | null
  lastModifiedBy?: string  // 変更元デバイスID
  name?: string
  priority?: number
  tags?: string[]
  dueDate?: admin.firestore.Timestamp | null
  startDate?: admin.firestore.Timestamp | null
  repeat?: object | null
  notes?: string[]
  url?: string | null
  dateCompleted?: admin.firestore.Timestamp | null
  dateCreated?: admin.firestore.Timestamp
  dateModified?: admin.firestore.Timestamp
  // Google Calendar連携
  allDay?: boolean
  addToCalendar?: boolean
  calendarEventId?: string | null
}

interface TaskChange {
  id: string
  action: 'create' | 'update' | 'delete'
  listId: string
  previousListId?: string
  deviceId: string
  timestamp: admin.firestore.Timestamp
  data?: Task
}

// 変更キューの最大件数（削除が同期されない問題を防ぐため大きめに設定）
const MAX_RECENT_CHANGES = 50

function getListDocPath(userId: string, listId: string, spaceId?: string, useLegacyPath: boolean = false): string {
  if (spaceId && !useLegacyPath) {
    return `spaces/${spaceId}/lists/${listId}`
  }
  return `users/${userId}/lists/${listId}`
}

async function updateIncompleteTaskCount(
  userId: string,
  listId: string,
  delta: number,
  spaceId?: string,
  useLegacyPath: boolean = false
): Promise<void> {
  const listRef = db.doc(getListDocPath(userId, listId, spaceId, useLegacyPath))
  await listRef.update({
    incompleteTaskCount: admin.firestore.FieldValue.increment(delta),
  })
}

function isCountedIncompleteTask(task: Task): boolean {
  return !!task.listId
    && !task.parentId
    && task.completed !== true
    && task.deleted !== true
}

// 変更をキューに追加する共通関数
async function addTaskChange(
  userId: string,
  taskId: string,
  change: {
    action: 'create' | 'update' | 'delete'
    listId: string
    previousListId?: string
    deviceId: string
    data?: Task
  }
) {
  const userRef = db.doc(`users/${userId}`)
  const userDoc = await userRef.get()
  const userData = userDoc.data() || {}

  // 既存のキューを取得（なければ空配列）
  let recentChanges: TaskChange[] = userData.recentTaskChanges || []

  // 新しい変更を追加（undefinedはFirestoreに保存できないため除外）
  const newChange: TaskChange = {
    id: taskId,
    action: change.action,
    listId: change.listId,
    deviceId: change.deviceId,
    timestamp: admin.firestore.Timestamp.now(),
  }
  // previousListIdがある場合のみ追加
  if (change.previousListId) {
    newChange.previousListId = change.previousListId
  }
  // dataがある場合のみ追加
  if (change.data) {
    newChange.data = change.data
  }
  recentChanges.push(newChange)

  // 最大件数を超えたら古いものを削除
  if (recentChanges.length > MAX_RECENT_CHANGES) {
    recentChanges = recentChanges.slice(-MAX_RECENT_CHANGES)
  }

  await userRef.set({
    lastTaskModified: admin.firestore.FieldValue.serverTimestamp(),
    lastModifiedBy: change.deviceId,
    recentTaskChanges: recentChanges,
  }, { merge: true })
}

async function handleTaskCreated(
  task: Task,
  params: { userId: string; taskId: string; spaceId?: string; useLegacyPath?: boolean }
): Promise<void> {
  const { userId, taskId, spaceId, useLegacyPath = false } = params
  const { listId, completed, parentId, lastModifiedBy } = task

  await addTaskChange(userId, taskId, {
    action: 'create',
    listId,
    deviceId: lastModifiedBy || 'unknown',
    data: task,
  })

  if (parentId || !listId || completed) return
  await updateIncompleteTaskCount(userId, listId, 1, spaceId, useLegacyPath)
}

async function handleTaskDeleted(
  task: Task,
  params: { userId: string; taskId: string; spaceId?: string; useLegacyPath?: boolean }
): Promise<void> {
  const { userId, taskId, spaceId, useLegacyPath = false } = params
  const { listId, completed, parentId, lastModifiedBy } = task

  await addTaskChange(userId, taskId, {
    action: 'delete',
    listId,
    deviceId: lastModifiedBy || 'unknown',
  })

  if (parentId || !listId || completed) return
  await updateIncompleteTaskCount(userId, listId, -1, spaceId, useLegacyPath)
}

async function handleTaskUpdated(
  before: Task,
  after: Task,
  params: { userId: string; taskId: string; spaceId?: string; useLegacyPath?: boolean }
): Promise<void> {
  const { userId, taskId, spaceId, useLegacyPath = false } = params

  await addTaskChange(userId, taskId, {
    action: 'update',
    listId: after.listId,
    previousListId: before.listId !== after.listId ? before.listId : undefined,
    deviceId: after.lastModifiedBy || 'unknown',
    data: after,
  })

  const countedBefore = isCountedIncompleteTask(before)
  const countedAfter = isCountedIncompleteTask(after)

  if (before.listId !== after.listId) {
    const updates: Promise<void>[] = []
    if (countedBefore) {
      updates.push(updateIncompleteTaskCount(userId, before.listId, -1, spaceId, useLegacyPath))
    }
    if (countedAfter) {
      updates.push(updateIncompleteTaskCount(userId, after.listId, 1, spaceId, useLegacyPath))
    }
    if (updates.length > 0) {
      await Promise.all(updates)
    }
    return
  }

  if (countedBefore === countedAfter) return

  await updateIncompleteTaskCount(userId, after.listId, countedAfter ? 1 : -1, spaceId, useLegacyPath)
}

// タスク作成時: 未完了カウントを+1 + 変更キューに追加 + カレンダー登録
export const onTaskCreated = functions
  .region('asia-northeast1')
  .firestore.document('users/{userId}/tasks/{taskId}')
  .onCreate(async (snapshot, context) => {
    const task = snapshot.data() as Task
    const { userId, taskId } = context.params
    await handleTaskCreated(task, { userId, taskId, useLegacyPath: true })
  })

export const onSpaceTaskCreated = functions
  .region('asia-northeast1')
  .firestore.document('spaces/{spaceId}/tasks/{taskId}')
  .onCreate(async (snapshot, context) => {
    const task = snapshot.data() as Task
    const { spaceId, taskId } = context.params
    const userId = Array.isArray(task.editableByMemberIds) && task.editableByMemberIds[0]
      ? task.editableByMemberIds[0]
      : Array.isArray(task.visibleToMemberIds) && task.visibleToMemberIds[0]
        ? task.visibleToMemberIds[0]
        : null
    if (!userId) return
    await handleTaskCreated(task, { userId, taskId, spaceId })
  })

// タスク削除時: 適切なカウントを-1 + 変更キューに追加 + カレンダー削除
export const onTaskDeleted = functions
  .region('asia-northeast1')
  .firestore.document('users/{userId}/tasks/{taskId}')
  .onDelete(async (snapshot, context) => {
    const task = snapshot.data() as Task
    const { userId, taskId } = context.params
    await handleTaskDeleted(task, { userId, taskId, useLegacyPath: true })
  })

export const onSpaceTaskDeleted = functions
  .region('asia-northeast1')
  .firestore.document('spaces/{spaceId}/tasks/{taskId}')
  .onDelete(async (snapshot, context) => {
    const task = snapshot.data() as Task
    const { spaceId, taskId } = context.params
    const userId = Array.isArray(task.editableByMemberIds) && task.editableByMemberIds[0]
      ? task.editableByMemberIds[0]
      : Array.isArray(task.visibleToMemberIds) && task.visibleToMemberIds[0]
        ? task.visibleToMemberIds[0]
        : null
    if (!userId) return
    await handleTaskDeleted(task, { userId, taskId, spaceId })
  })

// タスク更新時: completed状態の変更を検知 + 変更キューに追加 + カレンダー更新
export const onTaskUpdated = functions
  .region('asia-northeast1')
  .firestore.document('users/{userId}/tasks/{taskId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data() as Task
    const after = change.after.data() as Task
    const { userId, taskId } = context.params
    await handleTaskUpdated(before, after, { userId, taskId, useLegacyPath: true })
  })

export const onSpaceTaskUpdated = functions
  .region('asia-northeast1')
  .firestore.document('spaces/{spaceId}/tasks/{taskId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data() as Task
    const after = change.after.data() as Task
    const { spaceId, taskId } = context.params
    const userId = Array.isArray(after.editableByMemberIds) && after.editableByMemberIds[0]
      ? after.editableByMemberIds[0]
      : Array.isArray(after.visibleToMemberIds) && after.visibleToMemberIds[0]
        ? after.visibleToMemberIds[0]
        : null
    if (!userId) return
    await handleTaskUpdated(before, after, { userId, taskId, spaceId })
  })
