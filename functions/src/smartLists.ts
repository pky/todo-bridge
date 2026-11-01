import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { buildScopedCollectionPath, type ScopedRequest } from './sharedTypes'

const db = admin.firestore()

interface TaskData {
  name: string
  listId: string
  completed: boolean
  deleted?: boolean
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

type SmartListCountResponse = Omit<SmartListCounts, 'lastUpdated'>

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

  if (!task || task.completed || task.deleted || task.parentId) return categories
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

// 差分更新時刻とは分け、全再集計の完了時刻で日付境界を判定する。
export function canReuseSmartListCounts(data: admin.firestore.DocumentData | undefined, now: Date): boolean {
  const counts = data?.smartListCounts
  const calculatedAt = data?.smartListCountsRecalculatedAt
  if (!counts || !(calculatedAt instanceof Timestamp)) return false
  if (!['today', 'tomorrow', 'overdue', 'thisWeek', 'noDate'].every(
    (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0
  )) return false
  const time = calculatedAt.toMillis()
  return time >= getJstDayBoundaries(now).todayStart.getTime() && time <= now.getTime()
}

// 必要時だけ全件を読む。競合時は再試行で保存済みカウントを再確認する。
async function recalculateSmartListCounts(
  userId: string,
  spaceId?: string,
  options?: { filterByUserVisibility?: boolean; preferCached?: boolean }
): Promise<SmartListCounts> {
  const countsRef = db.doc(buildSmartListCountsDocPath(userId, spaceId))
  const tasksQuery = db.collection(spaceId ? `spaces/${spaceId}/tasks` : `users/${userId}/tasks`)
    .where('completed', '==', false)

  return db.runTransaction(async (transaction) => {
    const saved = await transaction.get(countsRef)
    const now = new Date()
    if (options?.preferCached && canReuseSmartListCounts(saved.data(), now)) {
      return saved.data()!.smartListCounts as SmartListCounts
    }
    const snapshot = await transaction.get(tasksQuery)
    const counts: SmartListCounts = {
      today: 0, tomorrow: 0, overdue: 0, thisWeek: 0, noDate: 0,
      lastUpdated: Timestamp.fromDate(now),
    }
    snapshot.docs.forEach((doc) => {
      const task = doc.data() as TaskData
      if (spaceId && options?.filterByUserVisibility !== false && !taskMatchesScope(task, userId, { spaceId, useLegacyPath: false })) return
      categorizeTask(task, now).forEach((category) => {
        counts[category as keyof SmartListCountResponse]++
      })
    })
    transaction.set(countsRef, {
      smartListCounts: counts,
      smartListCountsRecalculatedAt: Timestamp.fromDate(now),
      smartListCountsSnapshotAt: snapshot.readTime,
    }, { merge: true })
    return counts
  })
}

function toSmartListCountResponse(counts: SmartListCounts): SmartListCountResponse {
  return {
    today: counts.today,
    tomorrow: counts.tomorrow,
    overdue: counts.overdue,
    thisWeek: counts.thisWeek,
    noDate: counts.noDate,
  }
}

// 全再集計へ含まれた変更の遅延配信は加算しない。削除もイベントのcommit時刻で判定する。
export function parseSmartListEventTime(value: string | undefined): Timestamp | undefined {
  if (!value) return undefined
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) return undefined
  const fraction = /\.(\d+)Z$/.exec(value)?.[1] ?? ''
  return new Timestamp(Math.floor(millis / 1000), Number(fraction.padEnd(9, '0').slice(0, 9)))
}

async function applySmartListDelta(path: string, delta: Record<string, number>, eventTime?: Timestamp): Promise<void> {
  const ref = db.doc(path)
  await db.runTransaction(async (transaction) => {
    const saved = await transaction.get(ref)
    const snapshotAt = saved.data()?.smartListCountsSnapshotAt
    if (eventTime && snapshotAt instanceof Timestamp &&
      (eventTime.seconds < snapshotAt.seconds ||
        (eventTime.seconds === snapshotAt.seconds && eventTime.nanoseconds <= snapshotAt.nanoseconds))) return
    const counts: Record<string, admin.firestore.FieldValue | Timestamp> = { lastUpdated: Timestamp.now() }
    Object.entries(delta).forEach(([key, value]) => {
      if (value !== 0) counts[key] = FieldValue.increment(value)
    })
    transaction.set(ref, { smartListCounts: counts }, { merge: true })
  })
}

export function taskMatchesScope(task: TaskData, userId: string, scope?: ScopedRequest): boolean {
  // 個人スペースではFirestore Rulesも可視性フィールドに関係なく所有者へ読み取りを許可する。
  // 移行前のタスクには visibleToMemberIds がないため、通常リストと同じ条件で対象に含める。
  if (scope?.spaceId && !scope.useLegacyPath && !scope.spaceId.startsWith('personal_')) {
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

    await applySmartListDelta(`users/${userId}`, delta,
      change.after.updateTime ?? parseSmartListEventTime(context.timestamp))
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

    await applySmartListDelta(buildSmartListCountsDocPath('', spaceId), delta,
      change.after.updateTime ?? parseSmartListEventTime(context.timestamp))
  })

// 毎日0時（JST）にスマートリストカウントを再計算（期限切れの更新用）
export async function runRecalculateAllSmartLists(): Promise<void> {
  const usersSnapshot = await db.collection('users').get()
  const userPromises = usersSnapshot.docs.map((doc) => recalculateSmartListCounts(doc.id))

  const spacesSnapshot = await db.collection('spaces').get()
  const spacePromises = spacesSnapshot.docs.map(async (spaceDoc) => {
    await recalculateSmartListCounts(spaceDoc.data().ownerUid ?? '', spaceDoc.id, {
      filterByUserVisibility: false,
    })
  })

  await Promise.all([...userPromises, ...spacePromises])
  console.log(`Updated smart list counts for ${usersSnapshot.size} users and ${spacesSnapshot.size} spaces`)
}

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

export const refreshSmartListCounts = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const { spaceId, useLegacyPath = false, preferCached = false } = data as {
      spaceId?: string
      useLegacyPath?: boolean
      preferCached?: boolean
    }
    const userId = context.auth.uid
    if (spaceId && !useLegacyPath) {
      if (typeof spaceId !== 'string' || spaceId.includes('/')) {
        throw new functions.https.HttpsError('invalid-argument', '無効なスペースです')
      }
      const membership = await db.doc(`spaces/${spaceId}/members/${userId}`).get()
      if (!membership.exists || membership.data()?.status !== 'active') {
        throw new functions.https.HttpsError('permission-denied', 'スペースへのアクセス権がありません')
      }
    }
    const counts = await recalculateSmartListCounts(
      userId,
      useLegacyPath ? undefined : spaceId,
      { filterByUserVisibility: false, preferCached: preferCached === true }
    )

    return toSmartListCountResponse(counts)
  })
