<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

const newsLinks = [
  {
    title: 'AIニュース',
    description: '生成AI、開発ツール、OSSなどの技術ニュースを確認します。',
    to: '/news/ai',
    accent: 'from-sky-500 to-cyan-500',
  },
  {
    title: 'モバイルニュース',
    description: 'Apple と Android の公式情報を中心に、要対応の更新を追います。',
    to: '/news/mobile',
    accent: 'from-emerald-500 to-teal-500',
  },
]

function goHome() {
  router.push({ name: 'home' })
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 px-4 py-24">
    <div class="mx-auto max-w-4xl">
      <div class="mb-8">
        <button
          type="button"
          class="mb-4 inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 shadow-sm transition hover:border-gray-300 hover:text-gray-900"
          @click="goHome"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
          Todoに戻る
        </button>
        <h1 class="text-2xl font-semibold text-gray-900">ニュース</h1>
        <p class="mt-2 text-sm text-gray-500">確認したいトピックを選択してください。</p>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <router-link
          v-for="link in newsLinks"
          :key="link.to"
          :to="link.to"
          class="group overflow-hidden rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <div class="mb-4 h-2 rounded-full bg-gradient-to-r" :class="link.accent" />
          <h2 class="text-lg font-semibold text-gray-900">{{ link.title }}</h2>
          <p class="mt-2 text-sm leading-relaxed text-gray-500">{{ link.description }}</p>
          <div class="mt-5 text-sm font-medium text-gray-700 group-hover:text-gray-900">開く</div>
        </router-link>
      </div>
    </div>
  </div>
</template>
