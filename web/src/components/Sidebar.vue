<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/services/firebase'
import { useListsStore } from '@/stores/lists'
import { buildPersonalSpaceId, useSpaceStore } from '@/stores/space'
import { useAuthStore } from '@/stores/auth'
import { useTasksStore } from '@/stores/tasks'
import type { SpaceMember, TaskList } from '@/types'

type SidebarSection = 'personal' | 'shared'

interface SidebarListItem extends TaskList {
  spaceId: string
  spaceLabel?: string
}

const listsStore = useListsStore()
const spaceStore = useSpaceStore()
const authStore = useAuthStore()
const tasksStore = useTasksStore()

const emit = defineEmits<{
  'list-selected': []
}>()

const newListName = ref('')
const addingSection = ref<SidebarSection | null>(null)
const draggedListId = ref<string | null>(null)
const dragOverIndex = ref<number | null>(null)
const editingListId = ref<string | null>(null)
const editingListName = ref('')
const editingShareMode = ref<'private' | 'shared'>('private')
const currentSpaceMembers = ref<SpaceMember[]>([])
const sharedSpaceMembers = ref<SpaceMember[]>([])
const lastLoadedCurrentMembersSpaceId = ref<string | null>(null)
const lastLoadedSharedMembersSpaceId = ref<string | null>(null)

const touchDragListId = ref<string | null>(null)
const touchStartY = ref<number>(0)
const isTouchDragging = ref(false)
const listItemRefs = ref<Map<string, HTMLElement>>(new Map())

const smartLists = computed(() => [
  { type: 'today', name: '今日', icon: '📅', count: listsStore.smartListCounts.today },
  { type: 'tomorrow', name: '明日', icon: '📆', count: listsStore.smartListCounts.tomorrow },
  {
    type: 'overdue',
    name: '期限切れ',
    icon: listsStore.smartListCounts.overdue > 0 ? '⚠️' : '📅',
    count: listsStore.smartListCounts.overdue,
  },
  { type: 'thisWeek', name: '今週', icon: '📋', count: listsStore.smartListCounts.thisWeek },
])

const currentUserId = computed(() => authStore.user?.uid ?? '')
const personalSpaceId = computed(() =>
  authStore.user ? buildPersonalSpaceId(authStore.user.uid) : null
)
const sharedMemberships = computed(() =>
  spaceStore.memberships.filter((membership) => !membership.spaceId.startsWith('personal_'))
)
const defaultSharedSpaceId = computed(() =>
  sharedMemberships.value[0]?.spaceId ?? null
)

function sortListItems(items: SidebarListItem[]): SidebarListItem[] {
  return [...items].sort((a, b) => {
    const posA = a.position ?? Infinity
    const posB = b.position ?? Infinity
    if (posA !== posB) return posA - posB
    const dateA = a.dateCreated?.toMillis?.() ?? 0
    const dateB = b.dateCreated?.toMillis?.() ?? 0
    return dateA - dateB
  })
}

const personalOverviewLists = ref<SidebarListItem[]>([])
const sharedOverviewLists = ref<SidebarListItem[]>([])

function getSpaceLabel(spaceId: string): string {
  if (spaceId.startsWith('personal_')) return '個人用'
  const membership = spaceStore.memberships.find((item) => item.spaceId === spaceId)
  return membership?.displayName ?? '共有'
}

function mergeCurrentSpaceLists(targetSpaceId: string | null, fallback: SidebarListItem[]): SidebarListItem[] {
  if (!targetSpaceId) return fallback
  if (spaceStore.currentSpaceId !== targetSpaceId) return fallback
  return sortListItems(
    listsStore.lists.map((list) => ({
      ...list,
      spaceId: targetSpaceId,
      spaceLabel: getSpaceLabel(targetSpaceId),
    }))
  )
}

const personalLists = computed(() =>
  mergeCurrentSpaceLists(personalSpaceId.value, personalOverviewLists.value)
)

const sharedLists = computed(() => {
  if (!defaultSharedSpaceId.value) return sharedOverviewLists.value
  const currentSharedLists = mergeCurrentSpaceLists(defaultSharedSpaceId.value, [])
  if (spaceStore.currentSpaceId !== defaultSharedSpaceId.value) {
    return sharedOverviewLists.value
  }
  return sortListItems([
    ...sharedOverviewLists.value.filter((list) => list.spaceId !== defaultSharedSpaceId.value),
    ...currentSharedLists,
  ])
})

