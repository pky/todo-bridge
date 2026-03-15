<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import { useListsStore } from '@/stores/lists'
import TaskItem from '@/components/TaskItem.vue'
// import { useCalendarStore } from '@/stores/calendar' // TODO: カレンダー自動登録機能を一時無効化
import { Timestamp } from 'firebase/firestore'
import { parseTaskInput } from '@/utils/parseTaskInput'
import { useToast } from '@/composables/useToast'

const props = withDefaults(defineProps<{
  showHeader?: boolean
}>(), {
  showHeader: true
})

const tasksStore = useTasksStore()
const listsStore = useListsStore()
const { showError, showInfo } = useToast()
// const calendarStore = useCalendarStore() // TODO: カレンダー自動登録機能を一時無効化

const editingName = ref(false)
const editName = ref('')
const editingNotes = ref(false)
const newNote = ref('')
const editingNoteIndex = ref<number | null>(null)
const editNoteContent = ref('')
const addingSubtask = ref(false)
const newSubtaskName = ref('')
const isSubmittingSubtask = ref(false)
const showCompletedSubtasks = ref(false)
const editingTags = ref(false)
const newTag = ref('')
const editingUrl = ref(false)
const editUrl = ref('')
const noteFormRef = ref<HTMLElement | null>(null)
const editDueTime = ref('')

const task = computed(() => tasksStore.selectedTask)

const incompleteChildTasks = computed(() => {
  if (!task.value) return []
  return tasksStore.getIncompleteSubtasks(task.value.id)
})

// 完了済みサブタスクを取得
const completedSubtasks = computed(() => {
  if (!task.value) return []
  return tasksStore.tasks.filter(t => t.parentId === task.value?.id && t.completed)
})

// 親タスクを取得（サブタスクの場合のみ）
const parentTask = computed(() => {
  if (!task.value?.parentId) return null
  return tasksStore.tasks.find((t) => t.id === task.value?.parentId) ?? null
})

function handleBackToParent() {
  if (parentTask.value) {
    tasksStore.selectTask(parentTask.value.id)
  }
}

watch(
  () => tasksStore.selectedTask,
  (newTask) => {
    if (newTask) {
      editName.value = newTask.name
      // 時刻指定タスクの場合、時刻を復元
      if (newTask.dueDate && !newTask.allDay) {
        editDueTime.value = formatTimeForInput(newTask.dueDate)
      } else {
        editDueTime.value = ''
      }
    }
  },
  { immediate: true }
)

