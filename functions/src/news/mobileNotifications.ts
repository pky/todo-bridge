import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions/v1'
import axios from 'axios'
import type { NewsArticle } from './types'

const db = admin.firestore()

interface DiscordNotificationPreferences {
  enabled?: boolean
  webhookUrl?: string
  urgentImmediate?: boolean
  dailyDigest?: boolean
}

interface MobileNotificationPreferences {
  discord?: DiscordNotificationPreferences
}

type FeedArticle = NewsArticle & { id: string }

function normalizeDiscordPreferences(input: DiscordNotificationPreferences | undefined): DiscordNotificationPreferences {
  return {
    enabled: input?.enabled === true,
    webhookUrl: typeof input?.webhookUrl === 'string' ? input.webhookUrl.trim() : '',
    urgentImmediate: input?.urgentImmediate !== false,
    dailyDigest: input?.dailyDigest !== false,
  }
}

function isDiscordWebhookUrl(url?: string): boolean {
  if (!url) return false

  try {
    const parsed = new URL(url)
    return (
      (parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com') &&
      parsed.pathname.startsWith('/api/webhooks/')
    )
  } catch {
    return false
  }
}

function formatReason(article: FeedArticle): string {
  if (article.requiredByDate) return `期限 ${article.requiredByDate}`
  if (article.actionType === 'sdk_requirement') return 'SDK要件の変更候補'
  if (article.actionType === 'policy' || article.actionType === 'play_policy') return 'ポリシー変更の確認対象'
  if (article.actionType === 'security') return 'セキュリティ関連の確認対象'
  if (article.actionType === 'store_review') return '審査運用への影響候補'
  if (article.importantLevel === 'review') return '確認推奨'
  return '今すぐ確認'
}

function getDeliveryDocId(articleId: string, channel: string, deliveryType: string): string {
  return `${articleId}_${channel}_${deliveryType}`
}

async function loadLatestMobileFeedForUser(uid: string): Promise<FeedArticle[]> {
  const feedRef = db.collection(`users/${uid}/newsFeed/mobile/articles`)
  const latestSnap = await feedRef.orderBy('date', 'desc').limit(1).get()
  if (latestSnap.empty) return []

  const latestDate = latestSnap.docs[0]?.data()?.date
  if (!latestDate) return []

  const articlesSnap = await feedRef.where('date', '==', latestDate).get()
  return articlesSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as NewsArticle) }))
}

async function loadExcludedMobileArticleIds(uid: string): Promise<Set<string>> {
  const interactionsSnap = await db.collection(`users/${uid}/newsInteractions`).get()
  const excludedArticleIds = new Set<string>()

  for (const interactionDoc of interactionsSnap.docs) {
    const data = interactionDoc.data()
    if (data.topic !== 'mobile') continue
    const articleId = typeof data.articleId === 'string' ? data.articleId : interactionDoc.id
    if (data.dismissed === true || data.clickedAt) {
      excludedArticleIds.add(articleId)
    }
  }

  return excludedArticleIds
}