const sections = computed(() => [
  {
    key: 'shared' as const,
    title: '共有',
    canAdd: !!defaultSharedSpaceId.value,
    emptyMessage: defaultSharedSpaceId.value ? '共有リストはありません' : '共有スペースは未作成です',
    lists: sharedLists.value,
  },
  {
    key: 'personal' as const,
    title: '個人用',
    canAdd: !!personalSpaceId.value,
    emptyMessage: '個人用リストはありません',
    lists: personalLists.value,
  },
])

const sortedCurrentSpaceMembers = computed(() => {
  const selfUid = currentUserId.value
  return [...currentSpaceMembers.value].sort((a, b) => {
    if (a.uid === selfUid) return -1
    if (b.uid === selfUid) return 1
    return (a.displayName ?? a.email ?? '').localeCompare(b.displayName ?? b.email ?? '', 'ja')
  })
})

const canConfigureCurrentSpaceMembers = computed(() =>
  !spaceStore.useLegacyPath && sortedCurrentSpaceMembers.value.some((member) => member.uid !== currentUserId.value)
)

function normalizeMemberIds(memberIds: string[]) {
  const selfUid = currentUserId.value
  if (!selfUid) return memberIds
  return [...new Set([selfUid, ...memberIds])]
}

function getSharedMemberIds(): string[] {
  return normalizeMemberIds(
    sharedSpaceMembers.value
      .filter((member) => member.status === 'active')
      .map((member) => member.uid)
  )
}

function getCurrentSharedMemberIds(): string[] {
  return normalizeMemberIds(
    currentSpaceMembers.value
      .filter((member) => member.status === 'active')
      .map((member) => member.uid)
  )
}

function resetNewListForm() {
  newListName.value = ''
  addingSection.value = null
}

function openAddList(section: SidebarSection) {
  addingSection.value = section
  newListName.value = ''
}

async function loadMembersForSpace(spaceId: string | null): Promise<SpaceMember[]> {
  if (!spaceId) return []

  const membersSnapshot = await getDocs(collection(db, 'spaces', spaceId, 'members'))
  return membersSnapshot.docs.map((documentSnapshot) => ({
    ...(documentSnapshot.data() as Omit<SpaceMember, 'uid'>),
    uid: documentSnapshot.id,
  }))
}

async function loadCurrentSpaceMembers() {
  if (spaceStore.useLegacyPath || !spaceStore.currentSpaceId) {
    currentSpaceMembers.value = authStore.user
      ? [{
          uid: authStore.user.uid,
          displayName: authStore.user.displayName,
          email: authStore.user.email,
          role: 'owner',
          status: 'active',
          createdAt: null as unknown as SpaceMember['createdAt'],
          updatedAt: null as unknown as SpaceMember['updatedAt'],
        }]
      : []
    return
  }

  if (lastLoadedCurrentMembersSpaceId.value === spaceStore.currentSpaceId && currentSpaceMembers.value.length > 0) {
    return
  }

  const members = await loadMembersForSpace(spaceStore.currentSpaceId)
  currentSpaceMembers.value = members.length > 0
    ? members
    : authStore.user
      ? [{
          uid: authStore.user.uid,
          displayName: authStore.user.displayName,
          email: authStore.user.email,
          role: 'owner' as const,
          status: 'active' as const,
          createdAt: null as unknown as SpaceMember['createdAt'],
          updatedAt: null as unknown as SpaceMember['updatedAt'],
        }]
      : []
  lastLoadedCurrentMembersSpaceId.value = spaceStore.currentSpaceId
}

async function loadSharedSpaceMembers() {
  if (!defaultSharedSpaceId.value) {
    sharedSpaceMembers.value = []
    lastLoadedSharedMembersSpaceId.value = null
    return
  }
  if (lastLoadedSharedMembersSpaceId.value === defaultSharedSpaceId.value && sharedSpaceMembers.value.length > 0) {
    return
  }
  sharedSpaceMembers.value = await loadMembersForSpace(defaultSharedSpaceId.value)
  lastLoadedSharedMembersSpaceId.value = defaultSharedSpaceId.value
}

