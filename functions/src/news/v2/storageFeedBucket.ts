import * as admin from 'firebase-admin'
import { PreconditionFailedError, type FeedBucket } from './publishAiFeed'

function hasCode(error: unknown, code: number): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && Number(error.code) === code
}

export function createStorageFeedBucket(): FeedBucket {
  const bucket = process.env.NEWS_FEED_BUCKET
    ? admin.storage().bucket(process.env.NEWS_FEED_BUCKET)
    : admin.storage().bucket()
  return {
    async read(path) {
      const file = bucket.file(path)
      try {
        // 読んだ世代のデータを固定し、本文と世代番号の取り違えを防ぐ。
        const [metadata] = await file.getMetadata()
        const generation = String(metadata.generation)
        const [data] = await bucket.file(path, { generation }).download()
        return { data, generation }
      } catch (err) {
        if (hasCode(err, 404)) return null
        throw err
      }
    },
    async write(path, data, opts) {
      const file = bucket.file(path)
      try {
        await file.save(data, {
          preconditionOpts: { ifGenerationMatch: opts.ifGenerationMatch },
          contentType: opts.contentType,
          metadata: { cacheControl: opts.cacheControl },
          resumable: false,
        })
        // save が受け取った応答の世代を使用し、後続書き込みの世代を返さない。
        if (!file.metadata.generation) throw new Error('保存した世代が取得できません')
        return { generation: String(file.metadata.generation) }
      } catch (err) {
        if (hasCode(err, 412)) throw new PreconditionFailedError('保存の世代が競合しました')
        throw err
      }
    },
  }
}