watch(editingNotes, (isEditing) => {
  if (isEditing) {
    nextTick(() => {
      noteFormRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }
})

async function handleUpdateName() {
  if (!task.value || !editName.value.trim()) return
  await tasksStore.updateTask(task.value.id, { name: editName.value.trim() })
  editingName.value = false
}

async function handleUpdatePriority(priority: 1 | 2 | 3 | 4) {
  if (!task.value) return
  await tasksStore.updateTask(task.value.id, { priority })
}

// 日付入力を組み立てて dueDate を更新する
async function handleUpdateDueDateInput(event: Event) {
  if (!task.value) return
  const dateInput = event.target as HTMLInputElement
  if (!dateInput.value) {
    // 日付を消した場合は期日ごとクリア
    await tasksStore.updateTask(task.value.id, { dueDate: null, addToCalendar: false, calendarEventId: null })
    return
  }
  const dueDate = buildDueTimestamp(dateInput.value, editDueTime.value, task.value.allDay)
  await tasksStore.updateTask(task.value.id, { dueDate })
}

// 時刻入力から dueDate を更新する
async function handleUpdateDueTimeInput(event: Event) {
  if (!task.value?.dueDate) return
  const timeInput = event.target as HTMLInputElement
  editDueTime.value = timeInput.value
  const dateStr = formatDateForInput(task.value.dueDate)
  const dueDate = buildDueTimestamp(dateStr, timeInput.value, false)
  await tasksStore.updateTask(task.value.id, { dueDate })
}

// 終日フラグを切り替える
async function handleToggleAllDay(event: Event) {
  if (!task.value) return
  const checkbox = event.target as HTMLInputElement
  const allDay = checkbox.checked
  // 終日ONにしたとき時刻をリセット
  if (allDay) editDueTime.value = ''
  await tasksStore.updateTask(task.value.id, { allDay })
}

// TODO: カレンダー自動登録機能を一時無効化
// async function handleToggleAddToCalendar(event: Event) {
//   if (!task.value) return
//   const checkbox = event.target as HTMLInputElement
//   await tasksStore.updateTask(task.value.id, { addToCalendar: checkbox.checked })
// }

async function handleClearDueDate() {
  if (!task.value) return
  editDueTime.value = ''
  await tasksStore.updateTask(task.value.id, { dueDate: null, addToCalendar: false, calendarEventId: null })
}

// 日付文字列と時刻文字列から Timestamp を生成する
function buildDueTimestamp(dateStr: string, timeStr: string, isAllDay: boolean): Timestamp {
  if (isAllDay || !timeStr) {
    // 終日 or 時刻未入力: ローカル日付の開始時刻（00:00）
    const [year, month, day] = dateStr.split('-').map(Number)
    return Timestamp.fromDate(new Date(year!, month! - 1, day!))
  }
  return Timestamp.fromDate(new Date(`${dateStr}T${timeStr}`))
}

function handleStartEditUrl() {
  if (!task.value) return
  editUrl.value = task.value.url || ''
  editingUrl.value = true
}

async function handleUpdateUrl() {
  if (!task.value) return
  const url = editUrl.value.trim() || null
  await tasksStore.updateTask(task.value.id, { url })
  editingUrl.value = false
}

async function handleClearUrl() {
  if (!task.value) return
  await tasksStore.updateTask(task.value.id, { url: null })
  editingUrl.value = false
}

async function handleCopyUrl() {
  if (!task.value?.url) return

  try {
    await navigator.clipboard.writeText(task.value.url)
    showInfo('URLをコピーしました')
  } catch (error) {
    console.error('URL copy error:', error)
    showError('URLのコピーに失敗しました')
  }
}

async function handleUpdateList(event: Event) {
  if (!task.value) return
  const select = event.target as HTMLSelectElement
  await tasksStore.updateTask(task.value.id, { listId: select.value })
}

async function handleAddNote() {
  if (!task.value || !newNote.value.trim()) return
  const notes = [...task.value.notes, newNote.value.trim()]
  await tasksStore.updateTask(task.value.id, { notes })
  newNote.value = ''
  editingNotes.value = false
}

async function handleDeleteNote(index: number) {
  if (!task.value) return
  const notes = task.value.notes.filter((_, i) => i !== index)
  await tasksStore.updateTask(task.value.id, { notes })
}

async function handleCopyNote(note: string) {
  try {
    await navigator.clipboard.writeText(note)
    showInfo('メモをコピーしました')
  } catch (error) {
    console.error('Note copy error:', error)
    showError('メモのコピーに失敗しました')
  }
}

function handleStartEditNote(index: number) {
  if (!task.value) return
  editingNoteIndex.value = index
  editNoteContent.value = task.value.notes[index] ?? ''
}

async function handleUpdateNote() {
  if (!task.value || editingNoteIndex.value === null) return
  if (!editNoteContent.value.trim()) {
    // 空になったら削除
    await handleDeleteNote(editingNoteIndex.value)
  } else {
    const notes = [...task.value.notes]
    notes[editingNoteIndex.value] = editNoteContent.value.trim()
    await tasksStore.updateTask(task.value.id, { notes })
  }
  editingNoteIndex.value = null
  editNoteContent.value = ''
}

function handleCancelEditNote() {
  editingNoteIndex.value = null
  editNoteContent.value = ''
}

async function handleAddSubtask() {
  if (!task.value || !newSubtaskName.value.trim() || isSubmittingSubtask.value) return
  isSubmittingSubtask.value = true
  try {
    const { name, url } = parseTaskInput(newSubtaskName.value)
    await tasksStore.createTask({
      name,
      url,
      parentId: task.value.id,
    })
    newSubtaskName.value = ''
    addingSubtask.value = false
  } finally {
    isSubmittingSubtask.value = false
  }
}

async function handleDelete() {
  if (!task.value) return
  if (!confirm('このタスクを削除しますか？')) return
  await tasksStore.deleteTask(task.value.id)
}

async function handleToggleComplete() {
  if (!task.value) return
  const parentId = task.value.parentId
  const wasCompleted = task.value.completed
  await tasksStore.toggleComplete(task.value.id)
  // 未完了→完了にしたとき、サブタスクなら親へ、通常タスクなら一覧へ戻す
  if (!wasCompleted) {
    if (parentId) {
      tasksStore.selectTask(parentId)
      return
    }
    tasksStore.selectTask(null)
  }
}

async function handleAddTag() {
  if (!task.value || !newTag.value.trim()) return
  const tagName = newTag.value.trim()
  if (task.value.tags.includes(tagName)) {
    newTag.value = ''
    return
  }
  const tags = [...task.value.tags, tagName]
  await tasksStore.updateTask(task.value.id, { tags })
  newTag.value = ''
  editingTags.value = false
}

async function handleRemoveTag(tagToRemove: string) {
  if (!task.value) return
  const tags = task.value.tags.filter((t) => t !== tagToRemove)
  await tasksStore.updateTask(task.value.id, { tags })
}

function formatDateForInput(timestamp: Timestamp | null): string {
  if (!timestamp) return ''
  const date = timestamp.toDate()
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function formatTimeForInput(timestamp: Timestamp | null): string {
  if (!timestamp) return ''
  const date = timestamp.toDate()
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${min}`
}

const priorityOptions = [
  { value: 1, label: '高', color: 'bg-red-500' },
  { value: 2, label: '中', color: 'bg-orange-500' },
  { value: 3, label: '低', color: 'bg-blue-500' },
  { value: 4, label: 'なし', color: 'bg-gray-300' },
]
</script>

<template>
  <aside class="h-full flex flex-col overflow-x-hidden">
    <!-- 未選択状態 -->
    <div v-if="!task" class="flex items-center justify-center h-full text-gray-500 text-sm">
      タスクを選択してください
    </div>

    <!-- 選択状態 -->
    <template v-else>
      <!-- ヘッダー（デスクトップのみ） -->
      <div v-if="showHeader" class="flex items-center justify-between mb-3 sm:mb-4">
        <h2 class="font-semibold text-gray-700 text-sm sm:text-base">詳細</h2>
        <button
          @click="tasksStore.selectTask(null)"
          class="text-gray-400 hover:text-gray-600"
        >
          ✕
        </button>
      </div>

      <!-- 親タスクへ戻るボタン（サブタスクの場合のみ） -->
      <button
        v-if="parentTask"
        @click="handleBackToParent"
        class="flex items-center gap-1 text-xs sm:text-sm text-blue-600 hover:text-blue-800 mb-3 sm:mb-4 truncate"
      >
        <span>←</span>
        <span class="truncate">{{ parentTask.name }}</span>
      </button>

      <!-- 完了/未完了ボタン -->
      <div class="mb-3 sm:mb-4">
        <button
          @click="handleToggleComplete"
          class="px-2.5 sm:px-3 py-1 sm:py-1.5 rounded text-xs sm:text-sm font-medium transition-colors"
          :class="task.completed
            ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            : 'bg-green-600 text-white hover:bg-green-700'"
        >
          {{ task.completed ? '未完了に戻す' : '完了にする' }}
        </button>
      </div>

      <div class="flex-1 overflow-y-auto overflow-x-hidden space-y-3 sm:space-y-4">
        <!-- タスク名 -->
        <div>
          <label class="block text-xs text-gray-500 mb-1">タスク名</label>
          <div v-if="!editingName" @click="editingName = true" class="cursor-pointer">
            <p class="text-gray-800 hover:bg-gray-50 px-2 py-1 rounded -mx-2 text-sm sm:text-base break-words">
              {{ task.name }}
            </p>
          </div>
          <div v-else>
            <input
              v-model="editName"
              @keyup.enter="handleUpdateName"
              @keyup.escape="editingName = false"
              @blur="handleUpdateName"
              type="text"
              class="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm sm:text-base"
              autofocus
            />
          </div>
        </div>

        <!-- リスト -->
        <div>
          <label class="block text-xs text-gray-500 mb-1">リスト</label>
          <select
            :value="task.listId"
            @change="handleUpdateList"
            class="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm sm:text-base"
          >
            <option v-for="list in listsStore.lists" :key="list.id" :value="list.id">
              {{ list.name }}
            </option>
          </select>
        </div>

        <!-- 優先度 -->
        <div>
          <label class="block text-xs text-gray-500 mb-1">優先度</label>
          <div class="flex gap-1 sm:gap-2">
            <button
              v-for="option in priorityOptions"
              :key="option.value"
              @click="handleUpdatePriority(option.value as 1 | 2 | 3 | 4)"
              class="px-2 sm:px-3 py-1 rounded text-xs sm:text-sm transition-colors"
              :class="[
                task.priority === option.value
                  ? `${option.color} text-white`
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              ]"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <!-- 期限 -->
        <div>
          <label class="block text-xs text-gray-500 mb-1">期限</label>
          <!-- 日付 + 時刻 + クリア -->
          <div class="flex items-center gap-1.5">
            <input
              type="date"
              :value="formatDateForInput(task.dueDate)"
              @change="handleUpdateDueDateInput"
              class="flex-1 min-w-0 px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
            <input
              v-if="task.dueDate && !task.allDay"
              type="time"
              :value="editDueTime"
              @change="handleUpdateDueTimeInput"
              class="w-24 px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
            <button
              v-if="task.dueDate"
              @click="handleClearDueDate"
              class="px-1.5 py-1 text-gray-400 hover:text-red-500 flex-shrink-0 text-xs"
              title="期限をクリア"
            >
              ✕
            </button>
          </div>
          <!-- 終日チェックボックス -->
          <label v-if="task.dueDate" class="flex items-center gap-1.5 mt-1.5 cursor-pointer">
            <input
              type="checkbox"
              :checked="task.allDay"
              @change="handleToggleAllDay"
              class="rounded text-blue-600 focus:ring-blue-500"
            />
            <span class="text-xs text-gray-600">終日</span>
          </label>
          <!-- TODO: カレンダー自動登録機能を一時無効化
          <label v-if="calendarStore.connected && task.dueDate" class="flex items-center gap-1.5 mt-1.5 cursor-pointer">
            <input
              type="checkbox"
              :checked="task.addToCalendar"
              @change="handleToggleAddToCalendar"
              class="rounded text-blue-600 focus:ring-blue-500"
            />
            <span class="text-xs text-gray-600">Googleカレンダーに登録</span>
            <span v-if="task.calendarEventId" class="text-xs text-green-600">✓ 登録済み</span>
          </label>
          -->
        </div>

        <!-- タグ -->
        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="block text-xs text-gray-500">タグ</label>
            <button
              v-if="!editingTags"
              @click="editingTags = true"
              class="text-xs text-blue-600 hover:text-blue-800"
            >
              + 追加
            </button>
          </div>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="tag in task.tags"
              :key="tag"
              class="group inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-600 text-xs sm:text-sm rounded-full"
            >
              #{{ tag }}
              <button
                @click="handleRemoveTag(tag)"
                class="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ✕
              </button>
            </span>
            <span v-if="task.tags.length === 0 && !editingTags" class="text-xs text-gray-400">
              タグなし
            </span>
          </div>
          <div v-if="editingTags" class="mt-2">
            <input
              v-model="newTag"
              @keyup.enter="handleAddTag"
              @keyup.escape="editingTags = false"
              type="text"
              placeholder="タグ名（#なしで入力）"
              class="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs sm:text-sm"
              autofocus
            />
            <div class="flex gap-1 sm:gap-2 mt-2">
              <button
                @click="handleAddTag"
                class="px-2 sm:px-3 py-1 bg-blue-600 text-white rounded text-xs sm:text-sm hover:bg-blue-700"
              >
                追加
              </button>
              <button
                @click="editingTags = false"
                class="px-2 sm:px-3 py-1 text-gray-600 hover:text-gray-800 text-xs sm:text-sm"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>

        <!-- URL -->
        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="block text-xs text-gray-500">URL</label>
            <div class="flex items-center gap-3">
              <button
                v-if="!editingUrl && task.url"
                @click="handleCopyUrl"
                class="text-xs text-blue-600 hover:text-blue-800"
              >
                コピー
              </button>
              <button
                v-if="!editingUrl && !task.url"
                @click="handleStartEditUrl"
                class="text-xs text-blue-600 hover:text-blue-800"
              >
                + 追加
              </button>
              <button
                v-if="!editingUrl && task.url"
                @click="handleStartEditUrl"
                class="text-xs text-gray-500 hover:text-gray-700"
              >
                編集
              </button>
            </div>
          </div>
          <!-- 編集モード -->
          <div v-if="editingUrl" class="space-y-2">
            <input
              v-model="editUrl"
              type="url"
              placeholder="https://..."
              class="w-full px-2 sm:px-3 py-1.5 sm:py-2 border border-gray-300 rounded text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              @keyup.enter="handleUpdateUrl"
              @keyup.escape="editingUrl = false"
              autofocus
            />
            <div class="flex gap-2">
              <button
                @click="handleUpdateUrl"
                class="px-2 sm:px-3 py-1 bg-blue-600 text-white rounded text-xs sm:text-sm hover:bg-blue-700"
              >
                保存
              </button>
              <button
                v-if="task.url"
                @click="handleClearUrl"
                class="px-2 sm:px-3 py-1 text-red-600 hover:text-red-800 text-xs sm:text-sm"
              >
                削除
              </button>
              <button
                @click="editingUrl = false"
                class="px-2 sm:px-3 py-1 text-gray-600 hover:text-gray-800 text-xs sm:text-sm"
              >
                キャンセル
              </button>
            </div>
          </div>
          <!-- 表示モード -->
          <a
            v-else-if="task.url"
            :href="task.url"
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 hover:text-blue-800 text-xs sm:text-sm break-all"
          >
            {{ task.url }}
          </a>
          <span v-else class="text-gray-400 text-xs">なし</span>
        </div>

        <!-- 子タスク（未完了のみ表示） -->
        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="block text-xs text-gray-500">サブタスク</label>
            <button
              v-if="!addingSubtask"
              @click="addingSubtask = true"
              class="text-xs text-blue-600 hover:text-blue-800"
            >
              + 追加
            </button>
          </div>
          <div class="space-y-1">
            <!-- 追加フォーム（上部） -->
            <div v-if="addingSubtask" class="mb-2">
              <input
                v-model="newSubtaskName"
                @keyup.escape="addingSubtask = false"
                type="text"
                placeholder="サブタスク名"
                class="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs sm:text-sm"
                autofocus
              />
              <div class="flex gap-1 sm:gap-2 mt-2">
                <button
                  @click="handleAddSubtask"
                  class="px-2 sm:px-3 py-1 bg-blue-600 text-white rounded text-xs sm:text-sm hover:bg-blue-700"
                >
                  追加
                </button>
                <button
                  @click="addingSubtask = false"
                  class="px-2 sm:px-3 py-1 text-gray-600 hover:text-gray-800 text-xs sm:text-sm"
                >
                  キャンセル
                </button>
              </div>
            </div>
            <!-- 未完了サブタスク -->
            <TaskItem
              v-for="subtask in incompleteChildTasks"
              :key="subtask.id"
              :task="subtask"
              :selected="tasksStore.selectedTaskId === subtask.id"
              @select="tasksStore.selectTask(subtask.id)"
              @complete="tasksStore.toggleComplete(subtask.id)"
            />
            <div
              v-if="!addingSubtask && incompleteChildTasks.length === 0"
              class="text-xs text-gray-400"
            >
              サブタスクなし
            </div>
          </div>
        </div>

        <!-- メモ -->
        <div>
          <label class="block text-xs text-gray-500 mb-1">メモ</label>
          <div class="space-y-2">
            <div
              v-for="(note, index) in task.notes"
              :key="index"
              class="bg-gray-50 p-2 rounded"
            >
              <!-- 編集モード -->
              <div v-if="editingNoteIndex === index" class="space-y-2">
                <textarea
                  v-model="editNoteContent"
                  @keyup.escape="handleCancelEditNote"
                  rows="3"
                  class="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs sm:text-sm"
                  autofocus
                ></textarea>
                <div class="flex gap-1 sm:gap-2">
                  <button
                    @click="handleUpdateNote"
                    class="px-2 sm:px-3 py-1 bg-blue-600 text-white rounded text-xs sm:text-sm hover:bg-blue-700"
                  >
                    保存
                  </button>
                  <button
                    @click="handleCancelEditNote"
                    class="px-2 sm:px-3 py-1 text-gray-600 hover:text-gray-800 text-xs sm:text-sm"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
              <!-- 表示モード -->
              <div v-else class="flex items-start gap-2">
                <p
                  @click="handleStartEditNote(index)"
                  class="flex-1 text-xs sm:text-sm text-gray-700 whitespace-pre-wrap cursor-pointer hover:bg-gray-100 rounded px-1 -mx-1 break-words"
                >
                  {{ note }}
                </p>
                <button
                  @click="handleCopyNote(note)"
                  class="text-xs text-blue-600 hover:text-blue-800 flex-shrink-0"
                >
                  コピー
                </button>
                <button
                  @click="handleDeleteNote(index)"
                  class="text-gray-400 hover:text-red-500 flex-shrink-0"
                >
                  ✕
                </button>
              </div>
            </div>

            <div v-if="editingNotes" ref="noteFormRef" class="space-y-2">
              <textarea
                v-model="newNote"
                @keyup.escape="editingNotes = false"
                placeholder="メモを追加"
                rows="5"
                class="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs sm:text-sm"
                autofocus
              ></textarea>
              <div class="flex gap-1 sm:gap-2">
                <button
                  @click="handleAddNote"
                  class="px-2 sm:px-3 py-1 bg-blue-600 text-white rounded text-xs sm:text-sm hover:bg-blue-700"
                >
                  追加
                </button>
                <button
                  @click="editingNotes = false"
                  class="px-2 sm:px-3 py-1 text-gray-600 hover:text-gray-800 text-xs sm:text-sm"
                >
                  キャンセル
                </button>
              </div>
            </div>

            <button
              v-if="!editingNotes"
              @click="editingNotes = true"
              class="text-xs sm:text-sm text-blue-600 hover:text-blue-800"
            >
              + メモを追加
            </button>
          </div>
        </div>

        <!-- 完了済みサブタスク（折りたたみ式） -->
        <div v-if="completedSubtasks.length > 0" class="pt-3 sm:pt-4 border-t border-gray-100">
          <button
            @click="showCompletedSubtasks = !showCompletedSubtasks"
            class="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700"
          >
            <span class="text-[10px]">{{ showCompletedSubtasks ? '▼' : '▶' }}</span>
            <span>完了済みサブタスク ({{ completedSubtasks.length }})</span>
          </button>
          <div v-if="showCompletedSubtasks" class="mt-2 space-y-1">
            <div
              v-for="subtask in completedSubtasks"
              :key="subtask.id"
              @click="tasksStore.selectTask(subtask.id)"
              class="px-2 py-1 rounded cursor-pointer hover:bg-gray-50 text-xs sm:text-sm line-through text-gray-400 truncate"
            >
              {{ subtask.name }}
            </div>
          </div>
        </div>
      </div>

      <!-- 削除ボタン -->
      <div class="pt-3 sm:pt-4 border-t border-gray-200 mt-3 sm:mt-4">
        <button
          @click="handleDelete"
          class="w-full px-3 sm:px-4 py-1.5 sm:py-2 text-red-600 hover:bg-red-50 rounded transition-colors text-sm"
        >
          タスクを削除
        </button>
      </div>
    </template>
  </aside>
</template>
