import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import {
  doc,
  setDoc,
  updateDoc,
  getDocs,
  getDocsFromCache,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  where,
  limit,
  startAfter,
  Timestamp,
  type QueryDocumentSnapshot,
  type DocumentData,
  type Unsubscribe,
} from 'firebase/firestore'
import { useToast } from '@/composables/useToast'
import { retryWithBackoff } from '@/utils/retry'
import { useAuthStore } from './auth'
import { useListsStore } from './lists'
import { useSpaceStore } from './space'
import type { Task, CreateTaskInput, UpdateTaskInput } from '@/types'
import {
  getSmartListTasks,
  searchTasksApi,
  type SmartListTask,
  type SearchResult,
} from '@/services/cloudFunctionsService'

export type SortOrder = 'name' | 'created'

// 再取得のしきい値（5分）
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000

export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref<Task[]>([])
  const selectedTaskId = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const sortOrder = ref<SortOrder>('name')
  const searchQuery = ref('')
  const selectedTag = ref<string | null>(null)

  // リストごとにタスクをキャッシュ（読み取り削減）
  const tasksByList = new Map<string, Task[]>()
  let currentListId: string | null = null
  // onSnapshotリスナーのunsubscribe関数
  let currentUnsubscribe: Unsubscribe | null = null
  // 検索用のキャッシュ（全タスクではなく、読み込み済みのタスクを使用）
  const allTasksCache = ref<Task[]>([])
  // 完了タスクの読み込み状態（リストIDごとに管理）
  const completedTasksLoaded = ref<Set<string>>(new Set())
  const completedTasksLoading = ref(false)
  // Phase 4: 完了タスクのページネーション用カーソル（リストIDごとに管理）
  // reactive(Map)を使用してMapの変更を自動追跡
  const completedTasksCursors = reactive(new Map<string, QueryDocumentSnapshot<DocumentData>>())
  // スマートリスト用
  const smartListTasksLoading = ref(false)
  const currentSmartListType = ref<string | null>(null)
  // サーバー側検索結果
  const serverSearchResults = ref<SearchResult[]>([])
  const serverSearchLoading = ref(false)
  // 最終取得時刻（全体）
  const lastFetchTime = ref<number>(0)
  // 初回ロード完了フラグ（初回ロード中はforceRefreshを防止）
  const isInitialLoadComplete = ref(false)

  const selectedTask = computed(() => {
    if (!selectedTaskId.value) return null
    // 現在リストのタスクから検索
    const found = tasks.value.find((t) => t.id === selectedTaskId.value)
    if (found) return found
    // 検索モード時は全タスクキャッシュからも検索
    return allTasksCache.value.find((t) => t.id === selectedTaskId.value) || null
  })

  // Phase 4: 完了タスクがさらに読み込み可能かどうか
  const hasMoreCompletedTasks = computed(() => {
    const targetListId = currentListId || useListsStore().selectedListId
    if (!targetListId) return false
    return completedTasksCursors.has(targetListId)
  })

  // 検索モードかどうか
  const isSearching = computed(() => searchQuery.value.trim().length > 0)
  // 完了済みタスクも検索に含めるフラグ
  const searchIncludeCompleted = ref(false)

  // 検索結果（キャッシュから検索、サブタスクも含む）
  const searchResults = computed(() => {
    if (!isSearching.value) return []
    const q = searchQuery.value.toLowerCase().trim()
    return allTasksCache.value
      .filter((t) => {
        if (!searchIncludeCompleted.value && t.completed) return false
        return t.name.toLowerCase().includes(q)
      })
      .sort(mainSort)
  })

  // タグフィルタリングモードかどうか
  const isTagFiltering = computed(() => selectedTag.value !== null)

  const filteredTasks = computed(() => {
    // タグフィルタリング中はキャッシュからタグで絞り込む
    if (selectedTag.value) {
      return allTasksCache.value.filter((t) => t.tags.includes(selectedTag.value!))
    }

    // 通常時は現在のリストのタスク（既にフィルタリング済み）
    return tasks.value
  })

  // 親タスクのみ（サブタスクでないもの）
  const rootTasks = computed(() =>
    filteredTasks.value.filter((t) => !t.parentId)
  )

  // 親タスクIDでサブタスクを取得（ソート適用）
  function getSubtasks(parentId: string): Task[] {
    return filteredTasks.value
      .filter((t) => t.parentId === parentId)
      .sort(mainSort)
  }

  // 親タスクIDで未完了のサブタスクのみ取得（ソート適用）
  function getIncompleteSubtasks(parentId: string): Task[] {
    return filteredTasks.value
      .filter((t) => t.parentId === parentId && !t.completed)
      .sort(mainSort)
  }

  // タスクにサブタスクがあるかチェック
  function hasSubtasks(parentId: string): boolean {
    return filteredTasks.value.some((t) => t.parentId === parentId)
  }

  // サブタスクの数を取得（合計と未完了）
  function getSubtaskCounts(parentId: string): { total: number; incomplete: number } {
    const subtasks = filteredTasks.value.filter((t) => t.parentId === parentId)
    return {
      total: subtasks.length,
      incomplete: subtasks.filter((t) => !t.completed).length,
    }
  }

  // Timestampからミリ秒を取得（Firestore/モック両対応）
  function getMillis(date: unknown): number {
    if (!date) return 0
    if (typeof date === 'number') return date
    if (typeof (date as { toMillis?: () => number }).toMillis === 'function') {
      return (date as { toMillis: () => number }).toMillis()
    }
    // モックテスト用: { _seconds, _nanoseconds } 形式
    if (typeof (date as { _seconds?: number })._seconds === 'number') {
      return (date as { _seconds: number })._seconds * 1000
    }
    return 0
  }

  // 名前でソート（日本語対応）
  function compareByName(a: Task, b: Task): number {
    return a.name.localeCompare(b.name, 'ja')
  }

  // 作成日でソート（新しい順）
  function compareByCreated(a: Task, b: Task): number {
    const dateA = getMillis(a.dateCreated)
    const dateB = getMillis(b.dateCreated)
    return dateB - dateA
  }

  // 期限でソート（期限あり→期限なし、期限が近い順）
  function compareByDueDate(a: Task, b: Task): number {
    const dueDateA = getMillis(a.dueDate)
    const dueDateB = getMillis(b.dueDate)

    // 期限あり vs なし
    if (dueDateA && !dueDateB) return -1
    if (!dueDateA && dueDateB) return 1

    // 両方期限あり → 期限が近い順
    if (dueDateA && dueDateB) {
      return dueDateA - dueDateB
    }

    // 両方期限なし → 0
    return 0
  }

  // セカンダリソート（sortOrderに応じて）
  function secondarySort(a: Task, b: Task): number {
    if (sortOrder.value === 'name') {
      return compareByName(a, b)
    }
    return compareByCreated(a, b)
  }

  // メインソート（期限 → 優先度 → セカンダリ）
  function mainSort(a: Task, b: Task): number {
    // 1. 期限でソート
    const dueDateCompare = compareByDueDate(a, b)
    if (dueDateCompare !== 0) return dueDateCompare

    // 2. 優先度でソート
    if (a.priority !== b.priority) {
      return a.priority - b.priority
    }

    // 3. セカンダリソート
    return secondarySort(a, b)
  }

  const incompleteTasks = computed(() =>
    rootTasks.value
      .filter((t) => !t.completed)
      .sort(mainSort)
  )

  const completedTasks = computed(() =>
    filteredTasks.value
      .filter((t) => t.completed)
      .sort((a, b) => secondarySort(a, b))
  )

  function setSortOrder(order: SortOrder) {
    sortOrder.value = order
  }

  function getTasksCollection() {
    const spaceStore = useSpaceStore()
    return spaceStore.getCollectionRef('tasks')
  }

  function getTasksCollectionForSpace(spaceId?: string | null) {
    const spaceStore = useSpaceStore()
    return spaceStore.getCollectionRefForSpace('tasks', spaceId)
  }

  function getTaskDocRef(id: string, spaceId?: string | null) {
    return doc(getTasksCollectionForSpace(spaceId), id)
  }

  function getListSpaceId(listId?: string | null) {
    if (!listId) {
      return useSpaceStore().currentSpaceId
    }
    const listsStore = useListsStore()
    return listsStore.lists.find((list) => list.id === listId)?.spaceId ?? useSpaceStore().currentSpaceId
  }

  function getTaskVisibilityConstraint() {
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user || spaceStore.useLegacyPath) return null
    if (spaceStore.currentSpaceId?.startsWith('personal_')) return null
    return where('visibleToMemberIds', 'array-contains', authStore.user.uid)
  }

  function isActiveTask(task: Task): boolean {
    return task.deleted !== true
  }


  // リストのタスクを取得（getDocs版 - リアルタイム監視なし）
  async function fetchListTasks(listId: string, forceRefresh = false) {
    const authStore = useAuthStore()
    if (!authStore.user) return
    const targetSpaceId = getListSpaceId(listId)

    // キャッシュがあり、強制更新でない場合はキャッシュから表示
    const cachedTasks = tasksByList.get(listId)
    if (cachedTasks && !forceRefresh) {
      tasks.value = cachedTasks
      loading.value = false
      // キャッシュから返した場合も初回ロード完了とする
      if (!isInitialLoadComplete.value) {
        isInitialLoadComplete.value = true
        lastFetchTime.value = Date.now()
      }
      return
    }

    loading.value = true
    try {
      // 未完了タスクのみを取得（完了タスクは遅延読み込み）
      const constraints = [
        where('listId', '==', listId),
        where('completed', '==', false),
        orderBy('dateCreated', 'desc'),
      ]
      const visibilityConstraint = getTaskVisibilityConstraint()
      if (visibilityConstraint) {
        constraints.unshift(visibilityConstraint)
      }
      const q = query(getTasksCollectionForSpace(targetSpaceId), ...constraints)

      let snapshot
      // 強制更新でない場合はキャッシュ優先（読み取り課金削減）
      if (!forceRefresh) {
        try {
          snapshot = await getDocsFromCache(q)
          // 新規環境やiOS等でIndexedDBが消失すると0件が返るため、サーバーから再取得
          if (snapshot.docs.length === 0) {
            console.log('[tasks] fetchListTasks: cache returned 0, falling back to server')
            snapshot = await getDocs(q)
            console.log('[tasks] fetchListTasks:', snapshot.docs.length, 'from SERVER (cache empty)')
          } else {
            console.log('[tasks] fetchListTasks:', snapshot.docs.length, 'from CACHE')
          }
        } catch (cacheError) {
          // キャッシュにない場合はサーバーから取得
          console.log('[tasks] getDocsFromCache failed:', (cacheError as Error).message)
          snapshot = await getDocs(q)
          console.log('[tasks] fetchListTasks:', snapshot.docs.length, 'from SERVER')
        }
      } else {
        snapshot = await getDocs(q)
        console.log('[tasks] fetchListTasks:', snapshot.docs.length, 'from SERVER (force)')
      }
      const listTasks = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Task[]

      // このリストの完了タスク（既に読み込み済みのもの）を取得
      const existingCompleted = (tasksByList.get(listId) || []).filter((t) => t.completed)
      const combinedTasks = [...listTasks, ...existingCompleted]

      // リストごとのキャッシュを更新
      tasksByList.set(listId, combinedTasks)

      // 現在表示中のリストなら表示を更新
      if (currentListId === listId) {
        tasks.value = combinedTasks
      }

      // 検索用キャッシュにも追加（重複を避けて）
      const existingIds = new Set(allTasksCache.value.map((t) => t.id))
      listTasks.forEach((task) => {
        if (!existingIds.has(task.id)) {
          allTasksCache.value.push(task)
        } else {
          const index = allTasksCache.value.findIndex((t) => t.id === task.id)
          if (index !== -1) {
            allTasksCache.value[index] = task
          }
        }
      })

      // 最終取得時刻を更新
      lastFetchTime.value = Date.now()
      // 初回ロード完了
      isInitialLoadComplete.value = true
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  // 特定のリストをonSnapshotでリアルタイム監視
  function subscribeToList(listId: string | null) {
    const authStore = useAuthStore()
    if (!authStore.user) return

    // 既存のリスナーを解除
    if (currentUnsubscribe) {
      currentUnsubscribe()
      currentUnsubscribe = null
    }

    currentListId = listId

    // リスト切り替え時にloadingフラグをリセット
    completedTasksLoading.value = false

    // リストが選択されていない場合は空にする
    if (!listId) {
      tasks.value = []
      loading.value = false
      return
    }

    // キャッシュがあれば即座に表示（ローディング不要）
    // onSnapshotは常に設定してリアルタイム同期を維持する
    const cachedTasks = tasksByList.get(listId)
    if (cachedTasks) {
      tasks.value = cachedTasks
      loading.value = false
    } else {
      loading.value = true
    }

    const constraints = [
      where('listId', '==', listId),
      where('completed', '==', false),
      orderBy('dateCreated', 'desc'),
    ]
    const visibilityConstraint = getTaskVisibilityConstraint()
    if (visibilityConstraint) {
      constraints.unshift(visibilityConstraint)
    }
    const targetSpaceId = getListSpaceId(listId)
    const q = query(getTasksCollectionForSpace(targetSpaceId), ...constraints)

    currentUnsubscribe = onSnapshot(
      q,
      (snapshot) => {
        console.log('[tasks] onSnapshot: received', snapshot.docChanges().length, 'changes for list', listId)

        // 初回読み込みの場合は全件処理
        if (snapshot.docChanges().length === snapshot.docs.length) {
          const listTasks = snapshot.docs.map((d) => ({
            id: d.id,
            ...d.data(),
          })).filter((task) => isActiveTask(task as Task)) as Task[]

          // このリストの完了タスク（既に読み込み済みのもの）を取得
          const existingCompleted = (tasksByList.get(listId) || []).filter((t) => t.completed)
          const combinedTasks = [...listTasks, ...existingCompleted]

          // リストごとのキャッシュを更新
          tasksByList.set(listId, combinedTasks)

          // 現在表示中のリストなら表示を更新
          if (currentListId === listId) {
            tasks.value = combinedTasks
          }

          // 検索用キャッシュにも追加（重複を避けて）
          const existingIds = new Set(allTasksCache.value.map((t) => t.id))
          listTasks.forEach((task) => {
            if (!existingIds.has(task.id)) {
              allTasksCache.value.push(task)
            } else {
              const index = allTasksCache.value.findIndex((t) => t.id === task.id)
              if (index !== -1) {
                allTasksCache.value[index] = task
              }
            }
          })

          console.log('[tasks] onSnapshot: initial load,', listTasks.length, 'incomplete tasks')
        } else {
          // 差分更新の場合は変更分のみ処理
          snapshot.docChanges().forEach((change) => {
            // ローカル書き込み（hasPendingWrites=true）はスキップ
            // updateTask()で既にローカル更新済みなので、サーバー確認後のみ処理
            if (change.doc.metadata.hasPendingWrites) {
              console.log('[tasks] onSnapshot: skipping pending write for', change.doc.id)
              return
            }

            const task = { id: change.doc.id, ...change.doc.data() } as Task

            if (change.type === 'added') {
              if (!isActiveTask(task)) {
                return
              }
              // 追加
              const cached = tasksByList.get(listId) || []
              if (!cached.some((t) => t.id === task.id)) {
                tasksByList.set(listId, [task, ...cached])
                if (currentListId === listId) {
                  tasks.value = [task, ...tasks.value]
                }
              }
              // 検索キャッシュにも追加
              if (!allTasksCache.value.some((t) => t.id === task.id)) {
                allTasksCache.value.push(task)
              }
              console.log('[tasks] onSnapshot: added task', task.id)
            } else if (change.type === 'modified') {
              if (!isActiveTask(task)) {
                const removeFromList = (list: Task[]) => list.filter((t) => t.id !== task.id)
                const cached = tasksByList.get(listId)
                if (cached) {
                  tasksByList.set(listId, removeFromList(cached))
                }
                if (currentListId === listId) {
                  tasks.value = removeFromList(tasks.value)
                }
                allTasksCache.value = removeFromList(allTasksCache.value)
                return
              }
              // 更新
              const updateInList = (list: Task[]) => {
                const index = list.findIndex((t) => t.id === task.id)
                if (index !== -1) {
                  list[index] = task
                }
              }
              const cached = tasksByList.get(listId)
              if (cached) {
                updateInList(cached)
              }
              if (currentListId === listId) {
                updateInList(tasks.value)
              }
              updateInList(allTasksCache.value)
              console.log('[tasks] onSnapshot: modified task', task.id, 'metadata:', change.doc.metadata)
            } else if (change.type === 'removed') {
              // 削除
              const removeFromList = (list: Task[]) => list.filter((t) => t.id !== task.id)
              const cached = tasksByList.get(listId)
              if (cached) {
                tasksByList.set(listId, removeFromList(cached))
              }
              if (currentListId === listId) {
                tasks.value = removeFromList(tasks.value)
              }
              allTasksCache.value = removeFromList(allTasksCache.value)
              console.log('[tasks] onSnapshot: removed task', task.id)
            }
          })
        }

        // 最終取得時刻を更新
        lastFetchTime.value = Date.now()
        isInitialLoadComplete.value = true
        loading.value = false
      },
      (err) => {
        console.error('[tasks] onSnapshot error:', err)
        error.value = err.message
        loading.value = false
      }
    )
  }

  // 完了タスクを遅延読み込み（ユーザーが「完了済み」を展開した時に呼び出す）
  async function loadCompletedTasks(listId?: string, forceRefresh = false) {
    const targetListId = listId || currentListId
    if (!targetListId) return
    const targetSpaceId = getListSpaceId(targetListId)

    // 既に読み込み済みなら何もしない
    if (!forceRefresh && completedTasksLoaded.value.has(targetListId)) {
      return
    }

    completedTasksLoading.value = true
    try {
      // Phase 4: limit(100)から20に削減（段階的読み込み）
      const constraints = [
        where('listId', '==', targetListId),
        where('completed', '==', true),
        orderBy('dateCompleted', 'desc'),
        limit(20),
      ]
      const visibilityConstraint = getTaskVisibilityConstraint()
      if (visibilityConstraint) {
        constraints.unshift(visibilityConstraint)
      }
      const q = query(getTasksCollectionForSpace(targetSpaceId), ...constraints)
      let snapshot
      if (forceRefresh) {
        snapshot = await getDocs(q)
        console.log('[tasks] loadCompleted:', snapshot.docs.length, 'from SERVER (force)')
      } else {
        // キャッシュ優先で取得（読み取り課金削減）
        try {
          snapshot = await getDocsFromCache(q)
          // 新規環境やiOS等でIndexedDBが消失すると0件が返るため、サーバーから再取得
          if (snapshot.docs.length === 0) {
            console.log('[tasks] loadCompleted: cache returned 0, falling back to server')
            snapshot = await getDocs(q)
            console.log('[tasks] loadCompleted:', snapshot.docs.length, 'from SERVER (cache empty)')
          } else {
            console.log('[tasks] loadCompleted:', snapshot.docs.length, 'from CACHE')
          }
        } catch {
          snapshot = await getDocs(q)
          console.log('[tasks] loadCompleted:', snapshot.docs.length, 'from SERVER')
        }
      }
      const completedList = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })).filter((task) => isActiveTask(task as Task)) as Task[]

      // Phase 4: カーソルを保存（次回の読み込み用）
      // 20件未満なら全件取得済みなのでカーソル不要（無駄なクエリ防止）
      if (snapshot.docs.length >= 20) {
        const lastDoc = snapshot.docs[snapshot.docs.length - 1]!
        completedTasksCursors.set(targetListId, lastDoc)
      } else {
        completedTasksCursors.delete(targetListId)
      }

      const replaceCompletedTasks = (taskList: Task[]) => [
        ...taskList.filter((task) => !(task.listId === targetListId && task.completed)),
        ...completedList,
      ]

      tasks.value = replaceCompletedTasks(tasks.value)
      tasksByList.set(targetListId, replaceCompletedTasks(tasksByList.get(targetListId) || []))
      allTasksCache.value = replaceCompletedTasks(allTasksCache.value)

      completedTasksLoaded.value.add(targetListId)
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      completedTasksLoading.value = false
    }
  }

  // Phase 4: 完了タスクの追加読み込み（ページネーション）
  async function loadMoreCompletedTasks() {
    const targetListId = currentListId || useListsStore().selectedListId
    if (!targetListId) return
    const targetSpaceId = getListSpaceId(targetListId)

    // カーソルがない場合は何もしない（これ以上読み込むものがない）
    const cursor = completedTasksCursors.get(targetListId)
    if (!cursor) {
      console.log('[tasks] loadMoreCompleted: no cursor, all tasks loaded')
      return
    }

    if (completedTasksLoading.value) return
    completedTasksLoading.value = true
    error.value = null

    try {
      const constraints = [
        where('listId', '==', targetListId),
        where('completed', '==', true),
        orderBy('dateCompleted', 'desc'),
        startAfter(cursor),
        limit(20),
      ]
      const visibilityConstraint = getTaskVisibilityConstraint()
      if (visibilityConstraint) {
        constraints.unshift(visibilityConstraint)
      }
      const q = query(getTasksCollectionForSpace(targetSpaceId), ...constraints)

      let snapshot
      try {
        snapshot = await getDocsFromCache(q)
        if (snapshot.docs.length === 0) {
          snapshot = await getDocs(q)
          console.log('[tasks] loadMoreCompleted:', snapshot.docs.length, 'from SERVER (cache empty)')
        } else {
          console.log('[tasks] loadMoreCompleted:', snapshot.docs.length, 'from CACHE')
        }
      } catch {
        snapshot = await getDocs(q)
        console.log('[tasks] loadMoreCompleted:', snapshot.docs.length, 'from SERVER')
      }

      const completedList = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })).filter((task) => isActiveTask(task as Task)) as Task[]

      // カーソルを更新（次回の読み込み用）
      // 20件未満の場合はこれ以上読み込むものがないのでカーソルを削除
      if (snapshot.docs.length > 0) {
        if (snapshot.docs.length < 20) {
          completedTasksCursors.delete(targetListId)
          console.log('[tasks] loadMoreCompleted: reached end, cursor deleted')
        } else {
          const lastDoc = snapshot.docs[snapshot.docs.length - 1]!
          completedTasksCursors.set(targetListId, lastDoc)
        }
      } else {
        // 0件の場合もカーソルを削除
        completedTasksCursors.delete(targetListId)
      }

      // tasksに追加（重複を避けて）
      const existingIds = new Set(tasks.value.map((t) => t.id))
      const newTasks = completedList.filter((t) => !existingIds.has(t.id))
      tasks.value = [...tasks.value, ...newTasks]

      // リストごとのキャッシュにも追加
      const currentCached = tasksByList.get(targetListId) || []
      const cachedIds = new Set(currentCached.map((t) => t.id))
      const newCachedTasks = completedList.filter((t) => !cachedIds.has(t.id))
      tasksByList.set(targetListId, [...currentCached, ...newCachedTasks])

      // 検索用キャッシュにも追加
      const cacheIds = new Set(allTasksCache.value.map((t) => t.id))
      completedList.forEach((task) => {
        if (!cacheIds.has(task.id)) {
          allTasksCache.value.push(task)
        }
      })
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      completedTasksLoading.value = false
    }
  }

  // 強制再取得（フォアグラウンド復帰時などに使用）
  async function forceRefresh() {
    if (!currentListId) return
    await fetchListTasks(currentListId, true)
  }

  // 再取得が必要かどうかをチェック（5分以上経過していれば再取得）
  // 初回ロード完了前はfalseを返す（二重取得防止）
  function shouldRefresh(): boolean {
    if (!isInitialLoadComplete.value) return false
    const now = Date.now()
    return now - lastFetchTime.value > REFRESH_THRESHOLD_MS
  }

  function subscribe() {
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user) return
    void spaceStore.initSpace()

    // E2Eテスト用のモックタスクチェック
    const mockTasksData = localStorage.getItem('mock-tasks-data')
    if (mockTasksData) {
      try {
        const parsed = JSON.parse(mockTasksData)
        if (Array.isArray(parsed)) {
          tasks.value = parsed
          allTasksCache.value = parsed
          loading.value = false
          return
        }
      } catch {
        // モック状態のパースに失敗した場合は通常のFirestoreへ
      }
    }

    // 初期状態では選択中のリストがあればそれを購読
    const listsStore = useListsStore()
    if (listsStore.selectedListId) {
      console.log('[tasks] subscribe: subscribing to list', listsStore.selectedListId)
      subscribeToList(listsStore.selectedListId)
    }
  }

  function unsubscribe() {
    // onSnapshotリスナーを解除
    if (currentUnsubscribe) {
      currentUnsubscribe()
      currentUnsubscribe = null
    }
    tasksByList.clear()
    tasks.value = []
    allTasksCache.value = []
    selectedTaskId.value = null
    currentListId = null
    completedTasksLoaded.value.clear()
    completedTasksCursors.clear() // Phase 4: カーソルもクリア（セキュリティ対策）
    incompleteCacheLoaded = false
    completedCacheLoaded = false
    searchCacheLoading.value = false
    // ログアウト時はlocalStorageの検索キャッシュフラグもクリア
    clearSearchCacheFlags()
    // 初回ロードフラグをリセット（再ログイン用）
    isInitialLoadComplete.value = false
    lastFetchTime.value = 0
  }

  async function createTask(input: Partial<CreateTaskInput> & { name: string }) {
    const listsStore = useListsStore()
    const { showError } = useToast()
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user) throw new Error('認証が必要です')
    const nowTimestamp = Timestamp.now()
    const listId = input.listId || listsStore.selectedListId || ''
    const targetList = listsStore.lists.find((list) => list.id === listId)
    const targetSpaceId = input.spaceId ?? targetList?.spaceId ?? spaceStore.currentSpaceId
    const visibleToMemberIds = targetList?.visibleToMemberIds?.length
      ? [...targetList.visibleToMemberIds]
      : [authStore.user.uid]
    const editableByMemberIds = targetList?.editableByMemberIds?.length
      ? [...targetList.editableByMemberIds]
      : [authStore.user.uid]

    // IDを事前生成
    const docRef = doc(spaceStore.getCollectionRefForSpace('tasks', targetSpaceId))

    const taskData = {
      name: input.name,
      listId,
      parentId: input.parentId || null,
      priority: input.priority || 4,
      tags: input.tags || [],
      dueDate: input.dueDate || null,
      startDate: input.startDate || null,
      repeat: input.repeat || null,
      notes: input.notes || [],
      url: input.url || null,
      completed: false,
      dateCompleted: null,
      deleted: false,
      spaceId: targetSpaceId ?? undefined,
      visibleToMemberIds,
      editableByMemberIds,
      allDay: input.allDay ?? false,
      addToCalendar: input.addToCalendar ?? false,
      calendarEventId: null,
      dateCreated: serverTimestamp(),
      dateModified: serverTimestamp(),
    }

    const newTask: Task = {
      id: docRef.id,
      name: input.name,
      listId,
      parentId: input.parentId || null,
      priority: input.priority || 4,
      tags: input.tags || [],
      dueDate: input.dueDate || null,
      startDate: input.startDate || null,
      repeat: input.repeat || null,
      notes: input.notes || [],
      url: input.url || null,
      completed: false,
      dateCompleted: null,
      deleted: false,
      spaceId: targetSpaceId ?? undefined,
      visibleToMemberIds,
      editableByMemberIds,
      allDay: taskData.allDay,
      addToCalendar: taskData.addToCalendar,
      calendarEventId: null,
      dateCreated: nowTimestamp,
      dateModified: nowTimestamp,
    }

    // UIに即座に反映（optimistic update）
    const isCurrentScopeTarget = targetSpaceId === spaceStore.currentSpaceId
      || (spaceStore.useLegacyPath && (!targetSpaceId || targetSpaceId === spaceStore.currentSpaceId))

    if (isCurrentScopeTarget && listId === currentListId) {
      tasks.value = [newTask, ...tasks.value]
    }
    if (isCurrentScopeTarget) {
      const cached = tasksByList.get(listId) || []
      tasksByList.set(listId, [newTask, ...cached])
      allTasksCache.value = [newTask, ...allTasksCache.value]
    }

    // バックグラウンドでFirestoreに書き込み（リトライあり）
    retryWithBackoff(() => setDoc(docRef, taskData)).catch(() => {
      // 全リトライ失敗: ロールバック
      tasks.value = tasks.value.filter((t) => t.id !== docRef.id)
      if (isCurrentScopeTarget) {
        const cachedAfter = tasksByList.get(listId) || []
        tasksByList.set(listId, cachedAfter.filter((t) => t.id !== docRef.id))
        allTasksCache.value = allTasksCache.value.filter((t) => t.id !== docRef.id)
      }
      showError('タスクの追加に失敗しました')
    })

    return docRef.id
  }

  async function updateTask(id: string, input: UpdateTaskInput) {
    // カレンダー更新はCloud Functionsのトリガーが担当するため不要

    const existingTask = tasks.value.find((t) => t.id === id) || allTasksCache.value.find((t) => t.id === id)
    const docRef = getTaskDocRef(id, existingTask?.spaceId)
    await updateDoc(docRef, {
      ...input,
      dateModified: serverTimestamp(),
    })

    // ローカルstateを更新
    const nowTimestamp = Timestamp.now()
    const updateLocalTask = (taskList: Task[]) => {
      const index = taskList.findIndex((t) => t.id === id)
      const existing = taskList[index]
      if (index !== -1 && existing) {
        taskList[index] = {
          id: existing.id,
          name: input.name ?? existing.name,
          listId: input.listId ?? existing.listId,
          parentId: input.parentId !== undefined ? input.parentId : existing.parentId,
          priority: input.priority ?? existing.priority,
          tags: input.tags ?? existing.tags,
          dueDate: input.dueDate !== undefined ? input.dueDate : existing.dueDate,
          startDate: input.startDate !== undefined ? input.startDate : existing.startDate,
          repeat: input.repeat !== undefined ? input.repeat : existing.repeat,
          notes: input.notes ?? existing.notes,
          url: input.url !== undefined ? input.url : existing.url,
          completed: existing.completed,
          dateCompleted: existing.dateCompleted,
          dateCreated: existing.dateCreated,
          dateModified: nowTimestamp,
          allDay: input.allDay !== undefined ? input.allDay : existing.allDay,
          addToCalendar: input.addToCalendar !== undefined ? input.addToCalendar : existing.addToCalendar,
          calendarEventId: input.calendarEventId !== undefined ? input.calendarEventId : existing.calendarEventId,
        }
      }
    }

    // tasks.valueを更新
    const taskIndex = tasks.value.findIndex((t) => t.id === id)
    if (taskIndex !== -1) {
      tasks.value = tasks.value.map((t) => {
        if (t.id === id) {
          return {
            id: t.id,
            name: input.name ?? t.name,
            listId: input.listId ?? t.listId,
            parentId: input.parentId !== undefined ? input.parentId : t.parentId,
            priority: input.priority ?? t.priority,
            tags: input.tags ?? t.tags,
            dueDate: input.dueDate !== undefined ? input.dueDate : t.dueDate,
            startDate: input.startDate !== undefined ? input.startDate : t.startDate,
            repeat: input.repeat !== undefined ? input.repeat : t.repeat,
            notes: input.notes ?? t.notes,
            url: input.url !== undefined ? input.url : t.url,
            completed: t.completed,
            dateCompleted: t.dateCompleted,
            dateCreated: t.dateCreated,
            dateModified: nowTimestamp,
            allDay: input.allDay !== undefined ? input.allDay : t.allDay,
            addToCalendar: input.addToCalendar !== undefined ? input.addToCalendar : t.addToCalendar,
            calendarEventId: input.calendarEventId !== undefined ? input.calendarEventId : t.calendarEventId,
          }
        }
        return t
      })
    }

    // リストごとのキャッシュを更新
    tasksByList.forEach((cachedTasks) => updateLocalTask(cachedTasks))

    // 検索用キャッシュを更新
    updateLocalTask(allTasksCache.value)
  }

  async function toggleComplete(id: string) {
    const task = tasks.value.find((t) => t.id === id)
    if (!task) return

    const newCompleted = !task.completed
    const nowTimestamp = Timestamp.now()

    const docRef = getTaskDocRef(id, task.spaceId)
    await updateDoc(docRef, {
      completed: newCompleted,
      dateCompleted: newCompleted ? nowTimestamp : null,
      dateModified: serverTimestamp(),
    })

    // ローカルstateを更新
    const updateLocalTask = (taskList: Task[]) => {
      const index = taskList.findIndex((t) => t.id === id)
      const existing = taskList[index]
      if (index !== -1 && existing) {
        taskList[index] = {
          id: existing.id,
          name: existing.name,
          listId: existing.listId,
          parentId: existing.parentId,
          priority: existing.priority,
          tags: existing.tags,
          dueDate: existing.dueDate,
          startDate: existing.startDate,
          repeat: existing.repeat,
          notes: existing.notes,
          url: existing.url,
          completed: newCompleted,
          dateCompleted: newCompleted ? nowTimestamp : null,
          dateCreated: existing.dateCreated,
          dateModified: nowTimestamp,
          allDay: existing.allDay,
          addToCalendar: existing.addToCalendar,
          calendarEventId: existing.calendarEventId,
        }
      }
    }

    // tasks.valueを更新
    tasks.value = tasks.value.map((t) => {
      if (t.id === id) {
        return {
          id: t.id,
          name: t.name,
          listId: t.listId,
          parentId: t.parentId,
          priority: t.priority,
          tags: t.tags,
          dueDate: t.dueDate,
          startDate: t.startDate,
          repeat: t.repeat,
          notes: t.notes,
          url: t.url,
          completed: newCompleted,
          dateCompleted: newCompleted ? nowTimestamp : null,
          dateCreated: t.dateCreated,
          dateModified: nowTimestamp,
          allDay: t.allDay,
          addToCalendar: t.addToCalendar,
          calendarEventId: t.calendarEventId,
        }
      }
      return t
    })

    // リストごとのキャッシュを更新
    tasksByList.forEach((cachedTasks) => updateLocalTask(cachedTasks))

    // 検索用キャッシュを更新
    updateLocalTask(allTasksCache.value)
  }

  function collectDeletionTasks(initialTasks: Task[], sourceTasks: Task[]): Task[] {
    const deleteMap = new Map(initialTasks.map((task) => [task.id, task]))

    for (const task of sourceTasks) {
      if (task.parentId && deleteMap.has(task.parentId)) {
        deleteMap.set(task.id, task)
      }
    }

    return [...deleteMap.values()]
  }

  function removeDeletedTasksFromLocalState(deleteSet: Set<string>, listId?: string) {
    tasks.value = tasks.value.filter((t) => !deleteSet.has(t.id))
    allTasksCache.value = allTasksCache.value.filter((t) => !deleteSet.has(t.id))

    if (listId) {
      const cached = tasksByList.get(listId)
      if (cached) {
        tasksByList.set(listId, cached.filter((t) => !deleteSet.has(t.id)))
      }
    } else {
      tasksByList.forEach((cachedTasks, key) => {
        tasksByList.set(key, cachedTasks.filter((t) => !deleteSet.has(t.id)))
      })
    }

    if (selectedTaskId.value && deleteSet.has(selectedTaskId.value)) {
      selectedTaskId.value = null
    }
  }

  async function logicallyDeleteTasks(tasksToDelete: Task[], listId?: string) {
    const deletedIds: string[] = []
    const failedIds: string[] = []

    for (const task of tasksToDelete) {
      const docRef = getTaskDocRef(task.id, task.spaceId)
      try {
        await updateDoc(docRef, {
          deleted: true,
          dateModified: serverTimestamp(),
        })
        deletedIds.push(task.id)
      } catch (err) {
        console.log('[tasks] logicallyDeleteTasks: update error', (err as Error).message)
        failedIds.push(task.id)
      }
    }

    if (deletedIds.length > 0) {
      removeDeletedTasksFromLocalState(new Set(deletedIds), listId)
    }

    if (failedIds.length > 0) {
      throw new Error('タスクの削除に失敗しました')
    }
  }

  async function deleteTask(id: string) {
    const task = tasks.value.find((t) => t.id === id)
    if (!task) return
    // カレンダー削除はCloud FunctionsのonTaskDeletedトリガーが担当するため不要

    // サブタスクを収集（親タスク削除時に連鎖削除するため）
    const tasksToDelete = collectDeletionTasks([task], tasks.value)
    await logicallyDeleteTasks(tasksToDelete, task.listId)
  }

  async function deleteCompletedTasksInCurrentList() {
    const targetListId = currentListId || useListsStore().selectedListId
    if (!targetListId) return 0
    const targetSpaceId = getListSpaceId(targetListId)

    const constraints = [
      where('listId', '==', targetListId),
      where('completed', '==', true),
      orderBy('dateCompleted', 'desc'),
    ]
    const visibilityConstraint = getTaskVisibilityConstraint()
    if (visibilityConstraint) {
      constraints.unshift(visibilityConstraint)
    }

    const q = query(getTasksCollectionForSpace(targetSpaceId), ...constraints)
    const snapshot = await getDocs(q)
    const completedTasksInList = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    })).filter((task) => isActiveTask(task as Task)) as Task[]

    if (completedTasksInList.length === 0) {
      return 0
    }

    const sourceTasks = [...tasks.value]
    completedTasksInList.forEach((task) => {
      if (!sourceTasks.some((existing) => existing.id === task.id)) {
        sourceTasks.push(task)
      }
    })

    const tasksToDelete = collectDeletionTasks(
      completedTasksInList,
      sourceTasks
    )

    await logicallyDeleteTasks(tasksToDelete, targetListId)
    completedTasksLoaded.value.delete(targetListId)
    completedTasksCursors.delete(targetListId)

    return completedTasksInList.length
  }

  function selectTask(id: string | null) {
    selectedTaskId.value = id
  }

  // 全タスクキャッシュ読み込み済みフラグ（検索用・メモリ上）
  let incompleteCacheLoaded = false
  let completedCacheLoaded = false
  const searchCacheLoading = ref(false)

  // localStorage永続化キー（IndexedDBに全タスクが保存済みかどうか）
  const SEARCH_CACHE_KEY_INCOMPLETE = 'rertm-search-cache-incomplete'
  const SEARCH_CACHE_KEY_COMPLETED = 'rertm-search-cache-completed'

  function getSearchCacheKey(suffix: string): string {
    const spaceStore = useSpaceStore()
    return spaceStore.getScopedStorageKey(suffix)
  }

  function markSearchCacheBuilt(key: string) {
    localStorage.setItem(getSearchCacheKey(key), '1')
  }

  function clearSearchCacheFlags() {
    localStorage.removeItem(getSearchCacheKey(SEARCH_CACHE_KEY_INCOMPLETE))
    localStorage.removeItem(getSearchCacheKey(SEARCH_CACHE_KEY_COMPLETED))
  }

  // 検索用タスクキャッシュを読み込む（Phase 5: リスナーキャッシュを活用）
  // リスナーで既に取得済みのタスクを優先利用し、不足分のみサーバーから取得
  async function loadAllTasksForSearch(includeCompleted: boolean) {
    // 未完了タスクが未読み込みなら取得
    if (!incompleteCacheLoaded) {
      searchCacheLoading.value = true
      try {
        const listsStore = useListsStore()
        const allLists = listsStore.lists

        // Phase 5: リスナーで既に取得済みのタスクを検索キャッシュに追加
        const tasksFromListeners: Task[] = []
        const listIdsWithListener: string[] = []

        tasksByList.forEach((tasks, listId) => {
          // 未完了タスクのみ抽出
          const incompleteTasks = tasks.filter((t) => !t.completed)
          tasksFromListeners.push(...incompleteTasks)
          listIdsWithListener.push(listId)
        })

        console.log('[tasks] loadAllTasksForSearch: got', tasksFromListeners.length, 'incomplete tasks from listeners')

        // リスナーがないリストIDを特定
        const listIdsWithoutListener = allLists
          .map((list) => list.id)
          .filter((id) => !listIdsWithListener.includes(id))

        // リスナーがないリストのタスクのみサーバーから取得
        let additionalTasks: Task[] = []
        if (listIdsWithoutListener.length > 0) {
          // in演算子は最大10個まで、それ以上は分割して取得
          const chunks = []
          for (let i = 0; i < listIdsWithoutListener.length; i += 10) {
            chunks.push(listIdsWithoutListener.slice(i, i + 10))
          }

          for (const chunk of chunks) {
            const constraints = [
              where('listId', 'in', chunk),
              where('completed', '==', false),
            ]
            const visibilityConstraint = getTaskVisibilityConstraint()
            if (visibilityConstraint) {
              constraints.unshift(visibilityConstraint)
            }
            const q = query(getTasksCollection(), ...constraints)
            const snapshot = await getDocs(q)
            const tasks = snapshot.docs.map((d) => ({
              id: d.id,
              ...d.data(),
            })).filter((task) => isActiveTask(task as Task)) as Task[]
            additionalTasks.push(...tasks)
          }
          console.log('[tasks] loadAllTasksForSearch: got', additionalTasks.length, 'additional incomplete tasks from server')
        }

        // リスナーキャッシュ + 追加取得を統合
        allTasksCache.value = [...tasksFromListeners, ...additionalTasks]
        markSearchCacheBuilt(SEARCH_CACHE_KEY_INCOMPLETE)
        incompleteCacheLoaded = true
      } catch (e) {
        console.error('[tasks] loadAllTasksForSearch error:', e)
        searchCacheLoading.value = false
        return
      }
    }

    // 完了済みも含む場合、まだ読み込んでいなければ追加取得
    if (includeCompleted && !completedCacheLoaded) {
      searchCacheLoading.value = true
      try {
        const listsStore = useListsStore()
        const allLists = listsStore.lists

        // Phase 5: リスナーで既に取得済みの完了タスクを検索キャッシュに追加
        const completedTasksFromListeners: Task[] = []
        const listIdsWithCompletedTasks: string[] = []

        tasksByList.forEach((tasks, listId) => {
          // 完了タスクのみ抽出
          const completed = tasks.filter((t) => t.completed)
          if (completed.length > 0) {
            completedTasksFromListeners.push(...completed)
            listIdsWithCompletedTasks.push(listId)
          }
        })

        console.log('[tasks] loadAllTasksForSearch: got', completedTasksFromListeners.length, 'completed tasks from listeners')

        // completedTasksLoadedに記録されているリストも取得済みとみなす
        const loadedListIds = [...listIdsWithCompletedTasks, ...Array.from(completedTasksLoaded.value)]
        const listIdsWithoutCompletedTasks = allLists
          .map((list) => list.id)
          .filter((id) => !loadedListIds.includes(id))

        // リスナーがないリストの完了タスクのみサーバーから取得
        let additionalCompletedTasks: Task[] = []
        if (listIdsWithoutCompletedTasks.length > 0) {
          // in演算子は最大10個まで、それ以上は分割して取得
          const chunks = []
          for (let i = 0; i < listIdsWithoutCompletedTasks.length; i += 10) {
            chunks.push(listIdsWithoutCompletedTasks.slice(i, i + 10))
          }

          for (const chunk of chunks) {
            const constraints = [
              where('listId', 'in', chunk),
              where('completed', '==', true),
            ]
            const visibilityConstraint = getTaskVisibilityConstraint()
            if (visibilityConstraint) {
              constraints.unshift(visibilityConstraint)
            }
            const q = query(getTasksCollection(), ...constraints)
            const snapshot = await getDocs(q)
            const tasks = snapshot.docs.map((d) => ({
              id: d.id,
              ...d.data(),
            })).filter((task) => isActiveTask(task as Task)) as Task[]
            additionalCompletedTasks.push(...tasks)
          }
          console.log('[tasks] loadAllTasksForSearch: got', additionalCompletedTasks.length, 'additional completed tasks from server')
        }

        // 既存キャッシュに追加（重複なし）
        const existingIds = new Set(allTasksCache.value.map((t) => t.id))
        const newTasks = [
          ...completedTasksFromListeners.filter((t) => !existingIds.has(t.id)),
          ...additionalCompletedTasks.filter((t) => !existingIds.has(t.id)),
        ]
        if (newTasks.length > 0) {
          allTasksCache.value = [...allTasksCache.value, ...newTasks]
        }

        markSearchCacheBuilt(SEARCH_CACHE_KEY_COMPLETED)
        completedCacheLoaded = true
      } catch (e) {
        console.error('[tasks] loadCompletedForSearch error:', e)
      }
    }

    searchCacheLoading.value = false
  }

  function setSearchQuery(inputQuery: string) {
    searchQuery.value = inputQuery
    if (inputQuery.trim()) {
      const needLoad = !incompleteCacheLoaded || (searchIncludeCompleted.value && !completedCacheLoaded)
      if (needLoad) {
        loadAllTasksForSearch(searchIncludeCompleted.value)
      }
    }
  }

  function toggleSearchIncludeCompleted() {
    searchIncludeCompleted.value = !searchIncludeCompleted.value
    // 完了済み含むに切り替えた場合、まだ読み込んでいなければ取得
    if (searchIncludeCompleted.value && !completedCacheLoaded && searchQuery.value.trim()) {
      loadAllTasksForSearch(true)
    }
  }

  function clearSearch() {
    searchQuery.value = ''
  }

  function setTagFilter(tag: string | null) {
    selectedTag.value = tag
  }

  function clearTagFilter() {
    selectedTag.value = null
  }

  // スマートリストのタスクをCloud Functionsから読み込む
  async function loadSmartListTasks(smartListType: string) {
    smartListTasksLoading.value = true
    currentSmartListType.value = smartListType

    try {
      const result = await getSmartListTasks(
        smartListType as 'today' | 'tomorrow' | 'overdue' | 'thisWeek' | 'noDate'
      )

      // SmartListTaskをTaskに変換
      const convertedTasks: Task[] = result.tasks.map((t: SmartListTask) => ({
        id: t.id,
        name: t.name,
        listId: t.listId,
        parentId: null,
        priority: (t.priority as 1 | 2 | 3 | 4),
        tags: t.tags,
        dueDate: t.dueDate ? Timestamp.fromDate(new Date(t.dueDate)) : null,
        startDate: null,
        repeat: null,
        notes: [] as string[],
        url: null,
        completed: false,
        dateCompleted: null,
        dateCreated: Timestamp.now(),
        dateModified: Timestamp.now(),
        allDay: false,
        addToCalendar: false,
        calendarEventId: null,
      }))

      tasks.value = convertedTasks
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      smartListTasksLoading.value = false
    }
  }

  // サーバー側検索を実行
  async function searchTasksServer(queryText: string) {
    if (!queryText.trim()) {
      serverSearchResults.value = []
      return
    }

    serverSearchLoading.value = true
    try {
      const result = await searchTasksApi(queryText, { includeCompleted: false })
      serverSearchResults.value = result.results
    } catch (err) {
      error.value = (err as Error).message
      serverSearchResults.value = []
    } finally {
      serverSearchLoading.value = false
    }
  }

  return {
    tasks,
    selectedTaskId,
    selectedTask,
    filteredTasks,
    rootTasks,
    getSubtasks,
    getIncompleteSubtasks,
    hasSubtasks,
    getSubtaskCounts,
    incompleteTasks,
    completedTasks,
    completedTasksLoading,
    hasMoreCompletedTasks,
    loading,
    error,
    sortOrder,
    searchQuery,
    isSearching,
    searchResults,
    selectedTag,
    isTagFiltering,
    setTagFilter,
    clearTagFilter,
    subscribe,
    subscribeToList,
    loadCompletedTasks,
    loadMoreCompletedTasks,
    unsubscribe,
    createTask,
    updateTask,
    toggleComplete,
    deleteTask,
    deleteCompletedTasksInCurrentList,
    selectTask,
    setSortOrder,
    setSearchQuery,
    clearSearch,
    // スマートリスト用
    smartListTasksLoading,
    currentSmartListType,
    loadSmartListTasks,
    // 検索オプション
    searchIncludeCompleted,
    toggleSearchIncludeCompleted,
    searchCacheLoading,
    // サーバー側検索用
    serverSearchResults,
    serverSearchLoading,
    searchTasksServer,
    // スマート自動更新用
    forceRefresh,
    shouldRefresh,
    lastFetchTime,
  }
})
