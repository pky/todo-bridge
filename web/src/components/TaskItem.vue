<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Task } from '@/types'
import type { Timestamp } from 'firebase/firestore'

const props = withDefaults(defineProps<{
  task: Task
  selected: boolean
}>(), {
})

const emit = defineEmits<{
  select: []
  complete: []
}>()

// スワイプ検出
const SWIPE_THRESHOLD = 90
const MAX_SWIPE_OFFSET = 120
const touchStartX = ref(0)
const touchStartY = ref(0)
const swipeOffset = ref(0)
const isSwiping = ref(false)
const gestureDirection = ref<'undecided' | 'horizontal' | 'vertical'>('undecided')

function handleTouchStart(e: TouchEvent) {
  touchStartX.value = e.touches[0]!.clientX
  touchStartY.value = e.touches[0]!.clientY
  swipeOffset.value = 0
  isSwiping.value = false
  gestureDirection.value = 'undecided'
}

function handleTouchMove(e: TouchEvent) {
  const touch = e.touches[0]
  if (!touch) return

  const dx = touch.clientX - touchStartX.value
  const dy = touch.clientY - touchStartY.value

  if (gestureDirection.value === 'undecided') {
    if (Math.abs(dy) > Math.abs(dx)) {
      gestureDirection.value = 'vertical'
      return
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      gestureDirection.value = 'horizontal'
    }
  }

  if (gestureDirection.value !== 'horizontal') return

  // 左スワイプのみ追跡（閾値を超える余地を残して最大値を少し広げる）
  if (dx < 0) {
    swipeOffset.value = Math.max(dx, -MAX_SWIPE_OFFSET)
    isSwiping.value = true
  }
}

function handleTouchEnd() {
  if (swipeOffset.value <= -SWIPE_THRESHOLD) {
    emit('complete')
  }
  swipeOffset.value = 0
  isSwiping.value = false
  gestureDirection.value = 'undecided'
}

function handleTouchCancel() {
  swipeOffset.value = 0
  isSwiping.value = false
  gestureDirection.value = 'undecided'
}

function formatDate(timestamp: Timestamp | null): string {
  if (!timestamp) return ''
  const date = timestamp.toDate()
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  if (date.toDateString() === today.toDateString()) return '今日'
  if (date.toDateString() === tomorrow.toDateString()) return '明日'

  return `${date.getMonth() + 1}/${date.getDate()}`
}

const isOverdue = computed(() => {
  if (!props.task.dueDate || props.task.completed) return false
  return props.task.dueDate.toDate() < new Date()
})
</script>

<template>
  <div
    class="task-item relative overflow-hidden rounded-lg"
    @touchstart="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
    @touchcancel="handleTouchCancel"
  >
    <!-- スワイプ時の背景（チェックマーク） -->
    <div
      class="absolute inset-0 flex items-center justify-end pr-4 rounded-lg transition-opacity"
      :class="task.completed ? 'bg-orange-400' : 'bg-green-500'"
      :style="{ opacity: Math.min(Math.abs(swipeOffset) / SWIPE_THRESHOLD, 1) }"
    >
      <span class="text-white text-lg font-bold">{{ task.completed ? '↩' : '✓' }}</span>
    </div>
    <!-- タスク本体（スワイプでスライド） -->
  <div
    @click="emit('select')"
    class="relative flex items-start gap-1.5 sm:gap-2 py-3 px-2 sm:py-3 sm:px-3 rounded-lg cursor-pointer transition-colors bg-white"
    :class="[
      selected ? 'bg-blue-50 border border-blue-200' : 'hover:bg-gray-50 border border-transparent',
      task.completed ? 'opacity-60' : ''
    ]"
    :style="isSwiping ? { transform: `translateX(${swipeOffset}px)`, transition: 'none' } : { transform: 'translateX(0)', transition: 'transform 0.2s ease' }"
  >
    <!-- 優先度インジケーター（左側） -->
    <div
      v-if="task.priority < 4"
      class="w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
      :class="{
        'bg-red-500': task.priority === 1,
        'bg-orange-500': task.priority === 2,
        'bg-blue-500': task.priority === 3,
      }"
    ></div>
    <div v-else class="w-2 flex-shrink-0"></div>

    <!-- タスク情報 -->
    <div class="flex-1 min-w-0 overflow-hidden">
      <p
        class="text-gray-800 truncate text-sm sm:text-base"
        :class="{ 'line-through text-gray-500': task.completed }"
      >
        {{ task.name }}
      </p>

      <div class="flex items-center gap-1 sm:gap-2 mt-0.5 sm:mt-1 text-xs">
        <!-- 期限 -->
        <span
          v-if="task.dueDate"
          class="flex items-center gap-0.5 sm:gap-1"
          :class="isOverdue ? 'text-red-500' : 'text-gray-500'"
        >
          <span class="hidden sm:inline">📅</span> {{ formatDate(task.dueDate) }}
        </span>

        <!-- タグ（モバイルでは1つまで） -->
        <span
          v-for="tag in task.tags.slice(0, 1)"
          :key="tag"
          class="text-gray-400 truncate max-w-[60px] sm:max-w-none"
        >
          #{{ tag }}
        </span>
        <span v-if="task.tags.length > 1" class="text-gray-400 sm:hidden">
          +{{ task.tags.length - 1 }}
        </span>
        <!-- デスクトップでは2つまで表示 -->
        <span
          v-for="tag in task.tags.slice(1, 2)"
          :key="tag"
          class="text-gray-400 hidden sm:inline"
        >
          #{{ tag }}
        </span>
        <span v-if="task.tags.length > 2" class="text-gray-400 hidden sm:inline">
          +{{ task.tags.length - 2 }}
        </span>
      </div>
    </div>
  </div>
  </div>
</template>

<style scoped>
.task-item {
  touch-action: pan-y;
}
</style>
