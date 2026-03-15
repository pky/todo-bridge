<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useListsStore } from '@/stores/lists'
import { useSpaceStore } from '@/stores/space'
import { useTasksStore } from '@/stores/tasks'
import { useRouter } from 'vue-router'
import Sidebar from '@/components/Sidebar.vue'
import TaskList from '@/components/TaskList.vue'
import TaskDetail from '@/components/TaskDetail.vue'

const authStore = useAuthStore()
const listsStore = useListsStore()
const spaceStore = useSpaceStore()
const tasksStore = useTasksStore()
const router = useRouter()
let reloadSequence = 0

// リスト選択が変更されたらタスクを再購読
// immediate: trueで初回ロード時も処理（リスナー登録の一元管理）
watch(
  () => listsStore.selectedListId,
  (newListId) => {
    if (newListId) {
      listsStore.selectSmartList(null) // スマートリスト選択を解除
      tasksStore.subscribeToList(newListId)
    }
  },
  { immediate: true }
)

// 検索入力（ローカルキャッシュから検索、サーバー読み込みなし）
function handleSearchInput(value: string) {
  tasksStore.setSearchQuery(value)
}

// モバイル用の状態管理
const isSidebarOpen = ref(false)
const isMobile = ref(false)
const isSearchOpen = ref(false)

// 画面サイズの検出
function checkMobile() {
  isMobile.value = window.innerWidth < 768
  // デスクトップではサイドバーを閉じない
  if (!isMobile.value) {
    isSidebarOpen.value = false
  }
}

// タスク詳細がモバイルで開いているか
const isDetailOpen = computed(() => isMobile.value && tasksStore.selectedTaskId !== null)

async function reloadHomeData() {
  if (!authStore.isAuthenticated) return

  const currentSequence = ++reloadSequence
  listsStore.unsubscribe()
  tasksStore.unsubscribe()

  try {
    await listsStore.subscribe()
    if (currentSequence !== reloadSequence) return
    tasksStore.subscribe()
  } catch (error) {
    if (currentSequence !== reloadSequence) return
    console.error('[HomeView] Reload error:', error)
  }
}

onMounted(async () => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
  await reloadHomeData()
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
  reloadSequence++
  listsStore.unsubscribe()
  tasksStore.unsubscribe()
})

watch(
  () => [
    authStore.isAuthenticated,
    spaceStore.initialized,
    spaceStore.currentSpaceId,
    spaceStore.useLegacyPath,
  ],
  async ([isAuthenticated, initialized]) => {
    if (!isAuthenticated) {
      reloadSequence++
      listsStore.unsubscribe()
      tasksStore.unsubscribe()
      return
    }

    if (!initialized) return
    await reloadHomeData()
  }
)

async function handleLogout() {
  reloadSequence++
  listsStore.unsubscribe()
  tasksStore.unsubscribe()
  await authStore.logout()
  router.push({ name: 'login' })
}

function toggleSidebar() {
  isSidebarOpen.value = !isSidebarOpen.value
}

function closeSidebar() {
  isSidebarOpen.value = false
}

function closeDetail() {
  tasksStore.selectTask(null)
}
</script>

