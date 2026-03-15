<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useNewsStore } from '@/stores/news'
import type { KeywordWeight } from '@/types'
import type { NewsTopic } from '@/types/news'

const newsStore = useNewsStore()
const newsKeywords = ref<KeywordWeight[]>([])
const currentTopic = ref<NewsTopic>('ai')
const mobilePlatforms = ref<Array<'ios' | 'android'>>(['ios', 'android'])
const officialOnly = ref(false)
const includeCommunity = ref(true)
const actionRequiredOnly = ref(false)

async function loadTopicPreferences(topic: NewsTopic): Promise<void> {
  await newsStore.loadPreferences(topic)
  newsKeywords.value = [...newsStore.preferences.keywords]
  mobilePlatforms.value = [...(newsStore.preferences.platforms ?? ['ios', 'android'])]
  officialOnly.value = newsStore.preferences.officialOnly ?? false
  includeCommunity.value = newsStore.preferences.includeCommunity ?? true
  actionRequiredOnly.value = newsStore.preferences.actionRequiredOnly ?? false
}

onMounted(async () => {
  await loadTopicPreferences(currentTopic.value)
})

async function switchTopic(topic: NewsTopic): Promise<void> {
  if (currentTopic.value === topic) return
  currentTopic.value = topic
  await loadTopicPreferences(topic)
}

async function saveCurrentPreferences(): Promise<void> {
  const valid = newsKeywords.value.filter((kw) => kw.word.trim() !== '')
  await newsStore.saveFullPreferences({
    keywords: valid,
    ...(currentTopic.value === 'mobile'
      ? {
          platforms: [...mobilePlatforms.value],
          officialOnly: officialOnly.value,
          includeCommunity: includeCommunity.value,
          actionRequiredOnly: actionRequiredOnly.value,
        }
      : {}),
  }, currentTopic.value)
  alert('保存しました')
}
</script>

<template>
  <section class="bg-white rounded-lg border border-gray-200 overflow-hidden">
    <div class="px-4 py-3 border-b border-gray-100">
      <h2 class="text-sm font-semibold text-gray-700">ニュースキーワード優先度</h2>
      <p class="text-xs text-gray-500 mt-0.5">
        優先したいキーワードは重み2.0以上、優先度を下げたいキーワードは1.0未満に設定
      </p>
    </div>

    <div class="px-4 py-3 border-b border-gray-100">
      <div class="flex gap-2">
        <button
          class="rounded-full px-3 py-1 text-xs font-medium"
          :class="currentTopic === 'ai' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'"
          @click="switchTopic('ai')"
        >
          AI
        </button>
        <button
          class="rounded-full px-3 py-1 text-xs font-medium"
          :class="currentTopic === 'mobile' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'"
          @click="switchTopic('mobile')"
        >
          モバイル
        </button>
      </div>
    </div>

    <div class="px-4 py-3 space-y-2">
      <div v-if="currentTopic === 'mobile'" class="space-y-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
        <div>
          <p class="text-xs font-semibold text-gray-700">対象プラットフォーム</p>
          <div class="mt-2 flex gap-2">
            <label class="flex items-center gap-1 text-sm text-gray-600">
              <input v-model="mobilePlatforms" type="checkbox" value="ios" />
              iOS
            </label>
            <label class="flex items-center gap-1 text-sm text-gray-600">
              <input v-model="mobilePlatforms" type="checkbox" value="android" />
              Android
            </label>
          </div>
        </div>

        <label class="flex items-center justify-between gap-3 text-sm text-gray-600">
          <span>公式のみ表示</span>
          <input v-model="officialOnly" type="checkbox" />
        </label>

        <label class="flex items-center justify-between gap-3 text-sm text-gray-600">
          <span>補完RSSを含める</span>
          <input v-model="includeCommunity" type="checkbox" />
        </label>

        <label class="flex items-center justify-between gap-3 text-sm text-gray-600">
          <span>要対応のみを優先</span>
          <input v-model="actionRequiredOnly" type="checkbox" />
        </label>
      </div>

      <div
        v-for="(kw, index) in newsKeywords"
        :key="index"
        class="flex items-center gap-2"
      >
        <input
          v-model="kw.word"
          type="text"
          placeholder="キーワード"
          class="flex-1 text-sm border border-gray-300 rounded px-2 py-1"
        />
        <input
          v-model.number="kw.weight"
          type="number"
          min="0.1"
          max="5.0"
          step="0.1"
          class="w-16 text-sm border border-gray-300 rounded px-2 py-1 text-center"
        />
        <button
          class="text-red-400 hover:text-red-600 text-xs"
          @click="newsKeywords.splice(index, 1)"
        >
          削除
        </button>
      </div>

      <button
        class="text-sm text-blue-500 hover:text-blue-700"
        @click="newsKeywords.push({ word: '', weight: 1.0 })"
      >
        + キーワードを追加
      </button>
    </div>

    <div class="px-4 py-3 border-t border-gray-100">
      <button
        class="w-full bg-blue-500 text-white text-sm rounded-lg py-2 hover:bg-blue-600"
        @click="saveCurrentPreferences"
      >
        保存
      </button>
    </div>
  </section>
</template>
