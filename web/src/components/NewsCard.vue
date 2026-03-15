<!-- web/src/components/NewsCard.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NewsArticle } from '@/types'

const props = defineProps<{
  article: NewsArticle
  variant?: 'hero' | 'featured' | 'default'
}>()

const emit = defineEmits<{
  bookmark: [article: NewsArticle]
  dismiss: [article: NewsArticle]
  articleClick: [article: NewsArticle]
}>()

const imageLoadFailed = ref(false)
const BRAND_ACCENT_COLORS = {
  openai: '#93c5fd',
  anthropic: '#fdba74',
  gemini: '#86efac',
  copilot: '#67e8f9',
} as const
const fallbackAccentPalette = ['#fecdd3', '#fbcfe8', '#ddd6fe', '#c7d2fe', '#bfdbfe', '#bae6fd', '#a7f3d0', '#fde68a']

const normalizedTags = computed(() =>
  (props.article.tags ?? []).map(tag => tag.toLowerCase())
)

function getFallbackAccentColor(article: NewsArticle): string {
  const seed = article.id || article.url || article.title
  let hash = 0

  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }

  return fallbackAccentPalette[hash % fallbackAccentPalette.length] ?? '#0f766e'
}

const accentColor = computed(() => {
  if (normalizedTags.value.some(tag => ['openai', 'codex', 'gpt', 'chatgpt'].includes(tag))) {
    return BRAND_ACCENT_COLORS.openai
  }
  if (normalizedTags.value.some(tag => ['anthropic', 'claude', 'claude-code'].includes(tag))) {
    return BRAND_ACCENT_COLORS.anthropic
  }
  if (normalizedTags.value.some(tag => ['google', 'gemini'].includes(tag))) {
    return BRAND_ACCENT_COLORS.gemini
  }
  if (normalizedTags.value.some(tag => ['copilot', 'github-copilot', 'microsoft'].includes(tag))) {
    return BRAND_ACCENT_COLORS.copilot
  }
  return getFallbackAccentColor(props.article)
})

const cardClass = computed(() => {
  if (props.variant === 'hero') {
    return 'border-gray-200 bg-white p-3 hover:bg-gray-50 active:bg-gray-100 xl:min-h-[360px] xl:border-gray-300 xl:bg-white/95 xl:p-4 xl:shadow-sm xl:hover:bg-white'
  }
  if (props.variant === 'featured') {
    return 'border-gray-200 bg-white p-3 hover:bg-gray-50 active:bg-gray-100 xl:min-h-[180px] xl:p-4 xl:shadow-sm xl:hover:bg-white'
  }
  return 'border-gray-200 bg-white p-3 hover:bg-gray-50 active:bg-gray-100'
})

const thumbnailClass = computed(() => {
  if (props.variant === 'hero') return 'h-14 w-14 rounded xl:h-48 xl:w-full xl:rounded-xl md:xl:h-56'
  if (props.variant === 'featured') return 'h-14 w-14 rounded xl:h-28 xl:w-full xl:rounded-lg'
  return 'h-14 w-14 rounded'
})

const titleClass = computed(() => {
  if (props.variant === 'hero') return 'text-sm font-semibold leading-snug text-gray-900 xl:text-xl xl:text-gray-950 xl:line-clamp-3'
  if (props.variant === 'featured') return 'text-sm font-semibold leading-snug text-gray-900 xl:text-base xl:line-clamp-2'
  return 'text-sm font-semibold leading-snug text-gray-900'
})

const summaryClass = computed(() => {
  if (props.variant === 'hero') return 'mt-2 text-xs leading-relaxed text-gray-500 line-clamp-3 xl:mt-3 xl:text-sm xl:text-gray-600 xl:line-clamp-4'
  if (props.variant === 'featured') return 'mt-2 text-xs leading-relaxed text-gray-500 line-clamp-3'
  return 'mt-2 text-xs leading-relaxed text-gray-500 line-clamp-3'
})

