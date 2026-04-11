// web/src/stores/news.ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  collection,
  doc,
  getDocs,
  getDocsFromServer,
  getDoc,
  setDoc,
  writeBatch,
  increment,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/services/firebase'
import { saveMobileNotificationPreferencesApi } from '@/services/cloudFunctionsService'
import { useAuthStore } from './auth'
import { useListsStore } from './lists'
import { useTasksStore } from './tasks'
import { useSpaceStore, buildPersonalSpaceId } from './space'
import type {
  NewsArticle,
  NewsPreferences,
  KeywordWeight,
  TaskList,
  MobileNotificationPreferences,
} from '@/types'
import type { NewsInteraction, NewsTopic } from '@/types/news'

export const useNewsStore = defineStore('news', () => {
  const NEWS_FETCH_TIMEOUT_MS = 8000
  const authStore = useAuthStore()
  const articles = ref<NewsArticle[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const preferences = ref<NewsPreferences>({ keywords: [] })
  const latestFeedDateByTopic = ref<Record<NewsTopic, string | null>>({
    ai: null,
    mobile: null,
  })
  const mobileNotificationPreferences = ref<MobileNotificationPreferences>({
    discord: {
      enabled: false,
      webhookUrl: '',
      urgentImmediate: true,
      dailyDigest: true,
    },
  })
  const dismissedIds = ref<Set<string>>(new Set())
  const mobileAlertCount = ref(0)
  const mobileAlertSummary = ref({ urgent: 0, review: 0 })
  let activeLoadSequence = 0

  function getJstToday(): string {
    return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
  }

  function getNewsCacheKey(uid: string, topic: NewsTopic): string {
    return `rertm-news-cache-${uid}-${topic}`
  }

  function readCachedFeed(uid: string, topic: NewsTopic): { date: string; articles: NewsArticle[] } | null {
    try {
      const raw = localStorage.getItem(getNewsCacheKey(uid, topic))
      if (!raw) return null
      const parsed = JSON.parse(raw) as { date?: string; articles?: NewsArticle[] }
      if (!parsed.date || !Array.isArray(parsed.articles)) return null
      return { date: parsed.date, articles: parsed.articles }
    } catch {
      return null
    }
  }

  function writeCachedFeed(uid: string, topic: NewsTopic, date: string, nextArticles: NewsArticle[]) {
    localStorage.setItem(
      getNewsCacheKey(uid, topic),
      JSON.stringify({ date, articles: nextArticles })
    )
  }

  function updateCachedFeedArticleList(uid: string, topic: NewsTopic, articleId: string) {
    const cached = readCachedFeed(uid, topic)
    if (!cached) return
    writeCachedFeed(uid, topic, cached.date, cached.articles.filter((article) => article.id !== articleId))
  }

  async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        window.setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  }

  function getInteractionDocId(topic: NewsTopic, articleId: string): string {
    return `${topic}_${articleId}`
  }

  async function getServerFirstSnapshot(target: ReturnType<typeof collection> | ReturnType<typeof query>) {
    try {
      return await getDocsFromServer(target)
    } catch (error) {
      console.warn('[news] Server fetch failed, falling back to default getDocs:', error)
      return await getDocs(target)
    }
  }

  function isMatchingTopicInteraction(topic: NewsTopic, interaction: Partial<NewsInteraction>): boolean {
    return interaction.topic === topic || (!interaction.topic && topic === 'ai')
  }

  async function loadTopicInteractions(uid: string, topic: NewsTopic): Promise<{
    excludedUrls: Set<string>
    dismissedArticleIds: Set<string>
  }> {
    const interactionsRef = collection(db, `users/${uid}/newsInteractions`)
    const interactionsSnap = await getServerFirstSnapshot(interactionsRef)
    const excludedUrls = new Set<string>()
    const dismissedArticleIds = new Set<string>()

    for (const interactionDoc of interactionsSnap.docs) {
      const data = interactionDoc.data() as Partial<NewsInteraction>
      if (!isMatchingTopicInteraction(topic, data)) continue

      const interactionArticleId = data.articleId ?? interactionDoc.id
      if (typeof data.shownCount === 'number' && data.shownCount >= 2 && data.url) {
        excludedUrls.add(data.url)
      }
      if (data.dismissed === true) {
        dismissedArticleIds.add(interactionArticleId)
        if (data.url) excludedUrls.add(data.url)
      }
      if (data.clickedAt && data.url) {
        excludedUrls.add(data.url)
      }
    }

    return { excludedUrls, dismissedArticleIds }
  }

  async function loadLatestFeedDocs(uid: string, topic: NewsTopic) {
    const feedRef = collection(db, `users/${uid}/newsFeed/${topic}/articles`)
    const feedSnap = await getServerFirstSnapshot(query(feedRef, orderBy('date', 'desc'), limit(1)))

    if (feedSnap.empty || !feedSnap.docs[0]) {
      return { latestDate: null, feedDocs: [] as typeof feedSnap.docs }
    }

    const latestDocData = feedSnap.docs[0].data() as { date?: string } | undefined
    const latestDate = latestDocData?.date
    if (!latestDate) {
      return { latestDate: null, feedDocs: [] as typeof feedSnap.docs }
    }

    const latestFeedSnap = await getServerFirstSnapshot(query(feedRef, where('date', '==', latestDate)))
    const sortedFeedDocs = [...latestFeedSnap.docs].sort((a, b) => {
      const aData = a.data() as { displayScore?: number } | undefined
      const bData = b.data() as { displayScore?: number } | undefined
      const aScore = typeof aData?.displayScore === 'number' ? aData.displayScore : 0
      const bScore = typeof bData?.displayScore === 'number' ? bData.displayScore : 0
      return bScore - aScore
    })

    return { latestDate, feedDocs: sortedFeedDocs }
  }

  function shouldKeepVisibleAfterClick(article: NewsArticle, topic: NewsTopic): boolean {
    return topic === 'mobile' && article.importantLevel === 'urgent'
  }

  async function trackDisplayedArticles(
    uid: string,
    topic: NewsTopic,
    latestDate: string,
    displayedArticles: NewsArticle[]
  ): Promise<void> {
    if (displayedArticles.length === 0) return

    const interactionsRef = collection(db, `users/${uid}/newsInteractions`)
    const interactionsSnap = await getServerFirstSnapshot(interactionsRef)
    const interactionMap = new Map(
      interactionsSnap.docs.map((snap) => {
        const data = snap.data() as Partial<NewsInteraction>
        return [data.articleId ?? snap.id, data]
      })
    )
    const batch = writeBatch(db)
    let hasUpdates = false

    for (const article of displayedArticles) {
      const existing = interactionMap.get(article.id)
      if (existing?.lastShownDate === latestDate) continue

      batch.set(
        doc(db, `users/${uid}/newsInteractions/${getInteractionDocId(topic, article.id)}`),
        {
          topic,
          articleId: article.id,
          url: article.url,
          shownCount: increment(1),
          lastShownDate: latestDate,
          lastShownAt: serverTimestamp(),
        },
        { merge: true }
      )
      hasUpdates = true
    }

    if (hasUpdates) {
      await batch.commit()
    }
  }

  async function loadTodayFeed(topic: NewsTopic = 'ai', forceRefresh = false): Promise<void> {
    const uid = authStore.user?.uid
    if (!uid) return
    const today = getJstToday()
    const cachedFeed = readCachedFeed(uid, topic)
    const loadSequence = ++activeLoadSequence

    if (!forceRefresh && cachedFeed?.date === today) {
      articles.value = cachedFeed.articles
      latestFeedDateByTopic.value = {
        ...latestFeedDateByTopic.value,
        [topic]: cachedFeed.date,
      }
      dismissedIds.value = new Set()
      loading.value = false
      error.value = null
      return
    }

    loading.value = true
    error.value = null

    try {
      const { excludedUrls, dismissedArticleIds, latestDate, sortedFeedDocs } = await withTimeout(
        (async () => {
          const [{ excludedUrls, dismissedArticleIds }, { latestDate, feedDocs }] = await Promise.all([
            loadTopicInteractions(uid, topic),
            loadLatestFeedDocs(uid, topic),
          ])
          return {
            excludedUrls,
            dismissedArticleIds,
            latestDate,
            sortedFeedDocs: feedDocs,
          }
        })(),
        NEWS_FETCH_TIMEOUT_MS,
        'news-feed-timeout'
      )

      if (loadSequence !== activeLoadSequence) return
      dismissedIds.value = dismissedArticleIds

      if (!latestDate) {
        articles.value = []
        latestFeedDateByTopic.value = {
          ...latestFeedDateByTopic.value,
          [topic]: null,
        }
        return
      }

      const articlePromises = sortedFeedDocs
        .filter(feedDoc => !dismissedIds.value.has(feedDoc.id))
        .map(async (feedDoc) => {
          const data = feedDoc.data() as Record<string, unknown>
          
          // 新形式（記事データがそのまま入っている場合）
          if (typeof data.title === 'string') {
            return { id: feedDoc.id, ...data } as NewsArticle
          }
          
          // 旧形式（articleRefしかない場合）
          if (typeof data.articleRef === 'string') {
            try {
              const articleSnap = await getDoc(doc(db, data.articleRef))
              if (!articleSnap.exists()) return null
              return { id: articleSnap.id, ...(articleSnap.data() as Record<string, unknown>) } as NewsArticle
            } catch (e) {
              console.warn('[news] Failed to fetch referenced article', e)
              return null
            }
          }
          
          return null
        })

      const results = await Promise.all(articlePromises)
      const visibleArticles = results
        .filter((a): a is NewsArticle => a !== null)
        .filter(article => !excludedUrls.has(article.url) || shouldKeepVisibleAfterClick(article, topic))

      if (loadSequence !== activeLoadSequence) return
      articles.value = visibleArticles
      latestFeedDateByTopic.value = {
        ...latestFeedDateByTopic.value,
        [topic]: latestDate,
      }
      writeCachedFeed(uid, topic, latestDate, visibleArticles)
      void trackDisplayedArticles(uid, topic, latestDate, visibleArticles).catch((trackError) => {
        console.error('[news] trackDisplayedArticles error:', trackError)
      })
    } catch (err) {
      console.error('[news] loadTodayFeed error:', err)
      const fallbackFeed = readCachedFeed(uid, topic)
      if (fallbackFeed?.date === today && fallbackFeed.articles.length) {
        articles.value = fallbackFeed.articles
        latestFeedDateByTopic.value = {
          ...latestFeedDateByTopic.value,
          [topic]: fallbackFeed.date,
        }
        error.value = null
      } else {
        latestFeedDateByTopic.value = {
          ...latestFeedDateByTopic.value,
          [topic]: null,
        }
        error.value = '記事の読み込みに失敗しました'
      }
    } finally {
      if (loadSequence === activeLoadSequence) {
        loading.value = false
      }
    }
  }

  async function loadPreferences(topic: NewsTopic = 'ai'): Promise<void> {
    const uid = authStore.user?.uid
    if (!uid) return

    try {
      const prefSnap = await getDoc(doc(db, `users/${uid}/newsPreferences/${topic}`))
      if (prefSnap.exists()) {
        preferences.value = prefSnap.data() as NewsPreferences
      }
    } catch (err) {
      console.error('[news] loadPreferences error:', err)
    }
  }

  async function loadMobileNotificationPreferences(): Promise<void> {
    const uid = authStore.user?.uid
    if (!uid) return

    try {
      const prefSnap = await getDoc(doc(db, `users/${uid}/notificationPreferences/mobile`))
      if (prefSnap.exists()) {
        mobileNotificationPreferences.value = {
          discord: {
            enabled: false,
            webhookUrl: '',
            urgentImmediate: true,
            dailyDigest: true,
            ...(prefSnap.data().discord ?? {}),
          },
        }
      }
    } catch (err) {
      console.error('[news] loadMobileNotificationPreferences error:', err)
    }
  }

  async function savePreferences(keywords: KeywordWeight[], topic: NewsTopic = 'ai'): Promise<void> {
    const uid = authStore.user?.uid
    if (!uid) return

    const newPrefs: NewsPreferences = { keywords }
    await setDoc(doc(db, `users/${uid}/newsPreferences/${topic}`), newPrefs)
    preferences.value = newPrefs
  }

  async function saveFullPreferences(newPrefs: NewsPreferences, topic: NewsTopic = 'ai'): Promise<void> {
    const uid = authStore.user?.uid
    if (!uid) return

    await setDoc(doc(db, `users/${uid}/newsPreferences/${topic}`), newPrefs)
    preferences.value = newPrefs
  }

  async function saveMobileNotificationPreferences(newPrefs: MobileNotificationPreferences): Promise<void> {
    await saveMobileNotificationPreferencesApi(newPrefs)
    mobileNotificationPreferences.value = newPrefs
  }

  async function trackClick(article: NewsArticle, topic: NewsTopic = article.topic ?? 'ai'): Promise<void> {
    const uid = authStore.user?.uid
    if (!uid) return

    const interaction: Partial<NewsInteraction> = {
      topic,
      articleId: article.id,
      url: article.url,
      clickedAt: serverTimestamp() as NewsInteraction['clickedAt'],
      titleEn: article.title,
      summaryJa: article.summaryJa,
      tags: article.tags,
    }
    await setDoc(
      doc(db, `users/${uid}/newsInteractions/${getInteractionDocId(topic, article.id)}`),
      interaction,
      { merge: true }
    )
  }

  async function dismissArticle(articleId: string, url?: string, topic: NewsTopic = 'ai'): Promise<void> {
    const uid = authStore.user?.uid
    if (!uid) return

    // Firestoreに記録（urlも保存して翌日の同URL記事を除外できるようにする）
    await setDoc(
      doc(db, `users/${uid}/newsInteractions/${getInteractionDocId(topic, articleId)}`),
      { topic, articleId, dismissed: true, dismissedAt: serverTimestamp(), ...(url ? { url } : {}) },
      { merge: true }
    )

    // ローカルから即座に除去
    dismissedIds.value.add(articleId)
    articles.value = articles.value.filter(a => a.id !== articleId)
    updateCachedFeedArticleList(uid, topic, articleId)
  }

  async function loadMobileAlertCount(): Promise<void> {
    const uid = authStore.user?.uid
    if (!uid) {
      mobileAlertCount.value = 0
      mobileAlertSummary.value = { urgent: 0, review: 0 }
      return
    }

    try {
      const { excludedUrls, dismissedArticleIds } = await loadTopicInteractions(uid, 'mobile')
      const { latestDate, feedDocs } = await loadLatestFeedDocs(uid, 'mobile')

      if (!latestDate) {
        mobileAlertCount.value = 0
        mobileAlertSummary.value = { urgent: 0, review: 0 }
        return
      }

      const visibleArticles = feedDocs
        .filter(feedDoc => !dismissedArticleIds.has(feedDoc.id))
        .map(feedDoc => ({ id: feedDoc.id, ...(feedDoc.data() as Record<string, unknown>) }) as NewsArticle)
        .filter(article => !excludedUrls.has(article.url) || shouldKeepVisibleAfterClick(article, 'mobile'))
        .filter(article => article.isOfficial === true)

      const urgent = visibleArticles.filter(article => article.importantLevel === 'urgent').length
      const review = visibleArticles.filter(article => article.importantLevel === 'review').length

      mobileAlertSummary.value = { urgent, review }
      mobileAlertCount.value = urgent
    } catch (err) {
      console.error('[news] loadMobileAlertCount error:', err)
      mobileAlertCount.value = 0
      mobileAlertSummary.value = { urgent: 0, review: 0 }
    }
  }

  async function bookmarkArticle(article: NewsArticle): Promise<void> {
    const listsStore = useListsStore()
    const tasksStore = useTasksStore()
    const spaceStore = useSpaceStore()
    const uid = authStore.user?.uid
    if (!uid) throw new Error('認証が必要です')
    const personalSpaceId = buildPersonalSpaceId(uid)

    // 「あとで読む」は常に個人スペースへ保存する
    let readLaterList: TaskList | undefined = listsStore.lists.find(
      (l) => l.name === 'あとで読む' && l.spaceId === personalSpaceId
    )
    if (!readLaterList) {
      const personalListsRef = spaceStore.getCollectionRefForSpace('lists', personalSpaceId)
      const existingListSnap = await getDocs(query(personalListsRef, where('name', '==', 'あとで読む'), limit(1)))
      const existingDoc = existingListSnap.docs[0]
      if (existingDoc) {
        readLaterList = {
          id: existingDoc.id,
          ...(existingDoc.data() as Omit<TaskList, 'id'>),
        }
      }
    }
    if (!readLaterList) {
      await listsStore.createList({ name: 'あとで読む', spaceId: personalSpaceId })
      const createdListSnap = await getDocs(
        query(spaceStore.getCollectionRefForSpace('lists', personalSpaceId), where('name', '==', 'あとで読む'), limit(1))
      )
      const createdDoc = createdListSnap.docs[0]
      if (createdDoc) {
        readLaterList = {
          id: createdDoc.id,
          ...(createdDoc.data() as Omit<TaskList, 'id'>),
        }
      }
    }
    if (!readLaterList) throw new Error('あとで読むリストの作成に失敗しました')

    await tasksStore.createTask({
      name: article.titleJa || article.title,
      listId: readLaterList.id,
      spaceId: personalSpaceId,
      parentId: null,
      priority: 4,
      tags: ['ai-news'],
      dueDate: null,
      startDate: null,
      repeat: null,
      notes: [article.summaryJa ?? ''],
      url: article.url,
    })

    // ブックマーク済み記事はフィードから除外（今日 + 翌日以降も同URLは出さない）
    await dismissArticle(article.id, article.url, article.topic ?? 'ai')
  }

  return {
    articles,
    loading,
    error,
    preferences,
    latestFeedDateByTopic,
    mobileNotificationPreferences,
    dismissedIds,
    loadTodayFeed,
    loadPreferences,
    loadMobileNotificationPreferences,
    savePreferences,
    saveFullPreferences,
    saveMobileNotificationPreferences,
    trackClick,
    dismissArticle,
    bookmarkArticle,
    loadMobileAlertCount,
    mobileAlertCount,
    mobileAlertSummary,
  }
})
