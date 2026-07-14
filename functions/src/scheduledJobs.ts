import * as functions from 'firebase-functions/v1'
import { runCollectArticles, runCollectMobileArticles } from './news/collectArticles'
import { runGenerateMobilePersonalizedFeed, runGeneratePersonalizedFeed } from './news/generatePersonalizedFeed'
import { runSendMobileDiscordDailyDigest, runSendMobileDiscordUrgentNotifications } from './news/mobileNotifications'
import { runDailyBackup } from './scheduledBackup'
import { runRecalculateAllSmartLists } from './smartLists'
import { runDocumentConsistency } from './documents/consistency'

const R2_SECRETS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]

async function runPipelineStep(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    console.log(`[dailyNewsPipeline] ${name} starting`)
    await run()
    console.log(`[dailyNewsPipeline] ${name} completed`)
  } catch (err) {
    console.error(`[dailyNewsPipeline] ${name} failed:`, err)
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
  .runWith({ timeoutSeconds: 540, memory: '512MB', secrets: ['GEMINI_API_KEY'] })
  .pubsub.schedule('0 6 * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async () => {
    await Promise.all([
      runPipelineStep('collectArticles', runCollectArticles),
      runPipelineStep('collectMobileArticles', runCollectMobileArticles),
    ])

    await Promise.all([
      runPipelineStep('generatePersonalizedFeed', runGeneratePersonalizedFeed),
      runPipelineStep('generateMobilePersonalizedFeed', runGenerateMobilePersonalizedFeed),
    ])

    await Promise.all([
      runPipelineStep('sendMobileDiscordUrgentNotifications', runSendMobileDiscordUrgentNotifications),
      runPipelineStep('sendMobileDiscordDailyDigest', runSendMobileDiscordDailyDigest),
    ])
  })
