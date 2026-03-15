import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { buildScopedCollectionPath } from './sharedTypes'

const db = admin.firestore()

interface TaskData {
  name: string
  listId: string
  completed: boolean
  parentId?: string | null
  dueDate?: admin.firestore.Timestamp | null
  priority: number
  tags: string[]
  notes?: string[]
  dateCreated: admin.firestore.Timestamp
  dateCompleted?: admin.firestore.Timestamp | null
}

interface SearchResult {
  id: string
  name: string
  listId: string
  priority: number
  completed: boolean
  dueDate: string | null
  tags: string[]
  parentId: string | null
}

// タスク検索API（Callable Function）
export const searchTasks = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const {
      query,
      listId,
      includeCompleted = false,
      limitCount = 50,
      spaceId,
      useLegacyPath = false,
    } = data as {
      query: string
      listId?: string
      includeCompleted?: boolean
      limitCount?: number
      spaceId?: string
      useLegacyPath?: boolean
    }
    const userId = context.auth.uid

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new functions.https.HttpsError('invalid-argument', '検索クエリが必要です')
    }

    const searchTerms = query.toLowerCase().trim().split(/\s+/)
    const tasksRef = db.collection(buildScopedCollectionPath(userId, 'tasks', { spaceId, useLegacyPath }))

    // 基本クエリを構築
    let tasksQuery: FirebaseFirestore.Query = tasksRef

    if (listId) {
      tasksQuery = tasksQuery.where('listId', '==', listId)
    }

    if (!includeCompleted) {
      tasksQuery = tasksQuery.where('completed', '==', false)
    }

    const snapshot = await tasksQuery.get()
    const results: SearchResult[] = []

    snapshot.docs.forEach((doc) => {
      const task = doc.data() as TaskData
      if (spaceId && !useLegacyPath) {
        const visibleToMemberIds = (task as TaskData & { visibleToMemberIds?: string[] }).visibleToMemberIds || []
        if (!visibleToMemberIds.includes(userId)) return
      }
      const nameLower = task.name.toLowerCase()
      const tagsLower = (task.tags || []).map((t) => t.toLowerCase())

      // 全ての検索語が名前またはタグに含まれるかチェック
      const matches = searchTerms.every((term) => {
        if (term.startsWith('#')) {
          // タグ検索
          const tagTerm = term.slice(1)
          return tagsLower.some((t) => t.includes(tagTerm))
        }
        // 名前検索
        return nameLower.includes(term) || tagsLower.some((t) => t.includes(term))
      })

      if (matches) {
        results.push({
          id: doc.id,
          name: task.name,
          listId: task.listId,
          priority: task.priority,
          completed: task.completed,
          dueDate: task.dueDate ? task.dueDate.toDate().toISOString() : null,
          tags: task.tags || [],
          parentId: task.parentId || null,
        })
      }
    })

    // 優先度と作成日でソート（未完了優先）
    results.sort((a, b) => {
      // 未完了を優先
      if (a.completed !== b.completed) return a.completed ? 1 : -1
      // 優先度で比較
      if (a.priority !== b.priority) return a.priority - b.priority
      return 0
    })

    return {
      results: results.slice(0, limitCount),
      totalCount: results.length,
      searchTerms,
    }
  })

// フィルター付きタスク取得API（Callable Function）
export const getTasksByFilter = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const {
      listId,
      tag,
      completed,
      priority,
      hasDueDate,
      limitCount = 100,
      offset = 0,
      spaceId,
      useLegacyPath = false,
    } = data as {
      listId?: string
      tag?: string
      completed?: boolean
      priority?: number
      hasDueDate?: boolean
      limitCount?: number
      offset?: number
      spaceId?: string
      useLegacyPath?: boolean
    }
    const userId = context.auth.uid

    const tasksRef = db.collection(buildScopedCollectionPath(userId, 'tasks', { spaceId, useLegacyPath }))
    let tasksQuery: FirebaseFirestore.Query = tasksRef

    // Firestoreクエリでできるフィルタリング
    if (listId) {
      tasksQuery = tasksQuery.where('listId', '==', listId)
    }

    if (typeof completed === 'boolean') {
      tasksQuery = tasksQuery.where('completed', '==', completed)
    }

    const snapshot = await tasksQuery.get()
    let results: SearchResult[] = []

    snapshot.docs.forEach((doc) => {
      const task = doc.data() as TaskData
      if (spaceId && !useLegacyPath) {
        const visibleToMemberIds = (task as TaskData & { visibleToMemberIds?: string[] }).visibleToMemberIds || []
        if (!visibleToMemberIds.includes(userId)) return
      }

      // クライアント側フィルタリング
      if (tag && !(task.tags || []).includes(tag)) return
      if (typeof priority === 'number' && task.priority !== priority) return
      if (typeof hasDueDate === 'boolean') {
        if (hasDueDate && !task.dueDate) return
        if (!hasDueDate && task.dueDate) return
      }

      results.push({
        id: doc.id,
        name: task.name,
        listId: task.listId,
        priority: task.priority,
        completed: task.completed,
        dueDate: task.dueDate ? task.dueDate.toDate().toISOString() : null,
        tags: task.tags || [],
        parentId: task.parentId || null,
      })
    })

    // 優先度と期限でソート
    results.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      if (a.dueDate && b.dueDate)
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
      if (a.dueDate) return -1
      if (b.dueDate) return 1
      return 0
    })

    const total = results.length
    results = results.slice(offset, offset + limitCount)

    return {
      tasks: results,
      totalCount: total,
      hasMore: offset + limitCount < total,
    }
  })