const metaClass = computed(() => {
  if (props.variant === 'hero') return 'mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-400 xl:mt-2 xl:text-gray-500'
  return 'mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-400'
})

const showsHeaderContent = computed(() => props.variant === 'hero' || props.variant === 'featured')
const mobileBadges = computed(() => {
  const badges: string[] = []
  if (props.article.isOfficial) badges.push('公式')
  if (props.article.platform === 'ios') badges.push('iOS')
  if (props.article.platform === 'android') badges.push('Android')
  if (props.article.actionRequired) badges.push('要対応')
  if (props.article.actionType === 'sdk_requirement') badges.push('SDK')
  if (props.article.actionType === 'policy' || props.article.actionType === 'play_policy') badges.push('ポリシー')
  return badges
})

const thumbnailUrl = computed(() => {
  const url = props.article.thumbnailUrl
  if (!url || imageLoadFailed.value) return null

  // GitHub OGP は 429 が出やすいため、GitHub記事では画像を読まない
  if (props.article.source === 'github' || url.includes('opengraph.githubassets.com')) {
    return null
  }

  return url
})

function formatScore(article: NewsArticle): string {
  if (article.source === 'hn' && article.score !== null) {
    return `★ ${article.score.toLocaleString()}pt`
  }
  if (article.source === 'reddit' && article.score !== null) {
    return `↑ ${article.score.toLocaleString()}`
  }
  return ''
}

function formatDate(article: NewsArticle): string {
  if (!article.publishedAt) return ''
  
  let date: Date
  if (typeof (article.publishedAt as any).toDate === 'function') {
    date = (article.publishedAt as any).toDate()
  } else if (article.publishedAt instanceof Date) {
    date = article.publishedAt
  } else if (typeof article.publishedAt === 'string') {
    date = new Date(article.publishedAt)
  } else if (typeof (article.publishedAt as any)._seconds === 'number') {
    date = new Date((article.publishedAt as any)._seconds * 1000)
  } else {
    return ''
  }
  
  return date.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
}

function openArticle(): void {
  emit('articleClick', props.article)
  window.open(props.article.url, '_blank', 'noopener,noreferrer')
}

function handleImageError(): void {
  imageLoadFailed.value = true
}
</script>

