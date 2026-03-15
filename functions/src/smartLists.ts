import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { buildScopedCollectionPath, type ScopedRequest } from './sharedTypes'

const db = admin.firestore()

interface TaskData {
  name: string
  listId: string
  completed: boolean
  parentId?: string | null
  dueDate?: admin.firestore.Timestamp | null
  priority: number
  tags: string[]
  visibleToMemberIds?: string[]
}

interface SmartListCounts {
  today: number
  tomorrow: number
  overdue: number
  thisWeek: number
  noDate: number
  lastUpdated: admin.firestore.Timestamp
}

export function buildSmartListCountsDocPath(userId: string, spaceId?: string): string {
  if (spaceId) {
    return `spaces/${spaceId}`
  }
  return `users/${userId}`
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

function getShiftedJstDate(date: Date): Date {
  return new Date(date.getTime() + JST_OFFSET_MS)
}

function getUtcBoundaryFromJstDateParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number
): Date {
  return new Date(Date.UTC(year, month, day, hour, minute, second, millisecond) - JST_OFFSET_MS)
}

export function getJstDayBoundaries(date: Date = new Date()): {
  todayStart: Date
  todayEnd: Date
  tomorrowStart: Date
  tomorrowEnd: Date
  weekEnd: Date
} {
  const shifted = getShiftedJstDate(date)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth()
  const day = shifted.getUTCDate()
  const dayOfWeek = shifted.getUTCDay()
  const daysUntilSunday = (7 - dayOfWeek) % 7

  return {
    todayStart: getUtcBoundaryFromJstDateParts(year, month, day, 0, 0, 0, 0),
    todayEnd: getUtcBoundaryFromJstDateParts(year, month, day, 23, 59, 59, 999),
    tomorrowStart: getUtcBoundaryFromJstDateParts(year, month, day + 1, 0, 0, 0, 0),
    tomorrowEnd: getUtcBoundaryFromJstDateParts(year, month, day + 1, 23, 59, 59, 999),
    weekEnd: getUtcBoundaryFromJstDateParts(year, month, day + daysUntilSunday, 23, 59, 59, 999),
  }
}

// タスクがどのスマートリストに属するか判定
export function categorizeTask(task: TaskData | null, now: Date): string[] {
  const categories: string[] = []

  if (!task || task.completed || task.parentId) return categories
  if (!task.dueDate) {
    categories.push('noDate')
    return categories
  }

  const dueDate = task.dueDate.toDate()
  const { todayStart, todayEnd, tomorrowStart, tomorrowEnd, weekEnd } = getJstDayBoundaries(now)

  if (dueDate < todayStart) {
    categories.push('overdue')
  } else if (dueDate >= todayStart && dueDate <= todayEnd) {
    categories.push('today')
    categories.push('thisWeek')
  } else if (dueDate >= tomorrowStart && dueDate <= tomorrowEnd) {
    categories.push('tomorrow')
    categories.push('thisWeek')
  } else if (dueDate <= weekEnd) {
    categories.push('thisWeek')
  }

  return categories
}

// ユーザーのスマートリストカウントを再計算
async function recalculateSmartListCounts(
  userId: string,
  spaceId?: string,
  options?: { filterByUserVisibility?: boolean }
): Promise<SmartListCounts> {
  const tasksRef = db.collection(spaceId ? `spaces/${spaceId}/tasks` : `users/${userId}/tasks`)
  const snapshot = await tasksRef.where('completed', '==', false).get()

  const now = new Date()
  const counts: SmartListCounts = {
    today: 0,
    tomorrow: 0,
    overdue: 0,
    thisWeek: 0,
    noDate: 0,
    lastUpdated: admin.firestore.Timestamp.now(),
  }

  snapshot.docs.forEach((doc) => {
    const task = doc.data() as TaskData
    if (spaceId && options?.filterByUserVisibility !== false && !taskMatchesScope(task, userId, { spaceId, useLegacyPath: false })) return
    if (task.parentId) return

    const categories = categorizeTask(task, now)
    categories.forEach((cat) => {
      if (cat in counts) {
        counts[cat as keyof Omit<SmartListCounts, 'lastUpdated'>]++
      }
    })
  })

  // ユーザードキュメントに保存
  await db.doc(buildSmartListCountsDocPath(userId, spaceId)).set({ smartListCounts: counts }, { merge: true })

  return counts
}

function buildIncrementUpdateData(delta: Record<string, number>): Record<string, admin.firestore.FieldValue | admin.firestore.Timestamp> {
  const updateData: Record<string, admin.firestore.FieldValue | admin.firestore.Timestamp> = {
    'smartListCounts.lastUpdated': admin.firestore.Timestamp.now(),
  }

  Object.entries(delta).forEach(([key, value]) => {
    if (value !== 0) {
      updateData[`smartListCounts.${key}`] = admin.firestore.FieldValue.increment(value)
    }
  })

  return updateData
}

function taskMatchesScope(task: TaskData, userId: string, scope?: ScopedRequest): boolean {
  if (scope?.spaceId && !scope.useLegacyPath) {
    return Array.isArray((task as TaskData & { visibleToMemberIds?: string[] }).visibleToMemberIds)
      ? ((task as TaskData & { visibleToMemberIds?: string[] }).visibleToMemberIds ?? []).includes(userId)
      : false
  }

  return true
}

// 差分更新: カテゴリの差分からインクリメント値を計算
function calculateDelta(
  beforeCategories: string[],
  afterCategories: string[]
): Record<string, number> {
  const delta: Record<string, number> = {
    today: 0,
    tomorrow: 0,
    overdue: 0,
    thisWeek: 0,
    noDate: 0,
  }

  // beforeにあってafterにない = -1
  beforeCategories.forEach((cat) => {
    if (!afterCategories.includes(cat) && cat in delta) {
      delta[cat]--
    }
  })

  // afterにあってbeforeにない = +1
  afterCategories.forEach((cat) => {
    if (!beforeCategories.includes(cat) && cat in delta) {
      delta[cat]++
    }
  })

  return delta
}