async function ensureCurrentSpaceMembersLoaded() {
  if (currentSpaceMembers.value.length > 0 && lastLoadedCurrentMembersSpaceId.value === spaceStore.currentSpaceId) {
    return
  }
  await loadCurrentSpaceMembers()
}

async function ensureSharedSpaceMembersLoaded() {
  if (sharedSpaceMembers.value.length > 0 && lastLoadedSharedMembersSpaceId.value === defaultSharedSpaceId.value) {
    return
  }
  await loadSharedSpaceMembers()
}

async function loadListsForSpace(spaceId: string): Promise<SidebarListItem[]> {
  if (!authStore.user) return []

  const snapshot = await getDocs(query(
    collection(db, 'spaces', spaceId, 'lists'),
    where('visibleToMemberIds', 'array-contains', authStore.user.uid)
  ))

  return sortListItems(snapshot.docs.map((documentSnapshot) => ({
    ...(documentSnapshot.data() as Omit<TaskList, 'id'>),
    id: documentSnapshot.id,
    spaceId,
    spaceLabel: getSpaceLabel(spaceId),
  })))
}

async function loadOverviewLists() {
  if (!authStore.user) {
    personalOverviewLists.value = []
    sharedOverviewLists.value = []
    return
  }

  if (spaceStore.useLegacyPath) {
    const fallbackPersonalSpaceId = personalSpaceId.value ?? buildPersonalSpaceId(authStore.user!.uid)
    personalOverviewLists.value = sortListItems(
      listsStore.lists.map((list) => ({
        ...list,
        spaceId: fallbackPersonalSpaceId,
        spaceLabel: '個人用',
      }))
    )
    sharedOverviewLists.value = []
    return
  }

  personalOverviewLists.value = personalSpaceId.value && personalSpaceId.value !== spaceStore.currentSpaceId
    ? await loadListsForSpace(personalSpaceId.value)
    : []

  const sharedSpaces = sharedMemberships.value.map((membership) => membership.spaceId)
  const overviewSharedSpaces = sharedSpaces.filter((spaceId) => spaceId !== spaceStore.currentSpaceId)
  const sharedListsBySpace = await Promise.all(overviewSharedSpaces.map((spaceId) => loadListsForSpace(spaceId)))
  sharedOverviewLists.value = sortListItems(sharedListsBySpace.flat())
}

function isSharedList(list: SidebarListItem) {
  const visibleIds = list.visibleToMemberIds ?? []
  return visibleIds.some((memberId) => memberId !== currentUserId.value)
}

function isSelectedList(list: SidebarListItem) {
  return spaceStore.currentSpaceId === list.spaceId && listsStore.selectedListId === list.id
}

function isCurrentSpaceList(list: SidebarListItem) {
  return spaceStore.currentSpaceId === list.spaceId
}

function getSelectedListStorageKeyForSpace(spaceId: string): string {
  return `rertm-selected-list-id-${spaceId}`
}

function handleSelectSmartList(type: string) {
  tasksStore.clearTagFilter()
  listsStore.selectSmartList(type)
  tasksStore.subscribeToList(null)
  tasksStore.loadSmartListTasks(type)
  emit('list-selected')
}

function handleSelectList(list: SidebarListItem) {
  tasksStore.clearTagFilter()
  listsStore.selectSmartList(null)

  if (spaceStore.currentSpaceId !== list.spaceId) {
    localStorage.setItem(getSelectedListStorageKeyForSpace(list.spaceId), list.id)
    spaceStore.selectSpace(list.spaceId)
    emit('list-selected')
    return
  }

  listsStore.selectList(list.id)
  emit('list-selected')
}

async function handleAddList() {
  if (!newListName.value.trim() || !addingSection.value) return
  if (!authStore.user) return

  const targetSpaceId = addingSection.value === 'personal'
    ? personalSpaceId.value
    : defaultSharedSpaceId.value

  if (!targetSpaceId) return

  if (addingSection.value === 'shared') {
    await ensureSharedSpaceMembersLoaded()
  }

  const memberIds = addingSection.value === 'shared'
    ? getSharedMemberIds()
    : normalizeMemberIds([])

  if (spaceStore.currentSpaceId !== targetSpaceId) {
    spaceStore.selectSpace(targetSpaceId)
  }

  await listsStore.createList({
    name: newListName.value.trim(),
    visibleToMemberIds: memberIds,
  })

  await loadOverviewLists()
  resetNewListForm()
}

