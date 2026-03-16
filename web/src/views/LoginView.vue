<script setup lang="ts">
import { watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'

const authStore = useAuthStore()
const router = useRouter()

watch(
  () => authStore.isAuthenticated,
  (isAuthenticated) => {
    if (!isAuthenticated) return
    void router.replace({ name: 'home' })
  },
  { immediate: true }
)

async function handleGoogleLogin() {
  try {
    await authStore.loginWithGoogle()
    await router.replace({ name: 'home' })
  } catch (e) {
    console.error('Login failed:', e)
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-100">
    <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
      <div class="mb-8 flex items-center justify-center gap-3">
        <img src="/icons/icon.svg" alt="TodoBridge" class="h-12 w-12" />
        <span class="text-xl font-medium tracking-tight text-gray-700">TodoBridge</span>
      </div>
      <p class="text-gray-600 text-center mb-6">
        共有対応のタスク管理アプリ
      </p>

      <button
        @click="handleGoogleLogin"
        :disabled="authStore.loading"
        class="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 rounded-lg px-6 py-3 text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg class="w-5 h-5" viewBox="0 0 24 24">
          <path
            fill="#4285F4"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          />
          <path
            fill="#34A853"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          />
          <path
            fill="#FBBC05"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
          />
          <path
            fill="#EA4335"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
          />
        </svg>
        <span>{{ authStore.loading ? 'ログイン中...' : 'Googleでログイン' }}</span>
      </button>

      <p v-if="authStore.error" class="mt-4 text-red-500 text-center text-sm">
        {{ authStore.error }}
      </p>
    </div>
  </div>
</template>