// タスク変更時にスマートリストカウントを差分更新（全タスク読み込みなし）
export const updateSmartListCounts = functions
  .region('asia-northeast1')
  .firestore.document('users/{userId}/tasks/{taskId}')
  .onWrite(async (change, context) => {
    const { userId } = context.params
    const before = change.before.exists ? (change.before.data() as TaskData) : null
    const after = change.after.exists ? (change.after.data() as TaskData) : null

    // サブタスクは無視
    if ((before && before.parentId) || (after && after.parentId)) return

    const now = new Date()
    const beforeCategories = categorizeTask(before, now)
    const afterCategories = categorizeTask(after, now)

    // カテゴリに変化がなければ何もしない
    const beforeSet = new Set(beforeCategories)
    const afterSet = new Set(afterCategories)
    const sameCategories =
      beforeSet.size === afterSet.size &&
      [...beforeSet].every((cat) => afterSet.has(cat))

    if (sameCategories) return

    // 差分を計算
    const delta = calculateDelta(beforeCategories, afterCategories)

    // 差分が全て0なら更新不要
    const hasChanges = Object.values(delta).some((v) => v !== 0)
    if (!hasChanges) return

    // FieldValue.incrementで差分更新（読み込みなし）
    const userRef = db.doc(`users/${userId}`)
    await userRef.update(buildIncrementUpdateData(delta))
  })

export const updateSpaceSmartListCounts = functions
  .region('asia-northeast1')
  .firestore.document('spaces/{spaceId}/tasks/{taskId}')
  .onWrite(async (change, context) => {
    const { spaceId } = context.params
    const before = change.before.exists ? (change.before.data() as TaskData) : null
    const after = change.after.exists ? (change.after.data() as TaskData) : null

    // 共有スペースのカウントはスペース全体の値として扱う。
    // メンバーごとの再計算をやめ、差分だけを反映して読み取りを抑える。
    const now = new Date()
    const beforeCategories = categorizeTask(before, now)
    const afterCategories = categorizeTask(after, now)

    const beforeSet = new Set(beforeCategories)
    const afterSet = new Set(afterCategories)
    const sameCategories =
      beforeSet.size === afterSet.size &&
      [...beforeSet].every((category) => afterSet.has(category))

    if (sameCategories) return

    const delta = calculateDelta(beforeCategories, afterCategories)
    const hasChanges = Object.values(delta).some((value) => value !== 0)
    if (!hasChanges) return

    await db.doc(buildSmartListCountsDocPath('', spaceId)).set(buildIncrementUpdateData(delta), { merge: true })
  })

// 毎日0時（JST）にスマートリストカウントを再計算（期限切れの更新用）
export const recalculateAllSmartLists = functions
  .region('asia-northeast1')
  .pubsub.schedule('0 0 * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async () => {
    const usersSnapshot = await db.collection('users').get()
    const userPromises = usersSnapshot.docs.map((doc) => recalculateSmartListCounts(doc.id))

    const spacesSnapshot = await db.collection('spaces').get()
    const spacePromises = spacesSnapshot.docs.map(async (spaceDoc) => {
      const counts = await recalculateSmartListCounts(spaceDoc.data().ownerUid ?? '', spaceDoc.id, {
        filterByUserVisibility: false,
      })
      await db.doc(buildSmartListCountsDocPath('', spaceDoc.id)).set({ smartListCounts: counts }, { merge: true })
    })

    await Promise.all([...userPromises, ...spacePromises])
    console.log(`Updated smart list counts for ${usersSnapshot.size} users and ${spacesSnapshot.size} spaces`)
  })

// スマートリストのタスクを取得（Callable Function）
export const getSmartListTasks = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const { smartListType, limitCount = 50, spaceId, useLegacyPath = false } = data as {
      smartListType: string
      limitCount?: number
      spaceId?: string
      useLegacyPath?: boolean
    }
    const userId = context.auth.uid

    if (!['today', 'tomorrow', 'overdue', 'thisWeek', 'noDate'].includes(smartListType)) {
      throw new functions.https.HttpsError('invalid-argument', '無効なスマートリストタイプです')
    }

    const tasksRef = db.collection(buildScopedCollectionPath(userId, 'tasks', { spaceId, useLegacyPath }))
    const snapshot = await tasksRef.where('completed', '==', false).get()

    const now = new Date()
    const tasks: Array<{
      id: string
      name: string
      listId: string
      priority: number
      dueDate: string | null
      tags: string[]
    }> = []

    snapshot.docs.forEach((doc) => {
      const task = doc.data() as TaskData
      if (task.parentId) return
      if (!taskMatchesScope(task, userId, { spaceId, useLegacyPath })) return

      const categories = categorizeTask(task, now)
      if (categories.includes(smartListType)) {
        tasks.push({
          id: doc.id,
          name: task.name,
          listId: task.listId,
          priority: task.priority,
          dueDate: task.dueDate ? task.dueDate.toDate().toISOString() : null,
          tags: task.tags || [],
        })
      }
    })

    // 優先度と期限でソート
    tasks.sort((a, b) => {
      // 優先度で比較
      if (a.priority !== b.priority) return a.priority - b.priority
      // 期限で比較
      if (a.dueDate && b.dueDate) return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
      if (a.dueDate) return -1
      if (b.dueDate) return 1
      return 0
    })

    return {
      tasks: tasks.slice(0, limitCount),
      totalCount: tasks.length,
    }
  })