async function handleDeleteList(list: SidebarListItem) {
  if (list.name === 'Inbox') return

  const inputName = prompt(
    `リスト「${list.name}」を削除します。\n\nこのリスト内のタスクもすべて削除されます。\n\n削除するには、リスト名を入力してください：`
  )

  if (inputName === null) return
  if (inputName.trim() !== list.name) {
    alert('リスト名が一致しません。削除をキャンセルしました。')
    return
  }

  await listsStore.deleteList(list.id)
  await loadOverviewLists()
}

async function startEditingList(list: SidebarListItem, event: MouseEvent) {
  if (list.name === 'Inbox' || !isCurrentSpaceList(list)) return
  event.stopPropagation()
  await ensureCurrentSpaceMembersLoaded()
  editingListId.value = list.id
  editingListName.value = list.name
  editingShareMode.value = isSharedList(list) ? 'shared' : 'private'
}

async function saveListName(id: string) {
  if (!editingListName.value.trim()) {
    cancelEditingList()
    return
  }

  if (editingShareMode.value === 'shared') {
    await ensureCurrentSpaceMembersLoaded()
  }

  const memberIds = editingShareMode.value === 'shared'
    ? getCurrentSharedMemberIds()
    : normalizeMemberIds([])

  await listsStore.updateList(id, {
    name: editingListName.value.trim(),
    visibleToMemberIds: memberIds,
  })
  editingListId.value = null
  editingListName.value = ''
  editingShareMode.value = 'private'
  await loadOverviewLists()
}

function cancelEditingList() {
  editingListId.value = null
  editingListName.value = ''
  editingShareMode.value = 'private'
}

function handleDragStart(list: SidebarListItem, event: DragEvent) {
  if (!isCurrentSpaceList(list)) return
  draggedListId.value = list.id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
  }
}

function handleDragOver(index: number, event: DragEvent) {
  event.preventDefault()
  dragOverIndex.value = index
}

function handleDragLeave() {
  dragOverIndex.value = null
}

async function handleDrop(targetIndex: number) {
  if (draggedListId.value) {
    await listsStore.reorderList(draggedListId.value, targetIndex)
    await loadOverviewLists()
  }
  draggedListId.value = null
  dragOverIndex.value = null
}

function handleDragEnd() {
  draggedListId.value = null
  dragOverIndex.value = null
}

function buildListItemKey(list: SidebarListItem): string {
  return `${list.spaceId}:${list.id}`
}

function handleTouchStart(list: SidebarListItem, event: TouchEvent) {
  if (!isCurrentSpaceList(list)) return

  const target = event.target as HTMLElement
  if (!target.classList.contains('drag-handle')) return

  const touch = event.touches[0]
  if (!touch) return

  event.preventDefault()
  touchDragListId.value = list.id
  touchStartY.value = touch.clientY
  isTouchDragging.value = true
  draggedListId.value = list.id
}

function handleTouchMove(event: TouchEvent) {
  if (!isTouchDragging.value || !touchDragListId.value) return

  const touch = event.touches[0]
  if (!touch) return

  event.preventDefault()
  const currentY = touch.clientY

  const activeLists = spaceStore.currentSpaceId?.startsWith('personal_')
    ? personalLists.value
    : sharedLists.value

  for (let index = 0; index < activeLists.length; index++) {
    const list = activeLists[index]
    if (!list) continue
    const element = listItemRefs.value.get(buildListItemKey(list))
    if (!element) continue
    const rect = element.getBoundingClientRect()
    if (currentY >= rect.top && currentY <= rect.bottom) {
      dragOverIndex.value = index
      break
    }
  }
}

function handleTouchEnd() {
  if (!isTouchDragging.value || !touchDragListId.value) return

  if (dragOverIndex.value !== null) {
    void listsStore.reorderList(touchDragListId.value, dragOverIndex.value).then(loadOverviewLists)
  }

  touchDragListId.value = null
  isTouchDragging.value = false
  draggedListId.value = null
  dragOverIndex.value = null
}

