import * as functions from 'firebase-functions/v1'
import { runCollectArticles, runCollectMobileArticles } from './news/collectArticles'
import { runGenerateMobilePersonalizedFeed, runGeneratePersonalizedFeed } from './news/generatePersonalizedFeed'
import { runSendMobileDiscordDailyDigest, runSendMobileDiscordUrgentNotifications } from './news/mobileNotifications'
import { runDailyBackup } from './scheduledBackup'
import { runRecalculateAllSmartLists } from './smartLists'
import { runDocumentConsistency } from './documents/consistency'
import { publishCuratorArticles } from './news/v2/aiStaticFeedPipeline'
import { createStorageFeedBucket } from './news/v2/storageFeedBucket'
import { runDailyNewsPipeline } from './news/v2/dailyNewsPipeline'
import { aiFeedDailyPath, publishDaily, type AiFeedDaily, type FeedBucket } from './news/v2/publishAiFeed'

const R2_SECRETS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]

export const dailyMaintenance = functions
  .region('asia-northeast1')
  .runWith({ timeoutSeconds: 540, memory: '512MB', secrets: R2_SECRETS })
  .pubsub.schedule('0 0 * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async () => {
    await Promise.all([
      runRecalculateAllSmartLists(),
      runDocumentConsistency(),
    ])
  })

export const dailyBackupJob = functions
  .region('asia-northeast1')
  .pubsub.schedule('0 3 * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async () => {
    await runDailyBackup()
  })

export const dailyNewsPipeline = functions
  .region('asia-northeast1')
  .runWith({ timeoutSeconds: 540, memory: '512MB', secrets: ['ANTHROPIC_API_KEY'] })
  .pubsub.schedule('0 6 * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async () => {
    const feedDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    let bucket: FeedBucket | undefined
    let daily: AiFeedDaily | undefined
    const getBucket = () => bucket ?? (bucket = createStorageFeedBucket())
    await runDailyNewsPipeline({
      feedDate,
      now: () => new Date(),
      curatorUid: process.env.NEWS_CURATOR_UID,
      readDailyTimeoutMs: 30000,
      readDailyExists: async () => {
        const object = await getBucket().read(aiFeedDailyPath(feedDate))
        if (!object) return false
        daily = JSON.parse(object.data.toString('utf8')) as AiFeedDaily
        if (daily.feedDate !== feedDate) throw new Error('日次原本の対象日が一致しません')
        return true
      },
      collectAi: runCollectArticles,
      generateAi: runGeneratePersonalizedFeed,
      publish: async (articles, learningCutoffAt) => {
        const result = await publishCuratorArticles({
          bucket: getBucket(), feedDate, now: () => new Date(),
        }, articles, learningCutoffAt)
        if (result.status.startsWith('skipped-')) console.warn(`[dailyNewsPipeline] AI static feed ${result.status}`)
        return result
      },
      recoverPublish: async () => {
        if (!daily) throw new Error('日次原本がありません')
        const result = await publishDaily(getBucket(), daily, new Date().toISOString())
        if (result.status.startsWith('skipped-')) console.warn(`[dailyNewsPipeline] AI static feed ${result.status}`)
        return result
      },
      collectMobile: runCollectMobileArticles,
      generateMobile: runGenerateMobilePersonalizedFeed,
      sendMobileUrgent: runSendMobileDiscordUrgentNotifications,
      sendMobileDigest: runSendMobileDiscordDailyDigest,
      log: console,
    })
  })
