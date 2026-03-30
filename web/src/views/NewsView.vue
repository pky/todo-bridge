<!-- web/src/views/NewsView.vue -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNewsStore } from '@/stores/news'
import NewsCard from '@/components/NewsCard.vue'
import type { NewsArticle } from '@/types'
import type { NewsTopic } from '@/types/news'

const router = useRouter()
const route = useRoute()

const newsStore = useNewsStore()
const bookmarkToast = ref(false)
const showScrollTop = ref(false)
const listContainerRef = ref<HTMLElement | null>(null)
const mobileFilter = ref<'all' | 'required' | 'ios' | 'android'>('required')

const currentTopic = computed<NewsTopic>(() => route.name === 'news-mobile' ? 'mobile' : 'ai')
const pageTitle = computed(() => currentTopic.value === 'mobile' ? 'モバイルニュース' : 'AIニュース')
const pageSubtitle = computed(() => currentTopic.value === 'mobile' ? 'Apple / Android の公式情報を優先表示' : '毎朝6時更新')
const isMobileTopic = computed(() => currentTopic.value === 'mobile')

function isImportantArticle(article: NewsArticle): boolean {
  return article.importantLevel === 'urgent'
}

const preferenceFilteredArticles = computed(() => {
  if (!isMobileTopic.value) return newsStore.articles

  return newsStore.articles.filter((article) => {
    const preferredPlatforms = newsStore.preferences.platforms ?? ['ios', 'android']
    const matchesPlatform =
      article.platform === 'cross' ||
      article.platform == null ||
      preferredPlatforms.includes(article.platform)

    if (!matchesPlatform) return false
    if (newsStore.preferences.officialOnly === true && article.isOfficial !== true) return false
    if (newsStore.preferences.includeCommunity === false && article.sourceTier === 'community-rss') return false
    if (newsStore.preferences.actionRequiredOnly === true && article.actionRequired !== true) return false
    return true
  })
})

const filteredArticles = computed(() => {
  if (!isMobileTopic.value) return newsStore.articles

  switch (mobileFilter.value) {
    case 'required':
      return preferenceFilteredArticles.value.filter((article) => isImportantArticle(article))
    case 'ios':
      return preferenceFilteredArticles.value.filter((article) => article.platform === 'ios')
    case 'android':
      return preferenceFilteredArticles.value.filter((article) => article.platform === 'android')
    default:
      return preferenceFilteredArticles.value
  }
})

function getImportanceRank(article: NewsArticle): number {
  let rank = 0
  if (article.importantLevel === 'urgent') rank += 12
  if (article.importantLevel === 'review') rank += 6
  if (article.isOfficial) rank += 4
  if (article.actionRequired) rank += 8
  if (article.requiredByDate) rank += 4

  switch (article.actionType) {
    case 'sdk_requirement':
      rank += 5
      break
    case 'policy':
    case 'play_policy':
      rank += 4
      break
    case 'security':
      rank += 4
      break
    case 'store_review':
      rank += 3
      break
    case 'beta':
      rank += 2
      break
    case 'release':
      rank += 1
      break
  }

  return rank
}

function getImportanceReason(article: NewsArticle): string {
  if (article.importantLevel === 'urgent' && article.requiredByDate) {
    return `期限あり: ${article.requiredByDate} までに確認`
  }
  if (article.actionType === 'sdk_requirement') return 'SDK要件の変更候補'
  if (article.actionType === 'policy' || article.actionType === 'play_policy') return 'ポリシー変更の確認対象'
  if (article.actionType === 'security') return 'セキュリティ関連の確認対象'
  if (article.actionType === 'store_review') return '審査運用への影響候補'
  if (article.importantLevel === 'review') return '公式変更として確認推奨'
  if (article.actionRequired) return '対応要否の確認が必要'
  if (article.isOfficial) return '公式情報として確認推奨'
  return '参考情報'
}

const importantArticles = computed(() => {
  if (!isMobileTopic.value) return []

  const sourceArticles = mobileFilter.value === 'required'
    ? preferenceFilteredArticles.value
    : filteredArticles.value

  return [...sourceArticles]
    .filter((article) => isImportantArticle(article))
    .sort((left, right) => getImportanceRank(right) - getImportanceRank(left))
    .slice(0, 3)
})

const regularArticles = computed(() => {
  if (!isMobileTopic.value) return filteredArticles.value

  const importantIds = new Set(importantArticles.value.map((article) => article.id))
  return filteredArticles.value.filter((article) => !importantIds.has(article.id))
})

const heroArticles = computed(() => {
  if (isMobileTopic.value) return regularArticles.value.slice(0, 3)
  return filteredArticles.value.slice(0, 3)
})
const sideArticles = computed(() => {
  if (isMobileTopic.value) return regularArticles.value.slice(3, 7)
  return filteredArticles.value.slice(3, 7)
})
const remainingArticles = computed(() => {
  if (isMobileTopic.value) return regularArticles.value.slice(7)
  return filteredArticles.value.slice(7)
})

const goBack = () => {
  if (window.history.state && window.history.state.back) {
    router.back()
  } else {
    router.push({ name: 'home' })
  }
}

