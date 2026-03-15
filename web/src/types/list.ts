import type { Timestamp } from 'firebase/firestore'

export interface TaskList {
  id: string
  name: string
  position: number
  spaceId?: string
  visibleToMemberIds?: string[]
  editableByMemberIds?: string[]
  dateCreated: Timestamp
  dateModified: Timestamp
  // Cloud Functionsで自動更新される未完了タスク数
  incompleteTaskCount?: number
}

export interface SmartListFilter {
  listIds?: string[]
  tagIds?: string[]
  priority?: (1 | 2 | 3 | 4)[]
  dueDateRange?: {
    start?: Timestamp
    end?: Timestamp
  }
  completed?: boolean
  hasNotes?: boolean
}

export interface SmartList {
  id: string
  name: string
  filter: SmartListFilter
  dateCreated: Timestamp
}

export interface Tag {
  id: string
  name: string
  spaceId?: string
  visibleToMemberIds?: string[]
  editableByMemberIds?: string[]
}

export interface ListMetadata {
  listId: string
  lastModified: Timestamp
}

export type CreateListInput = Pick<
  TaskList,
  'name' | 'visibleToMemberIds'
> & {
  spaceId?: string
}
export type UpdateListInput = Partial<
  Pick<TaskList, 'name' | 'visibleToMemberIds'>
>
