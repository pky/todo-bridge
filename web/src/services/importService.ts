import { collection, doc, writeBatch, Timestamp, getDocs } from 'firebase/firestore'
import { db } from '@/services/firebase'
import type { RTMExport } from '@/types/rtm'
import {
  convertRTMList,
  convertRTMTask,
  extractTags,
  groupNotesBySeriesId,
} from '@/utils/rtmConverter'

export interface ImportScope {
  spaceId?: string | null
  useLegacyPath?: boolean
}

export interface ImportProgress {
  phase: 'lists' | 'tasks' | 'subtasks' | 'tags' | 'done'
  current: number
  total: number
  message: string
}

export interface ImportResult {
  success: boolean
  listsImported: number
  tasksImported: number
  tagsImported: number
  error?: string
}

const BATCH_SIZE = 400 // Firestoreのバッチ上限は500

function getScopedCollection(name: 'lists' | 'tasks' | 'tags', userId: string, scope?: ImportScope) {
  if (!scope?.spaceId || scope.useLegacyPath) {
    return collection(db, 'users', userId, name)
  }
  return collection(db, 'spaces', scope.spaceId, name)
}

/**
 * RTMエクスポートデータをFirestoreにインポート
 */
export async function importRTMData(
  userId: string,
  data: RTMExport,
  onProgress?: (progress: ImportProgress) => void,
  scope?: ImportScope
): Promise<ImportResult> {
  try {
    const listsCollection = getScopedCollection('lists', userId, scope)
    const tasksCollection = getScopedCollection('tasks', userId, scope)
    const tagsCollection = getScopedCollection('tags', userId, scope)

    // 1. リストをインポート
    onProgress?.({ phase: 'lists', current: 0, total: data.lists.length, message: 'リストをインポート中...' })

    const listIdMap = new Map<string, string>()
    let inboxId: string | null = null

    for (let i = 0; i < data.lists.length; i += BATCH_SIZE) {
      const batch = writeBatch(db)
      const chunk = data.lists.slice(i, i + BATCH_SIZE)

      for (const rtmList of chunk) {
        const converted = convertRTMList(rtmList)
        const docRef = doc(listsCollection)

        batch.set(docRef, {
          name: converted.name,
          dateCreated: Timestamp.fromDate(converted.dateCreated),
          dateModified: Timestamp.fromDate(converted.dateModified),
          rtmId: converted.rtmId,
        })

        listIdMap.set(rtmList.id, docRef.id)

        if (rtmList.name === 'Inbox') {
          inboxId = docRef.id
        }
      }

      await batch.commit()
      onProgress?.({ phase: 'lists', current: Math.min(i + BATCH_SIZE, data.lists.length), total: data.lists.length, message: 'リストをインポート中...' })
    }

    // 2. ノートをグループ化
    const notesMap = groupNotesBySeriesId(data.notes)

    // 3. タスクをインポート（まずparentId=nullで全タスクをインポート）
    onProgress?.({ phase: 'tasks', current: 0, total: data.tasks.length, message: 'タスクをインポート中...' })

    // rtmId → FirestoreId のマップ（サブタスクのparentId解決用）
    const taskIdMap = new Map<string, string>()
    // サブタスク情報（後でparentIdを更新するため）
    const subtasksToUpdate: { firestoreId: string; rtmParentId: string }[] = []

    for (let i = 0; i < data.tasks.length; i += BATCH_SIZE) {
      const batch = writeBatch(db)
      const chunk = data.tasks.slice(i, i + BATCH_SIZE)

      for (const rtmTask of chunk) {
        const converted = convertRTMTask(rtmTask, listIdMap, notesMap, inboxId ?? undefined)
        const docRef = doc(tasksCollection)

        // rtmId → FirestoreId のマッピングを保存
        taskIdMap.set(converted.rtmId, docRef.id)

        // サブタスクの場合は後で更新するためにリストに追加
        if (converted.rtmParentId) {
          subtasksToUpdate.push({
            firestoreId: docRef.id,
            rtmParentId: converted.rtmParentId,
          })
        }

        batch.set(docRef, {
          name: converted.name,
          listId: converted.listId,
          parentId: null, // 最初はnull、後で更新
          priority: converted.priority,
          tags: converted.tags,
          dueDate: converted.dueDate ? Timestamp.fromDate(converted.dueDate) : null,
          startDate: converted.startDate ? Timestamp.fromDate(converted.startDate) : null,
          repeat: null,
          notes: converted.notes,
          url: converted.url,
          completed: converted.completed,
          dateCompleted: converted.dateCompleted ? Timestamp.fromDate(converted.dateCompleted) : null,
          dateCreated: Timestamp.fromDate(converted.dateCreated),
          dateModified: Timestamp.fromDate(converted.dateModified),
          rtmId: converted.rtmId,
        })
      }

      await batch.commit()
      onProgress?.({ phase: 'tasks', current: Math.min(i + BATCH_SIZE, data.tasks.length), total: data.tasks.length, message: 'タスクをインポート中...' })
    }

    // 4. サブタスクのparentIdを更新
    if (subtasksToUpdate.length > 0) {
      onProgress?.({ phase: 'subtasks', current: 0, total: subtasksToUpdate.length, message: 'サブタスクを関連付け中...' })

      for (let i = 0; i < subtasksToUpdate.length; i += BATCH_SIZE) {
        const batch = writeBatch(db)
        const chunk = subtasksToUpdate.slice(i, i + BATCH_SIZE)

        for (const subtask of chunk) {
          const parentFirestoreId = taskIdMap.get(subtask.rtmParentId)
          if (parentFirestoreId) {
            const docRef = doc(tasksCollection, subtask.firestoreId)
            batch.update(docRef, { parentId: parentFirestoreId })
          }
        }

        await batch.commit()
        onProgress?.({ phase: 'subtasks', current: Math.min(i + BATCH_SIZE, subtasksToUpdate.length), total: subtasksToUpdate.length, message: 'サブタスクを関連付け中...' })
      }
    }

    // 5. タグをインポート
    const uniqueTags = extractTags(data.tasks)
    onProgress?.({ phase: 'tags', current: 0, total: uniqueTags.length, message: 'タグをインポート中...' })

    for (let i = 0; i < uniqueTags.length; i += BATCH_SIZE) {
      const batch = writeBatch(db)
      const chunk = uniqueTags.slice(i, i + BATCH_SIZE)

      for (const tagName of chunk) {
        const docRef = doc(tagsCollection)
        batch.set(docRef, { name: tagName })
      }

      await batch.commit()
      onProgress?.({ phase: 'tags', current: Math.min(i + BATCH_SIZE, uniqueTags.length), total: uniqueTags.length, message: 'タグをインポート中...' })
    }

    onProgress?.({ phase: 'done', current: 1, total: 1, message: 'インポート完了！' })

    return {
      success: true,
      listsImported: data.lists.length,
      tasksImported: data.tasks.length,
      tagsImported: uniqueTags.length,
    }
  } catch (error) {
    return {
      success: false,
      listsImported: 0,
      tasksImported: 0,
      tagsImported: 0,
      error: error instanceof Error ? error.message : 'インポートに失敗しました',
    }
  }
}