const openReadLaterInTodo = () => {
  router.push({
    name: 'home',
    query: { target: 'read-later' },
  })
}

const handleScroll = () => {
  // window スクロール
  const scrollY = window.scrollY || document.documentElement.scrollTop
  // 内部コンテナのスクロール
  const containerScrollY = listContainerRef.value?.scrollTop || 0
  
  showScrollTop.value = scrollY > 300 || containerScrollY > 300
}

const scrollToTop = () => {
  window.scrollTo({ top: 0, behavior: 'smooth' })
  if (listContainerRef.value) {
    listContainerRef.value.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

onMounted(async () => {
  window.addEventListener('scroll', handleScroll)
  if (listContainerRef.value) {
    listContainerRef.value.addEventListener('scroll', handleScroll)
  }
  await newsStore.loadPreferences(currentTopic.value)
  await newsStore.loadTodayFeed(currentTopic.value)
})

watch(currentTopic, async (topic, previousTopic) => {
  if (topic === previousTopic) return
  mobileFilter.value = topic === 'mobile' ? 'required' : 'all'
  await newsStore.loadPreferences(topic)
  await newsStore.loadTodayFeed(topic)
})

onUnmounted(() => {
  window.removeEventListener('scroll', handleScroll)
  if (listContainerRef.value) {
    listContainerRef.value.removeEventListener('scroll', handleScroll)
  }
})

async function handleBookmark(article: NewsArticle): Promise<void> {
  try {
    await newsStore.bookmarkArticle(article)
    bookmarkToast.value = true
    setTimeout(() => { bookmarkToast.value = false }, 2000)
  } catch (err) {
    console.error('[news] bookmark failed:', err)
  }
}

async function handleDismiss(article: NewsArticle): Promise<void> {
  await newsStore.dismissArticle(article.id, article.url, currentTopic.value)
}

async function handleArticleClick(article: NewsArticle): Promise<void> {
  await newsStore.trackClick(article, currentTopic.value)
}

</script>

<template>
  <div class="flex flex-col min-h-screen bg-gray-50 pt-[65px]">
    <!-- ヘッダー (fixed で固定) -->
    <header class="fixed top-0 left-0 right-0 z-50 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 shadow-sm">
      <button
        @click="goBack"
        class="text-gray-500 hover:text-gray-700 p-1 -ml-1"
        aria-label="戻る"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div>
        <h1 class="text-base font-semibold text-gray-800">{{ pageTitle }}</h1>
        <p class="text-xs text-gray-400">{{ pageSubtitle }}</p>
      </div>
      <button
        type="button"
        class="ml-auto inline-flex items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:border-gray-300 hover:bg-white hover:text-gray-900"
        @click="openReadLaterInTodo"
      >
        あとで読むを開く
      </button>
    </header>

    <!-- 記事リスト -->
    <div class="flex-1 overflow-y-auto" ref="listContainerRef">
      <div v-if="isMobileTopic" class="sticky top-0 z-10 border-b border-gray-200 bg-white/95 px-3 py-2 backdrop-blur">
        <div class="flex gap-2 overflow-x-auto">
          <button
            class="rounded-full px-3 py-1 text-xs font-medium"
            :class="mobileFilter === 'required' ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-600'"
            @click="mobileFilter = 'required'"
          >
            重要事項
          </button>
          <button
            class="rounded-full px-3 py-1 text-xs font-medium"
            :class="mobileFilter === 'ios' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'"
            @click="mobileFilter = 'ios'"
          >
            iOS
          </button>
          <button
            class="rounded-full px-3 py-1 text-xs font-medium"
            :class="mobileFilter === 'android' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'"
            @click="mobileFilter = 'android'"
          >
            Android
          </button>
          <button
            class="rounded-full px-3 py-1 text-xs font-medium"
            :class="mobileFilter === 'all' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'"
            @click="mobileFilter = 'all'"
          >
            すべて
          </button>
        </div>
      </div>

      <!-- ローディング -->
      <div v-if="newsStore.loading" class="flex justify-center items-center py-12">
        <div class="text-sm text-gray-400">読み込み中...</div>
      </div>

      <!-- エラー -->
      <div v-else-if="newsStore.error" class="px-4 py-8 text-center">
        <p class="text-sm text-red-500">{{ newsStore.error }}</p>
        <button
          class="mt-3 text-sm text-blue-500"
          @click="newsStore.loadTodayFeed(currentTopic)"
        >
          再読み込み
        </button>
      </div>

      <!-- 記事なし -->
      <div v-else-if="filteredArticles.length === 0" class="px-4 py-12 text-center">
        <p class="text-sm text-gray-400">今日の記事はまだありません</p>
        <p class="text-xs text-gray-300 mt-1">毎朝6時に更新されます</p>
      </div>

      <!-- 記事一覧 -->
      <div v-else class="px-3 py-3 pb-20">
        <section
          v-if="isMobileTopic"
          class="mb-3 overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-red-50"
        >
          <div class="border-b border-amber-100 px-4 py-3">
            <p class="text-xs font-semibold tracking-[0.18em] text-amber-700">IMPORTANT</p>
            <h2 class="mt-1 text-base font-semibold text-gray-900">今日の重要事項</h2>
          </div>

          <div v-if="importantArticles.length > 0" class="grid gap-3 px-3 py-3 xl:grid-cols-3">
            <article
              v-for="article in importantArticles"
              :key="`important-${article.id}`"
              class="rounded-xl border border-amber-100 bg-white p-3 shadow-sm"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-xs font-medium text-amber-700">{{ getImportanceReason(article) }}</p>
                  <h3 data-testid="important-title" class="mt-1 text-sm font-semibold leading-snug text-gray-900">
                    {{ article.titleJa || article.title }}
                  </h3>
                </div>
                <button
                  class="rounded-full p-1 text-gray-300 hover:text-red-400"
                  @click.stop="handleDismiss(article)"
                  title="興味なし"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <p v-if="article.summaryJa" class="mt-2 text-xs leading-relaxed text-gray-600">
                {{ article.summaryJa }}
              </p>

              <div class="mt-3 flex items-center justify-between gap-2">
                <div class="flex flex-wrap gap-1 text-[11px]">
                  <span
                    v-if="article.importantLevel === 'urgent'"
                    class="rounded-full bg-red-600 px-2 py-1 text-white"
                  >
                    今すぐ確認
                  </span>
                  <span
                    v-else-if="article.importantLevel === 'review'"
                    class="rounded-full bg-amber-100 px-2 py-1 text-amber-700"
                  >
                    確認推奨
                  </span>
                  <span v-if="article.isOfficial" class="rounded-full bg-gray-900 px-2 py-1 text-white">公式</span>
                  <span v-if="article.platform === 'ios'" class="rounded-full bg-gray-100 px-2 py-1 text-gray-700">iOS</span>
                  <span v-if="article.platform === 'android'" class="rounded-full bg-gray-100 px-2 py-1 text-gray-700">Android</span>
                  <span v-if="article.actionRequired" class="rounded-full bg-red-100 px-2 py-1 text-red-700">要対応</span>
                  <span
                    v-if="article.requiredByDate"
                    class="rounded-full bg-blue-100 px-2 py-1 text-blue-700"
                  >
                    期限 {{ article.requiredByDate }}
                  </span>
                </div>
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    class="rounded-full border border-amber-200 bg-white px-3 py-1 text-xs font-medium text-amber-700 hover:border-amber-300 hover:bg-amber-50"
                    @click.stop="handleBookmark(article)"
                  >
                    あとで読む
                  </button>
                  <a
                    class="rounded-full bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600"
                    :href="article.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    @click.stop="handleArticleClick(article)"
                  >
                    確認する
                  </a>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section
          v-if="heroArticles.length > 0 || sideArticles.length > 0"
          class="grid grid-cols-1 gap-3 xl:grid-cols-4"
        >
          <div
            v-if="heroArticles.length > 0"
            class="grid grid-cols-1 gap-3 xl:col-span-2 xl:grid-cols-2"
          >
            <NewsCard
              v-if="heroArticles[0]"
              :article="heroArticles[0]"
              variant="hero"
              class="xl:col-span-2"
              @bookmark="handleBookmark"
              @dismiss="handleDismiss"
              @article-click="handleArticleClick"
            />
            <NewsCard
              v-if="heroArticles[1]"
              :article="heroArticles[1]"
              variant="featured"
              @bookmark="handleBookmark"
              @dismiss="handleDismiss"
              @article-click="handleArticleClick"
            />
            <NewsCard
              v-if="heroArticles[2]"
              :article="heroArticles[2]"
              variant="featured"
              @bookmark="handleBookmark"
              @dismiss="handleDismiss"
              @article-click="handleArticleClick"
            />
          </div>

          <div
            v-if="sideArticles.length > 0"
            class="grid grid-cols-1 gap-2 xl:col-span-2"
          >
            <NewsCard
              v-for="article in sideArticles"
              :key="article.id"
              :article="article"
              variant="default"
              @bookmark="handleBookmark"
              @dismiss="handleDismiss"
              @article-click="handleArticleClick"
            />
          </div>
        </section>

        <section
          v-if="remainingArticles.length > 0"
          class="mt-3 grid grid-cols-1 gap-2 xl:grid-cols-2"
        >
          <NewsCard
            v-for="article in remainingArticles"
            :key="article.id"
            :article="article"
            variant="default"
            @bookmark="handleBookmark"
            @dismiss="handleDismiss"
            @article-click="handleArticleClick"
          />
        </section>
      </div>
    </div>

    <!-- トップに戻るボタン -->
    <Transition name="fade">
      <button
        v-if="showScrollTop"
        @click="scrollToTop"
        class="fixed bottom-6 right-6 p-3 bg-white text-gray-600 border border-gray-200 rounded-full shadow-lg hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 z-40 transition-all"
        aria-label="トップに戻る"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18" />
        </svg>
      </button>
    </Transition>

    <!-- ブックマーク完了トースト -->
    <Transition name="toast">
      <div
        v-if="bookmarkToast"
        class="fixed bottom-20 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-sm px-4 py-2 rounded-full z-50"
      >
        「あとで読む」に追加しました
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