async function postDiscordMessage(webhookUrl: string, content: string): Promise<void> {
  await axios.post(webhookUrl, { content }, {
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

export const saveMobileNotificationPreferences = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const discord = normalizeDiscordPreferences(data?.discord as DiscordNotificationPreferences | undefined)

    if (discord.enabled && !isDiscordWebhookUrl(discord.webhookUrl)) {
      throw new functions.https.HttpsError('invalid-argument', '有効な Discord Webhook URL を入力してください')
    }

    const preferences: MobileNotificationPreferences = {
      discord,
    }

    await db.doc(`users/${context.auth.uid}/notificationPreferences/mobile`).set(preferences)

    return {
      success: true,
    }
  })

export const sendMobileDiscordUrgentNotifications = functions
  .region('asia-northeast1')
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .pubsub.schedule('50 6 * * *').timeZone('Asia/Tokyo')
  .onRun(async () => {
    const usersSnap = await db.collection('users').get()

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id

      try {
        const prefDoc = await db.doc(`users/${uid}/notificationPreferences/mobile`).get()
        const preferences = prefDoc.exists
          ? (prefDoc.data() as MobileNotificationPreferences)
          : {}
        const discord = preferences.discord

        if (!discord?.enabled || !discord.urgentImmediate || !isDiscordWebhookUrl(discord.webhookUrl)) {
          continue
        }

        const [articles, excludedIds] = await Promise.all([
          loadLatestMobileFeedForUser(uid),
          loadExcludedMobileArticleIds(uid),
        ])

        const urgentArticles = articles
          .filter((article) => article.isOfficial === true)
          .filter((article) => article.importantLevel === 'urgent')
          .filter((article) => !excludedIds.has(article.id))

        for (const article of urgentArticles) {
          const deliveryRef = db.doc(
            `users/${uid}/mobileNotifications/${getDeliveryDocId(article.id, 'discord', 'urgent_immediate')}`
          )
          const deliverySnap = await deliveryRef.get()
          if (deliverySnap.exists) continue

          const lines = [
            `【今すぐ確認】${article.titleJa ?? article.title}`,
            `理由: ${formatReason(article)}`,
            `ソース: ${article.sourceName}`,
            article.url,
          ]

          await postDiscordMessage(discord.webhookUrl!, lines.join('\n'))
          await deliveryRef.set({
            articleId: article.id,
            topic: 'mobile',
            channel: 'discord',
            deliveryType: 'urgent_immediate',
            importantLevel: article.importantLevel ?? 'urgent',
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            date: article.date,
          })
        }
      } catch (err) {
        console.error(`[sendMobileDiscordUrgentNotifications] Failed for ${uid}:`, err)
      }
    }
  })

export const sendMobileDiscordDailyDigest = functions
  .region('asia-northeast1')
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .pubsub.schedule('5 7 * * *').timeZone('Asia/Tokyo')
  .onRun(async () => {
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const usersSnap = await db.collection('users').get()

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id

      try {
        const prefDoc = await db.doc(`users/${uid}/notificationPreferences/mobile`).get()
        const preferences = prefDoc.exists
          ? (prefDoc.data() as MobileNotificationPreferences)
          : {}
        const discord = preferences.discord

        if (!discord?.enabled || !discord.dailyDigest || !isDiscordWebhookUrl(discord.webhookUrl)) {
          continue
        }

        const digestRef = db.doc(`users/${uid}/mobileNotifications/${getDeliveryDocId(today, 'discord', 'daily_digest')}`)
        const digestSnap = await digestRef.get()
        if (digestSnap.exists) continue

        const [articles, excludedIds] = await Promise.all([
          loadLatestMobileFeedForUser(uid),
          loadExcludedMobileArticleIds(uid),
        ])

        const visibleArticles = articles
          .filter((article) => article.isOfficial === true)
          .filter((article) => !excludedIds.has(article.id))

        const urgentArticles = visibleArticles.filter((article) => article.importantLevel === 'urgent')
        const reviewArticles = visibleArticles.filter((article) => article.importantLevel === 'review')
        const topArticles = [...urgentArticles, ...reviewArticles].slice(0, 3)

        if (topArticles.length === 0) continue

        const lines = [
          `モバイルニュース要約: 今 ${urgentArticles.length} 件 / 確 ${reviewArticles.length} 件`,
          ...topArticles.map((article, index) =>
            `${index + 1}. ${article.titleJa ?? article.title} (${formatReason(article)})`
          ),
        ]

        await postDiscordMessage(discord.webhookUrl!, lines.join('\n'))
        await digestRef.set({
          articleId: today,
          topic: 'mobile',
          channel: 'discord',
          deliveryType: 'daily_digest',
          importantLevel: urgentArticles.length > 0 ? 'urgent' : 'review',
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          date: today,
        })
      } catch (err) {
        console.error(`[sendMobileDiscordDailyDigest] Failed for ${uid}:`, err)
      }
    }
  })
