<script setup lang="ts">
import { ref, computed } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import { useListsStore } from '@/stores/lists'
import TaskItem from './TaskItem.vue'
import { parseTaskInput } from '@/utils/parseTaskInput'
import { Timestamp } from 'firebase/firestore'
import { useToast } from '@/composables/useToast'

const tasksStore = useTasksStore()
const listsStore = useListsStore()
const { showInfo, showError } = useToast()

// スマートリスト名のマッピング
const smartListNames: Record<string, string> = {
  today: '今日',
  tomorrow: '明日',
  overdue: '期限切れ',
  thisWeek: '今週',
  noDate: '期限なし',
}

// 検索結果（ローカルキャッシュから取得）
const localSearchResults = computed(() => tasksStore.searchResults)

const newTaskName = ref('')
const newTaskDueDate = ref('')
const newTaskPriority = ref<1 | 2 | 3 | 4>(4)
const isAdding = ref(false)
const isSubmitting = ref(false)
const isDeletingCompletedTasks = ref(false)
// 完了タスク表示の展開状態
const showCompletedTasks = ref(false)

// 完了タスクの展開/折りたたみ（展開時に遅延読み込み）
function toggleCompletedTasks() {
  showCompletedTasks.value = !showCompletedTasks.value
  // 展開時に完了タスクを読み込む
  if (showCompletedTasks.value) {
    tasksStore.loadCompletedTasks(undefined, true)
  }
}

const priorityOptions = [
  { value: 1, label: '高', color: 'bg-red-500' },
  { value: 2, label: '中', color: 'bg-orange-500' },
  { value: 3, label: '低', color: 'bg-blue-500' },
  { value: 4, label: 'なし', color: 'bg-gray-300' },
]

// 選択中のタスクがあるか
const hasSelectedTask = computed(() => !!tasksStore.selectedTaskId)
const selectedTaskCompleted = computed(() => tasksStore.selectedTask?.completed ?? false)
const canDeleteCompletedTasks = computed(() =>
  !tasksStore.isTagFiltering &&
  !listsStore.selectedSmartList &&
  tasksStore.completedTasks.length > 0
)

async function handleAddTask() {
  if (!newTaskName.value.trim() || isSubmitting.value) return

  isSubmitting.value = true
  try {
    const { name, url } = parseTaskInput(newTaskName.value)
    const dueDate = newTaskDueDate.value ? Timestamp.fromDate(new Date(newTaskDueDate.value)) : null
    await tasksStore.createTask({ name, url, dueDate, priority: newTaskPriority.value })
    resetAddForm()
  } finally {
    isSubmitting.value = false
  }
}

function resetAddForm() {
  newTaskName.value = ''
  newTaskDueDate.value = ''
  newTaskPriority.value = 4
  isAdding.value = false
}

function handleSelectTask(id: string) {
  tasksStore.selectTask(id)
}

async function handleCompleteSelected() {
  if (!tasksStore.selectedTaskId) return
  await tasksStore.toggleComplete(tasksStore.selectedTaskId)
}

async function handleSwipeComplete(taskId: string) {
  await tasksStore.toggleComplete(taskId)
}

async function handleDeleteCompletedTasks() {
  if (!canDeleteCompletedTasks.value || isDeletingCompletedTasks.value) return
  if (!confirm('このリストの完了タスクを一括削除しますか？')) return
  isDeletingCompletedTasks.value = true
  try {
    const deletedCount = await tasksStore.deleteCompletedTasksInCurrentList()
    if (deletedCount > 0) {
      showInfo(`${deletedCount}件の完了タスクを削除しました`)
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : '完了タスクの削除に失敗しました')
  } finally {
    isDeletingCompletedTasks.value = false
  }
}
</script>

