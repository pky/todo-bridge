import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  where,
  writeBatch,
  Timestamp,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from '@/services/firebase'
import { refreshSmartListCounts } from '@/services/cloudFunctionsService'
import { useAuthStore } from './auth'
import { useSpaceStore } from './space'
import type { TaskList, Tag, CreateListInput, UpdateListInput } from '@/types'

// スマートリストカウント型
export interface SmartListCounts {
  today: number
  tomorrow: number
  overdue: number
  thisWeek: number
  noDate: number
  lastUpdated?: { toMillis: () => number } | null
}

export const useListsStore = defineStore('lists', () => {
  const lists = ref<TaskList[]>([])
  const tags = ref<Tag[]>([])
  const selectedListId = ref<string | null>(null)
  const selectedSmartList = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const smartListCounts = ref<SmartListCounts>({
    today: 0,
    tomorrow: 0,
    overdue: 0,
    thisWeek: 0,
    noDate: 0,
  })

  let listsLoaded = false
  let tagsLoaded = false
  let listsUnsubscribe: Unsubscribe | null = null
  let smartListCountsUnsubscribe: (() => void) | null = null

  const selectedList = computed(() =>
    lists.value.find((l) => l.id === selectedListId.value) || null
  )

  function normalizeMemberIds(memberIds: string[] | undefined, currentUserId: string): string[] {
    return [...new Set([currentUserId, ...(memberIds ?? [])])]
  }

  function getTaskVisibilityConstraint() {
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user || spaceStore.useLegacyPath) return null
    return where('visibleToMemberIds', 'array-contains', authStore.user.uid)
  }

  function getListsCollection() {
    const spaceStore = useSpaceStore()
    return spaceStore.getCollectionRef('lists')
  }

  function getTagsCollection() {
    const spaceStore = useSpaceStore()
    return spaceStore.getCollectionRef('tags')
  }

  function sortLists(rawLists: TaskList[]): TaskList[] {
    return rawLists.sort((a, b) => {
      const posA = a.position ?? Infinity
      const posB = b.position ?? Infinity
      if (posA !== posB) return posA - posB
      const dateA = a.dateCreated?.toMillis?.() ?? 0
      const dateB = b.dateCreated?.toMillis?.() ?? 0
      return dateA - dateB
    })
  }

  function updateListsState(rawLists: TaskList[]) {
    lists.value = sortLists(rawLists)
    listsLoaded = true

    if (selectedListId.value && !lists.value.some((list) => list.id === selectedListId.value)) {
      const inbox = lists.value.find((list) => list.name === 'Inbox')
      selectedListId.value = inbox?.id ?? lists.value[0]?.id ?? null
    }
  }

  function getSelectedListStorageKey() {
    const spaceStore = useSpaceStore()
    return spaceStore.getScopedStorageKey('rertm-selected-list-id')
  }

  // リストを1回取得（onSnapshotではなくgetDocsで読み取り削減）
  async function fetchLists() {
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user) return
    await spaceStore.initSpace()

    // 既に読み込み済みで、リストが存在する場合は何もしない（重複防止）
    // リストが空の場合は再取得を試みる（オフライン復帰時対策）
    if (listsLoaded && lists.value.length > 0) {
      return
    }

    // E2Eテスト用のモックリストチェック
    const mockListsData = localStorage.getItem('mock-lists-data')
    if (mockListsData) {
      try {
        const parsed = JSON.parse(mockListsData)
        if (Array.isArray(parsed)) {
          lists.value = parsed
          loading.value = false
          listsLoaded = true
          // 選択中のリストがなければ最初のリストを選択
          if (!selectedListId.value && parsed.length > 0) {
            selectedListId.value = parsed[0].id
          }
          return
        }
      } catch {
        // モック状態のパースに失敗した場合は通常のFirestoreへ
      }
    }

    loading.value = true
    try {
      // リストは少量データのため常にサーバーから取得（キャッシュ起因の問題を回避）
      const snapshot = spaceStore.useLegacyPath
        ? await getDocs(getListsCollection())
        : await getDocs(query(
            getListsCollection(),
            where('visibleToMemberIds', 'array-contains', authStore.user.uid)
          ))
      console.log('[lists] fetchLists:', snapshot.docs.length, 'from SERVER')
      const rawLists = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as TaskList[]

      updateListsState(rawLists)

      // Inboxの重複排除 (複数ある場合は1つにまとめる)
      const inboxes = lists.value.filter((l) => l.name === 'Inbox')
      if (inboxes.length > 1 && inboxes[0]) {
        console.log('[lists] Found multiple Inboxes, merging...')
        const primaryInbox = inboxes[0]
        const duplicateInboxes = inboxes.slice(1)
        
        const tasksCollection = spaceStore.getCollectionRef('tasks')
        const batch = writeBatch(db)
        let hasChanges = false
        
        for (const duplicate of duplicateInboxes) {
          const taskConstraints = [where('listId', '==', duplicate.id)]
          const visibilityConstraint = getTaskVisibilityConstraint()
          if (visibilityConstraint) {
            taskConstraints.unshift(visibilityConstraint)
          }
          const tasksQuery = query(tasksCollection, ...taskConstraints)
          const tasksSnapshot = await getDocs(tasksQuery)
          
          tasksSnapshot.docs.forEach((docSnap) => {
            batch.update(docSnap.ref, { listId: primaryInbox.id })
            hasChanges = true
          })
          
          const listRef = doc(getListsCollection(), duplicate.id)
          batch.delete(listRef)
          hasChanges = true
        }
        
        if (hasChanges) {
          await batch.commit()
        }
        
        const duplicateIds = duplicateInboxes.map(l => l.id)
        lists.value = lists.value.filter((l) => !duplicateIds.includes(l.id))
      } else if (inboxes.length === 0) {
        // Inboxがなければ作成
        await createList({ name: 'Inbox' })
      }

      // 選択中のリストを復元（ローカルストレージから）
      if (!selectedListId.value) {
        const savedListId = localStorage.getItem(getSelectedListStorageKey())
        if (savedListId && lists.value.some((l) => l.id === savedListId)) {
          selectedListId.value = savedListId
        } else {
          const inbox = lists.value.find((l) => l.name === 'Inbox')
          if (inbox) selectedListId.value = inbox.id
        }
      }
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  function subscribeToLists() {
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user) return

    if (listsUnsubscribe) {
      listsUnsubscribe()
      listsUnsubscribe = null
    }

    const targetQuery = spaceStore.useLegacyPath
      ? getListsCollection()
      : query(
          getListsCollection(),
          where('visibleToMemberIds', 'array-contains', authStore.user.uid)
        )

    listsUnsubscribe = onSnapshot(
      targetQuery,
      (snapshot) => {
        const rawLists = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        })) as TaskList[]
        updateListsState(rawLists)
      },
      (err) => {
        console.error('[lists] subscribeToLists error:', err)
      }
    )
  }

  // スマートリストカウントを監視（ユーザードキュメントから取得）
  // タスクの同期はtasks.tsのonSnapshotで行うため、ここではカウントのみ監視
  function subscribeToSmartListCounts() {
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user) return

    // 既存リスナーがあれば解除（重複登録防止）
    if (smartListCountsUnsubscribe) {
      smartListCountsUnsubscribe()
      smartListCountsUnsubscribe = null
    }

    const targetDocRef = spaceStore.getSmartListCountsDocRef()

    smartListCountsUnsubscribe = onSnapshot(
      targetDocRef,
      (docSnapshot) => {
        if (docSnapshot.exists()) {
          const data = docSnapshot.data()
          if (data.smartListCounts) {
            smartListCounts.value = data.smartListCounts
          }
        }
      },
      (err) => {
        console.error('Smart list counts error:', err)
      }
    )
  }

  // タグを1回取得（onSnapshotではなくgetDocsで読み取り削減）
  async function fetchTags() {
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user) return
    await spaceStore.initSpace()

    // 既に読み込み済みなら何もしない（重複防止）
    // ただしタグが0件の場合は再取得を試みる
    if (tagsLoaded && tags.value.length > 0) {
      return
    }

    try {
      const q = spaceStore.useLegacyPath
        ? query(getTagsCollection(), orderBy('name', 'asc'))
        : query(
            getTagsCollection(),
            where('visibleToMemberIds', 'array-contains', authStore.user.uid)
          )
      // タグは少量データのため常にサーバーから取得
      const snapshot = await getDocs(q)
      console.log('[lists] fetchTags:', snapshot.docs.length, 'from SERVER')
      tags.value = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Tag[]
      tags.value = [...tags.value].sort((a, b) => a.name.localeCompare(b.name, 'ja'))
      tagsLoaded = true
    } catch (err) {
      error.value = (err as Error).message
    }
  }

  async function subscribe() {
    const spaceStore = useSpaceStore()
    await spaceStore.initSpace()
    await Promise.all([fetchLists(), fetchTags()])
    subscribeToLists()
    subscribeToSmartListCounts()
    try {
      const refreshedCounts = await refreshSmartListCounts()
      smartListCounts.value = {
        ...smartListCounts.value,
        ...refreshedCounts,
      }
    } catch (err) {
      console.error('Smart list counts refresh error:', err)
    }
  }

  function unsubscribe() {
    lists.value = []
    tags.value = []
    selectedListId.value = null
    selectedSmartList.value = null
    listsLoaded = false
    tagsLoaded = false
    if (smartListCountsUnsubscribe) {
      smartListCountsUnsubscribe()
      smartListCountsUnsubscribe = null
    }
    if (listsUnsubscribe) {
      listsUnsubscribe()
      listsUnsubscribe = null
    }
    smartListCounts.value = {
      today: 0,
      tomorrow: 0,
      overdue: 0,
      thisWeek: 0,
      noDate: 0,
    }
  }

  function selectSmartList(type: string | null) {
    selectedSmartList.value = type
    if (type) {
      selectedListId.value = null
    }
  }

  async function createList(input: CreateListInput) {
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user) throw new Error('認証が必要です')
    if (input.name === 'Inbox') {
      const existingInbox = lists.value.find((list) => list.name === 'Inbox')
      if (existingInbox) {
        return
      }
    }
    const targetSpaceId = input.spaceId ?? spaceStore.currentSpaceId
    const visibleToMemberIds = normalizeMemberIds(input.visibleToMemberIds, authStore.user.uid)
    const editableByMemberIds = [...visibleToMemberIds]
    const now = serverTimestamp()
    const maxPosition = lists.value.reduce((max, l) => Math.max(max, l.position ?? 0), 0)
    const docRef = await addDoc(spaceStore.getCollectionRefForSpace('lists', targetSpaceId), {
      name: input.name,
      position: maxPosition + 1,
      spaceId: targetSpaceId ?? undefined,
      visibleToMemberIds,
      editableByMemberIds,
      dateCreated: now,
      dateModified: now,
    })
    const currentScopeSpaceId = spaceStore.currentSpaceId
    const isCurrentScopeTarget = targetSpaceId === currentScopeSpaceId
      || (spaceStore.useLegacyPath && (!targetSpaceId || targetSpaceId === currentScopeSpaceId))
    if (isCurrentScopeTarget) {
      // 現在表示中スペースに作成した場合のみローカルstateに追加
      const newList: TaskList = {
        id: docRef.id,
        name: input.name,
        position: maxPosition + 1,
        spaceId: targetSpaceId ?? undefined,
        visibleToMemberIds,
        editableByMemberIds,
        dateCreated: Timestamp.now(),
        dateModified: Timestamp.now(),
      }
      lists.value = [...lists.value, newList].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    }
  }

  async function updateList(id: string, input: UpdateListInput) {
    const authStore = useAuthStore()
    if (!authStore.user) throw new Error('認証が必要です')

    const docRef = doc(getListsCollection(), id)
    const visibleToMemberIds = input.visibleToMemberIds
      ? normalizeMemberIds(input.visibleToMemberIds, authStore.user.uid)
      : undefined
    const editableByMemberIds = visibleToMemberIds ? [...visibleToMemberIds] : undefined
    await updateDoc(docRef, {
      ...input,
      visibleToMemberIds,
      editableByMemberIds,
      dateModified: serverTimestamp(),
    })
    // ローカルstateを更新
    lists.value = lists.value.map((l) =>
      l.id === id
        ? {
            ...l,
            name: input.name ?? l.name,
            visibleToMemberIds: visibleToMemberIds ?? l.visibleToMemberIds,
            editableByMemberIds: editableByMemberIds ?? l.editableByMemberIds,
            dateModified: Timestamp.now(),
          }
        : l
    )
  }

  async function deleteList(id: string) {
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user) throw new Error('認証が必要です')

    // リスト内のタスクをすべて削除
    const tasksCollection = spaceStore.getCollectionRef('tasks')
    const taskConstraints = [where('listId', '==', id)]
    const visibilityConstraint = getTaskVisibilityConstraint()
    if (visibilityConstraint) {
      taskConstraints.unshift(visibilityConstraint)
    }
    const tasksQuery = query(tasksCollection, ...taskConstraints)
    const tasksSnapshot = await getDocs(tasksQuery)

    // タスクが存在する場合、バッチ削除
    if (!tasksSnapshot.empty) {
      const batch = writeBatch(db)
      tasksSnapshot.docs.forEach((taskDoc) => {
        batch.delete(taskDoc.ref)
      })
      await batch.commit()
    }

    // リストを削除
    const docRef = doc(getListsCollection(), id)
    await deleteDoc(docRef)

    // ローカルstateから削除
    lists.value = lists.value.filter((l) => l.id !== id)

    if (selectedListId.value === id) {
      const inbox = lists.value.find((l) => l.name === 'Inbox')
      selectedListId.value = inbox?.id || null
    }
  }

  async function reorderList(id: string, newIndex: number) {
    const currentList = lists.value.find((l) => l.id === id)
    if (!currentList) return

    const sortedLists = [...lists.value].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    const currentIndex = sortedLists.findIndex((l) => l.id === id)
    if (currentIndex === newIndex) return

    // 移動するリストを取り出して新しい位置に挿入
    sortedLists.splice(currentIndex, 1)
    sortedLists.splice(newIndex, 0, currentList)

    // ローカルstateを先に更新（即座にUI反映）
    sortedLists.forEach((list, index) => {
      list.position = index
    })
    lists.value = [...sortedLists]

    // Firestoreを更新
    const batch = writeBatch(db)
    sortedLists.forEach((list, index) => {
      const docRef = doc(getListsCollection(), list.id)
      batch.update(docRef, { position: index })
    })
    await batch.commit()
  }

  async function createTag(name: string) {
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user) throw new Error('認証が必要です')
    const docRef = await addDoc(getTagsCollection(), {
      name,
      spaceId: spaceStore.currentSpaceId ?? undefined,
      visibleToMemberIds: [authStore.user.uid],
      editableByMemberIds: [authStore.user.uid],
    })
    // ローカルstateに追加（名前順にソート）
    const newTag: Tag = {
      id: docRef.id,
      name,
      spaceId: spaceStore.currentSpaceId ?? undefined,
      visibleToMemberIds: [authStore.user.uid],
      editableByMemberIds: [authStore.user.uid],
    }
    tags.value = [...tags.value, newTag].sort((a, b) => a.name.localeCompare(b.name, 'ja'))
  }

  async function deleteTag(id: string) {
    const docRef = doc(getTagsCollection(), id)
    await deleteDoc(docRef)
    // ローカルstateから削除
    tags.value = tags.value.filter((t) => t.id !== id)
  }

  function selectList(id: string | null) {
    selectedListId.value = id
    if (id) {
      localStorage.setItem(getSelectedListStorageKey(), id)
    } else {
      localStorage.removeItem(getSelectedListStorageKey())
    }
  }

  return {
    lists,
    tags,
    selectedListId,
    selectedList,
    selectedSmartList,
    smartListCounts,
    loading,
    error,
    subscribe,
    unsubscribe,
    createList,
    updateList,
    deleteList,
    reorderList,
    createTag,
    deleteTag,
    selectList,
    selectSmartList,
  }
})