<template>
  <div
    class="relative overflow-hidden border cursor-pointer transition-colors"
    :class="cardClass"
    :style="{ boxShadow: `inset 5px 0 0 ${accentColor}` }"
    @click="openArticle"
  >
    <div v-if="showsHeaderContent" class="space-y-3 xl:space-y-3">
      <div
        class="hidden overflow-hidden bg-gray-100 xl:block"
        :class="thumbnailClass"
      >
        <img
          v-if="thumbnailUrl"
          :src="thumbnailUrl"
          :alt="article.titleJa"
          class="h-full w-full object-cover"
          @error="handleImageError"
        />
        <div v-else class="flex h-full w-full items-center justify-center p-4 text-center text-xs text-gray-400">
          {{ article.sourceName }}
        </div>
      </div>

      <div class="flex gap-3 xl:hidden">
        <div class="flex h-14 w-14 flex-shrink-0 overflow-hidden bg-gray-100 xl:hidden" :class="thumbnailClass">
          <img
            v-if="thumbnailUrl"
            :src="thumbnailUrl"
            :alt="article.titleJa"
            class="h-full w-full object-cover"
            @error="handleImageError"
          />
          <div v-else class="flex h-full w-full items-center justify-center p-1 text-center text-xs text-gray-400">
            {{ article.sourceName }}
          </div>
        </div>

        <div class="min-w-0 flex-1">
          <p :class="titleClass">
            {{ article.titleJa || article.title }}
          </p>
          <div :class="metaClass">
            <span>{{ article.sourceName }}</span>
            <span v-if="formatScore(article)">{{ formatScore(article) }}</span>
            <span>{{ formatDate(article) }}</span>
          </div>
        </div>

        <div class="flex flex-shrink-0 flex-col gap-1 self-start">
          <button
            class="rounded-full p-1 text-gray-400 hover:text-blue-500"
            @click.stop="emit('bookmark', article)"
            title="あとで読む"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          </button>
          <button
            class="rounded-full p-1 text-gray-300 hover:text-red-400"
            @click.stop="emit('dismiss', article)"
            title="興味なし"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div class="hidden xl:flex xl:items-start xl:gap-3">
        <div class="min-w-0 flex-1">
          <p :class="titleClass">
            {{ article.titleJa || article.title }}
          </p>
          <div :class="metaClass">
            <span>{{ article.sourceName }}</span>
            <span v-if="formatScore(article)">{{ formatScore(article) }}</span>
            <span>{{ formatDate(article) }}</span>
          </div>
        </div>

        <div class="flex flex-shrink-0 flex-col gap-1 self-start">
          <button
            class="rounded-full p-1 text-gray-400 hover:text-blue-500"
            @click.stop="emit('bookmark', article)"
            title="あとで読む"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          </button>
          <button
            class="rounded-full p-1 text-gray-300 hover:text-red-400"
            @click.stop="emit('dismiss', article)"
            title="興味なし"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <p v-if="article.summaryJa" :class="summaryClass">
        {{ article.summaryJa }}
      </p>

      <div v-if="mobileBadges.length > 0" class="flex flex-wrap gap-1">
        <span
          v-for="badge in mobileBadges"
          :key="badge"
          class="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700"
        >
          {{ badge }}
        </span>
      </div>

      <div v-if="article.tags && article.tags.length > 0" class="flex flex-wrap gap-1">
        <span
          v-for="tag in article.tags"
          :key="tag"
          class="rounded-full bg-gray-100 px-2 py-1 text-[10px] font-medium text-gray-600"
        >
          #{{ tag }}
        </span>
      </div>
    </div>

    <div v-else class="flex gap-3">
      <div class="flex h-14 w-14 flex-shrink-0 overflow-hidden bg-gray-100" :class="thumbnailClass">
        <img
          v-if="thumbnailUrl"
          :src="thumbnailUrl"
          :alt="article.titleJa"
          class="h-full w-full object-cover"
          @error="handleImageError"
        />
        <div v-else class="flex h-full w-full items-center justify-center p-1 text-center text-xs text-gray-400">
          {{ article.sourceName }}
        </div>
      </div>

      <div class="min-w-0 flex-1">
        <p :class="titleClass">
          {{ article.titleJa || article.title }}
        </p>
        <div :class="metaClass">
          <span>{{ article.sourceName }}</span>
          <span v-if="formatScore(article)">{{ formatScore(article) }}</span>
          <span>{{ formatDate(article) }}</span>
        </div>
      </div>

      <div class="flex flex-shrink-0 flex-col gap-1 self-start">
        <button
          class="rounded-full p-1 text-gray-400 hover:text-blue-500"
          @click.stop="emit('bookmark', article)"
          title="あとで読む"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        </button>
        <button
          class="rounded-full p-1 text-gray-300 hover:text-red-400"
          @click.stop="emit('dismiss', article)"
          title="興味なし"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <p v-if="!showsHeaderContent && article.summaryJa" :class="summaryClass">
      {{ article.summaryJa }}
    </p>

    <div v-if="!showsHeaderContent && mobileBadges.length > 0" class="mt-2 flex flex-wrap gap-1">
      <span
        v-for="badge in mobileBadges"
        :key="badge"
        class="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"
      >
        {{ badge }}
      </span>
    </div>

    <div v-if="!showsHeaderContent && article.tags && article.tags.length > 0" class="mt-2 flex flex-wrap gap-1">
      <span
        v-for="tag in article.tags"
        :key="tag"
        class="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
      >
        #{{ tag }}
      </span>
    </div>
  </div>
</template>
