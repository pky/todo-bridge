import type { AiCollectResult } from '../collectArticles'
import type { GenerateAiFeedResult } from './aiStaticFeedPipeline'
import type { NewsArticleWithId } from './curatorSelection'

interface DailyNewsDependencies {
  feedDate: string
  now: () => Date
  curatorUid: string | undefined
  readDailyExists: () => Promise<boolean>
  readDailyTimeoutMs: number
  collectAi: () => Promise<AiCollectResult>
  generateAi: (context: { curatorUid: string | undefined; learningCutoffAt: Date }) => Promise<GenerateAiFeedResult>
  publish: (articles: NewsArticleWithId[], learningCutoffAt: Date) => Promise<unknown>
  recoverPublish: () => Promise<unknown>
  collectMobile: () => Promise<unknown>
  generateMobile: () => Promise<unknown>
  sendMobileUrgent: () => Promise<unknown>
  sendMobileDigest: () => Promise<unknown>
  log: { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void }
}

export async function runDailyNewsPipeline(deps: DailyNewsDependencies): Promise<void> {
  const step = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run()
    } catch {
      deps.log.error(`[dailyNewsPipeline] ${name} failed`)
    }
  }
  const mobile = async () => {
    await step('collectMobile', deps.collectMobile)
    await step('generateMobile', deps.generateMobile)
    await Promise.all([
      step('sendMobileUrgent', deps.sendMobileUrgent),
      step('sendMobileDigest', deps.sendMobileDigest),
    ])
  }
  const ai = async () => {
    const curatorUid = deps.curatorUid?.trim() ? deps.curatorUid : undefined
    let canPublish = Boolean(curatorUid)
    if (curatorUid) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const exists = await Promise.race([
          deps.readDailyExists(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('日次原本確認の時間超過')), deps.readDailyTimeoutMs)
          }),
        ])
        if (exists) {
          await step('recoverPublish', deps.recoverPublish)
          return
        }
      } catch {
        canPublish = false
        deps.log.warn('[dailyNewsPipeline] daily probe unavailable')
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    } else {
      deps.log.warn('[dailyNewsPipeline] missing curator')
    }
    let collected = false
    try {
      collected = (await deps.collectAi()).sourcesSucceeded >= 1
      if (!collected) deps.log.warn('[dailyNewsPipeline] AI collection unavailable')
    } catch {
      deps.log.error('[dailyNewsPipeline] AI collection failed')
    }
    const learningCutoffAt = deps.now()
    try {
      const generated = await deps.generateAi({ curatorUid, learningCutoffAt })
      if (!generated.ok) deps.log.warn('[dailyNewsPipeline] AI generation unavailable')
      if (canPublish && collected && generated.ok) {
        await step('publish', () => deps.publish(generated.curatorArticles, learningCutoffAt))
      }
    } catch {
      deps.log.error('[dailyNewsPipeline] AI generation failed')
    }
  }
  await Promise.all([mobile(), ai()])
}
