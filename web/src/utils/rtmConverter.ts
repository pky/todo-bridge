import type { RTMTask, RTMList, RTMNote } from '@/types/rtm'

// 変換後のタスク型（Firestoreに保存する前の形式）
export interface ConvertedTask {
  name: string
  listId: string
  priority: 1 | 2 | 3 | 4
  tags: string[]
  dueDate: Date | null
  startDate: Date | null
  repeat: null  // リピートは未対応
  notes: string[]
  url: string | null
  completed: boolean
  dateCompleted: Date | null
  dateCreated: Date
  dateModified: Date
  rtmId: string  // 元のRTM ID（重複チェック用）
  rtmParentId: string | null  // サブタスクの場合、親のRTM ID
}

export interface ConvertedList {
  name: string
  dateCreated: Date
  dateModified: Date
  rtmId: string
}

/**
 * RTMの優先度をReRTMの優先度に変換
 */
export function convertRTMPriority(priority: 'P1' | 'P2' | 'P3' | 'PN'): 1 | 2 | 3 | 4 {
  switch (priority) {
    case 'P1': return 1
    case 'P2': return 2
    case 'P3': return 3
    case 'PN': return 4
  }
}

/**
 * RTMリストをReRTMリストに変換
 */
export function convertRTMList(rtmList: RTMList): ConvertedList {
  return {
    name: rtmList.name,
    dateCreated: new Date(rtmList.date_created),
    dateModified: new Date(rtmList.date_modified),
    rtmId: rtmList.id,
  }
}

/**
 * RTMタスクをReRTMタスクに変換
 * @param rtmTask RTMタスク
 * @param listIdMap RTM list_id → Firestore listId のマップ
 * @param notesMap series_id → ノート配列 のマップ
 * @param fallbackListId リストが見つからない場合のフォールバックID
 */
export function convertRTMTask(
  rtmTask: RTMTask,
  listIdMap: Map<string, string>,
  notesMap: Map<string, string[]>,
  fallbackListId?: string
): ConvertedTask {
  const listId = listIdMap.get(rtmTask.list_id) ?? fallbackListId ?? ''
  const notes = notesMap.get(rtmTask.series_id) ?? []

  return {
    name: rtmTask.name,
    listId,
    priority: convertRTMPriority(rtmTask.priority),
    tags: rtmTask.tags,
    dueDate: rtmTask.date_due ? new Date(rtmTask.date_due) : null,
    startDate: rtmTask.date_start ? new Date(rtmTask.date_start) : null,
    repeat: null,
    notes,
    url: rtmTask.url ?? null,
    completed: !!rtmTask.date_completed,
    dateCompleted: rtmTask.date_completed ? new Date(rtmTask.date_completed) : null,
    dateCreated: new Date(rtmTask.date_created),
    dateModified: new Date(rtmTask.date_modified),
    rtmId: rtmTask.id,
    rtmParentId: rtmTask.parent_id ?? null,
  }
}

/**
 * タスク配列から一意のタグを抽出
 */
export function extractTags(tasks: RTMTask[]): string[] {
  const tagSet = new Set<string>()
  for (const task of tasks) {
    for (const tag of task.tags) {
      tagSet.add(tag)
    }
  }
  return Array.from(tagSet)
}

/**
 * ノートをseries_idでグループ化
 * @returns series_id → ノート内容の配列
 */
export function groupNotesBySeriesId(notes: RTMNote[]): Map<string, string[]> {
  const map = new Map<string, string[]>()

  for (const note of notes) {
    const content = note.title
      ? `【${note.title}】${note.content}`
      : note.content

    const existing = map.get(note.series_id)
    if (existing) {
      existing.push(content)
    } else {
      map.set(note.series_id, [content])
    }
  }

  return map
}