function setListItemRef(el: HTMLElement | null, list: SidebarListItem) {
  const key = buildListItemKey(list)
  if (el) {
    listItemRefs.value.set(key, el)
  } else {
    listItemRefs.value.delete(key)
  }
}

function showListSpaceLabel(_list: SidebarListItem, section: SidebarSection): boolean {
  return section === 'shared' && sharedMemberships.value.length > 1
}

async function refreshSidebarData() {
  await loadOverviewLists()
}

onMounted(() => {
  document.addEventListener('touchmove', handleTouchMove, { passive: false })
  document.addEventListener('touchend', handleTouchEnd)
  void refreshSidebarData()
})

onUnmounted(() => {
  document.removeEventListener('touchmove', handleTouchMove)
  document.removeEventListener('touchend', handleTouchEnd)
})

watch(
  () => [
    authStore.user?.uid,
    spaceStore.currentSpaceId,
    spaceStore.useLegacyPath,
    spaceStore.memberships.map((membership) => membership.spaceId).join(','),
  ],
  () => {
    if (lastLoadedCurrentMembersSpaceId.value !== spaceStore.currentSpaceId) {
      currentSpaceMembers.value = []
    }
    if (lastLoadedSharedMembersSpaceId.value !== defaultSharedSpaceId.value) {
      sharedSpaceMembers.value = []
    }
    void refreshSidebarData()
  }
)
</script>

