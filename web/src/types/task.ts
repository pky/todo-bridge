import type { Timestamp } from 'firebase/firestore'

export interface RepeatRule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  endDate?: Timestamp
}

export interface Task {
  id: string
  spaceId?: string
  name: string
  listId: string
  parentId: string | null  // サブタスクの場合、親タスクのID
  priority: 1 | 2 | 3 | 4  // 1=最高, 4=なし
  tags: string[]
  dueDate: Timestamp | null
  startDate: Timestamp | null
  repeat: RepeatRule | null
  notes: string[]
  url: string | null
  completed: boolean
  dateCompleted: Timestamp | null
  dateCreated: Timestamp
  dateModified: Timestamp
  deleted?: boolean  // 論理削除フラグ
  allDay: boolean                 // 終日フラグ（true: 終日, false: 時刻指定）
  addToCalendar: boolean          // Googleカレンダーに登録するか
  calendarEventId: string | null  // 登録済みカレンダーイベントID
  visibleToMemberIds?: string[]
  editableByMemberIds?: string[]
}

export type CreateTaskInput = Omit<Task, 'id' | 'dateCreated' | 'dateModified' | 'dateCompleted'>
export type UpdateTaskInput = Partial<Omit<Task, 'id' | 'dateCreated'>>
