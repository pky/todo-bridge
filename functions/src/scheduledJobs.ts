import * as functions from 'firebase-functions/v1'
import { runCollectArticles, runCollectMobileArticles } from './news/collectArticles'
import { runGenerateMobilePersonalizedFeed, runGeneratePersonalizedFeed } from './news/generatePersonalizedFeed'
import { runSendMobileDiscordDailyDigest, runSendMobileDiscordUrgentNotifications } from './news/mobileNotifications'
import { runDailyBackup } from './scheduledBackup'
import { runRecalculateAllSmartLists } from './smartLists'
import { runDocumentConsistency } from './documents/consistency'
import { runAiStaticFeedPipeline } from './news/v2/aiStaticFeedPipeline'
import { createStorageFeedBucket } from './news/v2/storageFeedBucket'

const R2_SECRETS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]

async function runPipelineStep(name: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    console.log(`[dailyNewsPipeline] ${name} starting`)
    await run()
    console.log(`[dailyNewsPipeline] ${name} completed`)
    return true
  } catch (err) {
    console.error(`[dailyNewsPipeline] ${name} failed:`, err)
    return false
  }
}

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
    // AIとmobileの収集完了後に生成へ進む従来の順序を維持する。
    let finishAiCollection: () => void = () => undefined
    const aiCollected = new Promise<void>(resolve => { finishAiCollection = resolve })
    const mobileCollected = runPipelineStep('collectMobileArticles', runCollectMobileArticles)
    const aiPipeline = (async () => {
      try {
        const result = await runAiStaticFeedPipeline({
          bucket: createStorageFeedBucket(),
          feedDate: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10),
          now: () => new Date(),
          curatorUid: process.env.NEWS_CURATOR_UID,
          collect: async () => {
            const ok = await runPipelineStep('collectArticles', runCollectArticles)
            finishAiCollection()
            await mobileCollected
            return ok
          },
          generate: context => runGeneratePersonalizedFeed(context),
          log: console,
        })
        if (result.status === 'failed') console.error(`[dailyNewsPipeline] AI static feed failed: ${result.reason}`)
        else if (result.publish.status.startsWith('skipped-')) console.warn(`[dailyNewsPipeline] AI static feed ${result.publish.status}`)
      } catch {
        console.error('[dailyNewsPipeline] AI static feed failed')
      } finally {
        finishAiCollection()
      }
    })()
    await Promise.all([aiCollected, mobileCollected])
    await Promise.all([
      aiPipeline,
      runPipelineStep('generateMobilePersonalizedFeed', runGenerateMobilePersonalizedFeed),
    ])

    await Promise.all([
      runPipelineStep('sendMobileDiscordUrgentNotifications', runSendMobileDiscordUrgentNotifications),
      runPipelineStep('sendMobileDiscordDailyDigest', runSendMobileDiscordDailyDigest),
    ])
  })
