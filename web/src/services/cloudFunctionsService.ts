import { httpsCallable } from 'firebase/functions'
import { functions } from './firebaseFunctions'
import { useSpaceStore } from '@/stores/space'

// スマートリストのカウント型
export interface SmartListCounts {
  today: number
  tomorrow: number
  overdue: number
  thisWeek: number
  noDate: number
  lastUpdated: string
}

// スマートリストタスク型
export interface SmartListTask {
  id: string
  name: string
  listId: string
  priority: number
  dueDate: string | null
  tags: string[]
}

// 検索結果型
export interface SearchResult {
  id: string
  name: string
  listId: string
  priority: number
  completed: boolean
  dueDate: string | null
  tags: string[]
  parentId: string | null
}

export interface CreateFamilySpaceResult {
  success: boolean
  spaceId: string
  name: string
}

export interface UpdateFamilySpaceNameResult {
  success: boolean
  spaceId: string
  name: string
}

export interface EnsureCurrentUserSpaceAccessResult {
  success: boolean
  personalSpaceId: string
  joinedFamilySpaceIds: string[]
  familySpaceCount: number
}

export interface ValidateCurrentUserAccessResult {
  success: boolean
  allowed: boolean
  personalSpaceId: string
  joinedFamilySpaceIds: string[]
}

export interface MigrateCurrentUserToPersonalSpaceResult {
  success: boolean
  migrated: boolean
  spaceId: string
  lists: {
    sourceCount: number
    targetCount: number
  }
  tasks: {
    sourceCount: number
    targetCount: number
  }
  tags: {
    sourceCount: number
    targetCount: number
  }
}

export interface SaveMobileNotificationPreferencesResult {
  success: boolean
}

// スマートリストのタスクを取得
export async function getSmartListTasks(
  smartListType: 'today' | 'tomorrow' | 'overdue' | 'thisWeek' | 'noDate',
  limitCount: number = 50
): Promise<{ tasks: SmartListTask[]; totalCount: number }> {
  const spaceStore = useSpaceStore()
  const callable = httpsCallable<
    { smartListType: string; limitCount: number; spaceId?: string | null; useLegacyPath: boolean },
    { tasks: SmartListTask[]; totalCount: number }
  >(functions, 'getSmartListTasks')

  const result = await callable({
    smartListType,
    limitCount,
    spaceId: spaceStore.currentSpaceId,
    useLegacyPath: spaceStore.useLegacyPath,
  })
  return result.data
}

export async function refreshSmartListCounts(): Promise<Omit<SmartListCounts, 'lastUpdated'>> {
  const spaceStore = useSpaceStore()
  const callable = httpsCallable<
    { spaceId?: string | null; useLegacyPath: boolean },
    Omit<SmartListCounts, 'lastUpdated'>
  >(functions, 'refreshSmartListCounts')

  const result = await callable({
    spaceId: spaceStore.currentSpaceId,
    useLegacyPath: spaceStore.useLegacyPath,
  })
  return result.data
}

// タスク検索（サーバー側フィルタリング）
export async function searchTasksApi(
  query: string,
  options: {
    listId?: string
    includeCompleted?: boolean
    limitCount?: number
  } = {}
): Promise<{ results: SearchResult[]; totalCount: number; searchTerms: string[] }> {
  const spaceStore = useSpaceStore()
  const callable = httpsCallable<
    {
      query: string
      listId?: string
      includeCompleted?: boolean
      limitCount?: number
      spaceId?: string | null
      useLegacyPath: boolean
    },
    { results: SearchResult[]; totalCount: number; searchTerms: string[] }
  >(functions, 'searchTasks')

  const result = await callable({
    query,
    listId: options.listId,
    includeCompleted: options.includeCompleted ?? false,
    limitCount: options.limitCount ?? 50,
    spaceId: spaceStore.currentSpaceId,
    useLegacyPath: spaceStore.useLegacyPath,
  })
  return result.data
}

// フィルター付きタスク取得
export async function getTasksByFilter(options: {
  listId?: string
  tag?: string
  completed?: boolean
  priority?: number
  hasDueDate?: boolean
  limitCount?: number
  offset?: number
}): Promise<{ tasks: SearchResult[]; totalCount: number; hasMore: boolean }> {
  const spaceStore = useSpaceStore()
  const callable = httpsCallable<
    typeof options & { spaceId?: string | null; useLegacyPath: boolean },
    { tasks: SearchResult[]; totalCount: number; hasMore: boolean }
  >(functions, 'getTasksByFilter')

  const result = await callable({
    ...options,
    spaceId: spaceStore.currentSpaceId,
    useLegacyPath: spaceStore.useLegacyPath,
  })
  return result.data
}

export async function createFamilySpaceApi(name: string, displayName?: string | null): Promise<CreateFamilySpaceResult> {
  const callable = httpsCallable<
    { name: string; displayName?: string | null },
    CreateFamilySpaceResult
  >(functions, 'createFamilySpace')

  const result = await callable({ name, displayName })
  return result.data
}

export async function updateFamilySpaceNameApi(
  spaceId: string,
  name: string
): Promise<UpdateFamilySpaceNameResult> {
  const callable = httpsCallable<
    { spaceId: string; name: string },
    UpdateFamilySpaceNameResult
  >(functions, 'updateFamilySpaceName')

  const result = await callable({ spaceId, name })
  return result.data
}

export async function ensureCurrentUserSpaceAccessApi(): Promise<EnsureCurrentUserSpaceAccessResult> {
  const callable = httpsCallable<Record<string, never>, EnsureCurrentUserSpaceAccessResult>(
    functions,
    'ensureCurrentUserSpaceAccess'
  )

  const result = await callable({})
  return result.data
}

export async function validateCurrentUserAccessApi(): Promise<ValidateCurrentUserAccessResult> {
  const callable = httpsCallable<Record<string, never>, ValidateCurrentUserAccessResult>(
    functions,
    'validateCurrentUserAccess'
  )

  const result = await callable({})
  return result.data
}

export async function migrateCurrentUserToPersonalSpaceApi(): Promise<MigrateCurrentUserToPersonalSpaceResult> {
  const callable = httpsCallable<Record<string, never>, MigrateCurrentUserToPersonalSpaceResult>(
    functions,
    'migrateCurrentUserToPersonalSpace'
  )

  const result = await callable({})
  return result.data
}

export async function saveMobileNotificationPreferencesApi(data: {
  discord?: {
    enabled: boolean
    webhookUrl?: string
    urgentImmediate: boolean
    dailyDigest: boolean
  }
}): Promise<SaveMobileNotificationPreferencesResult> {
  const callable = httpsCallable<
    typeof data,
    SaveMobileNotificationPreferencesResult
  >(functions, 'saveMobileNotificationPreferences')

  const result = await callable(data)
  return result.data
}
