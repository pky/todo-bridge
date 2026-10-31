// web/src/stores/news.ts
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import {
  collection,
  doc,
  getDocs,
  getDocsFromServer,
  getDoc,
  getDocFromServer,
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
import { filterEligibleAiNews, selectDisplayableAiNews } from '@/utils/aiNewsDisplay'
import { filterEligibleMobileNews, selectDisplayableMobileNews } from '@/utils/mobileNewsDisplay'
import { matchesMobileActionItemPreferences, pruneResolvedState, selectUnresolvedActionItems } from '@/utils/mobileActionItems'
import type {
  NewsArticle,
  NewsPreferences,
  KeywordWeight,
  TaskList,
  MobileNotificationPreferences,
  MobileActionItem,
  MobileActionItemState,
} from '@/types'
import type { NewsInteraction, NewsTopic } from '@/types/news'

type FeedLoadState =
  | 'idle'
  | 'loading'
  | 'showing'
  | 'no-feed'
  | 'all-filtered'
  | 'fetch-failed'

interface FeedDiagnostic {
  state: FeedLoadState
  message: string
}

interface MobileActionItemsCache {
  feedDate: string | null
  items: Record<string, MobileActionItem>
  resolved: Record<string, MobileActionItemState>
}

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
  const feedDiagnosticsByTopic = ref<Record<NewsTopic, FeedDiagnostic>>({
    ai: {
      state: 'idle',
      message: 'まだニュース取得を開始していません',
    },
    mobile: {
      state: 'idle',
      message: 'まだニュース取得を開始していません',
    },
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
  const mobileActionItems = ref<Record<string, MobileActionItem>>({})
  const mobileActionItemStates = ref<Record<string, MobileActionItemState>>({})
  let actionItemsOwnerUid: string | null = null
  let actionItemsLoadedDate: string | null | undefined
  let actionItemsLoadFailed = false
  const actionItemLoads = new Map<string, Promise<void>>()
  let actionItemWrite: Promise<void> = Promise.resolve()
  let activeLoadSequence = 0

  function getNewsCacheKey(uid: string, topic: NewsTopic): string {
    return `rertm-news-cache-${uid}-${topic}`
  }

  function getLocalDateKey(date: Date = new Date()): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  function getActionItemsCacheKey(uid: string): string {
    return `rertm-mobile-action-items-${uid}`
  }

  function updateMobileAlerts(): void {
    const unresolved = selectUnresolvedActionItems(mobileActionItems.value, mobileActionItemStates.value)
      .filter(item => matchesMobileActionItemPreferences(item, preferences.value))
    const urgent = unresolved.filter(item => item.importantLevel === 'urgent').length
    const review = unresolved.filter(item => item.importantLevel === 'review').length
    mobileAlertCount.value = urgent
    mobileAlertSummary.value = { urgent, review }
  }

  watch(preferences, () => {
    if (!actionItemsLoadFailed) updateMobileAlerts()
  }, { deep: true, flush: 'sync' })

  function getActionItemsFeedDate(uid: string): string | null {
    return latestFeedDateByTopic.value.mobile ?? readCachedFeed(uid, 'mobile')?.date ?? null
  }

  function cacheMobileActionItems(uid: string, feedDate: string | null): void {
    try {
      localStorage.setItem(getActionItemsCacheKey(uid), JSON.stringify({
        feedDate,
        items: mobileActionItems.value,
        resolved: mobileActionItemStates.value,
      }))
    } catch {
      // 保存領域が使えなくても、読み込みや対応済み操作は成功として扱う。
    }
  }

  async function loadMobileActionItems(): Promise<void> {
    const uid = authStore.user?.uid
    if (actionItemsOwnerUid !== (uid ?? null)) {
      mobileActionItems.value = {}
      mobileActionItemStates.value = {}
      actionItemsOwnerUid = uid ?? null
      actionItemsLoadedDate = undefined
      actionItemsLoadFailed = false
    }
    if (!uid) {
      updateMobileAlerts()
      return
    }
    const feedDate = getActionItemsFeedDate(uid)
    const loadKey = JSON.stringify([uid, feedDate])
    const pending = actionItemLoads.get(loadKey)
    if (pending) return await pending
    // キャッシュ保存に失敗しても、同じフィードの操作済み状態を巻き戻さない。
    if (actionItemsLoadedDate === feedDate && !actionItemsLoadFailed) {
      updateMobileAlerts()
      return
    }

    try {
      const raw = localStorage.getItem(getActionItemsCacheKey(uid))
      const cached: MobileActionItemsCache | null = raw ? JSON.parse(raw) : null
      if (cached?.feedDate === feedDate && cached.items && cached.resolved) {
        mobileActionItems.value = cached.items
        mobileActionItemStates.value = cached.resolved
        actionItemsLoadedDate = cached.feedDate
        actionItemsLoadFailed = false
        updateMobileAlerts()
        return
      }
    } catch {
      // キャッシュが壊れている場合は2件のドキュメントから読み直す。
    }

    const load = (async () => {
      try {
        const [aggregate, state] = await Promise.all([
          getDoc(doc(db, 'topics/mobile/meta/actionItems')),
          getDoc(doc(db, `users/${uid}/newsState/mobileActionItems`)),
        ])
        if (authStore.user?.uid !== uid || actionItemsOwnerUid !== uid
          || getActionItemsFeedDate(uid) !== feedDate) return
        const aggregateData: { items?: Record<string, MobileActionItem> } | undefined = aggregate.data()
        const stateData: { resolved?: Record<string, MobileActionItemState> } | undefined = state.data()
        mobileActionItems.value = aggregateData?.items ?? {}
        mobileActionItemStates.value = stateData?.resolved ?? {}
        actionItemsLoadedDate = feedDate
        actionItemsLoadFailed = false
        updateMobileAlerts()
        cacheMobileActionItems(uid, feedDate)
      } catch (err) {
        if (authStore.user?.uid !== uid || actionItemsOwnerUid !== uid
          || getActionItemsFeedDate(uid) !== feedDate) return
        console.error('[news] loadMobileActionItems error:', err)
        actionItemsLoadedDate = undefined
        actionItemsLoadFailed = true
        mobileAlertCount.value = 0
        mobileAlertSummary.value = { urgent: 0, review: 0 }
      }
    })()
    actionItemLoads.set(loadKey, load)
    try {
      await load
    } finally {
      actionItemLoads.delete(loadKey)
    }
  }

  async function writeMobileActionItemState(key: string, state?: MobileActionItemState['state'], url?: string): Promise<void> {
    const uid = authStore.user?.uid
    if (!uid) return
    // 丸ごと保存するため、前の操作が成功してから最新の状態で次の書き込みを組み立てる。
    const operation = actionItemWrite.then(async () => {
      if (authStore.user?.uid !== uid) return
      const feedDate = getActionItemsFeedDate(uid)
      const [aggregate, currentState] = await Promise.all([
        getDocFromServer(doc(db, 'topics/mobile/meta/actionItems')),
        getDocFromServer(doc(db, `users/${uid}/newsState/mobileActionItems`)),
      ])
      if (authStore.user?.uid !== uid) return
      const aggregateData: { items?: Record<string, MobileActionItem> } | undefined = aggregate.data()
      const stateData: { resolved?: Record<string, MobileActionItemState> } | undefined = currentState.data()
      const items = aggregateData?.items ?? {}
      const targetKey = items[key]?.key ?? Object.values(items).find(item => item.url === url)?.key
      if (!targetKey) return
      const resolved = pruneResolvedState(items, stateData?.resolved ?? {})
      if (state) resolved[targetKey] = { state, at: Date.now() }
      else delete resolved[targetKey]
      await setDoc(doc(db, `users/${uid}/newsState/mobileActionItems`), { resolved })
      if (authStore.user?.uid !== uid) return
      actionItemsOwnerUid = uid
      mobileActionItems.value = items
      mobileActionItemStates.value = resolved
      actionItemsLoadedDate = feedDate
      actionItemsLoadFailed = false
      updateMobileAlerts()
      cacheMobileActionItems(uid, feedDate)
    })
    actionItemWrite = operation.catch(() => {})
    await operation
  }

  async function resolveMobileActionItem(key: string, state: MobileActionItemState['state']): Promise<void> {
    await writeMobileActionItemState(key, state)
  }

  async function restoreMobileActionItem(key: string): Promise<void> {
    await writeMobileActionItemState(key)
  }

  function readCachedFeed(uid: string, topic: NewsTopic): { date: string; articles: NewsArticle[]; isSharedFallback: boolean } | null {
    try {
      const raw = localStorage.getItem(getNewsCacheKey(uid, topic))
      if (!raw) return null
      const parsed = JSON.parse(raw) as { date?: string; articles?: NewsArticle[]; isSharedFallback?: boolean }
      if (!parsed.date || !Array.isArray(parsed.articles)) return null
      // 旧形式には出所の印がない。個別フィードだけが持つ表示スコアで判別する。
      const legacySharedFallback = parsed.isSharedFallback == null
        && parsed.articles.some(article => typeof article.displayScore !== 'number')
      const isSharedFallback = parsed.isSharedFallback === true || legacySharedFallback
      return {
        date: parsed.date,
        // 旧形式のキャッシュ（20件超、feedEligible なし）も読み出し時に同じ条件で絞る。
        articles: topic === 'ai'
          ? selectDisplayableAiNews(parsed.articles, { shared: isSharedFallback })
          : topic === 'mobile' && isSharedFallback ? selectDisplayableMobileNews(parsed.articles) : parsed.articles,
        isSharedFallback,
      }
    } catch {
      return null
    }
  }

  function writeCachedFeed(uid: string, topic: NewsTopic, date: string, nextArticles: NewsArticle[], isSharedFallback = false) {
    localStorage.setItem(
      getNewsCacheKey(uid, topic),
      JSON.stringify({ date, articles: nextArticles, isSharedFallback })
    )
  }

  function updateCachedFeedArticleList(uid: string, topic: NewsTopic, articleId: string) {
    const cached = readCachedFeed(uid, topic)
    if (!cached) return
    writeCachedFeed(uid, topic, cached.date, cached.articles.filter((article) => article.id !== articleId), cached.isSharedFallback)
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

  type InteractionCandidate = { id: unknown; url?: unknown }
  const INTERACTION_QUERY_IN_LIMIT = 30

  // 今日の候補記事に関係する記録だけを、ID と url で引いて読む。全件は読まない。
  // ドキュメント ID は `${topic}_${記事ID}` と、旧形式の裸の記事ID。
  function isUnavailableError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'unavailable'
  }

  async function loadRelatedInteractionDocs(
    uid: string,
    topic: NewsTopic,
    candidates: InteractionCandidate[],
    includeUrls = true
  ): Promise<Array<{ id: string; data: Partial<NewsInteraction> }>> {
    if (candidates.length === 0) return []
    const interactionsRef = collection(db, `users/${uid}/newsInteractions`)

    const articleIds = [...new Set(
      candidates
        .map((candidate) => candidate.id)
        .filter((id): id is string => typeof id === 'string' && id !== '' && !id.includes('/'))
    )]
    const docIds = articleIds.flatMap((id) => [getInteractionDocId(topic, id), id])
    const urls = includeUrls
      ? [...new Set(
          candidates
            .map((candidate) => candidate.url)
            .filter((url): url is string => typeof url === 'string' && url !== '')
        )]
      : []

    const urlQueries: Array<ReturnType<typeof query>> = []
    for (let i = 0; i < urls.length; i += INTERACTION_QUERY_IN_LIMIT) {
      urlQueries.push(query(interactionsRef, where('url', 'in', urls.slice(i, i + INTERACTION_QUERY_IN_LIMIT))))
    }

    const [idSnaps, urlSnaps] = await Promise.all([
      Promise.all(docIds.map(async (docId) => {
        try {
          return await getDoc(doc(db, `users/${uid}/newsInteractions/${docId}`))
        } catch (error) {
          // オフラインでキャッシュに無い記録は「見つからない」として扱い、他の取得結果を捨てない。
          if (isUnavailableError(error)) return null
          throw error
        }
      })),
      Promise.all(urlQueries.map((target) => getServerFirstSnapshot(target))),
    ])
    const found = new Map<string, Partial<NewsInteraction>>()
    for (const snap of idSnaps) {
      if (snap && snap.exists() && !found.has(snap.id)) found.set(snap.id, snap.data() as Partial<NewsInteraction>)
    }
    for (const snapshot of urlSnaps) {
      for (const interactionDoc of snapshot.docs) {
        if (!found.has(interactionDoc.id)) found.set(interactionDoc.id, interactionDoc.data() as Partial<NewsInteraction>)
      }
    }
    return [...found].map(([id, data]) => ({ id, data }))
  }

  function toInteractionCandidates(feedDocs: Array<{ id: string; data: () => unknown }>): InteractionCandidate[] {
    return feedDocs.map((feedDoc) => {
      const data = feedDoc.data() as { url?: unknown } | undefined
      return { id: feedDoc.id, url: data?.url }
    })
  }

  async function loadTopicInteractions(uid: string, topic: NewsTopic, candidates: InteractionCandidate[]): Promise<{
    excludedUrls: Set<string>
    dismissedArticleIds: Set<string>
  }> {
    const interactionDocs = await loadRelatedInteractionDocs(uid, topic, candidates)
    const excludedUrls = new Set<string>()
    const dismissedArticleIds = new Set<string>()

    for (const interactionDoc of interactionDocs) {
      const data = interactionDoc.data
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

  async function loadLatestTopicArticleDocs(topic: NewsTopic) {
    const articlesRef = collection(db, `topics/${topic}/articles`)
    const articlesSnap = await getServerFirstSnapshot(query(articlesRef, orderBy('date', 'desc'), limit(1)))

    if (articlesSnap.empty || !articlesSnap.docs[0]) {
      return { latestDate: null, articleDocs: [] as typeof articlesSnap.docs }
    }

    const latestDocData = articlesSnap.docs[0].data() as { date?: string } | undefined
    const latestDate = latestDocData?.date
    if (!latestDate) {
      return { latestDate: null, articleDocs: [] as typeof articlesSnap.docs }
    }

    const latestArticlesSnap = await getServerFirstSnapshot(query(
      articlesRef,
      where('date', '==', latestDate),
      ...(topic === 'ai' ? [where('feedEligible', '==', true)] : [])
    ))
    const sortedArticleDocs = [...latestArticlesSnap.docs].sort((a, b) => {
      const aData = a.data() as Partial<NewsArticle>
      const bData = b.data() as Partial<NewsArticle>
      const aPublishedAt = typeof aData.publishedAt?.toMillis === 'function' ? aData.publishedAt.toMillis() : 0
      const bPublishedAt = typeof bData.publishedAt?.toMillis === 'function' ? bData.publishedAt.toMillis() : 0
      const aScore = typeof aData.score === 'number' ? aData.score : 0
      const bScore = typeof bData.score === 'number' ? bData.score : 0

      if (bPublishedAt !== aPublishedAt) return bPublishedAt - aPublishedAt
      return bScore - aScore
    })

    if (topic === 'mobile') {
      // 対象外と分類待ちの記事は共有記事でも表示しない。件数の上限は利用者の除外条件を当てた後に掛ける。
      const mobileDocsById = new Map(sortedArticleDocs.map((articleDoc) => [articleDoc.id, articleDoc]))
      const displayableMobile = filterEligibleMobileNews(
        sortedArticleDocs.map((articleDoc) => ({ id: articleDoc.id, ...(articleDoc.data() as Record<string, unknown>) }) as NewsArticle)
      )
      if (displayableMobile.length === 0) return { latestDate: null, articleDocs: [] as typeof sortedArticleDocs }
      return {
        latestDate,
        articleDocs: displayableMobile.flatMap((article) => mobileDocsById.get(article.id) ?? []),
      }
    }
    if (topic !== 'ai') return { latestDate, articleDocs: sortedArticleDocs }

    // date と feedEligible の複合インデックスで取得した記事を、概要などの表示条件でさらに絞る。
    // 件数の上限は利用者の除外条件を当てた後に掛ける。
    const docsById = new Map(sortedArticleDocs.map((articleDoc) => [articleDoc.id, articleDoc]))
    const displayable = filterEligibleAiNews(
      sortedArticleDocs.map((articleDoc) => ({ id: articleDoc.id, ...(articleDoc.data() as Record<string, unknown>) }) as NewsArticle),
      { shared: true }
    )
    // 表示できる記事がない日は、共有記事の最新日として扱わない。
    if (displayable.length === 0) return { latestDate: null, articleDocs: [] as typeof sortedArticleDocs }
    return {
      latestDate,
      articleDocs: displayable.flatMap((article) => docsById.get(article.id) ?? []),
    }
  }

  // refCache を渡すと、同じ articleRef の参照先は1回だけ読み、以降は同じ結果を使い回す。
  async function resolveArticleDocs(
    feedDocs: Array<{ id: string; data: () => unknown }>,
    refCache?: Map<string, Promise<NewsArticle | null>>
  ): Promise<NewsArticle[]> {
    const articlePromises = feedDocs.map(async (feedDoc) => {
      const rawData = feedDoc.data()
      if (!rawData || typeof rawData !== 'object') return null
      const data = rawData as Record<string, unknown>

      // 新形式（記事データがそのまま入っている場合）
      if (typeof data.title === 'string') {
        return { id: feedDoc.id, ...data } as NewsArticle
      }

      // 旧形式（articleRefしかない場合）
      if (typeof data.articleRef === 'string') {
        const articleRef = data.articleRef
        const cached = refCache?.get(articleRef)
        if (cached) return cached
        const fetched = (async (): Promise<NewsArticle | null> => {
          try {
            const articleSnap = await getDoc(doc(db, articleRef))
            if (!articleSnap.exists()) return null
            return { id: articleSnap.id, ...(articleSnap.data() as Record<string, unknown>) } as NewsArticle
          } catch (e) {
            console.warn('[news] Failed to fetch referenced article', e)
            return null
          }
        })()
        refCache?.set(articleRef, fetched)
        return fetched
      }

      return null
    })

    const results = await Promise.all(articlePromises)
    return results.filter((article): article is NewsArticle => article !== null)
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

    const interactionDocs = await loadRelatedInteractionDocs(uid, topic, displayedArticles, false)
    // 同じ記事に topic 付きと裸の旧形式の記録が両方ある場合は、topic 付きを優先する。
    const interactionMap = new Map<string, Partial<NewsInteraction>>()
    for (const snap of interactionDocs) {
      const key = snap.data.articleId ?? snap.id
      if (!interactionMap.has(key) || snap.id === getInteractionDocId(topic, key)) {
        interactionMap.set(key, snap.data)
      }
    }
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
    if (!uid) {
      feedDiagnosticsByTopic.value = {
        ...feedDiagnosticsByTopic.value,
        [topic]: {
          state: 'idle',
          message: '認証後にニュース取得を開始します',
        },
      }
      return
    }
    const cachedFeed = readCachedFeed(uid, topic)
    const loadSequence = ++activeLoadSequence
    const today = getLocalDateKey()

    if (!forceRefresh && cachedFeed) {
      articles.value = cachedFeed.articles
      latestFeedDateByTopic.value = {
        ...latestFeedDateByTopic.value,
        [topic]: cachedFeed.date,
      }
      error.value = null

      if (cachedFeed.articles.length > 0) {
        if (cachedFeed.date === today && !cachedFeed.isSharedFallback) {
          loading.value = false
          feedDiagnosticsByTopic.value = {
            ...feedDiagnosticsByTopic.value,
            [topic]: {
              state: 'showing',
              message: 'ニュースを表示しています',
            },
          }
          return
        }

        loading.value = true
        feedDiagnosticsByTopic.value = {
          ...feedDiagnosticsByTopic.value,
          [topic]: {
            state: 'showing',
            message: cachedFeed.isSharedFallback
              ? '個別フィード生成前のため、共有記事を表示しています'
              : '保存済みの記事を表示しつつ、サーバーの更新を確認しています',
          },
        }
      } else {
        dismissedIds.value = new Set()
        loading.value = true
        feedDiagnosticsByTopic.value = {
          ...feedDiagnosticsByTopic.value,
          [topic]: {
            state: 'loading',
            message: '保存済みの記事がないため、サーバーから最新ニュースを取得しています',
          },
        }
      }
    } else {
      loading.value = true
      feedDiagnosticsByTopic.value = {
        ...feedDiagnosticsByTopic.value,
        [topic]: {
          state: 'loading',
          message: 'サーバーから最新ニュースを取得しています',
        },
      }
    }
    error.value = null

    try {
      const refCache = new Map<string, Promise<NewsArticle | null>>()
      const personalizedFeedPromise = loadLatestFeedDocs(uid, topic)
      const sharedFeedPromise = loadLatestTopicArticleDocs(topic)

      // 履歴は候補記事が分かってから、共有記事と個別フィードそれぞれの取得完了に合わせて引く。
      // 個別フィード側は、共有記事側で引いた分を除く。
      const sharedCandidatesPromise = sharedFeedPromise.then((sharedFeed) => toInteractionCandidates(sharedFeed.articleDocs))
      const sharedInteractionsPromise = sharedCandidatesPromise.then((candidates) =>
        loadTopicInteractions(uid, topic, candidates)
      )
      const personalInteractionsPromise = personalizedFeedPromise.then(async (personalizedFeed) => {
        const sharedCandidates = await sharedCandidatesPromise
        const alreadyRead = new Set(sharedCandidates.map((candidate) => `${String(candidate.id)}\n${String(candidate.url)}`))
        // 参照だけの旧形式文書は、解決後の id と url も候補にする。
        const resolvedPersonal = await resolveArticleDocs(personalizedFeed.feedDocs, refCache)
        const candidates = [
          ...toInteractionCandidates(personalizedFeed.feedDocs),
          ...resolvedPersonal.map((article) => ({ id: article.id, url: article.url })),
        ]
          .filter((candidate) => !alreadyRead.has(`${String(candidate.id)}\n${String(candidate.url)}`))
        return loadTopicInteractions(uid, topic, candidates)
      })

      if (!cachedFeed?.articles.length) {
        void sharedFeedPromise
          .then(async (sharedFeed) => {
            if (loadSequence !== activeLoadSequence || !sharedFeed.latestDate || sharedFeed.articleDocs.length === 0) {
              return
            }
            if (articles.value.length > 0) return

            const resolvedSharedArticles = await resolveArticleDocs(sharedFeed.articleDocs, refCache)
            const sharedArticles = topic === 'ai'
              ? selectDisplayableAiNews(resolvedSharedArticles, { shared: true })
              : topic === 'mobile' ? selectDisplayableMobileNews(resolvedSharedArticles) : resolvedSharedArticles
            if (loadSequence !== activeLoadSequence || articles.value.length > 0 || sharedArticles.length === 0) {
              return
            }

            articles.value = sharedArticles
            latestFeedDateByTopic.value = {
              ...latestFeedDateByTopic.value,
              [topic]: sharedFeed.latestDate,
            }
            feedDiagnosticsByTopic.value = {
              ...feedDiagnosticsByTopic.value,
              [topic]: {
                state: 'showing',
                message: '個別フィード生成前のため、共有記事を表示しています',
              },
            }
            writeCachedFeed(uid, topic, sharedFeed.latestDate, sharedArticles, true)
          })
          .catch((sharedError) => {
            console.warn('[news] shared feed early fallback failed:', sharedError)
          })
      }

      const { excludedUrls, dismissedArticleIds, latestDate, sortedFeedDocs, isSharedFallback } = await withTimeout(
        (async () => {
          const [personalizedFeed, sharedFeed, sharedInteractions, personalInteractions] = await Promise.all([
            personalizedFeedPromise,
            sharedFeedPromise,
            sharedInteractionsPromise,
            personalInteractionsPromise,
          ])
          const excludedUrls = new Set([...sharedInteractions.excludedUrls, ...personalInteractions.excludedUrls])
          const dismissedArticleIds = new Set([
            ...sharedInteractions.dismissedArticleIds,
            ...personalInteractions.dismissedArticleIds,
          ])

          let shouldUseSharedFallback = (
            !!sharedFeed.latestDate &&
            (!personalizedFeed.latestDate || sharedFeed.latestDate > personalizedFeed.latestDate)
          )

          // 共有記事が日付で新しくても、利用者の除外条件を当てた後に0件で、
          // 個別フィードに除外後1件以上あれば個別フィードを表示する。
          if (shouldUseSharedFallback && personalizedFeed.latestDate) {
            const isExcluded = (id: string, url: unknown) =>
              dismissedArticleIds.has(id) || (typeof url === 'string' && excludedUrls.has(url))
            const sharedRemaining = sharedFeed.articleDocs.filter((articleDoc) => {
              const data = articleDoc.data() as { url?: unknown } | undefined
              return !isExcluded(articleDoc.id, data?.url)
            })
            if (sharedRemaining.length === 0) {
              const personalizedArticles = (await resolveArticleDocs(
                personalizedFeed.feedDocs.filter((feedDoc) => !dismissedArticleIds.has(feedDoc.id)),
                refCache
              )).filter((article) => !excludedUrls.has(article.url) || shouldKeepVisibleAfterClick(article, topic))
              const personalizedRemaining = topic === 'ai'
                ? selectDisplayableAiNews(personalizedArticles, { shared: false })
                : personalizedArticles
              if (personalizedRemaining.length > 0) shouldUseSharedFallback = false
            }
          }

          return {
            excludedUrls,
            dismissedArticleIds,
            latestDate: shouldUseSharedFallback ? sharedFeed.latestDate : personalizedFeed.latestDate,
            sortedFeedDocs: shouldUseSharedFallback ? sharedFeed.articleDocs : personalizedFeed.feedDocs,
            isSharedFallback: shouldUseSharedFallback,
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
        feedDiagnosticsByTopic.value = {
          ...feedDiagnosticsByTopic.value,
          [topic]: {
            state: 'no-feed',
            message: 'サーバーには最新の配信データがまだありません',
          },
        }
        return
      }

      const results = await resolveArticleDocs(sortedFeedDocs.filter(feedDoc => !dismissedIds.value.has(feedDoc.id)), refCache)
      const unfilteredArticles = results
        .filter(article => !excludedUrls.has(article.url) || shouldKeepVisibleAfterClick(article, topic))
      const visibleArticles = topic === 'ai'
        ? selectDisplayableAiNews(unfilteredArticles, { shared: isSharedFallback })
        : topic === 'mobile' && isSharedFallback ? selectDisplayableMobileNews(unfilteredArticles) : unfilteredArticles

      if (loadSequence !== activeLoadSequence) return
      articles.value = visibleArticles
      latestFeedDateByTopic.value = {
        ...latestFeedDateByTopic.value,
        [topic]: latestDate,
      }
      feedDiagnosticsByTopic.value = {
        ...feedDiagnosticsByTopic.value,
        [topic]: visibleArticles.length > 0
          ? {
              state: 'showing',
              message: isSharedFallback
                ? '個別フィード生成前のため、共有記事を表示しています'
                : 'ニュースを表示しています',
            }
          : {
              state: 'all-filtered',
              message: isSharedFallback
                ? '共有記事は取得できましたが、既読・非表示条件により表示対象がありません'
                : '取得は成功しましたが、既読・非表示条件により表示対象がありません',
            },
      }
      writeCachedFeed(uid, topic, latestDate, visibleArticles, isSharedFallback)
      void trackDisplayedArticles(uid, topic, latestDate, visibleArticles).catch((trackError) => {
        console.error('[news] trackDisplayedArticles error:', trackError)
      })
    } catch (err) {
      console.error('[news] loadTodayFeed error:', err)
      const fallbackFeed = readCachedFeed(uid, topic)
      if (fallbackFeed && fallbackFeed.articles.length) {
        articles.value = fallbackFeed.articles
        latestFeedDateByTopic.value = {
          ...latestFeedDateByTopic.value,
          [topic]: fallbackFeed.date,
        }
        feedDiagnosticsByTopic.value = {
          ...feedDiagnosticsByTopic.value,
          [topic]: {
            state: 'fetch-failed',
            message: 'サーバー取得に失敗したため、保存済みの記事を表示しています',
          },
        }
        error.value = null
      } else {
        latestFeedDateByTopic.value = {
          ...latestFeedDateByTopic.value,
          [topic]: null,
        }
        feedDiagnosticsByTopic.value = {
          ...feedDiagnosticsByTopic.value,
          [topic]: {
            state: 'fetch-failed',
            message: 'サーバーからニュースを取得できませんでした',
          },
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
      ...learningFields(article),
    }
    await setDoc(
      doc(db, `users/${uid}/newsInteractions/${getInteractionDocId(topic, article.id)}`),
      interaction,
      { merge: true }
    )
  }

  function learningFields(article: Pick<NewsArticle, 'title' | 'summaryJa' | 'tags'>): { titleEn: string; summaryJa?: string; tags?: string[] } {
    return {
      titleEn: article.title,
      ...(article.summaryJa ? { summaryJa: article.summaryJa } : {}),
      ...(article.tags ? { tags: article.tags } : {}),
    }
  }

  async function recordArticleDismissal(articleId: string, url?: string, topic: NewsTopic = 'ai'): Promise<void> {
    const uid = authStore.user?.uid
    if (!uid) return

    // 表示中の記事なら、好みの学習に使うタイトル・要約・タグも一緒に記録する
    const shown = articles.value.find(a => a.id === articleId)
      ?? (topic === 'mobile' ? mobileActionItems.value[articleId]
        ?? Object.values(mobileActionItems.value).find(item => item.url === url) : undefined)

    // Firestoreに記録（urlも保存して翌日の同URL記事を除外できるようにする）
    await setDoc(
      doc(db, `users/${uid}/newsInteractions/${getInteractionDocId(topic, articleId)}`),
      {
        topic,
        articleId,
        dismissed: true,
        dismissedAt: serverTimestamp(),
        ...(url ? { url } : {}),
        ...(shown ? learningFields(shown) : {}),
      },
      { merge: true }
    )

    // ローカルから即座に除去
    if (authStore.user?.uid !== uid) return
    dismissedIds.value.add(articleId)
    articles.value = articles.value.filter(a => a.id !== articleId)
    updateCachedFeedArticleList(uid, topic, articleId)
  }

  async function dismissArticle(articleId: string, url?: string, topic: NewsTopic = 'ai'): Promise<void> {
    const uid = authStore.user?.uid
    if (!uid) return
    if (topic === 'mobile') {
      const key = articles.value.find(article => article.id === articleId)?.actionItemKey ?? articleId
      await writeMobileActionItemState(key, 'dismissed', url)
      if (authStore.user?.uid !== uid) return
    }
    await recordArticleDismissal(articleId, url, topic)
  }

  async function loadMobileAlertCount(): Promise<void> {
    await loadMobileActionItems()
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

    // 後で読むを好みの学習に使うため、時刻とタイトル・要約・タグを記録する
    await setDoc(
      doc(db, `users/${uid}/newsInteractions/${getInteractionDocId(article.topic ?? 'ai', article.id)}`),
      { topic: article.topic ?? 'ai', articleId: article.id, readLaterAt: serverTimestamp(), ...learningFields(article) },
      { merge: true }
    )

    // ブックマーク済み記事はフィードから除外（今日 + 翌日以降も同URLは出さない）
    await recordArticleDismissal(article.id, article.url, article.topic ?? 'ai')
  }

  return {
    articles,
    loading,
    error,
    preferences,
    latestFeedDateByTopic,
    feedDiagnosticsByTopic,
    mobileNotificationPreferences,
    mobileActionItems,
    mobileActionItemStates,
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
    loadMobileActionItems,
    resolveMobileActionItem,
    restoreMobileActionItem,
    mobileAlertCount,
    mobileAlertSummary,
  }
})
