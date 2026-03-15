<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ToastNotification from '@/components/ToastNotification.vue'
import { useAuthStore } from '@/stores/auth'
// import { useCalendarStore } from '@/stores/calendar' // TODO: カレンダー機能を一時無効化
import { useRegisterSW } from 'virtual:pwa-register/vue'

const authStore = useAuthStore()
// const calendarStore = useCalendarStore() // TODO: カレンダー機能を一時無効化

// PWA更新検知
const {
  needRefresh,
  updateServiceWorker,
} = useRegisterSW({
  immediate: true, // すぐに更新チェック
  onRegistered(r) {
    console.log('SW registered:', r)
    if (r) {
      // 10分ごとに更新をチェック
      setInterval(() => r.update(), 10 * 60 * 1000)
      // フォアグラウンド復帰時にも更新チェック
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') r.update()
      })
    }
  },
  onNeedRefresh() {
    console.log('New version available!')
  },
  onOfflineReady() {
    console.log('App is ready for offline use')
  },
})

const showUpdateToast = ref(true)

function handleUpdate() {
  updateServiceWorker(true)
  // iOS PWAではcontrollerchangeイベントが発火しない場合があるため強制リロード
  setTimeout(() => window.location.reload(), 1500)
}

function dismissUpdate() {
  showUpdateToast.value = false
}

onMounted(async () => {
  await authStore.initAuth()
})
</script>

<template>
  <div v-if="authStore.loading" class="min-h-screen flex items-center justify-center">
    <div class="text-gray-500">読み込み中...</div>
  </div>
  <router-view v-else />

  <!-- PWA更新通知 -->
  <Transition name="slide-up">
    <div
      v-if="needRefresh && showUpdateToast"
      class="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-80 bg-blue-600 text-white rounded-lg shadow-lg p-4 z-50"
    >
      <div class="flex items-start gap-3">
        <div class="flex-1">
          <p class="font-medium">新しいバージョンがあります</p>
          <p class="text-sm text-blue-100 mt-1">更新して最新版を使用しますか？</p>
        </div>
        <button
          @click="dismissUpdate"
          class="text-blue-200 hover:text-white"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="flex gap-2 mt-3">
        <button
          @click="handleUpdate"
          class="flex-1 px-4 py-2 bg-white text-blue-600 rounded font-medium hover:bg-blue-50 transition-colors"
        >
          更新する
        </button>
        <button
          @click="dismissUpdate"
          class="px-4 py-2 text-blue-100 hover:text-white transition-colors"
        >
          後で
        </button>
      </div>
    </div>
  </Transition>

  <!-- エラートースト -->
  <ToastNotification />
</template>

<style scoped>
.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}
.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translateY(100%);
}
</style>
