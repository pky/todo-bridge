// Remember The Milk エクスポート形式の型定義

export interface RTMExport {
  config: RTMConfig
  lists: RTMList[]
  tasks: RTMTask[]
  tags: RTMTag[]
  notes: RTMNote[]
  smart_lists?: RTMSmartList[]
  locations?: RTMLocation[]
  contacts?: unknown[]
  external_auths?: unknown[]
  list_permissions?: unknown[]
  apps?: unknown[]
  sorting_schemes?: unknown[]
  drag_drop?: unknown[]
  notification_sinks?: unknown[]
  requests?: unknown[]
  activities?: unknown[]
  reminders?: unknown[]
  file_services?: unknown[]
  attachments?: unknown[]
  favorites?: unknown[]
  scripts?: unknown[]
}

export interface RTMConfig {
  username: string
  first_name: string
  last_name: string
  email: string
  timezone_id: string
  date_format_month_first: boolean
  time_format_24hr: boolean
}

export interface RTMList {
  id: string
  name: string
  date_created: number  // Unix timestamp (ms)
  date_modified: number
  syncable?: boolean
  token?: string
}

export interface RTMTask {
  id: string
  series_id: string
  list_id: string
  parent_id?: string
  name: string
  priority: 'P1' | 'P2' | 'P3' | 'PN'  // P1=高, P2=中, P3=低, PN=なし
  date_created: number
  date_added: number
  date_modified: number
  date_completed?: number
  date_due?: number
  date_due_has_time?: boolean
  date_start?: number
  date_start_has_time?: boolean
  postponed?: number
  source?: string
  repeat_every?: boolean
  tags: string[]  // タグ名の配列
  url?: string
}

export interface RTMTag {
  id: string  // タグ名そのもの
  date_created: number
  date_modified: number
  relative_position?: number
}

export interface RTMNote {
  id: string
  series_id: string  // タスクのseries_idと紐づく
  date_created: number
  date_modified: number
  title?: string
  content: string
  creator_id?: string
  last_editor_id?: string
}

export interface RTMSmartList {
  id: string
  name: string
  date_created: number
  date_modified: number
  filter?: string
}

export interface RTMLocation {
  id: string
  name: string
  latitude?: number
  longitude?: number
  zoom?: number
  address?: string
}