<template>
  <aside class="h-full flex flex-col">
    <div class="mb-3">
      <h2 class="text-xs font-medium text-gray-500 mb-1.5">スマート</h2>
      <div class="grid grid-cols-2 gap-1">
        <button
          v-for="smartList in smartLists"
          :key="smartList.type"
          @click="handleSelectSmartList(smartList.type)"
          class="flex items-center justify-between px-2 py-1.5 rounded text-xs cursor-pointer transition-colors"
          :class="
            listsStore.selectedSmartList === smartList.type
              ? 'bg-blue-100 text-blue-800'
              : 'hover:bg-gray-100 text-gray-600'
          "
        >
          <span class="flex items-center gap-1 truncate">
            <span class="text-sm">{{ smartList.icon }}</span>
            <span class="truncate">{{ smartList.name }}</span>
          </span>
          <span
            v-if="smartList.count > 0"
            class="text-[10px] px-1 rounded-full ml-1 flex-shrink-0"
            :class="
              smartList.type === 'overdue'
                ? 'bg-red-100 text-red-600'
                : 'bg-gray-200 text-gray-500'
            "
          >
            {{ smartList.count }}
          </span>
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto space-y-4 border-t border-gray-200 pt-3">
      <section
        v-for="section in sections"
        :key="section.key"
      >
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-xs font-medium text-gray-500">{{ section.title }}</h2>
          <button
            v-if="section.canAdd"
            @click="openAddList(section.key)"
            class="text-blue-600 hover:text-blue-800 text-xs"
          >
            + 追加
          </button>
        </div>

        <div
          v-if="addingSection === section.key"
          class="mb-3 rounded-lg border border-gray-200 bg-white p-2"
        >
          <input
            v-model="newListName"
            @keyup.enter="handleAddList"
            @keyup.escape="resetNewListForm"
            type="text"
            :placeholder="`${section.title}リスト名`"
            class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            autofocus
          />
          <p class="mt-2 text-[11px] text-gray-500">
            {{ section.key === 'personal' ? '個人用に作成します' : '共有スペースに作成します' }}
          </p>
          <div class="flex gap-2 mt-2">
            <button
              @click="handleAddList"
              class="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
            >
              追加
            </button>
            <button
              @click="resetNewListForm"
              class="px-3 py-1 text-gray-600 hover:text-gray-800 text-sm"
            >
              キャンセル
            </button>
          </div>
        </div>

        <ul class="space-y-0.5">
          <li
            v-for="(list, index) in section.lists"
            :key="buildListItemKey(list)"
            :ref="(el) => setListItemRef(el as HTMLElement | null, list)"
            :draggable="isCurrentSpaceList(list)"
            @click="handleSelectList(list)"
            @dragstart="handleDragStart(list, $event)"
            @dragover="isCurrentSpaceList(list) ? handleDragOver(index, $event) : null"
            @dragleave="handleDragLeave"
            @drop="handleDrop(index)"
            @dragend="handleDragEnd"
            class="group flex items-center justify-between px-2 py-1.5 rounded cursor-pointer transition-colors text-sm"
            :class="[
              isSelectedList(list)
                ? 'bg-blue-100 text-blue-800'
                : 'hover:bg-gray-100 text-gray-700',
              dragOverIndex === index && isCurrentSpaceList(list) ? 'border-t-2 border-blue-500' : '',
              draggedListId === list.id ? 'opacity-50' : ''
            ]"
          >
            <span class="flex items-center gap-1.5 min-w-0">
              <span
                class="drag-handle text-gray-400 text-xs select-none touch-none p-1"
                :class="isCurrentSpaceList(list) ? 'cursor-grab' : 'cursor-default opacity-30'"
                @touchstart="handleTouchStart(list, $event)"
              >⋮⋮</span>
              <span class="text-sm">{{ list.name === 'Inbox' ? '📥' : '📋' }}</span>
              <div v-if="editingListId === list.id && isCurrentSpaceList(list)" class="min-w-0 flex-1" @click.stop>
                <input
                  v-model="editingListName"
                  @keyup.enter="saveListName(list.id)"
                  @keyup.escape="cancelEditingList"
                  type="text"
                  class="w-full px-1 py-0.5 border border-blue-500 rounded text-sm focus:outline-none min-w-0"
                  autofocus
                />
                <div
                  v-if="canConfigureCurrentSpaceMembers"
                  class="mt-2 rounded-md border border-blue-100 bg-white p-2"
                >
                  <div class="flex gap-3 text-xs text-gray-600">
                    <label class="flex items-center gap-1">
                      <input
                        v-model="editingShareMode"
                        type="radio"
                        value="private"
                      />
                      個人用
                    </label>
                    <label class="flex items-center gap-1">
                      <input
                        v-model="editingShareMode"
                        type="radio"
                        value="shared"
                      />
                      共有
                    </label>
                  </div>
                </div>
                <div class="mt-2 flex gap-2">
                  <button
                    @click="saveListName(list.id)"
                    class="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"
                  >
                    保存
                  </button>
                  <button
                    @click="cancelEditingList"
                    class="px-2 py-1 text-gray-600 hover:text-gray-800 text-xs"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
              <div
                v-else
                class="min-w-0"
                @dblclick="startEditingList(list, $event)"
              >
                <span class="truncate block">{{ list.name }}</span>
                <span
                  v-if="showListSpaceLabel(list, section.key)"
                  class="text-[10px] text-gray-400"
                >
                  {{ list.spaceLabel }}
                </span>
              </div>
            </span>

            <span class="flex items-center gap-1 flex-shrink-0">
              <span
                v-if="list.incompleteTaskCount && list.incompleteTaskCount > 0"
                class="text-[10px] text-gray-400"
              >
                {{ list.incompleteTaskCount }}
              </span>
              <button
                v-if="list.name !== 'Inbox' && isCurrentSpaceList(list)"
                @click.stop="startEditingList(list, $event)"
                class="text-gray-400 hover:text-blue-500 transition-colors text-xs md:opacity-0 md:group-hover:opacity-100"
                :class="isSelectedList(list) ? 'opacity-100' : 'opacity-100 md:opacity-0'"
                title="編集"
              >
                ✎
              </button>
              <button
                v-if="list.name !== 'Inbox' && isCurrentSpaceList(list)"
                @click.stop="handleDeleteList(list)"
                class="text-gray-400 hover:text-red-500 transition-colors text-xs md:opacity-0 md:group-hover:opacity-100"
                :class="isSelectedList(list) ? 'opacity-100' : 'opacity-100 md:opacity-0'"
                title="削除"
              >
                ✕
              </button>
            </span>
          </li>
        </ul>

        <p
          v-if="section.lists.length === 0"
          class="px-2 py-2 text-xs text-gray-400"
        >
          {{ section.emptyMessage }}
        </p>
      </section>
    </div>
  </aside>
</template>