/**
 * JSONファイルをパースしてRTMExport型として返す
 */
export function parseRTMExportFile(jsonContent: string): RTMExport {
  const data = JSON.parse(jsonContent) as RTMExport

  // 最低限の検証
  if (!data.lists || !Array.isArray(data.lists)) {
    throw new Error('Invalid RTM export: lists not found')
  }
  if (!data.tasks || !Array.isArray(data.tasks)) {
    throw new Error('Invalid RTM export: tasks not found')
  }

  return data
}

export interface ClearResult {
  success: boolean
  tasksDeleted: number
  listsDeleted: number
  tagsDeleted: number
  error?: string
}

/**
 * ユーザーの全データを削除（タスク、リスト、タグ）
 */
export async function clearAllUserData(userId: string, scope?: ImportScope): Promise<ClearResult> {
  try {
    const tasksCollection = getScopedCollection('tasks', userId, scope)
    const listsCollection = getScopedCollection('lists', userId, scope)
    const tagsCollection = getScopedCollection('tags', userId, scope)

    let tasksDeleted = 0
    let listsDeleted = 0
    let tagsDeleted = 0

    // タスクを削除
    const tasksDocs = await getDocs(tasksCollection)
    if (!tasksDocs.empty) {
      for (let i = 0; i < tasksDocs.docs.length; i += BATCH_SIZE) {
        const batch = writeBatch(db)
        const chunk = tasksDocs.docs.slice(i, i + BATCH_SIZE)
        for (const docSnap of chunk) {
          batch.delete(docSnap.ref)
        }
        await batch.commit()
      }
      tasksDeleted = tasksDocs.docs.length
    }

    // リストを削除
    const listsDocs = await getDocs(listsCollection)
    if (!listsDocs.empty) {
      for (let i = 0; i < listsDocs.docs.length; i += BATCH_SIZE) {
        const batch = writeBatch(db)
        const chunk = listsDocs.docs.slice(i, i + BATCH_SIZE)
        for (const docSnap of chunk) {
          batch.delete(docSnap.ref)
        }
        await batch.commit()
      }
      listsDeleted = listsDocs.docs.length
    }

    // タグを削除
    const tagsDocs = await getDocs(tagsCollection)
    if (!tagsDocs.empty) {
      for (let i = 0; i < tagsDocs.docs.length; i += BATCH_SIZE) {
        const batch = writeBatch(db)
        const chunk = tagsDocs.docs.slice(i, i + BATCH_SIZE)
        for (const docSnap of chunk) {
          batch.delete(docSnap.ref)
        }
        await batch.commit()
      }
      tagsDeleted = tagsDocs.docs.length
    }

    return {
      success: true,
      tasksDeleted,
      listsDeleted,
      tagsDeleted,
    }
  } catch (error) {
    return {
      success: false,
      tasksDeleted: 0,
      listsDeleted: 0,
      tagsDeleted: 0,
      error: error instanceof Error ? error.message : '削除に失敗しました',
    }
  }
}

export interface ExportData {
  exportedAt: string
  lists: unknown[]
  tasks: unknown[]
  tags: unknown[]
}

/**
 * ユーザーの全データをエクスポート
 */
export async function exportUserData(userId: string, scope?: ImportScope): Promise<ExportData> {
  const tasksCollection = getScopedCollection('tasks', userId, scope)
  const listsCollection = getScopedCollection('lists', userId, scope)
  const tagsCollection = getScopedCollection('tags', userId, scope)

  const [tasksDocs, listsDocs, tagsDocs] = await Promise.all([
    getDocs(tasksCollection),
    getDocs(listsCollection),
    getDocs(tagsCollection),
  ])

  const tasks = tasksDocs.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }))

  const lists = listsDocs.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }))

  const tags = tagsDocs.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }))

  return {
    exportedAt: new Date().toISOString(),
    lists,
    tasks,
    tags,
  }
}