<template>
  <div class="h-screen w-full max-w-full bg-gray-100 flex flex-col overflow-hidden">
    <!-- Header -->
    <header class="bg-white shadow flex-shrink-0 z-30">
      <div class="px-2 sm:px-4 py-2 sm:py-3 flex items-center justify-between">
        <div class="flex items-center gap-1 sm:gap-3">
          <!-- ハンバーガーメニュー（モバイルのみ） -->
          <button
            @click="toggleSidebar"
            class="md:hidden p-1.5 sm:p-2 -ml-1 sm:-ml-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg"
            aria-label="メニュー"
          >
            <svg class="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <img src="/logo.svg" alt="TodoBridge" class="h-6 sm:h-8" />
          <!-- 検索バー -->
          <div class="relative hidden md:block">
            <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              :value="tasksStore.searchQuery"
              @input="handleSearchInput(($event.target as HTMLInputElement).value)"
              placeholder="タスクを検索..."
              class="pl-9 pr-8 py-1.5 w-64 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button
              v-if="tasksStore.searchQuery"
              @click="tasksStore.clearSearch()"
              class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div class="flex items-center gap-1 sm:gap-4">
          <!-- モバイル検索ボタン -->
          <button
            @click="isSearchOpen = !isSearchOpen"
            class="md:hidden p-1.5 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg"
            aria-label="検索"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
          <router-link
            to="/news"
            class="hidden md:inline text-gray-600 hover:text-blue-600 text-sm"
          >
            ニュース
          </router-link>
          <router-link
            to="/settings"
            class="text-gray-600 hover:text-blue-600 text-sm hidden md:inline"
          >
            設定
          </router-link>
          <div class="flex items-center gap-1 md:gap-2">
            <img
              v-if="authStore.user?.photoURL"
              :src="authStore.user.photoURL"
              alt="Profile"
              class="w-7 h-7 md:w-8 md:h-8 rounded-full"
            />
            <span class="text-gray-700 hidden md:inline">{{ authStore.user?.displayName }}</span>
          </div>
          <button
            @click="handleLogout"
            class="text-gray-600 hover:text-gray-800 text-sm hidden md:inline"
          >
            ログアウト
          </button>
        </div>
      </div>
      <!-- モバイル検索バー -->
      <div
        v-if="isSearchOpen"
        class="md:hidden px-4 py-2 border-t border-gray-100"
      >
        <div class="relative">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            :value="tasksStore.searchQuery"
            @input="handleSearchInput(($event.target as HTMLInputElement).value)"
            placeholder="タスクを検索..."
            class="w-full pl-9 pr-8 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            autofocus
          />
          <button
            v-if="tasksStore.searchQuery"
            @click="tasksStore.clearSearch()"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </header>

    <!-- Main Content -->
    <main class="flex-1 w-full max-w-full flex flex-col overflow-hidden relative">
      <!-- デスクトップ: 3カラムレイアウト -->
      <div class="hidden md:grid md:grid-cols-12 gap-4 flex-1 min-h-0 py-4 px-4">
        <!-- Sidebar: Lists -->
        <div class="md:col-span-3 lg:col-span-2 bg-white rounded-lg shadow p-4 overflow-y-auto">
          <Sidebar />
        </div>

        <!-- Task List -->
        <div class="md:col-span-4 lg:col-span-4 bg-white rounded-lg shadow p-4 overflow-y-auto">
          <TaskList />
        </div>

        <!-- Task Detail -->
        <div class="md:col-span-5 lg:col-span-6 bg-white rounded-lg shadow p-4 overflow-y-auto">
          <TaskDetail />
        </div>
      </div>

      <!-- モバイル: シングルカラム -->
      <div class="md:hidden flex-1 flex flex-col min-h-0 overflow-x-hidden">
        <!-- タスクリスト（常に表示） -->
        <div class="flex-1 bg-white m-2 sm:m-4 rounded-lg shadow p-3 sm:p-4 overflow-y-auto overflow-x-hidden">
          <TaskList />
        </div>
      </div>

      <!-- モバイル: サイドバーオーバーレイ -->
      <Transition name="fade">
        <div
          v-if="isSidebarOpen && isMobile"
          @click="closeSidebar"
          class="fixed inset-0 bg-black/50 z-40 md:hidden"
        />
      </Transition>
      <Transition name="slide-left">
        <div
          v-if="isSidebarOpen && isMobile"
          class="fixed inset-y-0 left-0 w-72 bg-white shadow-xl z-50 md:hidden flex flex-col"
        >
          <div class="flex items-center justify-between p-4 border-b">
            <h2 class="font-semibold text-gray-700">リスト</h2>
            <button
              @click="closeSidebar"
              class="p-2 text-gray-400 hover:text-gray-600 rounded-lg"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-4">
            <Sidebar @list-selected="closeSidebar" />
          </div>
          <div class="border-t border-gray-200 p-3 flex gap-2">
            <router-link
              to="/news"
              class="flex-1 text-center text-xs text-gray-600 hover:text-blue-600 py-2 px-1 rounded hover:bg-gray-50"
              @click="closeSidebar"
            >
              ニュース
            </router-link>
            <router-link
              to="/settings"
              class="flex-1 text-center text-xs text-gray-600 hover:text-blue-600 py-2 px-1 rounded hover:bg-gray-50"
              @click="closeSidebar"
            >
              設定
            </router-link>
            <button
              @click="handleLogout"
              class="flex-1 text-center text-xs text-gray-600 hover:text-red-600 py-2 px-1 rounded hover:bg-gray-50"
            >
              ログアウト
            </button>
          </div>
        </div>
      </Transition>

      <!-- モバイル: タスク詳細オーバーレイ -->
      <Transition name="slide-up">
        <div
          v-if="isDetailOpen"
          class="fixed inset-0 bg-white z-40 md:hidden flex flex-col"
        >
          <div class="flex items-center justify-between p-4 border-b bg-white">
            <button
              @click="closeDetail"
              class="flex items-center gap-2 text-blue-600 hover:text-blue-800"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
              </svg>
              <span>戻る</span>
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-4">
            <TaskDetail :show-header="false" />
          </div>
        </div>
      </Transition>
    </main>
  </div>
</template>

<style scoped>
/* フェードアニメーション */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 左からスライドイン */
.slide-left-enter-active,
.slide-left-leave-active {
  transition: transform 0.3s ease;
}
.slide-left-enter-from,
.slide-left-leave-to {
  transform: translateX(-100%);
}

/* 下からスライドアップ */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.3s ease;
}
.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
}
</style>