<template>
  <section class="h-full flex flex-col overflow-x-hidden">
    <!-- ヘッダー -->
    <div class="flex items-center justify-between gap-2 mb-2">
      <h2 class="font-semibold text-gray-700 truncate min-w-0 flex-1 text-sm sm:text-base">
        <template v-if="tasksStore.isSearching">
          検索結果: "{{ tasksStore.searchQuery }}"
        </template>
        <template v-else-if="tasksStore.isTagFiltering">
          <span class="flex items-center gap-1">
            <span class="text-blue-600">#{{ tasksStore.selectedTag }}</span>
            <button
              @click="tasksStore.clearTagFilter()"
              class="text-gray-400 hover:text-gray-600 text-xs"
            >✕</button>
          </span>
        </template>
        <template v-else-if="listsStore.selectedSmartList">
          {{ smartListNames[listsStore.selectedSmartList] || listsStore.selectedSmartList }}
        </template>
        <template v-else>
          {{ listsStore.selectedList?.name || 'タスク' }}
        </template>
      </h2>
      <span class="text-xs sm:text-sm text-gray-500 flex-shrink-0">
        <template v-if="tasksStore.isSearching">
          {{ localSearchResults.length }}件
        </template>
        <template v-else>
          {{ tasksStore.incompleteTasks.length }}件
        </template>
      </span>
    </div>
    <label v-if="tasksStore.isSearching" class="flex items-center gap-1.5 mb-2 text-xs text-gray-500 cursor-pointer select-none">
      <input
        type="checkbox"
        :checked="tasksStore.searchIncludeCompleted"
        @change="tasksStore.toggleSearchIncludeCompleted()"
        class="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
      />
      完了済みも含める
      <span v-if="tasksStore.searchCacheLoading" class="text-gray-400">読み込み中...</span>
    </label>

    <div v-if="listsStore.tags.length > 0" class="mb-3">
      <div class="flex items-center justify-between gap-2 mb-1">
        <span class="text-xs text-gray-500">タグ</span>
        <button
          v-if="tasksStore.selectedTag"
          @click="tasksStore.clearTagFilter()"
          class="text-[10px] text-blue-600 hover:text-blue-800"
        >
          クリア
        </button>
      </div>
      <div class="flex gap-1 overflow-x-auto pb-1">
        <button
          v-for="tag in listsStore.tags"
          :key="tag.id"
          @click="tasksStore.selectedTag === tag.name ? tasksStore.clearTagFilter() : tasksStore.setTagFilter(tag.name)"
          class="px-2 py-1 text-[10px] rounded-full whitespace-nowrap transition-colors"
          :class="tasksStore.selectedTag === tag.name
            ? 'bg-blue-500 text-white'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
        >
          #{{ tag.name }}
        </button>
      </div>
    </div>

    <!-- ツールバー -->
    <div class="flex items-center gap-1 sm:gap-2 mb-3 sm:mb-4 pb-2 border-b border-gray-200">
      <button
        @click="handleCompleteSelected"
        :disabled="!hasSelectedTask"
        class="w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center rounded border transition-colors flex-shrink-0"
        :class="hasSelectedTask
          ? (selectedTaskCompleted
              ? 'border-gray-300 bg-gray-50 text-gray-600 hover:bg-gray-100'
              : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')
          : 'border-gray-200 bg-gray-50 text-gray-300 cursor-not-allowed'"
        :title="selectedTaskCompleted ? '未完了に戻す' : '完了にする'"
      >
        <span class="text-base sm:text-lg">✓</span>
      </button>

      <!-- ソート切り替え -->
      <div class="flex items-center gap-1 ml-auto">
        <span class="text-xs text-gray-500 hidden sm:inline">並び順:</span>
        <button
          @click="tasksStore.setSortOrder('name')"
          class="px-1.5 sm:px-2 py-1 text-xs rounded transition-colors"
          :class="tasksStore.sortOrder === 'name'
            ? 'bg-blue-100 text-blue-700'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
        >
          名前
        </button>
        <button
          @click="tasksStore.setSortOrder('created')"
          class="px-1.5 sm:px-2 py-1 text-xs rounded transition-colors"
          :class="tasksStore.sortOrder === 'created'
            ? 'bg-blue-100 text-blue-700'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
        >
          作成日
        </button>
      </div>
    </div>

    <!-- タスク追加ボタン/フォーム -->
    <div class="mb-4">
      <div v-if="!isAdding">
        <button
          @click="isAdding = true"
          class="w-full text-left px-3 py-2 text-gray-500 hover:bg-gray-50 rounded-lg border border-dashed border-gray-300 hover:border-gray-400 transition-colors"
        >
          + タスクを追加
        </button>
      </div>
      <div v-else class="bg-white border border-gray-200 rounded-lg p-3 shadow-sm">
        <input
          v-model="newTaskName"
          @keyup.escape="resetAddForm"
          type="text"
          placeholder="タスク名を入力"
          class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          autofocus
        />
        <!-- 期限と優先度 -->
        <div class="flex flex-wrap items-center gap-3 mt-3">
          <div class="flex items-center gap-2">
            <label class="text-xs text-gray-500">期限</label>
            <input
              v-model="newTaskDueDate"
              type="date"
              class="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div class="flex items-center gap-1">
            <label class="text-xs text-gray-500">優先度</label>
            <button
              v-for="option in priorityOptions"
              :key="option.value"
              @click="newTaskPriority = option.value as 1 | 2 | 3 | 4"
              class="px-2 py-0.5 rounded text-xs transition-colors"
              :class="[
                newTaskPriority === option.value
                  ? `${option.color} text-white`
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              ]"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <div class="flex gap-2 mt-3">
          <button
            @click="handleAddTask"
            class="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700"
          >
            追加
          </button>
          <button
            @click="resetAddForm"
            class="px-4 py-2 text-gray-600 hover:text-gray-800 text-sm"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>

    <!-- タスク一覧 -->
    <div class="flex-1 overflow-y-auto space-y-1">
      <div v-if="tasksStore.loading" class="text-center text-gray-500 py-8">
        読み込み中...
      </div>

      <!-- 検索モード（ローカルキャッシュ検索） -->
      <template v-else-if="tasksStore.isSearching">
        <div v-if="tasksStore.searchCacheLoading" class="text-center text-gray-500 py-8">
          全リストを検索中...
        </div>
        <div v-else-if="localSearchResults.length === 0" class="text-center text-gray-500 py-8">
          検索結果がありません
        </div>
        <TaskItem
          v-for="task in localSearchResults"
          :key="task.id"
          :task="task"
          :selected="tasksStore.selectedTaskId === task.id"
          @select="handleSelectTask(task.id)"
          @complete="handleSwipeComplete(task.id)"
        />
      </template>

      <!-- スマートリストモード -->
      <template v-else-if="listsStore.selectedSmartList">
        <div v-if="tasksStore.smartListTasksLoading" class="text-center text-gray-500 py-8">
          読み込み中...
        </div>
        <div v-else-if="tasksStore.incompleteTasks.length === 0" class="text-center text-gray-500 py-8">
          タスクがありません
        </div>
        <TaskItem
          v-for="task in tasksStore.incompleteTasks"
          :key="task.id"
          :task="task"
          :selected="tasksStore.selectedTaskId === task.id"
          @select="handleSelectTask(task.id)"
          @complete="handleSwipeComplete(task.id)"
        />
      </template>

      <!-- 通常モード -->
      <template v-else>
        <!-- 未完了タスク -->
        <TaskItem
          v-for="task in tasksStore.incompleteTasks"
          :key="task.id"
          :task="task"
          :selected="tasksStore.selectedTaskId === task.id"
          @select="handleSelectTask(task.id)"
          @complete="handleSwipeComplete(task.id)"
        />

        <!-- 完了タスク（折りたたみ式・遅延読み込み） -->
        <div
          class="mt-6 pt-4 border-t border-gray-200 transition-opacity"
          :class="{ 'opacity-60 pointer-events-none': isDeletingCompletedTasks }"
        >
          <div class="flex items-center justify-between gap-2 mb-2">
            <button
              @click="toggleCompletedTasks"
              class="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700"
            >
              <span class="text-xs">{{ showCompletedTasks ? '▼' : '▶' }}</span>
              <span>完了済み</span>
              <span v-if="tasksStore.completedTasksLoading" class="text-xs text-gray-400">(読み込み中...)</span>
              <span v-else-if="showCompletedTasks || tasksStore.completedTasks.length > 0">({{ tasksStore.completedTasks.length }})</span>
            </button>
            <button
              v-if="showCompletedTasks && canDeleteCompletedTasks"
              @click="handleDeleteCompletedTasks"
              :disabled="isDeletingCompletedTasks"
              class="text-xs transition-colors"
              :class="isDeletingCompletedTasks
                ? 'text-gray-400 cursor-not-allowed'
                : 'text-red-500 hover:text-red-700'"
            >
              {{ isDeletingCompletedTasks ? '削除中...' : '完了タスクを削除' }}
            </button>
          </div>
          <template v-if="showCompletedTasks">
            <div v-if="isDeletingCompletedTasks" class="text-xs text-gray-500 py-2">
              完了タスクを削除中...
            </div>
            <!-- Phase 4: 初回読み込み中（まだタスクが0件の場合のみ） -->
            <div v-if="tasksStore.completedTasksLoading && tasksStore.completedTasks.length === 0" class="text-center text-gray-400 py-4 text-sm">
              完了タスクを読み込み中...
            </div>
            <!-- タスクが0件（読み込み完了後） -->
            <div v-else-if="!tasksStore.completedTasksLoading && tasksStore.completedTasks.length === 0" class="text-center text-gray-400 py-4 text-sm">
              完了したタスクはありません
            </div>
            <!-- Phase 4: タスク一覧（1件以上ある場合は追加読み込み中でも表示） -->
            <template v-else>
              <TaskItem
                v-for="task in tasksStore.completedTasks"
                :key="task.id"
                :task="task"
                :selected="tasksStore.selectedTaskId === task.id"
                @select="handleSelectTask(task.id)"
                @complete="handleSwipeComplete(task.id)"
              />
            </template>
            <!-- Phase 4: さらに読み込むボタン（タスク一覧とは独立して表示） -->
            <div v-if="tasksStore.hasMoreCompletedTasks" class="text-center py-3">
              <button
                @click="tasksStore.loadMoreCompletedTasks()"
                :disabled="tasksStore.completedTasksLoading"
                class="px-4 py-2 text-sm text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-md transition-colors disabled:text-gray-400 disabled:cursor-not-allowed"
              >
                {{ tasksStore.completedTasksLoading ? '読み込み中...' : 'さらに読み込む' }}
              </button>
            </div>
          </template>
        </div>

        <!-- 空の状態 -->
        <div
          v-if="tasksStore.incompleteTasks.length === 0 && tasksStore.completedTasks.length === 0"
          class="text-center text-gray-500 py-8"
        >
          タスクがありません
        </div>
      </template>
    </div>
  </section>
</template>
