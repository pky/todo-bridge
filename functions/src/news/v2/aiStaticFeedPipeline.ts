import { buildAiFeedV2, toAiFeedV2Article } from './feedContract'
import { aiFeedDailyPath, publishDaily, saveDailyIfAbsent, type AiFeedDaily, type FeedBucket, type PublishResult } from './publishAiFeed'
import type { NewsArticleWithId } from './curatorSelection'

export type GenerateAiFeedResult = { ok: true; curatorArticles: NewsArticleWithId[] } | { ok: false }
interface PipelineDependencies {
  bucket: FeedBucket
  feedDate: string
  now: () => Date
  curatorUid: string | undefined
  collect: () => Promise<boolean>
  generate: (context: { curatorUid: string; learningCutoffAt: Date }) => Promise<GenerateAiFeedResult>
  log: { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void }
}
type PipelineResult = { status: 'failed'; reason: 'missing-curator' | 'collect' | 'generate' }
  | { status: 'published' | 'recovered'; publish: PublishResult }

export async function runAiStaticFeedPipeline(deps: PipelineDependencies): Promise<PipelineResult> {
  if (!deps.curatorUid?.trim()) return { status: 'failed', reason: 'missing-curator' }
  const existing = await deps.bucket.read(aiFeedDailyPath(deps.feedDate))
  if (existing) {
    const daily: AiFeedDaily = JSON.parse(existing.data.toString('utf8'))
    if (daily.feedDate !== deps.feedDate) throw new Error('日次原本の対象日が一致しません')
    return { status: 'recovered', publish: await publishDaily(deps.bucket, daily, deps.now().toISOString()) }
  }
  if (!await deps.collect()) return { status: 'failed', reason: 'collect' }
  const learningCutoffAt = deps.now()
  const result = await deps.generate({ curatorUid: deps.curatorUid, learningCutoffAt })
  if (!result.ok) return { status: 'failed', reason: 'generate' }
  return { status: 'published', publish: await publishCuratorArticles(deps, result.curatorArticles, learningCutoffAt) }
}

export async function publishCuratorArticles(
  deps: Pick<PipelineDependencies, 'bucket' | 'feedDate' | 'now'>,
  curatorArticles: NewsArticleWithId[],
  learningCutoffAt: Date
): Promise<PublishResult> {
  const articles = curatorArticles.flatMap(article => {
    const dto = toAiFeedV2Article({ ...article })
    return dto ? [dto] : []
  })
  const feed = buildAiFeedV2({ feedDate: deps.feedDate, generatedAt: deps.now().toISOString(), articles })
  const daily = await saveDailyIfAbsent(deps.bucket, {
    schemaVersion: 2, topic: 'ai', feedDate: deps.feedDate, learningCutoffAt: learningCutoffAt.toISOString(), feed,
    actionArticles: articles.map(article => {
      const original = curatorArticles.find(value => value.id === article.id)!
      return {
        id: article.id, title: article.title, summary: article.summary,
        ...(article.url ? { url: article.url } : {}),
        ...(original.title ? { titleEn: original.title } : {}),
        ...(article.tags ? { tags: article.tags } : {}),
      }
    }),
  })
  return publishDaily(deps.bucket, daily, deps.now().toISOString())
}
